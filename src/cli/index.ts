import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Command } from "commander";
import { configJsonSchema, configSchemaPath, evidenceKeyPrefix, globalDbPath, isManagedNode, loadConfig, managedNodePath, nodePathFile, repoConfigDir, writeConfigSchema, type WorkSourceConfig } from "../config.ts";
import { descriptorFor } from "../sources/registry.ts";
import { stepDescriptorFor } from "../steps/registry.ts";
import { ejectPrompts, UnknownPromptStepError } from "../prompts-eject.ts";
import { installSkill, SkillBundleMissingError, SkillDestinationExistsError } from "../skill-install.ts";
import { createEvidencePublisher, enumerateEvidenceFiles, resolveGithubUsername } from "../clients/evidence.ts";
import { baseGroups, repoGroup, type DoctorGroup } from "../doctor.ts";
import { openDb } from "../db/index.ts";
import { Store } from "../db/store.ts";
import { initRepo } from "../init.ts";
import { afterDoctorHint, afterInstallHint, afterStartHint } from "../onboarding.ts";
import { systemClock, type Run, type SourceType } from "../types.ts";
import type { Deps } from "../core/deps.ts";
import { claimTicket, flushDurableIntents, reconcileRepo, reconcileRun, resumeRun, teardownTicket, withRunLockWaiting, withTickLock } from "../core/reconcile.ts";
import { evidencePublishKind, EVIDENCE_PUBLISH_LEASE_SECONDS } from "../intents/kinds/evidence-publish.ts";
import { intentRetryDelay } from "../intents/registry.ts";
import { applySignal, type SignalBody, type SignalResult } from "../core/signals.ts";
import { runObligations } from "../core/obligations.ts";
import { explainRun, fmtDur } from "../core/explain.ts";
import { runForeground } from "./run.ts";
import { triageRun } from "./triage.ts";
import { MEMORY_DIR } from "../core/step.ts";
import * as service from "../watchers/service.ts";
import { buildDeps, today } from "../build-deps.ts";
import { resolveActiveRun, resolveBeltName } from "../resolve.ts";
import { serve } from "../server/serve.ts";
import { ensureUp, stopServer, type Log } from "../watchers/supervisor.ts";
import { selfUpdate } from "../watchers/updater.ts";
import { pinnedNodeVersion, provisionNode } from "../watchers/provision.ts";
import { NoServerError, pingHealth, readHealth, readServerInfo, serverFetch, viaServerOrLocal } from "../server/client.ts";
import { VERSION } from "../version.ts";
import { initTelemetry, recordCliDuration, shutdownTelemetry, telemetryEnabled, telemetryEvent, telemetrySpan } from "../telemetry/index.ts";
import { disposeEffectRuntime } from "../runtime/effect.ts";

