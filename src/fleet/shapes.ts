// The factory HTTP API's response shapes, as a zero-import leaf.
//
// They used to live in `src/tui/api.ts`, back when the TUI had a client of its own; it now reads
// through `MachineClient` like everything else, and these shapes are what the two sides of the API
// agree on. `tui/api.ts` re-exports them, so the TUI's views keep importing from where they always
// did.
// Nothing in this file imports the engine: a UI or a CLI reader can depend on it without dragging
// in reconcile.
import type { RunObligations } from "../core/obligations-shape.ts";

/** One active run as returned by GET /repos/{repo}/status. */
export interface ActiveRun {
  id: number;
  ticketKey: string;
  workSource: string | null;
  belt: string | null;
  issueType: string | null;
  /** The name the run's worktree was created under; `branch` is where it is NOW (they differ once
   *  an agent renames the branch to the repo's convention). */
  worktreeName: string | null;
  branch: string | null;
  phase: string;
  step: string | null;
  prNumber: number | null;
  summary: string | null;
  outcome: string | null;
  attentionReason: string | null;
  worker: string | null;
  createdAt: number | null; // epoch seconds
  steps: { step: string; done: boolean; startedAt: number | null; doneAt: number | null; pass: number }[];
  /** A background problem the step columns can't show — e.g. the evidence step reads "done" (URLs
   *  emitted) but its media upload is still stuck retrying. Absent when the run is healthy. */
  problem?: { kind: "evidence-upload"; detail: string };
}

export interface RepoStatus {
  repo: string;
  limits: { maxActiveWorkspaces: number };
  /** Host-local machine.yml summary (cap occupancy, memory, active gate); absent when unset. */
  machine?: string;
  /** Per-source auth light (same vocab as evidenceSso): "down" = the source can't authenticate (its
   *  claims + write-backs are paused, auto-resuming on re-auth); "na" = the source needs no auth. */
  sources: { name: string; type: string; auth?: { state: "ok" | "down" | "na"; detail?: string; account?: string } }[];
  belts: {
    name: string;
    beltType: string;
    source: string;
    priority: number;
    active?: boolean;
    label?: string;
    steps: string[];
    diagnostic?: { state: "ok" | "down"; detail?: string };
  }[];
  active: ActiveRun[];
  finished: { id: number; ticketKey: string; phase: string; outcome: string | null; prNumber: number | null }[];
  /** Repo-level problems for the red per-repo light: runs parked for attention, suspended jobs
   *  (retries stopped after the 10-attempt cap), auth-stuck uploads (AWS creds), live source auth
   *  failures, and cached session-probe verdicts (an expired AWS SSO session lights the row within
   *  a few polls — the server refreshes the probes in the background, ~90s TTL). Present on the
   *  quick path too; the request never waits on a probe. */
  problems?: { kind: string; detail: string }[];
  /** Evidence-upload credential (AWS SSO) health for the dashboard light. "na" = no evidence config. */
  evidenceSso?: { state: "ok" | "down" | "na"; detail?: string };
}

export interface Health {
  ok: boolean;
  version: string;
  pid: number;
  uptimeSec: number;
  repos: { name: string; active: number }[];
}

export interface EligibleItem {
  source: string;
  belt: string;
  key: string;
  summary: string;
  type: string;
}

export interface TimelineEvent {
  ts: number;
  type: string;
  detail: string | null;
}

/** Result of a mutating action: ok, or a reason to show the user. */
export type ActionResult = { ok: true } | { ok: false; error: string };

/** Outcome of a POST whose BODY matters: `ok: true` means the call itself succeeded and `body` holds
 *  what the handler answered — which may still report a refusal of its own. The two levels are
 *  deliberate: `resume`/`retry-now` answer 200 with `{ ok: false, message }` for "nothing to do here",
 *  which a transport-only result would show as success. */
export type Posted<T> = { ok: true; body: T } | { ok: false; error: string };

/** Un-park an `attention` run (the engine refuses, with a `message`, for any other phase). */
export interface ResumeOutcome {
  ok: boolean;
  phase?: string;
  message?: string;
}

/** Clear suspensions and make waiting retries due now + flush them. `requeued` counts rows that
 *  were actually stuck; `unsuspended` is the subset that had suspended (10 failed attempts) and got
 *  a fresh window; `flushed` is false when a tick held the repo lock (that pass delivers them). */
export interface RetryNowOutcome {
  ok: boolean;
  requeued?: number;
  unsuspended?: number;
  flushed?: boolean;
  message?: string;
}

export interface ReloadOutcome {
  reached: boolean; // a server answered at all
  failures: { name: string; error: string }[]; // repos the server could NOT load after the reload
}

export type { RunObligations };
