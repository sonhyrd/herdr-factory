#!/usr/bin/env node
"use strict";
// The harness's SCRIPTED AGENT (tier 1). Each world writes <world>/bin/{claude,opencode} as a shim
// that `exec -a <kind>`s this file, so herdr adopts it as that kind (`agent start <name> --kind
// claude --pane <id>`) — the same dispatch path production uses. (herdr identifies a pane's agent by
// the foreground process's argv[0], which is why the shim renames rather than copies.)
//
// It behaves like a real step agent and nothing more:
//   1. it is handed a one-line pointer ("Read .memory/herdr-factory/prompt-<step>.md … follow it"),
//      on argv for a factory-spawned pane or on stdin for a layout pane;
//   2. it reads the RENDERED prompt and extracts its signal commands FROM IT — it never
//      reconstructs them. That makes the suite a live check of the agent-CLI contract
//      (ARCHITECTURE §14: those command lines are baked into prompts of already-running agents);
//   3. it reports its state to herdr the way a real harness does, because `agent_status` is
//      load-bearing (working vetoes the budget/stall watchdogs and freezes the read-only baseline);
//   4. it does what the scenario's behaviour script says: commit / hang / bounce / ask-human /
//      capture N times / replay a stale --pass / nothing at all.
//
// CommonJS on purpose: it is exec'd by a bare `node <path>` from a world dir that has no
// package.json, so it must not depend on the repo's ESM one.

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { execFileSync, spawnSync } = require("node:child_process");

const SIGNALS = ["step-done", "bounce", "ask-human", "capture-attempt", "evidence-upload", "set-branch"];
// Steps whose primitive produces commits — the agent commits there by default and nowhere else, so
// a `review`/`evidence` behaviour that sets `commit: true` is a deliberate read-only violation.
const COMMIT_STEPS = new Set(["work", "pr", "fix"]);
const DEFAULT_WORK_MS = 1200;

const LOG_DIR = process.env.HF_AGENT_LOG_DIR || "/tmp";
const LOG = path.join(LOG_DIR, "agent.log");
const SCRIPT_PATH = process.env.HF_AGENT_SCRIPT || "";
const STATE_DIR = process.env.HF_AGENT_STATE_DIR || "";
const PANE = process.env.HERDR_PANE_ID || "";
const HERDR = process.env.HF_HERDR_REAL || process.env.HERDR_BIN_PATH || "herdr";
// The kind is who herdr thinks we are: the world's shim execs this file under the kind's own name
// (`exec -a claude node agent.cjs`), so argv0 — not the script path — carries it.
const KIND = process.env.HF_AGENT_KIND || path.basename(process.argv0 || "claude");

function log(msg) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG, `[${new Date().toISOString()}] [${KIND}${PANE ? " " + PANE : ""}] ${msg}\n`);
  } catch {
    /* never let logging break the agent */
  }
}

// ── herdr-observed state ────────────────────────────────────────────────────────────────────────
// The OSC terminal title, which is exactly how herdr's shipped detection manifests read a real
// harness: claude.toml's `osc_title_working` matches a leading braille glyph, `osc_title_idle` a
// leading ✳. (`pane report-agent` looked like the "explicit" route but it TAKES AGENT AUTHORITY over
// the pane — reporting during startup knocks out herdr's own adoption record and `agent start` then
// fails on `agent.get`. Real harnesses don't call it; neither do we.) The status FILE alongside is
// how the fake-herdr lane observes the same transitions.
function setState(state) {
  const title = state === "working" ? "⠋ working" : "✳ idle";
  try {
    process.stdout.write(`\x1b]0;${title}\x07`);
  } catch {
    /* ignore */
  }
  if (STATE_DIR) {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(path.join(STATE_DIR, `${PANE || process.pid}.status`), state);
    } catch {
      /* ignore */
    }
  }
}

