// The `run` command: run the factory for one repo in the FOREGROUND — the first-run / aha path.
//
// It reconciles the repo on its configured cadence (reusing reconcileRepo under the same tick lock
// as the server + the `tick` command) and STREAMS the timeline as human-readable lines, so a new
// user can watch work flow through the belt without installing the background supervisor. Two
// modes, one loop:
//   • plain `run`      — rides until the repo goes idle (nothing actively working), then summarizes
//                        what's left (PRs in review, parked runs) and exits. Bounded.
//   • `run --follow`   — never auto-exits; tails progress until Ctrl-C (like `tail -f`). Unbounded.
//
// It never talks to the HTTP server — it runs in-process. Because it takes the per-repo tick lock,
// it COOPERATES with a resident server if one is up: a pass the server is mid-way through is simply
// skipped, and the server's own events still stream here (we read the shared DB). So `run --follow`
// is also a live view onto a background factory.
import type { Deps } from "../core/deps.ts";
import type { RepoEvent } from "../types.ts";
import { reconcileRepo, withTickLock } from "../core/reconcile.ts";
import { pingHealth, readServerInfo } from "../server/client.ts";

/** Friendly label per event type; unknown types fall back to the raw type string. */
const EVENT_LABEL: Record<string, string> = {
  claimed: "claimed",
  transition: "source status",
  worktree_created: "worktree created",
  layout_applied: "layout built",
  layout_apply_failed: "layout build failed",
  step_spawned: "▶ step started",
  step_done: "✓ step done",
  layout_wait_retry: "waiting for layout pane",
  pane_relaunched: "↻ undetected agent relaunched",
  idle_nudge: "↯ idle agent nudged",
  bounced: "↩ bounced back",
  rework: "↩ operator rework",
  step_done_refused: "✗ step-done refused (tree guard)",
  signal_queued: "signal queued",
  signal_rejected: "signal rejected",
  capture_attempt: "evidence capture attempt",
  evidence_uploaded: "evidence uploaded",
  evidence_upload_failed: "evidence upload failed",
  stale: "source item gone (stale)",
  human_question: "⏸ asked a human",
  human_question_moot: "question closed (step resolved it itself)",
  human_reply: "▶ human replied",
  pr_opened: "PR opened",
  resolver_woken: "resolver woken (review changed)",
  merged: "✓ merged",
  closed: "closed",
  torn_down: "torn down",
  belt_reassigned: "belt renamed",
  belt_deleted: "belt deleted",
  attention: "⚠ needs attention",
  resumed: "resumed",
  error: "error",
};

/** Types too chatty for a live feed — they fire on a cadence and add no signal for a watcher. */
const NOISY_EVENTS = new Set(["focus_applied"]);

function str(d: Record<string, unknown>, k: string): string | undefined {
  return typeof d[k] === "string" ? (d[k] as string) : undefined;
}
function num(d: Record<string, unknown>, k: string): number | undefined {
  return typeof d[k] === "number" ? (d[k] as number) : undefined;
}

/** A short, type-specific trailer for an event line, pulled from its `detail` JSON. Empty string
 *  when there's nothing worth showing (the label alone is enough). Never throws on odd detail. */
export function followEventExtra(type: string, detail: string | null): string {
  if (!detail) return "";
  let d: Record<string, unknown>;
  try {
    const parsed = JSON.parse(detail) as unknown;
    if (typeof parsed !== "object" || parsed === null) return "";
    d = parsed as Record<string, unknown>;
  } catch {
    return "";
  }
  switch (type) {
    case "claimed": {
      const belt = str(d, "belt");
      const source = str(d, "source");
      return belt || source ? `${source ?? "?"} → ${belt ?? "?"}` : "";
    }
    case "step_spawned":
    case "step_done":
    case "capture_attempt":
      return str(d, "step") ?? "";
    case "bounced": {
      const to = str(d, "toStep");
      return to ? `→ ${to}` : "";
    }
    case "rework": {
      const to = str(d, "toStep");
      return to ? `${str(d, "fromStep") ?? "?"} → ${to} (pass ${num(d, "pass") ?? "?"})` : "";
    }
    case "step_done_refused":
      return [str(d, "step"), str(d, "why")].filter(Boolean).join(" — ");
    case "transition":
    case "stale":
      return str(d, "to") ?? "";
    case "pr_opened":
      return num(d, "number") != null ? `#${num(d, "number")}` : "";
    case "torn_down":
      return str(d, "outcome") ?? "";
    case "attention":
      return str(d, "reason") ?? "";
    case "pr_green": {
      const head = str(d, "head");
      return `#${num(d, "number") ?? "?"} green${head ? ` @ ${head.slice(0, 7)}` : ""}`;
    }
    case "idle_nudge": {
      const step = str(d, "step");
      return `${step ?? "?"}${d.nudged === false ? " (not confirmed)" : ""}`;
    }
    case "resolver_woken": {
      const unresolved = num(d, "unresolved");
      const failing = num(d, "failing");
      return `${unresolved ?? 0} unresolved · ${failing ?? 0} failing`;
    }
    case "evidence_uploaded":
      return num(d, "files") != null ? `${num(d, "files")} file(s)` : "";
    case "error":
    case "evidence_upload_failed":
      return str(d, "message") ?? str(d, "reason") ?? "";
    case "belt_reassigned": {
      const from = str(d, "from");
      const to = str(d, "to");
      return from && to ? `${from} → ${to}` : "";
    }
    case "belt_deleted":
      return str(d, "belt") ?? "";
    default:
      return "";
  }
}

