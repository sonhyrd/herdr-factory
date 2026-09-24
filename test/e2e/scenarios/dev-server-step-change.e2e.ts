// Issue #98: a work step's dev server must not outlive the STEP, nor hold its port through a park.
// teardown-dev-server (#48) proves the reap once the run is over; these prove it while the run —
// and its worktree — are still live: after the work step's step-done, and after an ask-human park.
//
// Nothing below the factory is mocked. The WORK AGENT itself starts the server, the way a real one
// runs `pnpm dev`: `scripts/dev-listener.cjs` (committed into the target repo) spawns a detached
// listener — its own process group, cwd in the worktree — on an ephemeral port and performs the
// hf-port handshake, then the agent signals. So the listener is up at the moment of the signal, and
// only the engine's kill can take it down before the next step starts.
//
// Two scenarios, one file:
//   - dev-server-step-change: `port-brief` → the listener is dead once the run is on `pr`, worktree
//     still there; `noport-brief` (the launcher skips it) → reaches `pr` and merges with no kill.
//   - dev-server-park: `park-brief` asks a human → the parked run holds no listener.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { expectNoPendingIntents, scenario, type World } from "../harness/index.ts";

const brief = (title: string) => ["---", `title: ${title}`, "type: task", "---", `# ${title}`, "", "## Acceptance criteria", "- `work/hello.txt` exists", ""].join("\n");

// The target repo's "dev server": a detached listener that writes `<pid> <port>` to <git dir>/hf-listener
// (for the scenario) and then its port to <git dir>/hf-port (the handshake). Returns once hf-port
// exists. A worktree whose path names `noport` gets no server at all.
const LAUNCHER = [
  'const { spawn, execFileSync } = require("node:child_process");',
  'const { existsSync } = require("node:fs");',
  'if (process.cwd().includes("noport")) process.exit(0);',
  'const gd = execFileSync("git", ["rev-parse", "--absolute-git-dir"], { encoding: "utf8" }).trim();',
  'const src = "const fs=require(\'node:fs\'),s=require(\'node:net\').createServer().listen(0,()=>{" +',
  '  "fs.writeFileSync(" + JSON.stringify(gd + "/hf-listener") + ",process.pid+\' \'+s.address().port);" +',
  '  "fs.writeFileSync(" + JSON.stringify(gd + "/hf-port") + ",s.address().port+\'\\\\n\')})";',
  'spawn(process.execPath, ["-e", src], { detached: true, stdio: "ignore" }).unref();',
  "const until = Date.now() + 15000;",
  'while (!existsSync(gd + "/hf-port") && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);',
  "",
].join("\n");

const START_SERVER = "node scripts/dev-listener.cjs";

/** The worktree's own git dir, the way production reads it (NOT the code under test). */
function gitDirOf(worktree: string, env: Record<string, string>): string {
  const r = spawnSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: worktree, encoding: "utf8", env });
  expect(r.status, `git rev-parse --absolute-git-dir in ${worktree}: ${r.stderr}`).toBe(0);
  return r.stdout.trim();
}

