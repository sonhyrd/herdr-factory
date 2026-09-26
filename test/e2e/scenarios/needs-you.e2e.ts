// Issue #130: the dashboard's "needs you" section, outside the dashboard.
//
//   * `needs-you --line` — `hf: N need you` for Herdr's tab bar, N being the board's own count across
//     the fleet; NOTHING when N is 0 or this machine's server is down; and an unreachable remote costs
//     its budget, not the line.
//   * `machine.yml` `notify_needs_you` — the server announces each item ONCE when it enters the set,
//     and a restart does not re-announce what it already did.
//
// Two real servers (the fleet-cli shape), fake herdr: the notification is an argv the fake records.
import { expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scenario } from "../harness/index.ts";
import type { World } from "../harness/index.ts";

const ASK_1 = "ask-1";
const ASK_2 = "ask-2";
const briefs = (home: string) => join(home, "work-ask");
const drop = (w: World, key: string) => writeFileSync(join(briefs(w.paths.home), `${key}.md`), `# ${key}\n\nAmbiguous — the agent asks.\n`);

scenario(
  {
    name: "needs-you",
    lane: "fake",
    timeoutMs: 360_000,
    config: (p) => ({
      limits: { tick_interval_seconds: 2 },
      work_sources: [{ type: "local_markdown", name: "ask", local_markdown: { folder: briefs(p.home) } }],
      belt: [{ name: "asking", source: "ask", workspace_name: "a/{{work_id}}", steps: [{ type: "work" }] }],
    }),
    fleetMachines: {
      "build-box": {
        config: (p) => ({
          limits: { tick_interval_seconds: 2 },
          work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
          belt: [{ name: "quiet", source: "briefs", steps: [{ type: "work" }] }],
        }),
      },
    },
    agent: { default: { signal: "ask-human", text: "Should the banner be blue or green?" } },
    beforeStart: (p) => {
      mkdirSync(briefs(p.home), { recursive: true });
      mkdirSync(p.configDir, { recursive: true });
      writeFileSync(join(p.configDir, "machine.yml"), "notify_needs_you: true\n");
    },
  },
  async (w) => {
    const line = () => {
      const started = Date.now();
      const r = w.factory.cli(["needs-you", "--line"], { repoScoped: false, timeoutMs: 30_000 });
      return { ...r, ms: Date.now() - started };
    };
    const announced = (key: string) => w.herdr.notifications().filter((n) => n.title === `${w.repoName} ${key}`);

    // ── nothing needs you: the line is empty, not "hf: 0 need you" ─────────────────────────────
    await w.waitFor(async () => !!(await w.machine("build-box").health()), { label: "the second machine is up" });
    const empty = line();
    expect(empty.code).toBe(0);
    expect(empty.stdout, "N = 0 prints nothing").toBe("");

    // ── an item enters: the line counts it, and the server announces it once ───────────────────
    drop(w, ASK_1);
    await w.waitFor(() => w.db.run(ASK_1)?.phase === "waiting_for_human", { label: "the agent asks and the run parks", timeoutMs: 120_000 });
    expect(line().stdout.trim()).toBe("hf: 1 need you");
    const items = w.factory.cli(["needs-you"], { repoScoped: false, timeoutMs: 30_000 });
    expect(items.stdout, "without --line: the board's own item text").toMatch(new RegExp(`\\? ${ASK_1}\\s+waiting for a human reply`));

    await w.waitFor(() => announced(ASK_1).length > 0, { label: "the notifier announces the new arrival", timeoutMs: 90_000 });
    expect(announced(ASK_1)[0]!.body).toBe("waiting for a human reply · on this machine");

    // ── a restart does not re-announce it ──────────────────────────────────────────────────────
    await w.factory.stop();
    await w.factory.serve();
    // A second arrival AFTER the restart proves the restarted notifier has polled at least once.
    drop(w, ASK_2);
    await w.waitFor(() => w.db.run(ASK_2)?.phase === "waiting_for_human", { label: "the second run parks", timeoutMs: 120_000 });
    await w.waitFor(() => announced(ASK_2).length > 0, { label: "the restarted notifier announces the new one", timeoutMs: 90_000 });
    expect(announced(ASK_1), "still one notification for the item that was already waiting").toHaveLength(1);
    expect(announced(ASK_2)).toHaveLength(1);

    // ── one machine unreachable: exit 0, inside the budget, the rest still counted ─────────────
    await w.machine("build-box").stop();
    const blind = line();
    expect(blind.code).toBe(0);
    expect(blind.ms, "well under the tab bar's 10s").toBeLessThan(10_000);
    // Two parked runs plus the board's `build-box unverifiable` row — the dashboard's own N.
    expect(blind.stdout.trim()).toBe("hf: 3 need you");

    // ── this machine's server down: nothing, never a partial count ─────────────────────────────
    await w.factory.stop();
    const down = line();
    expect(down.code).toBe(0);
    expect(down.stdout, "server down prints nothing").toBe("");
  },
);