function sleep(ms) {
  if (ms <= 0) return;
  // Synchronous on purpose: the turn is a single blocking script, exactly like an agent's turn.
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

// ── the behaviour script ────────────────────────────────────────────────────────────────────────
function loadScript() {
  if (!SCRIPT_PATH) return {};
  try {
    return JSON.parse(fs.readFileSync(SCRIPT_PATH, "utf8"));
  } catch {
    return {};
  }
}

function behaviourFor(step, pass) {
  const s = loadScript(); // re-read every turn: a scenario may change behaviour between phases
  return Object.assign({}, s.default || {}, (s.steps || {})[step] || {}, (s.passes || {})[`${step}:${pass}`] || {});
}

// ── prompt parsing ──────────────────────────────────────────────────────────────────────────────
// A turn arrives one of two ways. Normally it is the dispatch pointer, which names the rendered
// prompt file outright. But the engine also nudges an EXISTING conversation — after a human reply,
// or after a `resume` — and those messages name the step in prose instead ("continue the work step"),
// because a real agent is mid-conversation and already knows where its brief is. A scripted agent is
// stateless per turn, so it recovers the same thing from the step name.
function promptRelFor(text) {
  const direct = /\.memory\/herdr-factory\/prompt-([a-z0-9_-]+)\.md/i.exec(text || "");
  if (direct) return { rel: direct[0], step: direct[1] };
  const named = /continue the ([a-z0-9_-]+) step/i.exec(text || "");
  if (named) return { rel: `.memory/herdr-factory/prompt-${named[1]}.md`, step: named[1] };
  return null;
}

/** Extract the rendered signal command lines. A candidate carrying a `<placeholder>` is prose, not
 *  the rendered token, so it loses to a concrete one. */
function parseSignals(prompt) {
  const found = {};
  // The path must not absorb the markdown fence the prompt wraps the command in (a leading backtick
  // makes /bin/sh die in backquote substitution), and the tail stops at the closing fence.
  const re = new RegExp("([^\\s`'\"]*herdr-factory)\\s+--repo\\s+(\\S+)\\s+(" + SIGNALS.join("|") + ")([^\\n`]*)", "g");
  let m;
  while ((m = re.exec(prompt))) {
    const cmd = `${m[1]} --repo ${m[2]} ${m[3]}${m[4]}`.replace(/[\s.,;:)\]]+$/, "");
    const name = m[3];
    const concrete = !cmd.includes("<");
    const prev = found[name];
    if (!prev || (concrete && prev.includes("<"))) found[name] = cmd;
  }
  return found;
}

function flagValue(cmd, flag) {
  const m = new RegExp(`--${flag}\\s+(\\S+)`).exec(cmd || "");
  return m ? m[1] : null;
}

function sh(cmd, cwd) {
  const r = spawnSync("/bin/sh", ["-c", cmd], { cwd, encoding: "utf8", timeout: 120_000 });
  log(`  $ ${cmd}\n    rc=${r.status} ${(r.stdout || "").trim().slice(0, 400)}${r.stderr ? " ERR:" + r.stderr.trim().slice(0, 400) : ""}`);
  return r;
}

// Retry a rejected signal instead of stopping — and log every attempt, so a scenario can assert that
// no rejection happened at all (test/e2e/scenarios/fast-signal.e2e.ts does).
//
// This is what the shipped prompts now tell a real agent to do too. It used to be load-bearing: the
// engine recorded a run's active step only AFTER the dispatch call returned, so a fast agent's
// step-done was rejected ("not the run's active step") and — because the rejection exited 0 — silently
// lost. Both halves are fixed in the engine; the retry stays as the backstop it should always have
// been.
function signalWithRetry(cmd, cwd) {
  const MAX = 8;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    const r = sh(cmd, cwd);
    const out = `${r.stdout || ""}${r.stderr || ""}`;
    // Match the REJECTION TEXT, not merely a non-zero exit: flag errors (a missing --reason-file, a
    // bad argument) also exit 1, and retrying those just hides the harness's own mistake eight times.
    if (!/signal ignored|is not the run's active step/.test(out)) {
      if (r.status !== 0) log(`  signal command FAILED (rc=${r.status}) — not a rejection, not retrying`);
      return r;
    }
    log(`  signal rejected — the engine has not recorded the dispatch yet (attempt ${attempt}/${MAX})`);
    sleep(1000);
  }
  log("  signal STILL rejected after retries — giving up");
  return null;
}

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  } catch (e) {
    log(`  git ${args.join(" ")} failed: ${e && e.message}`);
    return "";
  }
}

