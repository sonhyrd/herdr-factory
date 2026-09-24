// Issue #48, criterion 1 as a factory lifecycle: a completed run's teardown leaves no listener on
// the port its worktree reserved. Nothing below the factory is mocked — a real herdr worktree, a
// real `serve` doing the teardown, a real `lsof`, and a real process holding a real TCP port.
//
// The listener is a bare `net.createServer()` rather than a dev server: what matters is the SHAPE,
// not the framework. It is spawned `detached` so it owns its process group (the reparented
// pnpm→server orphan the issue measured), with its cwd inside the worktree that is about to be
// destroyed — so if teardown signalled the wrong thing, or nothing, the port would still be held
// after the run ended.
//
// Two briefs, two beats, one world:
//   - `port-brief`  — hf-port present → the listener and its port are gone after teardown.
//   - `noport-brief`— hf-port absent  → teardown still reaches `merged` with the worktree reaped
//                                       (criterion 4, as a lifecycle rather than a unit test).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { expectNoPendingIntents, scenario, type World } from "../harness/index.ts";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const brief = (title: string) => ["---", `title: ${title}`, "type: task", "---", `# ${title}`, "", "## Acceptance criteria", "- `work/hello.txt` exists", ""].join("\n");

/** The worktree's own git dir, the way production reads it — `git rev-parse --absolute-git-dir`
 *  inside the linked worktree (its `.git` is a FILE pointing here, which is the shape the engine
 *  has to resolve). Deliberately NOT the code under test. */
function gitDirOf(worktree: string, env: Record<string, string>): string {
  const r = spawnSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: worktree, encoding: "utf8", env });
  expect(r.status, `git rev-parse --absolute-git-dir in ${worktree}: ${r.stderr}`).toBe(0);
  return r.stdout.trim();
}

/** A process LISTENing on an ephemeral TCP port with its cwd inside the worktree, in its OWN
 *  process group. Resolves once it reports `<pid> <port>`. */
async function spawnListener(cwd: string): Promise<{ child: ChildProcess; pid: number; port: number; exited: Promise<void> }> {
  const src = "const s=require('node:net').createServer().listen(0,()=>console.log(process.pid,s.address().port))";
  const child = spawn(process.execPath, ["-e", src], { cwd, stdio: ["ignore", "pipe", "ignore"], detached: true });
  let onExit = (): void => undefined;
  const exited = new Promise<void>((resolve) => {
    onExit = resolve;
  });
  child.once("exit", () => onExit());
  const line = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("the dummy listener never reported its port")), 15_000);
    child.stdout!.once("data", (b: Buffer) => {
      clearTimeout(t);
      resolve(String(b));
    });
  });
  const [pid, port] = line.trim().split(/\s+/).map((n) => Number.parseInt(n, 10)) as [number, number];
  expect(Number.isInteger(pid) && Number.isInteger(port), `listener reported "${line.trim()}"`).toBe(true);
  return { child, pid, port, exited };
}

/** pids LISTENing on a port, straight from `lsof` — the operator's own check from the issue. */
function listenersOn(port: number): number[] {
  const r = spawnSync("lsof", ["-nP", "-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
  return (r.stdout ?? "")
    .split("\n")
    .map((l) => Number.parseInt(l.trim(), 10))
    .filter((n) => Number.isInteger(n));
}

/** Claim → PR → merge → ended, for one brief. Returns the run's worktree once it exists. */
async function worktreeOf(w: World, key: string): Promise<string> {
  await w.waitFor(() => !!w.db.run(key)?.worktree_path, { label: `${key}: worktree created` });
  const worktree = w.db.run(key)!.worktree_path!;
  expect(existsSync(worktree), `${worktree} exists while the run is live`).toBe(true);
  return worktree;
}

scenario(
  {
    name: "teardown-dev-server",
    briefs: { "port-brief": brief("Reap the dev server"), "noport-brief": brief("No port file") },
    config: (p) => ({
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      belt: [
        {
          name: "briefs-to-prs",
          source: "briefs",
          workspace_name: "{{semantic_work_prefix}}/{{work_id}}-{{work_full_slug}}",
          steps: [{ type: "work" }, { type: "pr" }],
        },
      ],
    }),
    agent: { default: { signal: "step-done" } },
  },
  async (w) => {
    // ── the run that reserved a port ──────────────────────────────────────────────────────────
    const worktree = await worktreeOf(w, "port-brief");
    const listener = await spawnListener(worktree);
    const gitDir = gitDirOf(worktree, w.env);
    // The handshake the target repo performs (one `echo`), here from the scenario because a public
    // checkout carries no tenant dev-server command.
    writeFileSync(join(gitDir, "hf-port"), `${listener.port}\n`);
    expect(listenersOn(listener.port), "the listener holds its port while the run is live").toContain(listener.pid);

    // ── the run with no hf-port at all (criterion 4) ──────────────────────────────────────────
    const bareWorktree = await worktreeOf(w, "noport-brief");
    expect(existsSync(join(gitDirOf(bareWorktree, w.env), "hf-port")), "no hf-port for this run").toBe(false);

    // ── drive both to merge ───────────────────────────────────────────────────────────────────
    for (const key of ["port-brief", "noport-brief"]) {
      await w.waitFor(() => (w.db.run(key)?.pr_number ?? 0) > 0, { label: `${key}: PR opened`, timeoutMs: 150_000 });
      w.gh.merge(w.db.run(key)!.pr_number!);
    }
    await w.waitForEnd("port-brief", "merged", { label: "the reserved-port run tears down", timeoutMs: 150_000 });
    await w.waitForEnd("noport-brief", "merged", { label: "the no-port run tears down", timeoutMs: 150_000 });

    // ── criterion 1: the dev server died with its run ─────────────────────────────────────────
    // Waited on rather than asserted once: teardown's own kill is TERM → grace → KILL, so the port
    // frees a beat after the run ends. A reap that never happens fails here by name (a bare
    // `await exited` would have failed as an opaque scenario timeout instead).
    await w.waitFor(() => listenersOn(listener.port).length === 0, {
      label: `nothing LISTENs on :${listener.port} after teardown (pid ${listener.pid} held it)`,
      timeoutMs: 30_000,
    });
    await Promise.race([listener.exited, delay(10_000)]); // the process itself is gone, not just its socket
    expect(listener.child.exitCode ?? listener.child.signalCode, `pid ${listener.pid} exited`).not.toBeNull();
    expect(existsSync(worktree), "the worktree is gone").toBe(false);
    expect(w.factory.repoLog(400), "teardown says which port it reaped").toMatch(
      new RegExp(`dev server port ${listener.port} \\(teardown\\) — killed pid\\(s\\) [0-9, ]*${listener.pid}`),
    );

    // ── criterion 4: no hf-port is not a teardown failure ─────────────────────────────────────
    const bare = w.db.run("noport-brief")!;
    expect(bare.outcome).toBe("merged");
    expect(existsSync(bareWorktree), "the no-port run's worktree is gone too").toBe(false);
    expect(w.branchExists(bare.branch!), `local branch ${bare.branch} deleted`).toBe(false);
    expectNoPendingIntents(w);
  },
);
