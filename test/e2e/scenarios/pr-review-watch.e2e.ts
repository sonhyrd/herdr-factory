// The terminal phase of a work_to_pull_request belt: the PR is open and the factory's job is to watch
// it. Three behaviours that only exist here, in one run:
//
//   * a DRAFT PR keeps the step-done gate — the pr step is not finished just because a PR exists;
//   * a ready (non-draft) PR hands off to the review watch IMMEDIATELY, without waiting for
//     step-done, so a pr agent that wanders off can't strand a mergeable PR; and
//   * while watching, a change in the REVIEW SIGNATURE (a new unresolved thread, a failing check)
//     wakes a resolver in the worktree, which holds a concurrency slot only while it is working; and
//   * a PR that is GREEN and mergeable notifies the operator once per green HEAD — including after a
//     push on a repo with no CI, where nothing else in the signature moves — and is never merged by
//     the factory (the human stays the merge gate); and
//   * "green" waits for the pr step's OWN step-done (issue #78): the hand-off above happens while
//     that agent is still polling CI and may still push, so the watch stays silent until it finishes.
import { expect } from "vitest";
import { scenario } from "../harness/index.ts";

scenario(
  {
    name: "pr-review-watch",
    timeoutMs: 300_000,
    briefs: { "watch-me": "# Watch me\n\nGoes to review and back.\n" },
    config: (p) => ({
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      belt: [
        {
          name: "shipping",
          source: "briefs",
          workspace_name: "w/{{work_id}}",
          // The belt's PR policy reaches the agent as prompt text; `draft: true` is the half that
          // changes what the ENGINE does with the PR it finds.
          pr: { draft: true },
          steps: [{ type: "work" }, { type: "pr" }],
        },
      ],
    }),
    // The pr agent opens the PR and then stops without signalling — the case the draft gate is for.
    agent: { steps: { pr: { signal: "none" } } },
  },
  async (w) => {
    const key = "watch-me";

    await w.waitFor(() => (w.db.run(key)?.pr_number ?? 0) > 0, { label: "the pr step opens a draft PR", timeoutMs: 150_000 });
    const pr = w.db.run(key)!.pr_number!;
    expect(w.gh.pr(pr)?.isDraft, "the belt's draft policy reached `gh pr create`").toBe(true);

    // A draft PR does NOT hand off: the step-done gate still stands, so the run stays on its step.
    await w.waitFor(() => w.db.events(key).length > 3, { label: "a few ticks pass", timeoutMs: 30_000 });
    expect(w.db.run(key)!.phase, "a draft PR keeps the step-done gate").toBe("running");
    expect(w.db.eventTypes(key)).not.toContain("resolver_woken");

    // ── marked ready ──────────────────────────────────────────────────────────────────────────
    w.gh.markReady(pr);
    await w.waitForPhase(key, "reviewing", { label: "a ready PR hands off to the watch without step-done", timeoutMs: 120_000 });
    expect(w.db.step(w.db.run(key)!.id, "pr")?.done, "…and it really was never signalled done").toBe(0);
    expect(w.db.run(key)!.resolver_active, "an idle watch holds no concurrency slot").toBe(0);

    // ── green, but the pr step is still running (issue #78) ───────────────────────────────────
    // Nothing unresolved, nothing failing, nothing pending — and yet NOT "ready to merge": the pr
    // agent that opened this PR has not signalled done, so it may still be polling CI and pushing.
    const ready = () => w.herdr.notifications().filter((n) => /ready to merge/i.test(n.title));
    for (let i = 0; i < 4; i++) await w.tick(); // explicit passes: a silent watch emits no event to wait on
    expect(w.db.eventTypes(key), "no pr_green while the pr step is unfinished").not.toContain("pr_green");
    expect(ready().length, "…and the operator is not told to merge it").toBe(0);
    const busy = await w.factory.repoApi<{ active: { ticketKey: string; prGreen?: boolean }[] }>("GET", "status?quick=1");
    expect(busy.active.find((r) => r.ticketKey === key)?.prGreen, "…and `/status` (the board) does not show it green").toBe(false);

    // ── the pr step finishes ──────────────────────────────────────────────────────────────────
    // run.step is null in `reviewing`, so this is the one step-done the identity check lets through.
    const done = w.factory.cli(["step-done", key, "pr", "--source", "briefs"]);
    expect(done.code, `step-done pr must be accepted in the PR watch:\n${done.stderr}`).toBe(0);
    expect(w.db.step(w.db.run(key)!.id, "pr")?.done, "…and it is recorded").toBe(1);

    // ── green ─────────────────────────────────────────────────────────────────────────────────
    // Same PR, same head, nothing about GitHub changed — finishing the step is what made it news.
    await w.waitForEvent(key, "pr_green", { label: "a green PR notifies the operator once the pr step is done", timeoutMs: 120_000 });
    expect(ready().length, "exactly one ready-to-merge notification, not one per tick").toBe(1);
    expect(ready()[0]!.body, "the notification is actionable on a phone — it carries the PR URL").toContain(`/pull/${pr}`);
    expect(w.gh.pr(pr)?.state, "the factory NEVER merges — it only says the PR could be").toBe("OPEN");

    // ── a reviewer leaves a comment ───────────────────────────────────────────────────────────
    w.gh.addUnresolvedThread(pr);
    await w.waitForEvent(key, "resolver_woken", { label: "the changed review signature wakes a resolver", timeoutMs: 120_000 });
    expect(w.db.run(key)!.resolver_active, "a working resolver holds a slot").toBe(1);

    // Once the thread is resolved and the resolver goes idle, the slot is released again — an
    // idle PR-in-review must never starve the belt of new claims.
    w.gh.resolveAllThreads(pr);
    await w.waitFor(() => w.db.run(key)?.resolver_active === 0, { label: "the resolver goes idle and releases its slot", timeoutMs: 120_000 });

    // Green again on the SAME head is not news (issue #114): the operator was already told about it.
    for (let i = 0; i < 4; i++) await w.tick();
    expect(ready().length, "a non-green patch on the same head does not re-notify").toBe(1);
    expect(w.gh.pr(pr)?.state, "still not merged by the factory").toBe("OPEN");

    // ── a push is a new green ─────────────────────────────────────────────────────────────────
    // This fake repo has NO checks, so the push moves nothing in the review signature — unresolved
    // and failing and pending all stay 0. Only the head commit changes. The operator must still be
    // told, because the thing they were told about is no longer what would be merged.
    w.gh.push(pr);
    await w.waitFor(() => ready().length === 2, { label: "a new head commit is a new green", timeoutMs: 120_000 });
    await w.waitFor(() => w.db.events(key).filter((e) => e.type === "pr_green").length === 2, { label: "…and it is recorded", timeoutMs: 30_000 });
    expect(ready().length, "still one per green head, not one per tick").toBe(2);
    expect(w.gh.pr(pr)?.state, "and STILL not merged by the factory").toBe("OPEN");

    // ── merged ────────────────────────────────────────────────────────────────────────────────
    w.gh.merge(pr);
    await w.waitForEnd(key, "merged", { label: "the merge tears the run down", timeoutMs: 120_000 });
    expect(w.branchExists(w.db.run(key)!.branch!), "the local branch is deleted").toBe(false);
  },
);