// ── one turn ────────────────────────────────────────────────────────────────────────────────────
function handle(text) {
  const cwd = process.cwd();
  const found = promptRelFor(text);
  if (!found) {
    // Still take a turn: a real harness starts working on ANY prompt, and callers like the PR-watch
    // resolver wake use a confirmed submission (`--until working`) to decide whether the agent woke.
    log(`no prompt pointer — taking an empty turn: ${JSON.stringify((text || "").slice(0, 160))}`);
    setState("working");
    sleep(1500);
    setState("idle");
    return;
  }
  const promptPath = path.join(cwd, found.rel);
  if (!fs.existsSync(promptPath)) {
    log(`prompt file MISSING: ${promptPath}`);
    return;
  }
  const prompt = fs.readFileSync(promptPath, "utf8");
  const cmds = parseSignals(prompt);
  const pass = Number(flagValue(cmds["step-done"], "pass") || "1");
  const step = found.step;
  const b = behaviourFor(step, pass);
  log(`turn step=${step} pass=${pass} behaviour=${JSON.stringify(b)} signals=${Object.keys(cmds).join(",")}`);
  try {
    fs.writeFileSync(path.join(LOG_DIR, `prompt-${step}-pass${pass}.md`), prompt);
  } catch {
    /* ignore */
  }

  setState(b.status || "working");

  if (b.hangMs !== undefined) {
    log(`hanging (${b.hangMs})`);
    if (b.hangMs === "forever") {
      for (;;) sleep(60_000);
    }
    sleep(Number(b.hangMs));
    setState(b.status || "idle");
    return; // never signals: the run must be rescued by a watchdog / resume / human
  }

  // Let the engine SEE this agent working before anything happens (watches that arm on an observed
  // `working` state need at least one reconcile pass in between).
  if (b.preWorkMs) sleep(Number(b.preWorkMs));

  const commits = b.commit === undefined ? (COMMIT_STEPS.has(step) ? 1 : 0) : b.commit === true ? 1 : b.commit === false ? 0 : Number(b.commit);
  for (let i = 0; i < commits; i++) {
    const f = path.join(cwd, "work", `${step}-${pass}-${i}.txt`);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `${step} pass ${pass} change ${i}\n`);
    git(["add", "-A"], cwd);
    git(["commit", "-m", `chore(${step}): scripted change ${i} (pass ${pass})`], cwd);
    log(`  committed ${path.relative(cwd, f)} HEAD=${git(["rev-parse", "--short", "HEAD"], cwd)}`);
  }

  // The repo's branch convention: rename onto it through the rendered set-branch command, exactly
  // as the shipped work prompt tells an agent to (its `<new-branch-name>` placeholder is the one
  // token an agent is expected to substitute).
  if (b.setBranch) {
    const cmd = cmds["set-branch"];
    if (!cmd) log(`  WANTED set-branch but the prompt renders no such command`);
    else sh(cmd.replace(/<new-branch-name>/, b.setBranch), cwd);
  }

  for (const cmd of b.run || []) sh(cmd, cwd);

  if (b.captureAttempts) {
    for (let i = 0; i < b.captureAttempts; i++) {
      if (cmds["capture-attempt"]) sh(cmds["capture-attempt"], cwd);
    }
  }

  if (b.evidence) {
    const dir = path.join(cwd, ".memory", "herdr-factory", "evidence");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${step}-before.png`), "PNG-ish bytes (harness)");
    fs.writeFileSync(path.join(dir, `${step}-after.png`), "PNG-ish bytes (harness)");
    if (cmds["evidence-upload"]) sh(cmds["evidence-upload"], cwd);
  }

  // A step that produces a pull request is recognised from the prompt itself: only the `pr`
  // primitive's body tells its agent to push the branch. Match on that instruction, not on "open the
  // PR" — the WORK prompt contains the phrase too, in "you do NOT open the PR yourself". A scenario
  // can always say so explicitly with `openPr`.
  const wantsPr = b.openPr === undefined ? /git push -u origin /.test(prompt) : b.openPr;
  if (wantsPr) {
    const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    const ghRepo = process.env.HF_GH_REPO || "acme/app";
    // The belt's `pr:` policy reaches the agent as prompt text, so honour it the way a real agent
    // would — by reading it. `--draft` is the one that changes the ENGINE's behaviour (a draft PR
    // keeps the step-done gate instead of handing straight off to the review watch).
    const draft = /--draft/.test(prompt) ? " --draft" : "";
    sh(`git push -u origin ${branch}`, cwd);
    sh(
      `gh pr create --repo ${ghRepo} --head ${branch} --base main${draft} ` +
        `--title ${JSON.stringify(`[harness] ${branch}`)} --body ${JSON.stringify(`Opened by the scripted agent for step ${step}.`)}`,
      cwd,
    );
  }

  if (!b.noHandoff) {
    const m = /\.memory\/herdr-factory\/handoff-([a-z0-9_-]+)\.md/g;
    // @@HANDOFF_OUT@@ is this step's own file; @@HANDOFF_IN@@ names the PRIOR step's.
    let hit;
    let outRel = null;
    while ((hit = m.exec(prompt))) if (hit[1] === step) outRel = hit[0];
    if (outRel) {
      const p = path.join(cwd, outRel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, `# handoff from ${step} (pass ${pass})\n\nDid: scripted work.\nVerify next: nothing.\n`);
      log(`  wrote ${outRel}`);
    }
  }

  sleep(b.workMs === undefined ? DEFAULT_WORK_MS : Number(b.workMs));

  const signal = b.signal || "step-done";
  if (signal !== "none") {
    let cmd = cmds[signal];
    if (!cmd) {
      log(`  WANTED signal "${signal}" but the prompt renders no such command`);
    } else {
      if (signal === "bounce") {
        const file = flagValue(cmd, "reason-file");
        if (file) writeIn(cwd, file, b.text || `Scripted bounce from ${step} (pass ${pass}).`);
      }
      if (signal === "ask-human") {
        const file = flagValue(cmd, "question-file");
        if (file) writeIn(cwd, file, b.text || `Scripted question from ${step} (pass ${pass}): which way?`);
      }
      signalWithRetry(cmd, cwd);
      if (b.replayStalePass) sh(cmd.replace(/--pass\s+\d+/, "--pass 1"), cwd);
    }
  }

  setState(b.status || "idle");
}

