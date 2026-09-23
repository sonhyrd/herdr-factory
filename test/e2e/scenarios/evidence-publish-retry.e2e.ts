// Evidence delivery is DURABLE: the URLs are published up front and the bytes retry in the background
// until the backend accepts them, so a backend that is down mid-run cannot ship a PR with broken
// evidence links. This drives that with a `command` publisher that fails, then succeeds.
//
// It also pins the operator's way out: a run whose background delivery is stuck carries a `problem`
// flag on `/status` (the dashboard's amber ⚠, orthogonal to its steps reading done), and
// `POST /intents/recover` makes the stuck rows due NOW rather than waiting out the retry clock.
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { scenario } from "../harness/index.ts";

interface StatusBody {
  // `problem` is an object ({kind, detail}) when set — the dashboard's amber ⚠ — and absent otherwise.
  active: { ticketKey: string; problem?: { kind: string; detail: string } }[];
}

/** The publisher script the config points at — rewritten mid-scenario to stop failing. */
function writePublisher(home: string, mode: "fail" | "ok"): void {
  const p = join(home, "publish-evidence.sh");
  writeFileSync(
    p,
    mode === "fail"
      ? '#!/bin/sh\necho "backend unavailable" >&2\nexit 1\n'
      : // The contract: upload, then print one public URL per file on stdout.
        '#!/bin/sh\nfor f in "$1"/*; do echo "https://cdn.example.test/$2/$(basename "$f")"; done\n',
  );
  chmodSync(p, 0o755);
}

scenario(
  {
    name: "evidence-publish-retry",
    timeoutMs: 240_000,
    briefs: { "flaky-backend": "# Flaky backend\n\n## Acceptance criteria\n- it looks right\n" },
    beforeStart: (p) => writePublisher(p.home, "fail"),
    config: (p) => ({
      evidence: { publisher: "command", command: join(p.home, "publish-evidence.sh"), timeout_seconds: 30, key_prefix: "e2e" },
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      layouts: [
        {
          // See evidence.e2e.ts: every step needs a layout pane, or the first dedicated spawn races
          // the hook's fresh-worktree guard and the layout is never built.
          id: "with-evidence",
          tabs: ["work", "evidence", "review", "pr"].map((title) => ({ title, panes: [{ title: "agent", agent: "claude" }] })),
        },
      ],
      belt: [
        {
          name: "proving",
          source: "briefs",
          workspace_name: "e/{{work_id}}",
          default_layout: "with-evidence",
          // The `pr` step is gated on the bytes landing (the evidence gate), which also keeps the run
          // ALIVE while they retry — so teardown can't drop a publish that never landed.
          steps: [
            { type: "work", tab: "work", pane: "agent" },
            { type: "evidence", tab: "evidence", pane: "agent" },
            { type: "review", tab: "review", pane: "agent" },
            { type: "pr", tab: "pr", pane: "agent" },
          ],
        },
      ],
    }),
    agent: { steps: { evidence: { commit: false, evidence: true }, review: { commit: false } } },
  },
  async (w) => {
    const key = "flaky-backend";

    // The publish fails, but the evidence STEP is not blocked by it — the run walks on while the bytes retry.
    await w.waitFor(() => w.db.intents({ kind: "evidence_publish" }).some((i) => i.attempts > 0 && i.status !== "delivered"), {
      label: "the failing publish is recorded as a retrying intent",
      timeoutMs: 120_000,
    });
    const stuck = w.db.intents({ kind: "evidence_publish" })[0]!;
    expect(stuck.last_error, "the failure reason is kept for the operator").toMatch(/backend unavailable|exit|1/i);
    expect(stuck.error_class, "a failed command publish is transient — retryable").toBe("transient");

    // The run carries a background `problem` even while its steps read done — the amber ⚠ the
    // dashboard shows so a stuck upload can't hide behind a green pipeline.
    await w.waitFor(async () => (await w.factory.repoApi<StatusBody>("GET", "status")).active.some((a) => a.ticketKey === key && a.problem), {
      label: "/status flags the run's stuck background work",
      timeoutMs: 60_000,
    });

    // ── the operator fixes the backend ────────────────────────────────────────────────────────
    writePublisher(w.paths.home, "ok");
    // Skip the backoff the way an operator does, rather than waiting it out. Recovery is
    // CAUSE-scoped: every row stuck behind the same backend comes due at once.
    await w.factory.repoApi("POST", "intents/recover", { causeScope: "publisher:command" });

    await w.waitFor(() => w.db.intents({ kind: "evidence_publish" }).every((i) => i.status === "delivered"), {
      label: "the retry lands once the backend works",
      timeoutMs: 120_000,
    });
    expect(w.db.eventTypes(key)).toContain("evidence_uploaded");
    await w.waitFor(async () => !(await w.factory.repoApi<StatusBody>("GET", "status")).active.some((a) => a.ticketKey === key && a.problem), {
      label: "and the problem flag clears",
      timeoutMs: 60_000,
    });

    // The belt walked on through review while the bytes were retrying, but the pr step waited for
    // them (the evidence gate, issue #90) — it opens the PR only now that the upload has landed.
    await w.waitFor(() => (w.db.run(key)?.pr_number ?? 0) > 0, { label: "the pr step opens the PR", timeoutMs: 120_000 });
    w.gh.merge(w.db.run(key)!.pr_number!);
    await w.waitForEnd(key, "merged", { label: "the run merges once its evidence is delivered", timeoutMs: 120_000 });
  },
);
