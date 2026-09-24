// Background evidence upload (issue #90). A `command` publisher that declares `public_base_url` has a
// predictable URL layout, so `evidence-upload` prints the URLs and returns at once — the upload runs
// in a detached child — instead of holding the evidence agent for the whole upload (minutes, on a
// real backend). What stops those early URLs from shipping dead is the EVIDENCE GATE: the pr step
// does not start until the run's latest publish has landed (`evidence_uploaded`), and a publish that
// never lands parks the run with a clear reason.
//
// Two runs, one publisher script: it sleeps before "uploading" (a slow backend), and fails outright
// for the `broken-backend` item (the key is in the prefix it receives).
//
// The config renames the key root (`key_root: hf`, issue #92): the predicted links and the prefix the
// publisher uploads under must both start with `hf/`, or every predicted link is a 404.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { expectParked, expectTimeline, scenario } from "../harness/index.ts";

const SLOW_SECONDS = 20;

scenario(
  {
    name: "evidence-background-upload",
    timeoutMs: 300_000,
    briefs: {
      "slow-backend": "# Slow backend\n\n## Acceptance criteria\n- it looks right\n",
      "broken-backend": "# Broken backend\n\n## Acceptance criteria\n- it looks right\n",
    },
    beforeStart: (p) => {
      const script = join(p.home, "publish-evidence.sh");
      writeFileSync(
        script,
        `#!/bin/sh
case "$2" in *broken-backend*) echo "backend rejected the upload" >&2; exit 1;; esac
echo "$2" > "${p.home}/upload-started"
sleep ${SLOW_SECONDS}
touch "${p.home}/upload-finished"
for f in "$1"/*; do echo "https://evidence.example.test/$2/$(basename "$f")"; done
`,
      );
      chmodSync(script, 0o755);
    },
    config: (p) => ({
      evidence: {
        publisher: "command",
        command: join(p.home, "publish-evidence.sh"),
        public_base_url: "https://evidence.example.test",
        timeout_seconds: 60,
        key_root: "hf",
        key_prefix: "e2e",
      },
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      layouts: [{ id: "with-evidence", tabs: ["work", "evidence", "review", "pr"].map((title) => ({ title, panes: [{ title: "agent", agent: "claude" }] })) }],
      belt: [
        {
          name: "proving",
          source: "briefs",
          workspace_name: "e/{{work_id}}",
          default_layout: "with-evidence",
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
    const slow = "slow-backend";
    const started = join(w.paths.home, "upload-started");
    const finished = join(w.paths.home, "upload-finished");

    // The evidence agent is NOT held by the upload: its step finishes while the (slow) upload is
    // still in flight, and the intent is pending in the background.
    await w.waitFor(() => existsSync(started) && w.db.step(w.db.run(slow)!.id, "evidence")?.done === 1, {
      label: "the evidence step finishes while the upload is in flight",
      timeoutMs: 180_000,
    });
    expect(existsSync(finished), `evidence-upload returned before the ${SLOW_SECONDS}s upload finished`).toBe(false);
    const intent = w.db.intents({ kind: "evidence_publish", runId: w.db.run(slow)!.id })[0]!;
    expect(intent.status).toBe("pending");

    // The review step runs meanwhile — but the pr step waits for the bytes.
    await w.waitFor(() => w.db.step(w.db.run(slow)!.id, "review")?.done === 1, { label: "review finishes", timeoutMs: 120_000 });
    if (!existsSync(finished)) expect(w.db.run(slow)!.step, "the pr step is gated on evidence_uploaded").toBe("review");

    await w.waitFor(() => w.db.eventTypes(slow).includes("pr_opened"), { label: "the pr step opens the PR once the upload lands", timeoutMs: 120_000 });
    expectTimeline(w, slow, ["evidence_uploaded", "pr_opened"]);
    // key_root: the publisher uploaded under hf/…, and the PR's predicted links point at the same keys.
    const uploadedPrefix = readFileSync(started, "utf8").trim();
    expect(uploadedPrefix).toMatch(/^hf\/.*slow-backend/);
    const links = w.gh.pr(w.db.run(slow)!.pr_number!)!.body.match(/https:\/\/evidence\.example\.test\/\S+/g) ?? [];
    expect(links.length, "the PR carries the predicted evidence links").toBeGreaterThan(0);
    for (const link of links) expect(link.startsWith(`https://evidence.example.test/${uploadedPrefix}/`), link).toBe(true);
    expect(w.db.intents({ kind: "evidence_publish", runId: w.db.run(slow)!.id })[0]!.status).toBe("delivered");

    // The broken backend: every attempt fails. Skip the flat 30s retry clock the way an operator
    // would (`retry-now`) until the row suspends — then the gate parks the run instead of letting
    // the pr step ship dead links.
    const broken = "broken-backend";
    await w.waitFor(
      async () => {
        const row = w.db.intents({ kind: "evidence_publish", runId: w.db.run(broken)?.id ?? -1 })[0];
        if (!row) return false;
        if (row.suspended_at != null) return true;
        if (row.attempts > 0 || row.lease_until == null) await w.factory.repoApi("POST", "retry-now", { key: broken });
        return false;
      },
      { label: "the broken upload retries until it suspends", timeoutMs: 180_000 },
    );
    await w.waitFor(() => w.db.run(broken)?.phase === "attention", { label: "the evidence gate parks the run", timeoutMs: 120_000 });
    expectParked(w, broken, "evidence_upload_failed");
    expect(w.db.run(broken)!.attention_reason).toContain("backend rejected the upload");
    expect(w.db.run(broken)!.pr_number ?? null, "no PR was opened with dead evidence links").toBeNull();

    w.gh.merge(w.db.run(slow)!.pr_number!);
    await w.waitForEnd(slow, "merged", { label: "the healthy run merges", timeoutMs: 120_000 });
  },
);
