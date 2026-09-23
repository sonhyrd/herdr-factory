// AN hf-review VERDICT ON A FACTORY-OWNED PR IS HANDED TO ITS SHIP RUN (issue #86). A review run
// (the `hf-review` belt) posts its findings as one PR review whose body carries marker lines —
// `<brand>-review-verdict: changes-requested|clean|unchanged|needs-human`, `<brand>-review-round: N`,
// `<brand>-review-head: <sha>` — and a numbered checklist (`- [ ] 1. **must-fix** …`). When a live run
// is watching that PR, the watch wakes its resolver with the findings, and once the fix is pushed the
// run re-runs its own gates over `reviewed-head..new-head` and posts the next round itself. The state
// is one watch_state row (run, 'pull_request', 'hf_review'): `sig` = the last review handled, `meta` =
// the HfReview below. Readers are brand-agnostic (the legacy `herdr-review:` marker too), like the
// claim ledger; writers emit the configured `source_comments.brand`.
import type { Deps } from "./deps.ts";
import type { Run } from "../types.ts";
import type { HfReview } from "./obligations-shape.ts";

export type { HfReview };

export const HF_REVIEW_WATCH = { step: "pull_request", watch: "hf_review" } as const;
/** Fix → self-check cycles one run does for review verdicts before the operator decides. */
export const MAX_SELF_CHECKS = 2;

export interface ReviewVerdict {
  /** Every verdict line's value (a round-3+ body carries `changes-requested` AND `needs-human`). */
  verdicts: string[];
  round: number | null;
  head: string | null;
  must: number;
  should: number;
  nit: number;
}


const MARKER = /^[ \t>]*(?:[A-Za-z0-9._-]+-review-(verdict|round|head)|herdr-review):[ \t]*(\S+)/gim;
const FINDING = /^[ \t]*(?:[-*][ \t]*)?(?:\[[ xX]\][ \t]*)?\d+[.)][ \t]+.*?\b(must-fix|should-fix|nit)\b/gim;

/** The review markers and finding counts in a PR review body; null when it carries no verdict. */
export function parseVerdict(body: string): ReviewVerdict | null {
  const v: ReviewVerdict = { verdicts: [], round: null, head: null, must: 0, should: 0, nit: 0 };
  for (const [, kind, value] of body.matchAll(MARKER)) {
    const val = value!.toLowerCase();
    if (!kind || kind.toLowerCase() === "verdict") v.verdicts.push(val);
    else if (kind.toLowerCase() === "round") v.round = Number.parseInt(val, 10) || null;
    else v.head = value!;
  }
  if (!v.verdicts.length) return null;
  for (const [, sev] of body.matchAll(FINDING)) {
    const s = sev!.toLowerCase();
    if (s === "must-fix") v.must++;
    else if (s === "should-fix") v.should++;
    else v.nit++;
  }
  return v;
}

/** Hand this verdict to the watching run? `changes-requested`, or `clean` that lists a should-fix.
 *  Never `unchanged`, nits-only `clean`, or anything already marked `needs-human`. */
export function wantsFix(v: ReviewVerdict): boolean {
  if (v.verdicts.includes("needs-human")) return false;
  return v.verdicts.includes("changes-requested") || (v.verdicts.includes("clean") && v.should > 0);
}

export function readHfReview(deps: Deps, run: Run): HfReview | null {
  const meta = deps.store.getWatchState(run.id, HF_REVIEW_WATCH.step, HF_REVIEW_WATCH.watch)?.meta;
  if (!meta) return null;
  try {
    const m = JSON.parse(meta) as Partial<HfReview>;
    return typeof m.phase === "string" ? (m as HfReview) : null;
  } catch {
    return null;
  }
}

export function writeHfReview(deps: Deps, run: Run, v: HfReview, handledReview?: string): void {
  deps.store.upsertWatchState(run.id, HF_REVIEW_WATCH.step, HF_REVIEW_WATCH.watch, {
    ...(handledReview !== undefined ? { sig: handledReview } : {}),
    meta: JSON.stringify(v),
  });
}

/** The resolver's brief for a verdict: fix every finding in one pass and map them to commits.
 *  When the PR has moved on but the reviewed commit is still an ancestor, name both SHAs. */
export function fixBrief(prNumber: number, reviewId: string, v: ReviewVerdict, body: string, prHead?: string): string {
  const moved = !!(prHead && v.head && !prHead.startsWith(v.head));
  return [
    "",
    `## Review findings to fix — round ${v.round ?? "?"} (review ${reviewId})`,
    "",
    `A factory review posted this verdict on PR #${prNumber}. It overrides the thread-by-thread steps above:`,
    "",
    ...(moved
      ? [
          `The review judged \`${v.head}\`. The PR is now at \`${prHead}\`. Apply each finding that still holds, and in the comment say which no longer apply.`,
          "",
        ]
      : []),
    "1. Fix **every** must-fix and should-fix finding below in this one pass, plus the nits that are cheap.",
    "   One focused commit per finding (or per group of findings that share a fix), then push.",
    `2. Post ONE PR comment that maps each finding number to its commit SHA, with a stated reason for anything you skipped (\`gh pr comment ${prNumber} --body-file <file>\`).`,
    "3. Do not re-review the result yourself and do not post a verdict — once you stop, the factory re-runs its evidence and review over what you pushed and posts the next round.",
    "",
    "<review>",
    body.trim(),
    "</review>",
    "",
  ].join("\n");
}

/** The note every verification step reads on a self-check pass. The LAST gate (the reviewer) posts
 *  the next round on the PR instead of bouncing. */
export function selfCheckNote(o: { prNumber: number; brand: string; hf: HfReview; newHead: string; last: boolean }): string {
  const { prNumber, brand, hf, newHead, last } = o;
  const range = hf.reviewedHead ? `${hf.reviewedHead}..${newHead}` : `the reviewed head..${newHead}`;
  const lines = [
    `**Self-check round ${hf.round} (${hf.fixes} of ${MAX_SELF_CHECKS}) for review round ${hf.round - 1}.** The resolver pushed fixes for`,
    `the review findings on PR #${prNumber}. Judge only what the fix changed: \`git diff ${range}\`.`,
    "An evidence step re-films only the acceptance criteria whose code or spec that diff touches, and carries the rest forward.",
  ];
  if (last) {
    lines.push(
      "",
      "You are the last gate, so post this pass as the next review round **instead of bouncing** — do not bounce on findings.",
      `Write the review body to a file; its first lines are the markers:`,
      "",
      "```",
      `<!-- ${brand}:review round ${hf.round} -->`,
      `${brand}-review-verdict: <changes-requested if any must-fix remains, else clean>`,
      `${brand}-review-round: ${hf.round}`,
      `${brand}-review-head: ${newHead}`,
      "```",
      "",
      hf.fixes >= MAX_SELF_CHECKS
        ? `This is the last self-check round: if a must-fix remains, add the line \`${brand}-review-verdict: needs-human\` and say plainly that the operator decides now.`
        : "If a must-fix remains, the factory hands your findings to the resolver for one more fix pass.",
      "Then the findings as a numbered checklist (`- [ ] 1. **must-fix** `file:line` — why — the fix`), should-fix and nits after the must-fix ones.",
      `Post it with \`gh pr review ${prNumber} --comment --body-file <file>\` (never \`--approve\`), then finish this step with step-done as usual.`,
    );
  }
  return lines.join("\n");
}
