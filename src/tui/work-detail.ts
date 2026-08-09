// Formats the read-only "work item detail" panel the Dashboard opens with `d` on a run row: a full
// overview (the untruncated summary, type, source/belt, live status, PR, worker, age), the belt's
// step-by-step progress with per-step timing, and the event timeline. Kept pure and string-only so it
// unit-tests without a renderer — the Dashboard wraps the returned lines in the shell's scrollable info
// modal (which renders every line in one color, so state is carried by ✓/●/◐/○/⚠ markers, mirroring the
// repo Detail view's ✓/✗/– style rather than color).

/** One step of a run as reported by the status payload (subset of the store's RunStep). */
export interface WorkItemDetailStep {
  step: string;
  done: boolean;
  startedAt: number | null; // epoch seconds
  doneAt: number | null; // epoch seconds
  pass: number;
}

/** Everything the panel needs about a single active run. Decoupled from the api.ts wire types so the
 *  formatter stays pure and independently testable; the Dashboard maps an ActiveRun onto this. */
export interface WorkItemDetail {
  key: string;
  summary: string | null;
  issueType: string | null;
  workSource: string | null;
  belt: string | null;
  branch: string | null;
  phase: string;
  step: string | null; // the active belt step (when phase is "running")
  prNumber: number | null;
  outcome: string | null;
  worker: string | null; // live pane state, when known
  attentionReason: string | null;
  problem: { detail: string } | null;
  createdAt: number | null; // epoch seconds
  /** The belt's ordered step names — drives the step list (so not-yet-started steps still show). */
  beltSteps: string[];
  /** The run's per-step rows (may cover only the steps reached so far). */
  steps: WorkItemDetailStep[];
  /** The `explainRun` narrative (core/explain.ts) — why the run is where it is, rendered from the
   *  obligations fetch. Absent when the server (or the run) isn't there; the section is omitted. */
  explain?: string[];
}

/** Compact, human duration (largest two units) for ages and per-step elapsed time. */
function humanDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return h ? `${d}d ${h}h` : `${d}d`;
  if (h) return m ? `${h}h ${m}m` : `${h}h`;
  if (m) return `${m}m`;
  return `${s}s`;
}

/** phase/state token → readable words ("waiting_for_human" → "waiting for human"). */
const humanize = (value: string): string => value.replace(/_/g, " ");

/**
 * Build the detail panel's lines. `timelineLines` are already-formatted event rows (the Dashboard
 * formats their timestamps the same way its bare timeline view does); `nowMs` is the current wall
 * clock in ms (injected so ages are deterministic under test).
 */
export function formatWorkItemDetail(detail: WorkItemDetail, timelineLines: string[], nowMs: number): string[] {
  const nowSec = nowMs / 1000;
  const out: string[] = [];
  const field = (name: string) => `  ${`${name}:`.padEnd(9)} `;

  out.push("Overview");
  out.push(`${field("summary")}${detail.summary ?? "(no summary)"}`);
  if (detail.issueType) out.push(`${field("type")}${detail.issueType}`);
  out.push(`${field("source")}${detail.workSource ?? "?"}${detail.belt ? ` · belt ${detail.belt}` : ""}`);
  if (detail.branch) out.push(`${field("branch")}${detail.branch}`);
  const status = [humanize(detail.phase)];
  if (detail.step) status.push(`step ${detail.step}`);
  if (detail.outcome) status.push(`outcome ${detail.outcome}`);
  out.push(`${field("status")}${status.join(" · ")}`);
  if (detail.worker) out.push(`${field("worker")}${detail.worker}`);
  if (detail.prNumber != null) out.push(`${field("PR")}#${detail.prNumber}`);
  if (detail.createdAt != null) out.push(`${field("age")}${humanDuration(nowSec - detail.createdAt)}`);
  if (detail.attentionReason) out.push(`  ⚠ attention: ${detail.attentionReason}`);
  if (detail.problem) out.push(`  ⚠ problem: ${detail.problem.detail}`);

  if (detail.explain?.length) {
    out.push("", "What's happening");
    for (const line of detail.explain) out.push(line ? `  ${line}` : "");
  }

  out.push("", "Steps");
  const byName = new Map(detail.steps.map((s) => [s.step, s]));
  // Prefer the belt's declared order so pending steps still appear; fall back to whatever run rows
  // exist when the belt is unknown (e.g. it was renamed out from under an in-flight run).
  const ordered = detail.beltSteps.length ? detail.beltSteps : detail.steps.map((s) => s.step);
  if (ordered.length === 0) {
    out.push("  (no steps)");
  } else {
    const width = Math.max(...ordered.map((n) => n.length));
    for (const name of ordered) {
      const s = byName.get(name);
      const current = detail.step === name && !s?.done;
      let marker: string;
      let state: string;
      if (s?.done) {
        marker = "✓";
        state = "done";
      } else if (current) {
        marker = "●";
        state = humanize(detail.phase);
      } else if (s?.startedAt != null) {
        marker = "◐";
        state = "in progress";
      } else {
        marker = "○";
        state = "pending";
      }
      let timing = "";
      if (s?.done && s.startedAt != null && s.doneAt != null) timing = `  (${humanDuration(s.doneAt - s.startedAt)})`;
      else if (current && s?.startedAt != null) timing = `  (${humanDuration(nowSec - s.startedAt)})`;
      const pass = s && s.pass > 1 ? `  · pass ${s.pass}` : "";
      out.push(`  ${marker} ${name.padEnd(width)}  ${state}${timing}${pass}`);
    }
  }

  out.push("", "Timeline");
  if (timelineLines.length === 0) out.push("  (no events)");
  else for (const line of timelineLines) out.push(`  ${line}`);

  return out;
}
