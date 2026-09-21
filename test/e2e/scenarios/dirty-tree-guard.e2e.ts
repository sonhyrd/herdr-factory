// A step that never commits is pinned to the tree it was given (issue #66). The incident: an agent
// left an edit UNCOMMITTED after its step_done, and the next step — which only films or reads —
// passed judgement on code that was already gone. Nothing in the engine looked at the worktree;
// `step-done` and step spawn only ever read the run row.
//
// The unit tests inject a dirty stat into a fake GitClient. This proves it against REAL git, a real
// worktree and the real CLI, in both directions:
//
//   1. SPAWN — the work agent leaves an uncommitted edit behind (exactly the incident). The advance
//      into the read-only gate parks the run `dirty_tree` with the diff stat, and the gate is never
//      dispatched: nothing further happens on a dirty tree.
//   2. STEP-DONE — the gate itself edits without committing. Its `step-done` exits 1 with the diff
//      stat, the step stays not-done, and the belt does not advance on a stale verdict.
//
// `read-only-violation` is deliberately NOT this: it is a gate that COMMITS (HEAD moves), parks
// `read_only_violation`, and is auto-rescued by its own step-done. Different code, different park,
// opposite rescue.
import { expect } from "vitest";
import { expectParked, scenario } from "../harness/index.ts";

/** An uncommitted edit to a TRACKED file. `.memory/` is gitignored in the harness target repo, so
 *  dirtying anything under it would prove nothing — `git status --porcelain` would stay empty. */
const LEAVE_EDIT_BEHIND = ["printf 'a narrow-viewport tweak nobody committed\\n' >> README.md"];

scenario(
  {
    name: "dirty-tree-guard",
    timeoutMs: 300_000,
    briefs: { "left-it-dirty": "# Left it dirty\n\nThe work agent edits a file and forgets to commit it.\n" },
    config: (p) => ({
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      belt: [{ name: "gated", source: "briefs", workspace_name: "d/{{work_id}}", steps: [{ type: "work" }, { type: "review" }] }],
    }),
    // The work agent commits its change and THEN leaves an extra edit uncommitted — the 12:27 of the
    // incident, made deterministic (the edit lands before its own step-done, so there is no race with
    // the advance).
    agent: { steps: { work: { run: LEAVE_EDIT_BEHIND }, review: { commit: false } } },
  },
  async (w) => {
    const key = "left-it-dirty";
    const run = () => w.db.run(key)!;

    // ── 1. the gate is never STARTED on a dirty tree ──────────────────────────────────────────
    await w.waitFor(() => run()?.phase === "attention", { label: "the advance into the gate refuses the dirty tree", timeoutMs: 120_000 });
    expectParked(w, key, "dirty_tree");
    const id = run().id;

    expect(w.db.step(id, "work")!.done, "the work step legitimately finished").toBe(1);
    expect(run().step, "the run stays on the completed step, so a resume re-runs the advance").toBe("work");
    expect(w.db.step(id, "review")?.dispatched_at ?? null, "the gate was never dispatched").toBeNull();
    // …not even a spawn attempt: no second agent ever saw this tree.
    const spawned = w.db.events(key).filter((e) => e.type === "step_spawned").map((e) => String(JSON.parse(e.detail ?? "{}").step));
    expect(spawned, "only the work step was ever spawned").toEqual(["work"]);

    // The park carries the evidence a human needs to decide whose edit it is.
    const parked = w.db.event(key, "attention", "first")!;
    expect(parked.data.step).toBe("review");
    expect(String(parked.data.why)).toContain("uncommitted changes");
    expect(String(parked.data.stat), "the diff stat names the dirty file").toContain("README.md");

    // ── 2. resume once the tree is clean: the same advance now goes through ───────────────────
    w.git(["checkout", "--", "README.md"], run().worktree_path!);
    expect(w.git(["status", "--porcelain"], run().worktree_path!), "the worktree is clean again").toBe("");
    // The resume re-prompts the idle WORK agent, which takes another turn — so take the edit out of
    // its script first, or it would dirty the tree again and re-park on the same cycle. Its second
    // step-done is an idempotent no-op (the step is already done).
    // `signal: "none"` on work: the advance may beat its second turn, and a step-done arriving after
    // the run has moved to the gate is a (correctly) rejected signal the agent would then retry.
    w.setAgentScript({ steps: { work: { commit: false, signal: "none" }, review: { commit: false, run: LEAVE_EDIT_BEHIND } } });
    await w.resumeUntilNudged(key);
    await w.waitFor(() => w.db.step(id, "review")?.dispatched_at != null, { label: "the gate starts once the tree is clean", timeoutMs: 120_000 });

    // ── 3. …and the gate's own step-done is refused when IT dirties the tree ──────────────────
    // The gate agent edits README without committing (a read-only step that edits at all is already
    // wrong; the engine's own HEAD watch cannot see it, because nothing was committed) and then runs
    // the step-done command its prompt renders.
    await w.waitForEvent(key, "step_done_refused", { label: "the gate's step-done is refused on the dirty tree", timeoutMs: 120_000 });
    const refused = w.db.event(key, "step_done_refused")!;
    expect(refused.data.step).toBe("review");
    expect(String(refused.data.why)).toContain("uncommitted changes");
    expect(String(refused.data.stat)).toContain("README.md");

    // The refusal reached the AGENT — non-zero exit with the reason and the stat on stderr, which is
    // the only channel it has. (The harness agent logs every command's rc and output.)
    expect(w.agentLog(), "the agent saw why it was refused").toContain("cannot finish on this tree");
    expect(w.agentLog()).toMatch(/rc=1/);

    // And the belt did not advance on a verdict about code that is already gone.
    expect(w.db.step(id, "review")!.done, "the gate is still not done").toBe(0);
    expect(run().step).toBe("review");
    expect(run().ended_at ?? null, "the run has not finished").toBeNull();
    // The run is deliberately left here: the gate's agent has had its turn and the guard is holding
    // the belt exactly where the dirty tree is, which IS the assertion. (`resume` would only re-prompt
    // the same agent onto the same dirty tree.)
  },
);