/** Render one timeline event as a `  HH:MM:SS  TICKET  <label> — <extra>` line for the live feed. */
export function formatFollowEvent(ev: RepoEvent): string {
  const time = new Date(ev.ts * 1000).toLocaleTimeString();
  const key = (ev.ticketKey ?? "—").padEnd(16);
  const label = EVENT_LABEL[ev.type] ?? ev.type;
  const extra = followEventExtra(ev.type, ev.detail);
  return `  ${time}  ${key} ${label}${extra ? ` — ${extra}` : ""}`;
}

/** Run the repo's reconcile loop in the foreground, streaming the timeline. Installs its own
 *  SIGINT/SIGTERM handlers (stop after the current pass) and RETURNS when it stops — the caller
 *  disposes runtimes + exits. `follow=false` returns as soon as the repo is idle; `follow=true`
 *  rides until interrupted. */
export async function runForeground(deps: Deps, opts: { follow: boolean }): Promise<void> {
  const c = deps.config;
  const intervalMs = c.limits.tickIntervalSeconds * 1000;

  console.log(
    `herdr-factory [${c.repoName}] — foreground ${opts.follow ? "run (following — Ctrl-C to stop)" : "run (exits when idle — Ctrl-C to stop)"}`,
  );
  console.log(`Sources: ${c.sources.map((s) => `${s.name}(${s.type})`).join(" · ")}`);
  console.log(
    `Belts (priority order): ${c.belts.map((b) => `${b.name}(src:${b.source}, p${b.priority}${b.active ? "" : ", INACTIVE"})`).join(" · ")}`,
  );

  // A resident server also ticks this repo. We cooperate via the tick lock (a pass it's mid-way
  // through is skipped here), and its events still stream below — so say so rather than double-tick
  // silently.
  const info = readServerInfo();
  if (info && (await pingHealth(info.port))) {
    console.log(`note: a resident server is already running (pid ${info.pid}) — this run cooperates via the tick lock and streams its progress.`);
  }
  console.log(`Reconciling every ${c.limits.tickIntervalSeconds}s. Streaming progress:\n`);

  // Stream only events created from here on — don't replay the repo's whole history.
  let lastEventId = deps.store.maxEventId(c.repoName);
  const drain = (): void => {
    for (const ev of deps.store.eventsSince(c.repoName, lastEventId)) {
      lastEventId = ev.id;
      if (!NOISY_EVENTS.has(ev.type)) console.log(formatFollowEvent(ev));
    }
  };

  let stopping = false;
  const onSignal = (sig: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${sig} — stopping after the current pass…`);
  };
  const sigint = (): void => onSignal("SIGINT");
  const sigterm = (): void => onSignal("SIGTERM");
  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigterm);

  try {
    let nextTickAt = 0; // 0 ⇒ run the first pass immediately
    for (;;) {
      let ticked = false;
      if (Date.now() >= nextTickAt) {
        try {
          await withTickLock(deps, () => reconcileRepo(deps));
        } catch (e) {
          console.error(`  ⚠ reconcile pass failed — ${e instanceof Error ? e.message : String(e)}`);
        }
        nextTickAt = Date.now() + intervalMs;
        ticked = true;
      }
      drain();

      // Idle-exit (non-follow): once a pass leaves no ACTIVELY-WORKED run, the local work has
      // drained (implemented + committed, PRs opened). Runs left in review-watch or parked hold no
      // occupancy slot and won't progress here without a human / a running server — report, don't
      // block. Evaluated only right after a pass, when the state can actually have changed.
      if (!opts.follow && ticked && deps.store.countOccupying(c.repoName) === 0) {
        summarizeAndClose(deps);
        break;
      }
      if (stopping) break;
      await deps.sleep(1000); // event-drain cadence (independent of the reconcile cadence above)
    }
  } finally {
    process.removeListener("SIGINT", sigint);
    process.removeListener("SIGTERM", sigterm);
  }
}

/** Non-follow exit summary: what the foreground run leaves behind and how to keep watching it. */
function summarizeAndClose(deps: Deps): void {
  const c = deps.config;
  const active = deps.store.activeRuns(c.repoName);
  if (active.length === 0) {
    // Onboarding pointer chain: a first `run` that finds no work is a dead end without a forward
    // link, so point at feeding the source and at `start` (keep watching in the background).
    console.log("\nnothing in flight — no eligible work to claim and no runs active.");
    console.log("Next: feed the source (label a ticket / drop a *.md brief), then re-run — or `herdr-factory start` to keep the factory watching in the background.");
    return;
  }
  const parked = active.filter((r) => r.phase === "attention" || r.phase === "waiting_for_human");
  const reviewing = active.filter((r) => r.phase === "reviewing");
  const other = active.filter((r) => !parked.includes(r) && !reviewing.includes(r));
  console.log("\nlocal work drained. Remaining:");
  if (reviewing.length) console.log(`  • ${reviewing.length} run(s) waiting on PR review/merge${reviewing.some((r) => r.prNumber) ? ` (${reviewing.map((r) => (r.prNumber ? `#${r.prNumber}` : r.ticketKey)).join(", ")})` : ""}`);
  if (parked.length) console.log(`  • ${parked.length} run(s) parked for attention/human input (${parked.map((r) => r.ticketKey).join(", ")})`);
  if (other.length) console.log(`  • ${other.length} run(s) still in flight (${other.map((r) => r.ticketKey).join(", ")})`);
  console.log("\nRe-run with `--follow` to ride these to merge, or `herdr-factory start` to keep the factory running in the background.");
}
