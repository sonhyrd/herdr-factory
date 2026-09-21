// The claim ledger (INV-10's multi-factory escape): several factories — one per host, each with its
// own DB — may poll ONE source backend when that source's `claim_guard` is enabled. Local claiming
// still runs under the tick lock + the v25 unique index; this adds a cross-host arbiter on the
// tracker itself, using the item's comment stream as an append-only ledger:
//
//   1. post `[<brand> claim id=<runId> host=<host>]` (brand = `source_comments.brand`, default
//      `herdr-factory`; host = `claim_guard.host` ?? machine.yml's `host_alias` ?? os.hostname())
//   2. wait `settle_ms`, re-read the comments
//   3. among claims with no matching `[<brand> release id=<runId> host=<host>]`, the LOWEST
//      server-assigned comment id wins — ids are monotonic, so every factory computes the same winner
//   4. loser: post its release, delete its (still pristine) run row, log `claimed elsewhere by <host>`
//   (an item that already shows another open claim is skipped before step 1 — nothing is posted)
//
// A winner posts its release at teardown. ANOTHER host's dead claim is NEVER cleared automatically
// (fence, never reap): only a human posting the release comment frees the item. Our OWN stale claims
// are the exception — a claim by THIS host whose run no longer exists locally (crash, teardown that
// could not post its release) is released before arbitrating, because this factory is the authority
// on its own runs: it can see the row is gone. Nothing else can free those, and left open they fence
// the item against every host, forever.
//
// ROLLOUT: the ledger is parsed brand-agnostically (LEDGER_RE) and a host's pre-alias hostname folds
// onto its alias (LedgerView) — so a half-migrated fleet, whichever half wrote a line, arbitrates on
// one shared ledger and two hosts never both think they own an item.
import type { Deps, SourceRuntime } from "./deps.ts";
import type { Run } from "../types.ts";
import { DEFAULT_BRAND } from "./deps.ts";

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

/** How a READER identifies ITSELF in the ledger: every `aliases` token is folded onto `host`, so a
 *  claim this host posted under its raw hostname is recognised as its own once `host_alias` renames
 *  it. Without the folding a host would see its own old claim as a foreign one and both sides would
 *  fence. Read-side only — what gets WRITTEN always carries the token as observed (see readLedger).
 *  There is deliberately no `brand` here: the ledger is parsed brand-agnostically (see LEDGER_RE). */
export interface LedgerView {
  host?: string;
  aliases?: readonly string[];
}

/** The ledger grammar, with ANY token in the brand position — the one place where the brand is
 *  purely cosmetic.
 *
 *  A fleet flips `source_comments.brand` host by host (it is per-host config), so during a rollout
 *  one host writes `[hf claim …]` while its neighbour still writes `[herdr-factory claim …]`. If a
 *  reader only accepted brands it can NAME, the un-flipped host would be blind to the flipped one's
 *  claims and both would claim the same item — two worktrees, two agents, two PRs, which is the one
 *  outcome this whole file exists to prevent. Accepting any brand token costs nothing: the rest of
 *  the grammar (`claim|release id=<n> host=<token>` inside one pair of brackets) is distinctive
 *  enough that nothing else writes it, and quoted lines are stripped before matching.
 *
 *  This is NOT the rule for `bearsHerdrMarker` (INV-6): that path has no distinctive grammar, so a
 *  bare `[<anything>]` would swallow a human's own bracketed text. It stays anchored to the
 *  configured + legacy brands. */
const LEDGER_RE = /\[[A-Za-z0-9._-]+ (claim|release) id=(\d+) host=([A-Za-z0-9._-]+)\]/g;

export const claimMarker = (t: ClaimTag, brand: string = DEFAULT_BRAND): string => `[${brand} claim id=${t.runId} host=${t.host}]`;
export const releaseMarker = (t: ClaimTag, brand: string = DEFAULT_BRAND): string => `[${brand} release id=${t.runId} host=${t.host}]`;

/** One parsed, still-open claim: `host` CANONICAL (alias-folded, what ownership is decided on) and
 *  `rawHost` exactly as the line spelled it — what a release for it must be WRITTEN with. */
export type OpenClaim = ClaimTag & { commentId: number; rawHost: string };