function fail(e: unknown): never {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

/** Record this node binary so `bin/herdr-factory` can re-exec with a known Node >=26 from any cwd
 *  (see config.nodePathFile). Best-effort + guarded to >=26 so we never bake an unusable path (the
 *  CLI effectively only ever runs under >=26 anyway — type-stripping + node:sqlite + the TUI's FFI
 *  require it). Runs on every invocation, so it self-heals as the pinned node is upgraded.
 *  When running under the vendored runtime (a managed install), bake the STABLE
 *  `<state>/runtime/current/bin/node` symlink path rather than this concrete version dir — so a
 *  later `.node-version` bump (which just flips that symlink) needs no re-bake. */
function bakeNodePath(): void {
  try {
    if (Number(process.versions.node.split(".")[0]) < 26) return;
    const file = nodePathFile();
    let target: string;
    if (isManagedNode(process.execPath)) {
      target = managedNodePath();
    } else {
      // Never DEMOTE a vendored-runtime path to a concrete system/nvm binary. A worker agent may run
      // the CLI under some ambient Node >=26 (the launcher prefers the active node); if a managed node
      // is already baked and still present, keep it — so `.node-version` bumps keep propagating via the
      // `current` symlink and the service's ExecStart never gets pinned to a volatile system node.
      let existing = "";
      try {
        existing = readFileSync(file, "utf8").trim();
      } catch {
        /* nothing baked yet */
      }
      if (existing && isManagedNode(existing) && existsSync(existing)) return;
      target = process.execPath;
    }
    if (existsSync(file) && readFileSync(file, "utf8") === target) return;
    mkdirSync(dirname(file), { recursive: true });
    // Atomic publish (write sibling temp, then rename) so a concurrent launcher `cat` never reads a
    // torn/empty file — writeFileSync truncates first, and multiple workers can bake at once.
    const tmp = `${file}.${process.pid}`;
    writeFileSync(tmp, target);
    renameSync(tmp, file);
  } catch {
    /* best-effort: a read-only / uncreatable state dir must never break the CLI */
  }
}
bakeNodePath();
initTelemetry();

async function shutdownRuntimes(): Promise<void> {
  await Promise.all([shutdownTelemetry(), disposeEffectRuntime()]);
}

/** A console logger for the repo-agnostic supervisor commands (serve/ensure-up/install/…). */
const consoleLog: Log = (level, msg) => console.log(`[${level}] ${msg}`);
let residentCommand = false;

const program = new Command();
program
  .name("herdr-factory")
  .description("Autonomous work→PR factory — runs Claude worker agents across repos on herdr worktrees.")
  .version(VERSION)
  .option("--repo <name>", "target repo (its ~/.config/herdr-factory/repos/<name>/)");

function requireRepo(): string {
  const repo = (program.opts() as { repo?: string }).repo;
  if (!repo) fail("this command needs a repo: herdr-factory --repo <name> <command>");
  return repo;
}

function humanQuestionText(opts: { question?: string; questionFile?: string }): string {
  if (opts.question && opts.questionFile) fail("ask-human: pass either --question or --question-file, not both");
  const text = opts.questionFile ? readFileSync(opts.questionFile, "utf8") : opts.question;
  if (!text?.trim()) fail("ask-human: provide a non-empty --question or --question-file");
  return text.trim();
}

function bounceReasonText(opts: { reason?: string; reasonFile?: string }): string {
  if (opts.reason && opts.reasonFile) fail("bounce: pass either --reason or --reason-file, not both");
  const text = opts.reasonFile ? readFileSync(opts.reasonFile, "utf8") : opts.reason;
  if (!text?.trim()) fail("bounce: provide a non-empty --reason or --reason-file (the findings the earlier step must address)");
  return text.trim();
}

/** Send a run-scoped agent signal (step-done · ask-human · bounce · capture-attempt): route it
 *  through the running server for a warm reconcile, with a direct in-process fallback so it still
 *  lands while the server restarts (the next tick is the backstop either way). BOTH paths run the
 *  same engine effect — `applySignal` on the server, or here in-process — so they can't drift. */
async function dispatchSignal(repo: string, name: string, body: SignalBody): Promise<SignalResult> {
  const { data } = await viaServerOrLocal(
    { method: "POST", path: `/repos/${encodeURIComponent(repo)}/${name}`, body },
    async () => applySignal(await buildDeps(repo), name, body),
  );
  return data as SignalResult;
}

/** Report a REJECTED signal as a failure: on stderr, with a non-zero exit.
 *
 *  The exit code is the only channel an agent has. A rejected `step-done` used to print a note and
 *  exit 0, so the agent believed it had finished, stopped, and the run sat until its step budget
 *  expired — the worst possible failure shape. Additive with respect to the cross-release agent CLI
 *  contract (ARCHITECTURE §14): no command, flag or accepted spelling changes; only a *failure* stops
 *  masquerading as success. Returns true when the caller should stop. */
function signalRejected(key: string, d: SignalResult, fallback: string): boolean {
  if (d.ok !== false) return false;
  console.error(`${key}: ${d.message ?? fallback}`);
  process.exitCode = 1;
  return true;
}

/** Print each source's credential presence (no network — env-var presence only). Driven by each
 *  source type's descriptor secrets manifest, so there are no per-type branches (jira: JIRA_EMAIL +
 *  JIRA_API_TOKEN; sentry: SENTRY_AUTH_TOKEN; local_markdown: none). github_issues has a gh-CLI
 *  fallback that the manifest can't express, so it keeps a small branch. */
function authStatusReport(config: ReturnType<typeof loadConfig>["config"], env: Record<string, string>): void {
  console.log(`auth status — repo ${config.repoName}:`);
  for (const s of config.sources) {
    if (s.type === "github_issues") {
      console.log(`  ${s.name} (github_issues): ${env.GITHUB_TOKEN ? "✓ GITHUB_TOKEN present" : "using the gh CLI login (`gh auth status`)"}`);
      continue;
    }
    const required = descriptorFor(s.type).secrets.filter((sec) => sec.required);
    if (required.length === 0) {
      console.log(`  ${s.name} (${s.type}): no authentication required`);
    } else {
      const missing = required.filter((sec) => !env[sec.envKey]);
      console.log(
        missing.length === 0
          ? `  ${s.name} (${s.type}): ✓ ${required.map((sec) => sec.envKey).join(" + ")} present`
          : `  ${s.name} (${s.type}): ✗ set ${missing.map((sec) => sec.envKey).join(" + ")} in the repo env`,
      );
    }
  }
}

function cliAction<Args extends unknown[]>(name: string, fn: (...args: Args) => Promise<void> | void): (...args: Args) => Promise<void> {
  return async (...args: Args) => {
    const startedAt = Date.now();
    const repo = (program.opts() as { repo?: string }).repo;
    await telemetrySpan("cli.command", { "cli.command": name, repo }, async () => {
      try {
        await fn(...args);
      } finally {
        recordCliDuration(Date.now() - startedAt, { "cli.command": name, repo });
      }
    });
  };
}

/** Print one doctor group as `✓/⚠/✗ <name> — <detail>` lines. Returns whether any check failed (an
 *  amber `⚠` warn is not a failure — it never gates the exit code). */
function printDoctorGroup(g: DoctorGroup): boolean {
  let failed = false;
  console.log(`${g.title}:`);
  for (const c of g.checks) {
    if (!c.ok) failed = true;
    const mark = c.warn && c.ok ? "⚠" : c.ok ? "✓" : "✗";
    console.log(`  ${mark} ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);
  }
  return failed;
}

program
  .command("telemetry-smoke")
  .description("emit a small OpenTelemetry trace/metric to verify local telemetry export")
  .action(cliAction("telemetry-smoke", async () => {
    if (!telemetryEnabled()) {
      console.log("telemetry disabled — set HERDR_FACTORY_TELEMETRY=1 and OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318");
      return;
    }
    await telemetrySpan("telemetry.smoke", {}, async () => {
      telemetryEvent("telemetry.smoke.event", { ok: true });
    });
    console.log("telemetry smoke trace emitted (service: herdr-factory, trace root: cli.command)");
  }));

program
  .command("tick")
  .description("run one reconcile pass (routes through the server if up, else runs in-process)")
  .action(cliAction("tick", async () => {
    try {
      const repo = requireRepo();
      const { viaServer, data } = await viaServerOrLocal({ method: "POST", path: `/repos/${encodeURIComponent(repo)}/tick` }, async () => {
        const deps = await buildDeps(repo);
        const ran = await withTickLock(deps, () => reconcileRepo(deps));
        if (!ran) deps.log("info", "another tick is already running — skipping");
        return { ran };
      });
      const ran = (data as { ran?: boolean }).ran;
      console.log(`tick: ${ran === false ? "another tick already running" : "ran"} (${viaServer ? "via server" : "in-process"})`);
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("watch")
  .description("[legacy/dev] single-repo resident loop (the server now does this for all repos)")
  .action(cliAction("watch", async () => {
    residentCommand = true;
    let deps: Deps;
    try {
      deps = await buildDeps(requireRepo());
    } catch (e) {
      fail(e); // exits non-zero; launchd KeepAlive retries after ThrottleInterval
    }
    const intervalMs = deps.config.limits.tickIntervalSeconds * 1000;
    let stopping = false;
    const shutdown = (sig: string) => {
      if (stopping) return;
      stopping = true;
      deps.log("info", `watch: received ${sig}, stopping after the current pass`);
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
    deps.log("info", `watch: started — reconciling every ${deps.config.limits.tickIntervalSeconds}s`);
    while (!stopping) {
      try {
        const ran = await withTickLock(deps, () => reconcileRepo(deps));
        if (!ran) deps.log("info", "another tick is already running — skipping");
      } catch (e) {
        // A single failed pass must never kill the loop — log and keep polling.
        deps.log("error", `watch: tick failed — ${e instanceof Error ? e.message : String(e)}`);
      }
      // Interruptible sleep, so SIGTERM (launchd bootout) stops us within ~1s.
      for (let waited = 0; waited < intervalMs && !stopping; waited += 1000) {
        await deps.sleep(Math.min(1000, intervalMs - waited));
      }
    }
    deps.log("info", "watch: stopped");
    await shutdownRuntimes();
    process.exit(0);
  }));

program
  .command("run")
  .description(
    "run the factory for this repo in the FOREGROUND: reconcile on the configured cadence and stream live progress — the first-run/aha path (no background server needed; it cooperates with one via the tick lock). Exits when the repo goes idle; --follow rides it until you Ctrl-C",
  )
  .option("--follow", "keep following after the local work drains (stream until Ctrl-C) instead of exiting when idle")
  .action(cliAction("run", async (opts: { follow?: boolean }) => {
    residentCommand = true; // a long-lived foreground loop: we own runtime shutdown + exit
    let deps: Deps;
    try {
      deps = await buildDeps(requireRepo());
    } catch (e) {
      fail(e);
    }
    try {
      await runForeground(deps, { follow: !!opts.follow });
    } catch (e) {
      await shutdownRuntimes();
      fail(e);
    }
    await shutdownRuntimes();
    process.exit(0);
  }));

program
  .command("status")
  .description("show active tickets + server/supervisor state for the repo")
  .action(cliAction("status", async () => {
    try {
      const deps = await buildDeps(requireRepo());
      const c = deps.config;
      const active = deps.store.activeRuns(c.repoName);
      const recent = deps.store.listRuns(c.repoName, true);
      const finished = recent.filter((r) => r.endedAt !== null);
      // The phase column shows the active step when running (phase is just "running" otherwise).
      const fmt = (r: Run, statusCol: string) =>
        `    ${r.ticketKey.padEnd(16)} ${(r.belt ?? "?").padEnd(16)} ${(r.phase === "running" && r.step ? r.step : r.phase).padEnd(12)} ${statusCol.padEnd(16)} PR:${(r.prNumber ? `#${r.prNumber}` : "-").padEnd(6)} ${(r.summary ?? "").slice(0, 50)}`;
      console.log(`herdr-factory [${c.repoName}] — cap ${c.limits.maxActiveWorkspaces} workspaces`);
      console.log(`Sources: ${c.sources.map((s) => `${s.name}(${s.type})`).join(" · ")}`);
      console.log(
        `Belts (priority order): ${c.belts.map((b) => `${b.name}(${b.beltType}, src:${b.source}, p${b.priority}${b.active ? "" : ", INACTIVE"})`).join(" · ")}`,
      );
      console.log(`Runs: ${active.length} running (cap ${c.limits.maxActiveWorkspaces}) · ${finished.length} finished`);
      console.log("");
      console.log(`  ACTIVE (${active.length})`);
      if (active.length === 0) console.log("    (none in flight)");
      for (const r of active) {
        // live worker status from herdr (what the cat is actually doing), vs the
        // ledger phase (where the loop thinks it is).
        const worker = r.paneId ? await deps.herdr.paneState(r.paneId).catch(() => "unknown") : "no-pane";
        console.log(fmt(r, `worker:${worker}`));
        const steps = deps.store.runStepsFor(r.id);
        if (steps.length) console.log(`      steps: ${steps.map((s) => `${s.step}${s.done ? "✓" : "●"}`).join(" ")}`);
      }
      if (finished.length) {
        console.log("");
        console.log(`  FINISHED (${finished.length}${recent.length >= 100 ? ", latest 100" : ""}, newest first)`);
        for (const r of finished) console.log(fmt(r, r.outcome ?? "—"));
      }
      console.log("");
      const info = readServerInfo();
      const healthy = info ? await pingHealth(info.port) : false;
      console.log(
        `server: ${healthy ? `running (pid ${info!.pid}, port ${info!.port}, v${info!.version})` : info ? "advertised but not responding" : "not running"}`,
      );
      console.log(`supervisor: ${(await service.isLoaded()) ? "loaded" : "not loaded"}`);
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("eligible")
  .description("list eligible (todo) work items across all sources")
  .action(cliAction("eligible", async () => {
    try {
      const deps = await buildDeps(requireRepo());
      const out: { source: string; key: string; summary: string; type: string }[] = [];
      // Per-belt eligibility: each belt polls its source with its own pickup label. Dedup by
      // (source, key) since two belts could name the same source (with distinct labels).
      const seen = new Set<string>();
      for (const belt of deps.belts) {
        const src = deps.resolveSource(belt.source);
        if (!src) continue;
        try {
          for (const t of await src.client.listEligible(belt.label)) {
            if (seen.has(`${src.name} ${t.key}`)) continue;
            seen.add(`${src.name} ${t.key}`);
            out.push({ source: src.name, key: t.key, summary: t.summary, type: t.type });
          }
        } catch (e) {
          deps.log("warn", `${src.name}: eligible query failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      console.log(JSON.stringify(out, null, 2));
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("claim <key>")
  .description("manually claim + start one work item on a belt")
  .option("--belt <name>", "which belt to run the item on (required if >1 belt)")
  .action(cliAction("claim", async (key: string, opts: { belt?: string }) => {
    try {
      const repo = requireRepo();
      await viaServerOrLocal({ method: "POST", path: `/repos/${encodeURIComponent(repo)}/claim`, body: { key, belt: opts.belt } }, async () => {
        const deps = await buildDeps(repo);
        await claimTicket(deps, resolveBeltName(deps, opts.belt), key);
        return { ok: true };
      });
      console.log(`${key}: claimed`);
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("teardown <key>")
  .description("tear down one work item's worktree")
  .option("--source <name>", "disambiguate when the key is active in more than one source")
  .action(cliAction("teardown", async (key: string, opts: { source?: string }) => {
    try {
      const repo = requireRepo();
      await viaServerOrLocal({ method: "POST", path: `/repos/${encodeURIComponent(repo)}/teardown`, body: { key, source: opts.source } }, async () => {
        await teardownTicket(await buildDeps(repo), key, opts.source);
        return { ok: true };
      });
      console.log(`${key}: torn down`);
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("resume <key>")
  .description("un-park an `attention` run back to where it was (running/reviewing/claiming)")
  .option("--source <name>", "disambiguate when the key is active in more than one source")
  .action(cliAction("resume", async (key: string, opts: { source?: string }) => {
    try {
      const repo = requireRepo();
      const { data } = await viaServerOrLocal(
        { method: "POST", path: `/repos/${encodeURIComponent(repo)}/resume`, body: { key, source: opts.source } },
        async () => {
          const deps = await buildDeps(repo);
          const run = resolveActiveRun(deps, key, opts.source);
          if (!run) {
            deps.log("warn", `${key}: no active run to resume`);
            return { ok: false, message: "no active run" };
          }
          // Resume mutates the phase and re-dispatches — serialize under this run's lock, like bounce.
          const { ran, result } = await withRunLockWaiting(deps, run.id, async () => {
            const res = await resumeRun(deps, deps.store.getRun(run.id)!);
            if (res.ok) await reconcileRun(deps, deps.store.getRun(run.id)!);
            return res;
          });
          if (!ran) return { ok: false, message: "run busy — retry the resume in a moment" };
          return result!;
        },
      );
      const d = data as { ok?: boolean; phase?: string; message?: string };
      if (d.ok === false) {
        console.log(`${key}: ${d.message ?? "resume failed"}`);
        return;
      }
      console.log(`${key}: resumed -> ${d.phase}`);
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("retry-now [key]")
  .description("stop waiting out a backoff: make this repo's backed-off retries (or just one run's) due now and flush them — run it after fixing the cause, e.g. `aws sso login`")
  .option("--source <name>", "disambiguate when the key is active in more than one source")
  .action(cliAction("retry-now", async (key: string | undefined, opts: { source?: string }) => {
    try {
      const repo = requireRepo();
      const { data } = await viaServerOrLocal(
        { method: "POST", path: `/repos/${encodeURIComponent(repo)}/retry-now`, body: { key, source: opts.source } },
        async () => {
          const deps = await buildDeps(repo);
          let runId: number | undefined;
          if (key) {
            const run = resolveActiveRun(deps, key, opts.source);
            if (!run) return { ok: false, requeued: 0, flushed: false, message: `${key}: no active run` };
            runId = run.id;
          }
          const requeued = deps.store.retryIntentsNow(repo, { runId });
          // Same contract as the route: re-queue, then flush under the tick lock so the rows land now.
          const flushed = await withTickLock(deps, () => flushDurableIntents(deps));
          return { ok: true, requeued, flushed };
        },
      );
      const d = data as { ok?: boolean; requeued?: number; flushed?: boolean; message?: string };
      if (d.ok === false) {
        console.log(d.message ?? "retry-now failed");
        return;
      }
      const n = d.requeued ?? 0;
      const scope = key ?? repo;
      if (n === 0) {
        console.log(`${scope}: no backed-off retries were waiting`);
        return;
      }
      console.log(`${scope}: ${n} backed-off retr${n === 1 ? "y" : "ies"} made due now${d.flushed ? " and flushed" : " (a tick is mid-pass — it will deliver them)"}`);
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("auth <action>")
  .description("work-source auth: `status` reports each source's credential presence (no network). All sources authenticate from the repo `env` (no browser login)")
  .action(cliAction("auth", async (action: string) => {
    try {
      const { config, env } = loadConfig(requireRepo());
      if (action === "status") {
        authStatusReport(config, env);
        return;
      }
      fail(`unknown auth action "${action}" — use: status`);
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("prompts <action>")
  .description(
    "prompt pack: `eject` copies the shipped step prompts into the repo config folder (repos/<name>/prompts/) so you can edit them and point a step's `prompt_file` at the copy",
  )
  .option("--step <name>", "eject only this prompt (e.g. work/review/pr/evidence/resolver); default: the whole pack")
  .option("--force", "overwrite prompts already ejected (default: skip existing files, preserving your edits)")
  .action(cliAction("prompts", async (action: string, opts: { step?: string; force?: boolean }) => {
    try {
      const repo = requireRepo();
      if (action !== "eject") fail(`unknown prompts action "${action}" — use: eject`);
      const dir = repoConfigDir(repo);
      // Eject works before `init` too, but a typo'd --repo would otherwise silently create a stray
      // folder — so nudge (don't fail) when there's no config.yml for this repo yet.
      if (!existsSync(join(dir, "config.yml"))) {
        console.log(`note: no config.yml at ${dir} yet — run \`herdr-factory --repo ${repo} init\` first if this isn't the repo you meant.\n`);
      }
      let result;
      try {
        result = ejectPrompts({ repoConfigDir: dir, step: opts.step, force: opts.force });
      } catch (e) {
        if (e instanceof UnknownPromptStepError) fail(e.message);
        throw e;
      }
      if (result.written.length === 0 && result.skipped.length === 0) {
        console.log("no shipped prompts found to eject.");
        return;
      }
      if (result.written.length > 0) {
        console.log(`Ejected ${result.written.length} prompt${result.written.length === 1 ? "" : "s"} into ${result.destRoot}:`);
        for (const f of result.written) console.log(`  ${f.configRel}`);
      }
      if (result.skipped.length > 0) {
        console.log(`Skipped ${result.skipped.length} already-present file${result.skipped.length === 1 ? "" : "s"} (pass --force to overwrite):`);
        for (const f of result.skipped) console.log(`  ${f.configRel}`);
      }
      // Wire hints for the shared, step-named prompts (the common case). Per-source variants and the
      // resolver prompt still land in the folder above; they just aren't a one-line paste.
      const wireable = result.written.filter((f) => !f.entry.source && stepDescriptorFor(f.entry.slug));
      if (wireable.length > 0) {
        console.log(`\nPoint a belt step at an ejected prompt (prompt_file_source defaults to \`config\`):`);
        for (const f of wireable) console.log(`  - { type: ${f.entry.slug}, prompt_file: ${f.configRel} }`);
        console.log(`For a work/review/pr/evidence step this AUGMENTS the shipped prompt; a \`custom\` step's prompt_file is its whole body.`);
      }
      if ([...result.written, ...result.skipped].some((f) => f.entry.slug === "resolver")) {
        console.log(`\nresolver.md is the PR-watch resolver prompt — a reference copy; it isn't wired via a belt step's prompt_file.`);
      }
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("skill <action>")
  .description(
    "agent skill: `install` puts the shipped herdr-factory skill where a coding agent finds it — ~/.claude/skills/ by default (symlinked to this checkout, so auto-update keeps it current), or a target repo's .claude/skills/ with --into",
  )
  .option("--into <dir>", "install into a repo checkout (<dir>/.claude/skills/) instead of ~/.claude/skills/ — copied, so it can be committed")
  .option("--copy", "copy the bundle instead of symlinking it (a frozen snapshot; won't track auto-updates)")
  .option("--symlink", "symlink the bundle even for --into (tracks this checkout; not committable)")
  .option("--force", "replace a destination that already exists")
  .action(cliAction("skill", (action: string, opts: { into?: string; copy?: boolean; symlink?: boolean; force?: boolean }) => {
    try {
      if (action !== "install") fail(`unknown skill action "${action}" — use: install`);
      if (opts.copy && opts.symlink) fail("skill install: pass either --copy or --symlink, not both");
      let result;
      try {
        result = installSkill({
          into: opts.into,
          mode: opts.copy ? "copy" : opts.symlink ? "symlink" : undefined,
          force: opts.force,
        });
      } catch (e) {
        if (e instanceof SkillDestinationExistsError || e instanceof SkillBundleMissingError) fail(e.message);
        throw e;
      }
      if (result.action === "current") {
        console.log(`Skill already installed at ${result.dest} → ${result.source}`);
      } else {
        const verb = result.action === "replaced" ? "Replaced" : "Installed";
        const how = result.mode === "symlink" ? `symlink → ${result.source}` : `${result.files.length} file${result.files.length === 1 ? "" : "s"} copied from ${result.source}`;
        console.log(`${verb} the herdr-factory skill at ${result.dest} (${how})`);
      }
      if (result.mode === "copy") {
        console.log(`Re-run with --force after a factory update to refresh the copy (a symlink install tracks the checkout automatically).`);
      }
      console.log(`\nAsk your agent to "set up herdr-factory for this repo" — the skill runs the config interview, answers questions about the engine, and diagnoses a stuck factory.`);
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("step-done <key> <step>")
  .description("a belt agent signals it finished its step — event-nudges the dispatcher")
  .option("--source <name>", "the work source the run belongs to (passed by the agent)")
  .option("--pass <n>", "the step pass this signal belongs to (stamped into the rendered prompt command)")
  .action(cliAction("step-done", async (key: string, step: string, opts: { source?: string; pass?: string }) => {
    try {
      const d = await dispatchSignal(requireRepo(), "step-done", { key, step, source: opts.source, pass: opts.pass });
      signalRejected(key, d, "no active run");
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("ask-human <key> <step>")
  .description("a belt agent asks a human through the work source and pauses until a reply arrives")
  .option("--source <name>", "the work source the run belongs to (passed by the agent)")
  .option("--question <text>", "question text")
  .option("--question-file <path>", "file containing the question text")
  .action(cliAction("ask-human", async (key: string, step: string, opts: { source?: string; question?: string; questionFile?: string }) => {
    try {
      const question = humanQuestionText(opts);
      const d = await dispatchSignal(requireRepo(), "ask-human", { key, step, source: opts.source, question });
      if (signalRejected(key, d, "no active run")) return;
      if (d.queued) {
        // The durable intent is recorded; the next reconcile pass posts it. Nothing else to do.
        console.log(`${key}: ${d.message}`);
        return;
      }
      console.log(`${key}: waiting for human answer (question #${d.questionId}${d.posted ? "" : ", posting deferred"})`);
      if (d.message) console.log(d.message);
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("bounce <key> <toStep>")
  .description("a belt agent sends the work back to an earlier step for rework (with findings)")
  .option("--source <name>", "the work source the run belongs to (passed by the agent)")
  .option("--reason <text>", "why it's being sent back (the findings the earlier step must address)")
  .option("--reason-file <path>", "file containing the reason/findings")
  .option("--step <name>", "the issuing step (stamped into the rendered prompt command)")
  .option("--pass <n>", "the issuing step's pass this signal belongs to")
  .action(cliAction("bounce", async (key: string, toStep: string, opts: { source?: string; reason?: string; reasonFile?: string; step?: string; pass?: string }) => {
    try {
      const reason = bounceReasonText(opts);
      const d = await dispatchSignal(requireRepo(), "bounce", { key, toStep, source: opts.source, reason, step: opts.step, pass: opts.pass });
      if (signalRejected(key, d, "bounce failed")) return;
      if (d.queued) {
        // The durable intent is recorded; the next reconcile pass applies it. The agent can stop.
        console.log(`${key}: ${d.message}`);
        return;
      }
      if (d.escalated) {
        console.log(`${key}: ${d.message}`); // bounce limit hit → parked for attention, NOT sent back
        return;
      }
      console.log(`${key}: bounced to ${toStep}${d.message ? ` — ${d.message}` : ""}`);
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("capture-attempt <key> <step>")
  .description("an evidence agent signals the start of a capture attempt — the engine caps flaky-capture loops")
  .option("--source <name>", "the work source the run belongs to (passed by the agent)")
  .action(cliAction("capture-attempt", async (key: string, step: string, opts: { source?: string }) => {
    try {
      const d = await dispatchSignal(requireRepo(), "capture-attempt", { key, step, source: opts.source });
      if (signalRejected(key, d, "capture-attempt failed")) return;
      if (d.escalated) {
        console.log(`${key}: ${d.message}`); // cap hit → parked for attention, NOT cleared to capture
        return;
      }
      console.log(`${key}: capture attempt #${d.attempts} recorded`);
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("runs")
  .description("list runs for the repo")
  .option("--all", "include finished runs")
  .action(cliAction("runs", async (opts: { all?: boolean }) => {
    try {
      const deps = await buildDeps(requireRepo());
      for (const r of deps.store.listRuns(deps.config.repoName, !!opts.all)) {
        console.log(
          `#${String(r.id).padEnd(4)} ${r.ticketKey.padEnd(12)} ${r.phase.padEnd(12)} ${(r.outcome ?? "").padEnd(9)} PR:${r.prNumber ?? "-"} ${r.branch ?? ""}`,
        );
      }
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("timeline <key>")
  .description("show the event timeline for a ticket")
  .action(cliAction("timeline", async (key: string) => {
    try {
      const deps = await buildDeps(requireRepo());
      for (const ev of deps.store.timeline(deps.config.repoName, key)) {
        console.log(`${new Date(ev.ts * 1000).toISOString()}  ${ev.type}${ev.detail ? `  ${ev.detail}` : ""}`);
      }
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("explain <key>")
  .description("why the run is where it is — its clocks, retries, and what would move it")
  .option("--source <name>", "disambiguate when the key is active in more than one source")
  .action(cliAction("explain", async (key: string, opts: { source?: string }) => {
    try {
      const deps = await buildDeps(requireRepo());
      const repo = deps.config.repoName;
      const run = resolveActiveRun(deps, key, opts.source); // throws on cross-source ambiguity
      if (!run) {
        const last = deps.store.latestRunForTicket(repo, key);
        if (!last) {
          console.log(`${key}: no run recorded — \`eligible\` lists what is claimable, \`claim ${key}\` starts one`);
        } else {
          const when = last.endedAt ? `ended ${fmtDur(deps.now() - last.endedAt)} ago (${last.outcome ?? last.phase})` : `is in phase ${last.phase}`;
          console.log(`${key}: no active run — the newest run #${last.id} ${when}.`);
          console.log(`Next: herdr-factory --repo ${repo} timeline ${key}   # its full event history`);
        }
        return;
      }
      for (const line of explainRun({ ob: runObligations(deps, run), repoName: repo, now: deps.now() })) console.log(line);
      // The clocks and retries above only advance when something ticks the repo — say so when
      // nothing does, because "the backoff never fires" reads exactly like "the factory is stuck".
      const info = readServerInfo();
      const healthy = info ? await pingHealth(info.port) : false;
      if (!healthy) {
        console.log("");
        console.log(
          "note: no server is ticking this repo — every clock and retry above advances only when a tick runs (`herdr-factory start`, or `tick` for one pass).",
        );
      }
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("triage <key>")
  .description("open your agent CLI on a stuck run, pre-briefed with the engine's own diagnosis")
  .option("--source <name>", "disambiguate when the key is active in more than one source")
  .option("--print", "print the briefing instead of launching the agent")
  .action(cliAction("triage", async (key: string, opts: { source?: string; print?: boolean }) => {
    try {
      const deps = await buildDeps(requireRepo());
      const run = resolveActiveRun(deps, key, opts.source); // throws on cross-source ambiguity
      if (!run) {
        const last = deps.store.latestRunForTicket(deps.config.repoName, key);
        console.log(
          last
            ? `${key}: no active run to triage — the newest run #${last.id} ended (${last.outcome ?? last.phase}). \`timeline ${key}\` has its history.`
            : `${key}: no run recorded — nothing to triage`,
        );
        return;
      }
      await triageRun(deps, run, { print: !!opts.print });
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("capture-lock <action> <resource> [owner]")
  .description("machine-global exclusive-resource lock for a step's exclusive_resource guard (acquire|release)")
  .action(cliAction("capture-lock", async (act: string, resource: string, owner = "worker") => {
    try {
      const dbPath = globalDbPath();
      mkdirSync(dirname(dbPath), { recursive: true });
      const store = new Store(openDb(dbPath), systemClock);
      if (act === "acquire") {
        const deadline = Date.now() + 3_600_000;
        for (;;) {
          if (store.acquireLock(resource, owner, 1200)) {
            console.log(`${resource} lock acquired by ${owner}`);
            return;
          }
          if (Date.now() > deadline) fail(`timed out waiting for the ${resource} lock`);
          await new Promise((r) => setTimeout(r, 5000));
        }
      } else if (act === "release") {
        store.releaseLock(resource, owner);
        console.log(`${resource} lock released by ${owner}`);
      } else {
        fail("capture-lock: acquire|release <resource> [owner]");
      }
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("evidence-upload <key>")
  .description("publish this run's captured evidence via the configured `evidence.publisher` (s3 | local | command) + print the public URLs; retries in the background if delivery is deferred")
  .option("--source <name>", "the work source the run belongs to (passed by the agent)")
  .action(cliAction("evidence-upload", async (key: string, opts: { source?: string }) => {
    try {
      const repo = requireRepo();
      const deps = await buildDeps(repo);
      const ev = deps.config.evidence;
      if (!ev) {
        console.log("evidence-upload: no `evidence:` block configured for this repo — skipping publish (no URLs produced)");
        return;
      }
      const activeRun = resolveActiveRun(deps, key, opts.source);
      if (!activeRun?.worktreePath) {
        console.log(`${key}: no active run with a worktree — nothing to publish`);
        return;
      }
      const dir = join(activeRun.worktreePath, MEMORY_DIR, "evidence");
      const files = enumerateEvidenceFiles(dir);
      if (files.length === 0) {
        console.log("evidence-upload: no files in the evidence dir — nothing to publish");
        return;
      }
      // Key layout (uniform across publishers): herdr-factory / <github_username> / <key_prefix> /
      // <ticketKey> / <runId>-<timestamp>. The per-user folder namespaces operators in a shared backend;
      // username = the config override, else the gh-authenticated login (best-effort). The run id +
      // timestamp mean a re-capture (e.g. after a bounce) never overwrites an earlier publish.
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const githubUsername = await resolveGithubUsername(ev, () => deps.github.currentLogin());
      if (!githubUsername) {
        console.log("evidence-upload: could not resolve github_username (set evidence.github_username or authenticate gh) — publishing under herdr-factory/ with no per-user folder");
      }
      const prefix = evidenceKeyPrefix({ githubUsername, keyPrefix: ev.keyPrefix, ticketKey: activeRun.ticketKey, runId: activeRun.id, stamp });
      const publisher = createEvidencePublisher(ev, { currentLogin: () => deps.github.currentLogin() });

      // Enqueue the publish as a durable LEDGER intent (persisting `prefix` so retry URLs stay
      // stable), then print the deterministic URLs UP FRONT so the handoff/PR get correct links
      // regardless of whether delivery lands now. Latest-wins: a re-capture (different prefix)
      // supersedes the run's earlier undelivered publishes. The lease keeps the server's Phase-0
      // flush from claiming the row while the inline attempt below is mid-upload; a failed inline
      // attempt clears it. The `command` publisher can't pre-compute URLs (they come from its
      // stdout) — its links print only after a successful publish below.
      const job = deps.store.enqueueIntent({
        repo,
        kind: evidencePublishKind.kind,
        scope: `run:${activeRun.id}`,
        runId: activeRun.id,
        ticketKey: activeRun.ticketKey,
        dedupKey: prefix,
        payload: JSON.stringify({ keyPrefix: prefix, evidenceDir: dir }),
        causeScope: `publisher:${ev.publisher}`,
        leaseUntil: deps.now() + EVIDENCE_PUBLISH_LEASE_SECONDS,
        supersedeScope: true,
      });
      const predicted = publisher.predictUrls(prefix, files);
      if (predicted) {
        console.log("public URLs (use these in your handoff even if delivery is deferred — they resolve once the bytes land):");
        for (const url of predicted) console.log(url);
      }

      // Inline fast path: publish now (the common success case). On failure DON'T hard-fail — the
      // ledger owns retry from here, so the agent proceeds (with the URLs above, for s3/local).
      try {
        const { urls } = await publisher.publish({ dir, prefix });
        deps.store.markIntentDelivered(job.id);
        if (!predicted) {
          console.log("public URLs (use these in your handoff):");
          for (const url of urls) console.log(url);
        }
        console.log(`published ${files.length} evidence file(s) via ${ev.publisher}`);
      } catch (e) {
        const c = publisher.classifyError(e);
        if (c.kind === "permanent") {
          deps.store.markIntentFailed(job.id, c.reason);
          console.log(`evidence-upload: publish FAILED (config error) — ${c.reason}. Run \`herdr-factory --repo ${repo} doctor --deep\`.${predicted ? " The URLs above will not resolve until this is fixed." : ""}`);
        } else {
          deps.store.recordIntentAttempt(job.id, c.reason, c.kind, intentRetryDelay(evidencePublishKind, job));
          const tail = predicted ? "the URLs above resolve once it lands." : "URLs will appear in the server logs once it lands (a `command` publisher can't pre-compute links).";
          console.log(`evidence-upload: publish deferred — ${c.reason}. The engine will retry automatically; ${tail}`);
        }
      }
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("serve")
  .description("run the resident server: tick every configured repo + expose the HTTP API (kept alive by the supervisor)")
  .action(cliAction("serve", async () => {
    residentCommand = true;
    try {
      await serve();
    } catch (e) {
      fail(e);
    }
  }));


program
  .command("ensure-up")
  .description("[supervisor] one-shot: (re)start the server if it's down/wedged/outdated, then exit (what launchd schedules)")
  .option("--restart", "force a graceful restart even if the server is healthy")
  .action(cliAction("ensure-up", async (opts: { restart?: boolean }) => {
    try {
      const { action } = await ensureUp({ force: opts.restart }, consoleLog);
      console.log(`ensure-up: ${action}`);
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("restart")
  .description("gracefully restart the running server (picks up new code after a pull)")
  .action(cliAction("restart", async () => {
    try {
      const { action } = await ensureUp({ force: true }, consoleLog);
      console.log(`restart: ${action}`);
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("update")
  .description("pull the latest code (hard reset to the channel target: upstream on main, newest release tag on stable) and restart onto it")
  .action(cliAction("update", async () => {
    try {
      const res = await selfUpdate(consoleLog);
      if (!res.updated) {
        console.log(`no update: ${res.reason}`);
        return;
      }
      console.log(`updated ${res.from?.slice(0, 12)} → ${res.to?.slice(0, 12)}; restarting server`);
      const { action } = await ensureUp({ force: true, skipAutoUpdate: true }, consoleLog);
      console.log(`restart: ${action}`);
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("provision-node")
  .description("download + verify the pinned Node (from .node-version) into <state>/runtime and point `current` at it")
  .action(cliAction("provision-node", async () => {
    try {
      const res = await provisionNode(pinnedNodeVersion(), consoleLog);
      console.log(`node ${res.version} ${res.changed ? "provisioned (current → this)" : "already current"} at ${res.nodePath}`);
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("reload")
  .description("hot-reload config: the running server re-reads every repo's config + re-discovers repos (no restart)")
  .action(cliAction("reload", async () => {
    try {
      const data = await serverFetch("POST", "/reload") as { repos?: string[]; failures?: { name: string; error: string }[] };
      const repos = data.repos ?? [];
      console.log(`reloaded — serving: ${repos.join(", ") || "(no repos)"}`);
      // A repo can fail to reload — e.g. the belt-removal guard refusing to drop a belt that still
      // has work in progress (it keeps running the old config). Surface it; it isn't a clean reload.
      for (const f of data.failures ?? []) console.log(`  ⚠ ${f.name}: ${f.error}`);
    } catch (e) {
      if (e instanceof NoServerError) {
        console.log("no server running — config is read fresh on the next `serve` start (try `herdr-factory start`)");
        return;
      }
      fail(e);
    }
  }));

program
  .command("init")
  .description("scaffold a repo config from inside the repo: writes ~/.config/herdr-factory/repos/<name>/config.yml (name defaults to --repo, else the checkout's dir name), inferring the repo path + github owner/name from the current checkout")
  .option("--source <type>", "work source to scaffold: jira | github_issues | local_markdown | sentry (default: github_issues if the origin resolves, else local_markdown)")
  .option("--path <dir>", "the repo checkout to point at (default: the git top-level of the current directory)")
  .option("--force", "overwrite an existing config.yml")
  .action(cliAction("init", async (opts: { source?: string; path?: string; force?: boolean }) => {
    try {
      const SOURCES: SourceType[] = ["jira", "github_issues", "local_markdown", "sentry"];
      if (opts.source && !SOURCES.includes(opts.source as SourceType)) {
        fail(`unknown --source "${opts.source}" — use one of: ${SOURCES.join(" | ")}`);
      }
      const repoName = (program.opts() as { repo?: string }).repo;
      const res = await initRepo({ repoName, source: opts.source as SourceType | undefined, path: opts.path, force: opts.force });
      console.log(`scaffolded repo "${res.repoName}" (${res.source}${res.ghRepo ? `, origin ${res.ghRepo}` : ""}) at:`);
      console.log(`  config: ${res.configPath}`);
      if (res.envPath) console.log(`  secrets: ${res.envPath}`);
      console.log(`  schema: ${res.schemaPath}`);
      console.log("");
      console.log("next steps:");
      for (const step of res.nextSteps) console.log(`  • ${step}`);
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("schema")
  .description("write the config.yml JSON Schema (editor autocomplete + validation) to <configDir>/config.schema.json")
  .option("--stdout", "print the schema to stdout instead of writing the file")
  .action(cliAction("schema", (opts: { stdout?: boolean }) => {
    try {
      if (opts.stdout) {
        console.log(JSON.stringify(configJsonSchema(), null, 2));
        return;
      }
      console.log(`wrote ${writeConfigSchema()}`);
      console.log("add this first line to a repo's config.yml so your editor uses it:");
      console.log("  # yaml-language-server: $schema=../../config.schema.json");
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("install")
  .description("install the machine-wide supervisor (one launchd job that keeps the server up for all repos)")
  .action(cliAction("install", async () => {
    try {
      writeConfigSchema(); // keep the editor schema current with this version's config shape
      await service.install();
      await ensureUp({}, consoleLog);
      console.log(`installed + loaded ${service.label()} — scheduled ensure-up keeps the server serving all configured repos`);
      console.log(`config schema at ${configSchemaPath()} (reference it with: # yaml-language-server: $schema=../../config.schema.json)`);
      // The onboarding pointer chain (see src/onboarding.ts). Suppressed when install.sh invokes this
      // (HERDR_FROM_INSTALLER): the installer's epilogue runs `doctor`, whose own pointer is the
      // context-aware forward link ("fix your ✗ tools" on a fresh box vs "point it at a repo").
      if (!process.env.HERDR_FROM_INSTALLER) {
        console.log("");
        console.log(afterInstallHint());
      }
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("uninstall")
  .description("remove the supervisor job and stop the server (in-flight workers untouched)")
  .action(cliAction("uninstall", async () => {
    try {
      await service.uninstall();
      await stopServer(consoleLog);
      console.log(`uninstalled ${service.label()}`);
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("start")
  .description("load the supervisor job (and bring the server up)")
  .action(cliAction("start", async () => {
    try {
      await service.start();
      await ensureUp({}, consoleLog);
      console.log(`started ${service.label()}`);
      console.log(afterStartHint()); // onboarding pointer chain — see src/onboarding.ts
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("stop")
  .description("unload the supervisor job and stop the server (workers keep running)")
  .action(cliAction("stop", async () => {
    try {
      await service.stop();
      await stopServer(consoleLog);
      console.log(`stopped ${service.label()}`);
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("logs [n]")
  .description("tail today's log for the repo")
  .action(cliAction("logs", async (n?: string) => {
    try {
      const deps = await buildDeps(requireRepo());
      const file = join(deps.config.paths.logsDir, `${today()}.log`);
      if (!existsSync(file)) {
        console.log(`no log for today at ${file}`);
        return;
      }
      const lines = readFileSync(file, "utf8").split("\n");
      console.log(lines.slice(-(Number(n) || 50)).join("\n"));
    } catch (e) {
      fail(e);
    }
  }));

program
  .command("doctor")
  .description("health check: local + presence by default; --deep also interacts with services (gh auth, work-source health, evidence-bucket write). Add --repo <name> for repo-specific checks")
  .option("--deep", "also interact with external services: gh auth, work-source health, and an evidence-bucket write probe (network + a tiny S3 write)")
  .action(cliAction("doctor", async (opts: { deep?: boolean }) => {
    const deep = opts.deep ?? false;
    const repo = (program.opts() as { repo?: string }).repo;
    const groups = await baseGroups(deep);
    if (repo) groups.push(await repoGroup(repo, deep));
    let failed = false;
    groups.forEach((g, i) => {
      if (i > 0) console.log("");
      failed = printDoctorGroup(g) || failed;
    });
    // The onboarding pointer chain (see src/onboarding.ts): one context-aware forward link, folding
    // in the old shallow/no-repo nudges — ✗ → resolve & re-run; ✓ + shallow repo → deep repo doctor;
    // ✓ + deep repo → first run; ✓ + no repo → point it at a repo with `init`.
    console.log("");
    console.log(afterDoctorHint({ repo, deep, failed }));
    if (failed) process.exitCode = 1; // so scripts/CI can gate on a clean doctor
  }));

program
  .parseAsync()
  .then(async () => {
    if (!residentCommand) await shutdownRuntimes();
  })
  .catch(async (e) => {
    await shutdownRuntimes();
    fail(e);
  });
