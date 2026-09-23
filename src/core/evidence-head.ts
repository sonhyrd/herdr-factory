// EVIDENCE BELONGS TO A HEAD (issue #84). A run in the PR watch vouches for its PR because its
// read-only gates (evidence, review, a read-only custom step between them) judged a commit. When the
// PR head moves past that commit — a resolver fixing a review thread, the pr step fixing CI — the
// verdict no longer covers what would be merged. This module answers "does it still?" and records
// the answer on one watch_state row (run, 'pull_request', 'evidence_head'): `sig` = the PR head it
// looked at, `meta` = { evidenceHead, stale, files }. The reconciler's PR watch acts on it (sends
// the run back through its gates); the ready-to-merge notification, the board and `explain` read it.
import type { StepConfig } from "../config.ts";
import type { Deps } from "./deps.ts";
import type { Run } from "../types.ts";

export const EVIDENCE_WATCH = { step: "pull_request", watch: "evidence_head" } as const;

export interface EvidenceHead {
  /** The commit the gates judged (the first gate's pinned read-only HEAD). */
  evidenceHead: string;
  /** The PR head this verdict was computed against. */
  prHead: string;
  /** A code change sits between the two — the evidence and review no longer cover the PR. */
  stale: boolean;
  /** The paths that changed since evidenceHead (capped at 20). */
  files: string[];
}

// ponytail: path-based, so a comment-only edit under src/ counts as code. A per-repo knob when a
// repo keeps prose somewhere these don't match.
const NON_CODE = [/\.(md|mdx|markdown|rst|adoc|txt)$/i, /(^|\/)(docs|locales|i18n|translations)\//i];
export const isNonCode = (path: string): boolean => NON_CODE.some((re) => re.test(path));

/** The gates that vouch for a PR head: the contiguous read-only steps right before the belt's
 *  PR-opening step. Empty ⇒ the belt has nothing to re-run, and the watch behaves as before. */
export function verificationSteps(steps: readonly StepConfig[]): StepConfig[] {
  const pr = steps.findIndex((s) => s.opensPr);
  if (pr < 0) return [];
  let i = pr;
  while (i > 0 && steps[i - 1]!.readOnly) i--;
  return steps.slice(i, pr);
}

export function readEvidenceHead(row: { sig: string | null; meta: string } | undefined): EvidenceHead | null {
  if (!row?.sig || !row.meta) return null;
  try {
    const m = JSON.parse(row.meta) as Partial<EvidenceHead>;
    return typeof m.evidenceHead === "string" ? { evidenceHead: m.evidenceHead, prHead: row.sig, stale: m.stale === true, files: m.files ?? [] } : null;
  } catch {
    return null;
  }
}

/** Compare the head the gates judged with the PR's head and record the verdict. Null when there is
 *  nothing to compare (no gates, no pinned head, no PR head). A diff git cannot compute (the head
 *  was pushed from elsewhere and a fetch didn't bring it) counts as a code change. */
export async function observeEvidenceHead(deps: Deps, run: Run, gates: readonly StepConfig[], prHead: string | undefined): Promise<EvidenceHead | null> {
  const wt = run.worktreePath;
  const evidenceHead = gates[0] ? deps.store.getWatchState(run.id, gates[0].name, "read_only")?.sig : null;
  if (!evidenceHead || !prHead || !wt) return null;
  const prev = readEvidenceHead(deps.store.getWatchState(run.id, EVIDENCE_WATCH.step, EVIDENCE_WATCH.watch));
  if (prev && prev.prHead === prHead && prev.evidenceHead === evidenceHead) return prev;

  let files: string[] | null = [];
  if (evidenceHead !== prHead) {
    files = await deps.git.changedFiles(wt, evidenceHead, prHead);
    if (files == null && run.branch && (await deps.git.fetchRef(wt, "origin", run.branch))) files = await deps.git.changedFiles(wt, evidenceHead, prHead);
  }
  const v: EvidenceHead = { evidenceHead, prHead, stale: files == null || files.some((f) => !isNonCode(f)), files: (files ?? []).slice(0, 20) };
  deps.store.upsertWatchState(run.id, EVIDENCE_WATCH.step, EVIDENCE_WATCH.watch, {
    sig: prHead,
    meta: JSON.stringify({ evidenceHead, stale: v.stale, files: v.files }),
  });
  return v;
}