/** Every open claim (no matching release), lowest comment id first. Pure. Quoted (`> `) lines are
 *  ignored, so a human quoting a claim neither claims nor releases anything. */
export function openClaims(comments: readonly LedgerComment[], view?: LedgerView): OpenClaim[] {
  const canon = (h: string): string => (view?.host && view.aliases?.includes(h) ? view.host : h);
  const released = new Set<string>();
  const claims: OpenClaim[] = [];
  for (const c of comments) {
    const text = c.body
      .split(/\r?\n/)
      .filter((l) => !l.trimStart().startsWith(">"))
      .join("\n");
    for (const m of text.matchAll(LEDGER_RE)) {
      const rawHost = m[3]!;
      const tag = { runId: Number(m[2]), host: canon(rawHost), rawHost };
      if (m[1] === "release") released.add(`${tag.runId}@${tag.host}`);
      else claims.push({ ...tag, commentId: Number(c.id) });
    }
  }
  const open = claims.filter((c) => !released.has(`${c.runId}@${c.host}`));
  open.sort((a, b) => a.commentId - b.commentId);
  return open;
}

/** The open claim with the lowest comment id, or null when none is open. Pure. */
export function claimWinner(comments: readonly LedgerComment[], view?: LedgerView): OpenClaim | null {
  return openClaims(comments, view)[0] ?? null;
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
  const brand = deps.config.sourceComments.brand;
  const isMe = (t: ClaimTag | null): boolean => !!t && t.runId === me.runId && t.host === me.host;
  let winner: ClaimTag | null;
  let posted = false;
  try {
    winner = await readLedger(deps, src, run.ticketKey);
    if (!winner) {
      posted = true;
      await src.client.postClaimComment!(run.ticketKey, claimMarker(me, brand));
      await deps.sleep(src.claimGuard.settleMs);
      winner = await readLedger(deps, src, run.ticketKey);
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

/** Is this run still ours to hold a claim for? A row that is gone (crash, DB reset) or already ended
 *  (a teardown whose release post failed) is not — its claim is stale. */
function claimIsLive(deps: Deps, runId: number): boolean {
  const run = deps.store.getRun(runId);
  return !!run && run.endedAt === null;
}

/** Read the ledger, first releasing any claim THIS host holds for a run that no longer exists locally
 *  (see the header) — so a crashed or half-torn-down factory stops fencing the item, for itself and
 *  for every other host. Returns the open claim that wins after those releases. */
async function readLedger(deps: Deps, src: SourceRuntime & { claimGuard: NonNullable<SourceRuntime["claimGuard"]> }, key: string): Promise<OpenClaim | null> {
  const host = src.claimGuard.host;
  const brand = deps.config.sourceComments.brand;
  const open = openClaims(await src.client.listClaimComments!(key), { host, aliases: src.claimGuard.hostAliases });
  const stale = open.filter((c) => c.host === host && !claimIsLive(deps, c.runId));
  for (const tag of stale) {
    // Written with the host token AS OBSERVED, not the folded one: alias folding is a READ-side
    // courtesy so we recognise our own pre-rename claims. Releasing `host=<hostname>` as
    // `host=<alias>` would pair only in OUR view — every other host reads two different hosts, never
    // pairs them, and stays fenced on the item forever (the very thing this file swears never to do).
    await src.client.postClaimComment!(key, releaseMarker({ runId: tag.runId, host: tag.rawHost }, brand));
    deps.log("info", `${key}: released our own stale claim (run ${tag.runId} no longer exists here)`);
  }
  return open.find((c) => !stale.includes(c)) ?? null;
}

/** Post this run's release marker. Best-effort: a failure is logged loudly (the claim then stays open
 *  and blocks other hosts until a human posts the release — never reaped). */
export async function releaseClaim(deps: Deps, src: SourceRuntime, run: Run): Promise<void> {
  if (!guarded(src)) return;
  const tag = { runId: run.id, host: src.claimGuard.host };
  const brand = deps.config.sourceComments.brand;
  try {
    await src.client.postClaimComment!(run.ticketKey, releaseMarker(tag, brand));
  } catch (e) {
    deps.log("error", `${run.ticketKey}: could not post claim release (post "${releaseMarker(tag, brand)}" by hand to free the item): ${e instanceof Error ? e.message : String(e)}`);
  }
}
