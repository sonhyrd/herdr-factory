// Issue #88: the PR-watch resolver runs on the WORK step's agent, never the pr step's. Review fixes
// are implementation work; the pr step is often a cheap, fast model that only opens the PR. Here the
// two steps run DIFFERENT harnesses — work = `claude --hf-work-b` (B), pr = `opencode --hf-pr-a` (A) —
// so a wake that landed on the pr pane, or a spawn with the pr step's argv, is visible in the trace:
//
//   * work pane ALIVE: a new review thread re-prompts the work pane with the resolver prompt (not the
//     pr pane), and the run's pane follows it so idle detection reads the pane actually resolving;
//   * work pane DEAD: the next thread spawns a fresh resolver with B's kind + flags (not A's), and that
//     pane becomes the work step's pane (its stale session cleared);
//   * either way the resolving pane is published `hf_state=watching`.
import { expect } from "vitest";
import { scenario } from "../harness/index.ts";
import { flagValueFrom } from "../harness/herdr.ts";

scenario(
  {
    name: "resolver-work-agent",
    lane: "real",
    timeoutMs: 300_000,
    briefs: { "resolve-me": "# Resolve me\n\nReview fixes belong to the work agent.\n" },
    config: (p) => ({
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      belt: [
        {
          name: "shipping",
          source: "briefs",
          workspace_name: "w/{{work_id}}",
          steps: [
            { type: "work", agent: { command: "claude", flags: ["--hf-work-b"] } },
            { type: "pr", agent: { command: "opencode", flags: ["--hf-pr-a"] } },
          ],
        },
      ],
    }),
  },
  async (w) => {
    const key = "resolve-me";
    await w.waitForPhase(key, "reviewing", { label: "the pr step opens a ready PR and hands off to the watch", timeoutMs: 150_000 });
    const run = w.db.run(key)!;
    const pr = run.pr_number!;
    const workPane = w.db.step(run.id, "work")!.pane_id!;
    const prPane = w.db.step(run.id, "pr")!.pane_id!;
    expect(workPane, "the two steps ran in different panes").not.toBe(prPane);

    const resolverPrompts = () =>
      w.herdr.calls().filter((c) => c.argv[0] === "agent" && c.argv[1] === "prompt" && c.argv.some((a) => a.includes("prompt-resolver.md")));
    const watching = (pane: string) =>
      w.herdr.paneMetadata().some((m) => m.paneId === pane && m.argv.includes("hf_state=watching"));
    const wakes = () => w.db.events(key).filter((e) => e.type === "resolver_woken").length;

    // ── work pane alive: re-prompt it ─────────────────────────────────────────────────────────
    w.gh.addUnresolvedThread(pr);
    await w.waitFor(() => wakes() === 1, { label: "a review thread wakes the resolver", timeoutMs: 120_000 });
    const sent = resolverPrompts();
    expect(sent.length, "the resolver was re-prompted into a live pane, not spawned").toBe(1);
    expect(sent[0]!.argv[2], "…into the WORK step's pane").toBe(workPane);
    expect(sent[0]!.argv[2], "…never the pr step's").not.toBe(prPane);
    expect(w.db.run(key)!.pane_id, "run.pane_id follows the pane actually resolving").toBe(workPane);
    expect(watching(workPane), "the resolving pane is shown `watching`").toBe(true);

    w.gh.resolveAllThreads(pr);
    await w.waitFor(() => w.db.run(key)?.resolver_active === 0, { label: "the resolver goes idle", timeoutMs: 120_000 });

    // ── work pane dead: spawn with the work step's harness ────────────────────────────────────
    const closed = w.herdr.cli(["pane", "close", workPane]);
    expect(closed.code, `pane close failed: ${closed.stderr}`).toBe(0);
    w.gh.addUnresolvedThread(pr);
    await w.waitFor(() => wakes() === 2, { label: "the next thread wakes a fresh resolver", timeoutMs: 120_000 });

    const row = w.db.step(run.id, "work")!;
    const spawned = row.pane_id!;
    expect(spawned, "the fresh resolver is recorded as the work step's pane").not.toBe(workPane);
    expect(spawned).not.toBe(prPane);
    expect(row.session_id, "…with the dead pane's session cleared").toBeNull();
    expect(w.db.run(key)!.pane_id, "…and run.pane_id follows it").toBe(spawned);

    const start = w.herdr.calls().find((c) => c.argv[0] === "agent" && c.argv[1] === "start" && flagValueFrom(c.argv, "--pane") === spawned);
    expect(start, "the resolver pane was started through `agent start`").toBeDefined();
    const argv = start!.argv;
    expect(flagValueFrom(argv, "--kind"), "B's kind (the work step's command)").toBe("claude");
    const args = argv.slice(argv.indexOf("--") + 1);
    expect(args[0], "B's flags lead the spawned argv").toBe("--hf-work-b");
    expect(argv, "none of A's (the pr step's) harness").not.toContain("--hf-pr-a");
    expect(args.join("\n")).toContain("prompt-resolver.md");
    expect(watching(spawned), "the spawned resolver is shown `watching`").toBe(true);

    w.gh.resolveAllThreads(pr);
    w.gh.merge(pr);
    await w.waitForEnd(key, "merged", { label: "the merge tears the run down", timeoutMs: 120_000 });
  },
);