/** pids LISTENing on a port, straight from `lsof` — the operator's own check from the issue. */
function listenersOn(port: number): number[] {
  const r = spawnSync("lsof", ["-nP", "-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  return (r.stdout ?? "")
    .split("\n")
    .map((l) => Number.parseInt(l.trim(), 10))
    .filter((n) => Number.isInteger(n));
}

/** Gone, or a zombie nobody has reaped yet (the launcher that spawned it exited long ago). */
function dead(pid: number): boolean {
  const r = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
  const stat = (r.stdout ?? "").trim();
  return stat === "" || stat.startsWith("Z");
}

async function worktreeOf(w: World, key: string): Promise<string> {
  await w.waitFor(() => !!w.db.run(key)?.worktree_path, { label: `${key}: worktree created` });
  return w.db.run(key)!.worktree_path!;
}

/** Wait for the run's `dev_server_stopped`, then prove the listener it names is really gone — while
 *  the worktree is still there (a dead worktree would only re-prove #48). */
async function expectServerStopped(w: World, key: string, worktree: string, why: string): Promise<void> {
  await w.waitFor(() => !!w.db.event(key, "dev_server_stopped"), { label: `${key}: dev_server_stopped (${why})`, timeoutMs: 120_000 });
  const [pid, port] = readFileSync(join(gitDirOf(worktree, w.env), "hf-listener"), "utf8").trim().split(" ").map(Number) as [number, number];
  const ev = w.db.event(key, "dev_server_stopped")!.data;
  expect(ev, "the event names the port, the pid that held it, its RSS and why").toMatchObject({ port, why });
  expect(ev.pids as number[], `pid ${pid} was listening when the engine looked`).toContain(pid);
  expect(typeof ev.rssKb).toBe("number");
  await w.waitFor(() => listenersOn(port).length === 0, { label: `nothing LISTENs on :${port} (pid ${pid} held it)`, timeoutMs: 30_000 });
  await w.waitFor(() => dead(pid), { label: `pid ${pid} exited`, timeoutMs: 10_000 });
  expect(existsSync(worktree), "the worktree is still live — this is a step change, not a teardown").toBe(true);
  expect(w.db.run(key)!.ended_at, "the run has not ended").toBeNull();
  expect(w.factory.repoLog(400)).toMatch(new RegExp(`dev server port ${port} \\(${why}\\) — killed pid\\(s\\) [0-9, ]*${pid}`));
}

scenario(
  {
    name: "dev-server-step-change",
    briefs: { "port-brief": brief("Stop the dev server at step-done"), "noport-brief": brief("No port file") },
    repoFiles: { "scripts/dev-listener.cjs": LAUNCHER },
    config: (p) => ({
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      belt: [{ name: "briefs-to-prs", source: "briefs", workspace_name: "d/{{work_id}}", steps: [{ type: "work" }, { type: "pr" }] }],
    }),
    agent: { steps: { work: { run: [START_SERVER] } } },
  },
  async (w) => {
    const worktree = await worktreeOf(w, "port-brief");
    const bareWorktree = await worktreeOf(w, "noport-brief");

    // ── step-done: the work step's server is dead before `pr` runs, on a live worktree ──────────
    await w.waitFor(() => w.db.run("port-brief")?.step === "pr", { label: "port-brief: work → pr", timeoutMs: 120_000 });
    await expectServerStopped(w, "port-brief", worktree, "step-done");

    // ── no hf-port: transitions exactly as before ─────────────────────────────────────────────
    await w.waitFor(() => w.db.run("noport-brief")?.step === "pr", { label: "noport-brief: work → pr", timeoutMs: 120_000 });
    expect(existsSync(join(gitDirOf(bareWorktree, w.env), "hf-port")), "no hf-port for this run").toBe(false);

    for (const key of ["port-brief", "noport-brief"]) {
      await w.waitFor(() => (w.db.run(key)?.pr_number ?? 0) > 0, { label: `${key}: PR opened`, timeoutMs: 150_000 });
      w.gh.merge(w.db.run(key)!.pr_number!);
    }
    await w.waitForEnd("port-brief", "merged", { label: "the reserved-port run merges", timeoutMs: 150_000 });
    await w.waitForEnd("noport-brief", "merged", { label: "the no-port run merges", timeoutMs: 150_000 });
    expect(w.db.eventTypes("noport-brief"), "no port ⇒ nothing stopped").not.toContain("dev_server_stopped");
    expectNoPendingIntents(w);
  },
);

scenario(
  {
    name: "dev-server-park",
    briefs: { "park-brief": brief("Stop the dev server when the run parks") },
    repoFiles: { "scripts/dev-listener.cjs": LAUNCHER },
    config: (p) => ({
      limits: { step_budget_seconds: 600 },
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      belt: [{ name: "asking", source: "briefs", workspace_name: "d/{{work_id}}", steps: [{ type: "work" }] }],
    }),
    agent: { steps: { work: { run: [START_SERVER], signal: "ask-human", text: "Blue or green?" } } },
  },
  async (w) => {
    const key = "park-brief";
    const worktree = await worktreeOf(w, key);

    // ── a parked run holds no listener ────────────────────────────────────────────────────────
    await w.waitFor(() => w.db.run(key)?.phase === "waiting_for_human", { label: "the agent asks and the run parks", timeoutMs: 90_000 });
    await expectServerStopped(w, key, worktree, "waiting for a human");

    // Answer, and let the resumed step finish (without starting another server).
    w.setAgentScript({ steps: { work: { signal: "step-done" } } });
    w.answerHumanQuestion(key, "Blue.");
    w.db.dueNow("human_reply_poll", w.db.run(key)!.id);
    await w.waitForEnd(key, "completed", { label: "the answered run finishes", timeoutMs: 120_000 });
  },
);
