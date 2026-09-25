// A work item edited after the claim (issue #97). The incident: a run snapshot its ticket at claim,
// the ticket gained new surfaces and a new instruction afterwards, and every step worked against the
// stale copy — the PR reached the operator missing criteria it had never seen.
//
// The unit tests inject a mutable fake client. This proves it against the engine's REAL JiraSource,
// a stateful Jira fake, a real worktree and the real CLI, with three tickets on one board:
//
//   1. APP-1 — the description is edited while work runs. The advance into review parks the run
//      `work_item_edited`, review is never dispatched, the work doc is refreshed (claim-time copy
//      kept), the before/after is written, and a note lands on the ticket. `resume` ships as is.
//   2. APP-2 — the same park; `rework … work` re-runs the work step, and the belt runs forward.
//   3. APP-3 — only a label is added (`updated` moves, the content doesn't): never parks.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { JiraFake } from "../harness/sources/jira-fake.ts";
import { expectParked, scenario } from "../harness/index.ts";

const jira = new JiraFake({ project: "APP", boardId: 254 });
const MEM = ".memory/herdr-factory";
// The work agent holds its turn until the scenario has mutated the ticket, so the edit lands
// deterministically between the claim (baseline recorded) and work's step-done (the advance).
const GATE = [`i=0; while [ ! -f ${MEM}/go ] && [ $i -lt 110 ]; do sleep 1; i=$((i+1)); done`];
const KEYS = { resume: "APP-1", rework: "APP-2", label: "APP-3" };

scenario(
  {
    name: "work-item-edited",
    timeoutMs: 420_000,
    beforeStart: async () => {
      await jira.listen();
      for (const key of Object.values(KEYS)) {
        jira.seed({ key, summary: `Build the list (${key})`, type: "Story", status: "To Do", labels: ["agent"], description: "Build the list.\nShows 10 rows." });
      }
    },
    afterStop: () => jira.close(),
    env: { JIRA_EMAIL: "bot@example.test", JIRA_API_TOKEN: "token" },
    config: () => ({
      work_sources: [
        {
          type: "jira",
          name: "board",
          max_active_workspaces: 3,
          jira: { base_url: jira.url, project: "APP", board: 254, status: { todo: "To Do", in_development: "In Progress", review: "In Review" } },
        },
      ],
      belt: [{ name: "tickets", source: "board", label: "agent", workspace_name: "t/{{work_id}}", steps: [{ type: "work" }, { type: "review" }] }],
    }),
    agent: { steps: { work: { run: GATE }, review: { commit: false } } },
  },
  async (w) => {
    const run = (key: string) => w.db.run(key)!;
    const mem = (key: string) => join(run(key).worktree_path!, MEM);
    const reviewDispatched = (key: string) => w.db.step(run(key).id, "review")?.dispatched_at != null;

    // ── claim: every run records the item's content before its work step can finish ──────────
    for (const key of Object.values(KEYS)) {
      await w.waitFor(() => run(key)?.step === "work" && existsSync(join(mem(key), "work-content.json")), {
        label: `${key} is claimed with its content recorded`,
        timeoutMs: 180_000,
      });
    }
    expect(JSON.parse(readFileSync(join(mem(KEYS.resume), "work-content.json"), "utf8")).fields.Description).toContain("Shows 10 rows.");

    // ── a human edits two tickets and only labels the third; then work finishes ──────────────
    const NEW = "Build the list.\nShows 10 rows.\nAlso the messenger and applications lists.";
    jira.setDescription(KEYS.resume, NEW);
    jira.setDescription(KEYS.rework, NEW);
    jira.addLabel(KEYS.label, "frontend");
    for (const key of Object.values(KEYS)) writeFileSync(join(mem(key), "go"), "");

    // ── 3. label-only: the timestamp moved, the content did not — no park ─────────────────────
    await w.waitFor(() => reviewDispatched(KEYS.label), { label: "the label-only ticket reaches review", timeoutMs: 120_000 });
    expect(run(KEYS.label).attention_reason_code ?? null).toBeNull();
    expect(existsSync(join(mem(KEYS.label), "work-item-edits.md")), "no edit was recorded").toBe(false);

    // ── 1 + 2. the edited tickets park before review starts ───────────────────────────────────
    for (const key of [KEYS.resume, KEYS.rework]) {
      await w.waitFor(() => run(key)?.phase === "attention", { label: `${key} parks at the advance into review`, timeoutMs: 120_000 });
      expectParked(w, key, "work_item_edited");
      expect(run(key).attention_reason).toBe("ticket edited after claim: Description");
      expect(run(key).step, "the run stays on the completed step, so resume re-runs the advance").toBe("work");
      expect(w.db.step(run(key).id, "review")?.dispatched_at ?? null, "review never ran against the stale copy").toBeNull();

      // The worktree carries the new text, the claim-time copy and the before/after.
      expect(readFileSync(join(mem(key), "ticket.json"), "utf8")).toContain("messenger");
      expect(readFileSync(join(mem(key), "ticket.claimed.json"), "utf8")).not.toContain("messenger");
      const edits = readFileSync(join(mem(key), "work-item-edits.md"), "utf8");
      expect(edits).toContain("## Description");
      expect(edits).toMatch(/### Before[\s\S]*Shows 10 rows\.[\s\S]*### Now[\s\S]*messenger/);

      // …and whoever edited the ticket is told, on the ticket, with both choices.
      await w.waitFor(() => jira.comments(key).some((c) => c.body.includes("ticket edited after claim")), { label: `${key}: the park note reaches Jira` });
      const note = jira.comments(key).find((c) => c.body.includes("ticket edited after claim"))!.body;
      expect(note).toContain(`rework ${key} work`);
      expect(note).toContain(`resume ${key}`);
    }

    // The resume/rework nudges re-prompt work's pass-1 agent; that turn must not signal a step that
    // has already moved on. The rework's pass 2 keeps the normal behaviour.
    w.setAgentScript({ steps: { work: { run: GATE }, review: { commit: false } }, passes: { "work:1": { commit: false, signal: "none" } } });

    // ── 1. resume: ship as is — the acknowledged edit does not park again ────────────────────
    // cliAsync, not cli/resume(): the resumed pass dials the JiraFake hosted in THIS process, which a
    // spawnSync would block until the CLI times out.
    expect((await w.factory.cliAsync(["resume", KEYS.resume])).code, "the operator resumes the parked run").toBe(0);
    await w.waitFor(() => reviewDispatched(KEYS.resume), { label: "resume dispatches review", timeoutMs: 120_000 });
    const parks = w.db.events(KEYS.resume).filter((e) => e.type === "attention");
    expect(parks.length, "one park for one edit").toBe(1);

    // ── 2. rework: the work step re-runs against the new text, then the belt runs forward ─────
    const out = await w.factory.cliAsync(["rework", KEYS.rework, "work", "--note", "work item edited — see work-item-edits.md"]);
    expect(out.code, `rework should succeed (stderr: ${out.stderr.trim()})`).toBe(0);
    const id = run(KEYS.rework).id;
    expect(w.db.step(id, "work")!.done, "rework re-opens the completed work step").toBe(0);
    expect(w.db.step(id, "work")!.pass).toBe(2);
    await w.waitFor(() => reviewDispatched(KEYS.rework), { label: "the reworked run reaches review", timeoutMs: 120_000 });
    expect(w.db.step(id, "work")!.done).toBe(1);
    expect(w.db.events(KEYS.rework).filter((e) => e.type === "attention").length, "no second park").toBe(1);
  },
);
