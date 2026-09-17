// The claim ledger (INV-10's multi-factory escape): several factories — one per host, each with its
// own DB — may poll ONE source backend when that source's `claim_guard` is enabled. Local claiming
// still runs under the tick lock + the v25 unique index; this adds a cross-host arbiter on the
// tracker itself, using the item's comment stream as an append-only ledger:
//
//   1. post `[herdr-factory claim id=<runId> host=<host>]`
//   2. wait `settle_ms`, re-read the comments
//   3. among claims with no matching `[herdr-factory release id=<runId> host=<host>]`, the LOWEST
//      server-assigned comment id wins — ids are monotonic, so every factory computes the same winner
//   4. loser: post its release, delete its (still pristine) run row, log `claimed elsewhere by <host>`
//   (an item that already shows another open claim is skipped before step 1 — nothing is posted)
//
// A winner posts its release at teardown. A dead winner's claim is NEVER cleared automatically (fence,
// never reap): only a human posting the release comment frees the item.
import type { Deps, SourceRuntime } from "./deps.ts";
import type { Run } from "../types.ts";
import { HERDR_MARKER } from "./deps.ts";

/** A comment as the ledger sees it: the server-assigned id (numeric string) + its plain text. */
export interface LedgerComment {
  id: string;
  body: string;
}

export interface ClaimTag {
  runId: number;
  host: string;
}

/** Hosts are embedded in the marker and re-parsed, so they are restricted to a token-safe charset
 *  (enforced at config load). */
export const CLAIM_HOST_RE = /^[A-Za-z0-9._-]+$/;
const LEDGER_RE = /\[herdr-factory (claim|release) id=(\d+) host=([A-Za-z0-9._-]+)\]/g;

export const claimMarker = (t: ClaimTag): string => `${HERDR_MARKER} claim id=${t.runId} host=${t.host}]`;
export const releaseMarker = (t: ClaimTag): string => `${HERDR_MARKER} release id=${t.runId} host=${t.host}]`;

/** The open claim with the lowest comment id, or null when none is open. Pure. Quoted (`> `) lines are
 *  ignored, so a human quoting a claim neither claims nor releases anything. */
export function claimWinner(comments: readonly LedgerComment[]): (ClaimTag & { commentId: number }) | null {
  const released = new Set<string>();
  const claims: (ClaimTag & { commentId: number })[] = [];
  for (const c of comments) {
    const text = c.body
      .split(/\r?\n/)
      .filter((l) => !l.trimStart().startsWith(">"))
      .join("\n");
    for (const m of text.matchAll(LEDGER_RE)) {
      const tag = { runId: Number(m[2]), host: m[3]! };
      if (m[1] === "release") released.add(`${tag.runId}@${tag.host}`);
      else claims.push({ ...tag, commentId: Number(c.id) });
    }
  }
  const open = claims.filter((c) => !released.has(`${c.runId}@${c.host}`));
  open.sort((a, b) => a.commentId - b.commentId);
  return open[0] ?? null;
}

/** Is the guard active for this source? Needs both the config switch and the source's comment hooks. */
export function guarded(src: SourceRuntime): src is SourceRuntime & { claimGuard: NonNullable<SourceRuntime["claimGuard"]> } {
  return !!src.claimGuard && !!src.client.postClaimComment && !!src.client.listClaimComments;
}

/**
 * Arbitrate a fresh claim on the tracker. Called right after the run row insert and BEFORE any
 * worktree, agent, or status write, so losing costs nothing. Returns null when this run won; the
 * winning claim when it lost (the run row is already deleted). Throws on a backend failure — after
 * best-effort releasing and deleting the row, so the next pass retries from scratch.
 *
 * An item that already carries another factory's open claim is skipped WITHOUT posting: a dead
 * winner's claim stays open forever, and re-posting claim + release every tick would bury the ticket.
 */
export async function arbitrateClaim(deps: Deps, src: SourceRuntime, run: Run): Promise<ClaimTag | null> {
  if (!guarded(src)) return null;
  const me: ClaimTag = { runId: run.id, host: src.claimGuard.host };
  const isMe = (t: ClaimTag | null): boolean => !!t && t.runId === me.runId && t.host === me.host;
  let winner: ClaimTag | null;
  let posted = false;
  try {
    winner = claimWinner(await src.client.listClaimComments!(run.ticketKey));
    if (!winner) {
      posted = true;
      await src.client.postClaimComment!(run.ticketKey, claimMarker(me));
      await deps.sleep(src.claimGuard.settleMs);
      winner = claimWinner(await src.client.listClaimComments!(run.ticketKey));
    }
  } catch (e) {
    if (posted) await releaseClaim(deps, src, run);
    deps.store.deleteClaimingRun(run.id);
    throw e;
  }
  if (isMe(winner)) return null;
  // Lost — or our own claim isn't visible yet, which is never a win.
  if (posted) await releaseClaim(deps, src, run);
  deps.store.deleteClaimingRun(run.id);
  return winner ?? me;
}

/** Post this run's release marker. Best-effort: a failure is logged loudly (the claim then stays open
 *  and blocks other hosts until a human posts the release — never reaped). */
export async function releaseClaim(deps: Deps, src: SourceRuntime, run: Run): Promise<void> {
  if (!guarded(src)) return;
  const tag = { runId: run.id, host: src.claimGuard.host };
  try {
    await src.client.postClaimComment!(run.ticketKey, releaseMarker(tag));
  } catch (e) {
    deps.log("error", `${run.ticketKey}: could not post claim release (post "${releaseMarker(tag)}" by hand to free the item): ${e instanceof Error ? e.message : String(e)}`);
  }
}