function writeIn(cwd, rel, body) {
  const p = path.isAbsolute(rel) ? rel : path.join(cwd, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${body}\n`);
  log(`  wrote ${p} (${body.length} bytes)`);
}

/** Sit idle for a beat before the first turn — a real harness's boot window, and load-bearing here.
 *
 *  `herdr agent start` blocks until it has detected the agent AND marked it ready for input, and the
 *  engine records the dispatch (hence the run's ACTIVE STEP) only after that call returns. A real
 *  harness paints its prompt box, loads its config and sits idle for seconds before touching the
 *  prompt, so adoption completes long before its first turn. This script is otherwise at work within
 *  ~10ms of exec, which starves adoption of the idle window it needs: `agent start` keeps waiting for
 *  the whole turn, so every signal the turn emits is rejected as "not the run's active step" — and a
 *  rejected signal still exits 0, so the agent cannot tell. Dwelling is both faithful and the fix.
 *
 *  (The underlying engine hazard is real but narrow for real agents: any signal arriving between a
 *  blocking dispatch and the `run.step` write is dropped. See test/e2e/README.md.) */
function bootDwell() {
  if (!PANE) return;
  const ms = Number(process.env.HF_AGENT_STARTUP_MS || 4000);
  sleep(ms);
  const r = spawnSync(HERDR, ["agent", "list"], { encoding: "utf8", timeout: 10_000 });
  try {
    const agents = (JSON.parse(r.stdout || "{}").result || {}).agents || [];
    const me = agents.find((a) => a.pane_id === PANE);
    log(me ? `herdr sees me as "${me.name || me.agent}" (status=${me.agent_status}, ready=${me.interactive_ready})` : "herdr does not list this pane yet");
  } catch {
    log("could not read agent list after the boot dwell");
  }
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────
log(`START argv=${JSON.stringify(process.argv.slice(2))} cwd=${process.cwd()}`);
setState("idle");
process.stdout.write("\n> ");
bootDwell();

const initial = process.argv[process.argv.length - 1];
if (initial && promptRelFor(initial)) {
  try {
    handle(initial);
  } catch (e) {
    log(`TURN FAILED: ${e && e.stack}`);
    setState("idle");
  }
  process.stdout.write("\n> ");
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  log(`STDIN ${JSON.stringify(text.slice(0, 200))}`);
  try {
    handle(text);
  } catch (e) {
    log(`TURN FAILED: ${e && e.stack}`);
    setState("idle");
  }
  process.stdout.write("\n> ");
});
rl.on("close", () => {
  log("stdin closed — exiting");
  process.exit(0);
});
