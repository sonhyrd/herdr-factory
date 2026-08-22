// What the operator sees on a run's pane — published as herdr DISPLAY METADATA, never by renaming.
//
// The factory used to `agent rename` a pane to `<step>:<KEY>` (and `⚠ ATTENTION <KEY>` on a park).
// That wrote the pane's REAL label, which is also the handle a step's `pane:` target resolves by, so
// the first dispatch destroyed the name every later dispatch had to find the pane under. herdr 0.7.5
// added a display-only metadata channel (`pane report-metadata`: an agent-name override, a title
// override, and machine-readable tokens, all namespaced per reporter), so the two concerns separate:
// the layout owns `label` for good, and the factory decorates.
//
// The tokens are the part a user can build on: herdr's sidebar rows render per-token (with 0.7.5's
// per-token fg/bold/dim styling) and its agent-view queries can filter and sort on them, so a
// factory-driven "what is every run doing" view needs no factory UI.

import type { Deps } from "./deps.ts";
import type { Run } from "../types.ts";

/** Token names published on every factory-owned pane. Prefixed so they can't collide with another
 *  plugin's tokens in a shared `[ui.sidebar]` row config. */
export const PANE_TOKENS = {
  /** The work item's canonical key. */
  key: "hf_key",
  /** The belt step that owns the pane right now. */
  step: "hf_step",
  /** Coarse run posture — the value a sidebar/agent-view query filters on. */
  state: "hf_state",
} as const;

/** Coarse posture of the run behind a pane, as published in the `hf_state` token. */
export type PaneRunState = "running" | "attention" | "watching";

/** Publish `state` for a run's pane. Best-effort: display state must never fail a tick, so a herdr
 *  hiccup here is swallowed exactly like the rename it replaces.
 *
 *  The alarm state is the one that also overrides the pane TITLE: herdr's `agent_status` is owned by
 *  the agent's own lifecycle hook and can't be set externally, so a parked run needs a cue that
 *  outlives the tick — while a healthy pane leaves the title alone and lets the agent's own terminal
 *  title show through. */
/** Deliver an operator-facing ERROR REPORT into the run's own agent pane — where the work actually
 *  happened, and where the operator is already looking. This is the reporting channel for
 *  MECHANICAL failures (factory workings: budgets, stalls, evidence uploads, logins, suspensions):
 *  a ticket comment about factory plumbing is noise to whoever reads the ticket, and a note file in
 *  a hidden folder is where nobody looks. The text is submitted as a pane message (herdr
 *  `agentSend`), framed explicitly as a report so the agent does not treat it as a task — the
 *  factory's own machinery (resume, retry-now, the auth probes) owns recovery.
 *
 *  Best-effort by design: returns false when the run has no pane or herdr could not submit — the
 *  caller's desktop notification (sent regardless) is the fallback channel. */
export async function reportToPane(deps: Deps, run: Pick<Run, "paneId" | "ticketKey">, body: string): Promise<boolean> {
  if (!run.paneId) return false;
  const text = `[herdr-factory report — for the operator; no action needed] ${body}`;
  try {
    return await deps.herdr.agentSend(run.paneId, text);
  } catch {
    return false;
  }
}

export async function showRunPane(
  deps: Deps,
  paneId: string,
  s: { key: string; step?: string | null; state: PaneRunState },
): Promise<void> {
  const step = s.step ?? "watch";
  try {
    await deps.herdr.reportPaneDisplay(paneId, {
      agentName: `${step}:${s.key}`,
      ...(s.state === "attention" ? { title: `⚠ ATTENTION ${s.key}` } : { clearTitle: true }),
      tokens: { [PANE_TOKENS.key]: s.key, [PANE_TOKENS.step]: step, [PANE_TOKENS.state]: s.state },
    });
  } catch {
    /* display state is never worth failing a tick over */
  }
}
