// Issue #114: the ready-to-merge notification is once per green HEAD, and a PR that can't merge into
// its base is not green. In one watched run:
//
//   * a red CI flicker on the SAME head does not re-notify (the dashboard still shows it red while
//     it is red); only a push that is green again is news;
//   * a CONFLICTING PR never notifies — it wakes the resolver, whose prompt says to merge the BASE
//     (never the PR), once per conflicted head;
//   * a BEHIND PR notifies normally when its base does not require up-to-date branches, and wakes the
//     resolver instead when it does (strict status checks); and
//   * throughout, the factory never merges.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { scenario } from "../harness/index.ts";

scenario(
  {
    name: "pr-watch-green-once",
    timeoutMs: 300_000,
    briefs: { "green-once": "# Green once\n\nOne notification per head.\n" },
    config: (p) => ({
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      belt: [{ name: "shipping", source: "briefs", workspace_name: "w/{{work_id}}", steps: [{ type: "work" }, { type: "pr" }] }],
    }),
  },
  async (w) => {
    const key = "green-once";
    const ready = () => w.herdr.notifications().filter((n) => /ready to merge/i.test(n.title));
    const wakes = () => w.db.events(key).filter((e) => e.type === "resolver_woken");
    const prGreen = async () =>
      (await w.factory.repoApi<{ active: { ticketKey: string; prGreen?: boolean }[] }>("GET", "status?quick=1")).active.find((r) => r.ticketKey === key)
        ?.prGreen;
    const settle = async () => {
      for (let i = 0; i < 4; i++) await w.tick(); // explicit passes: a silent watch emits no event to wait on
    };

    await w.waitForEvent(key, "pr_green", { label: "the pr step finishes and the green PR notifies", timeoutMs: 150_000 });
    const pr = w.db.run(key)!.pr_number!;
    expect(ready().length).toBe(1);

    // ── a red flicker on the same head ────────────────────────────────────────────────────────
    w.gh.setChecks(pr, [{ name: "ci", conclusion: "FAILURE" }]);
    await w.waitFor(async () => (await prGreen()) === false, { label: "the failing check takes the PR off green", timeoutMs: 60_000 });
    w.gh.setChecks(pr, [{ name: "ci", conclusion: "SUCCESS" }]);
    await w.waitFor(async () => (await prGreen()) === true, { label: "the rerun check puts it back on green", timeoutMs: 120_000 });
    await settle();
    expect(ready().length, "green again on the SAME head is not news").toBe(1);
    expect(w.db.events(key).filter((e) => e.type === "pr_green").length).toBe(1);

    // ── a push that is green is ────────────────────────────────────────────────────────────────
    w.gh.push(pr);
    await w.waitFor(() => ready().length === 2, { label: "a new green head notifies once", timeoutMs: 60_000 });
    await settle();
    expect(ready().length).toBe(2);

    // ── a conflict with the base ──────────────────────────────────────────────────────────────
    await w.waitFor(() => w.db.run(key)?.resolver_active === 0, { label: "no resolver is working", timeoutMs: 60_000 });
    const before = wakes().length;
    w.gh.setMergeState(pr, { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" });
    w.gh.push(pr); // a new head — green on CI, but conflicted
    await w.waitFor(() => wakes().length === before + 1, { label: "the conflict wakes the resolver", timeoutMs: 60_000 });
    expect(JSON.parse(wakes().at(-1)!.detail!), "…to merge the base").toMatchObject({ baseMerge: "conflicting" });
    const prompt = readFileSync(join(w.db.run(key)!.worktree_path!, ".memory/herdr-factory/prompt-resolver.md"), "utf8");
    expect(prompt).toContain("CONFLICTING");
    expect(prompt).toContain("merge the base in");
    expect(prompt).toContain("Never merge the PR itself");
    await w.waitFor(() => w.db.run(key)?.resolver_active === 0, { label: "the resolver goes idle", timeoutMs: 60_000 });
    await settle();
    expect(ready().length, "a conflicted PR is never ready to merge").toBe(2);
    expect(await prGreen()).toBe(false);
    expect(wakes().length, "one wake per conflicted head, not one per tick").toBe(before + 1);

    // ── the base is merged in, but main moved again: BEHIND on a NON-strict base ────────────────
    w.gh.setMergeState(pr, { mergeable: "MERGEABLE", mergeStateStatus: "BEHIND", strictBase: false });
    w.gh.push(pr);
    await w.waitFor(() => ready().length === 3, { label: "BEHIND a non-strict base is still ready", timeoutMs: 60_000 });
    await settle();
    expect(wakes().length, "…and wakes no resolver").toBe(before + 1);

    // ── BEHIND a base that requires up-to-date branches ───────────────────────────────────────
    w.gh.setMergeState(pr, { mergeable: "MERGEABLE", mergeStateStatus: "BEHIND", strictBase: true });
    w.gh.push(pr);
    await w.waitFor(() => wakes().length === before + 2, { label: "BEHIND a strict base wakes the resolver", timeoutMs: 60_000 });
    expect(JSON.parse(wakes().at(-1)!.detail!)).toMatchObject({ baseMerge: "behind" });
    await settle();
    expect(ready().length, "…and is not ready to merge").toBe(3);

    expect(w.gh.pr(pr)?.state, "the factory NEVER merges").toBe("OPEN");
  },
);
