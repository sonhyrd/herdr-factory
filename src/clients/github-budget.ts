// PROCESS-WIDE GitHub REST budget. Module singletons on purpose: every repo runtime in this
// process spends the same authenticated user's rate budget (one PAT / gh login), so per-instance
// buckets would multiply the pressure by the repo count.
//
// What this layer actually guarantees (docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api):
//  - reads: BURST SMOOTHING ONLY. The 5,000 req/hr primary is NOT enforced here — it is shared
//    with the gh-CLI PR watcher and the operator's own tooling, none of which flow through these
//    buckets. Primary exhaustion is handled reactively instead: the client treats a rate-limit
//    error whose reset is far away as non-retryable and fails fast to the poll/outbox backoffs.
//  - mutations (comments, labels, close): kept under BOTH documented secondary caps — 80/min and
//    500/hr — by chaining two buckets. A per-minute bucket alone would allow ~3,600/hr.
// httpWithPolicy acquires the buckets per attempt (retries included) and records the wait time
// (herdr_factory.rate_limit.wait_ms, labeled by host), so back-pressure is visible.
import { TokenBucket } from "./http.ts";

/** Reads: 5/s sustained, burst 10 — smooths a claim-heavy tick's GET fan-out into a steady
 *  trickle. (Burst shaping only; see the header for what is NOT enforced.) */
export const githubReadBucket = new TokenBucket(5, 10);

/** Mutations: chained per-minute AND per-hour caps. The hourly bucket's sustained rate leaves
 *  room for its own burst — a bucket starts FULL, so rate 500/3600 + burst 10 could admit 510 in
 *  a rolling hour; (500 - 10)/3600 + burst 10 stays ≤ 500 in every window. */
const githubMutationMinuteBucket = new TokenBucket(1, 2); // ~60/min sustained vs the 80/min cap
const githubMutationHourBucket = new TokenBucket((500 - 10) / 3600, 10);

export const GITHUB_MUTATION_BUCKETS = [githubMutationMinuteBucket, githubMutationHourBucket] as const;

/** How a GitHub call was made. Both spend the SAME account budget, and only one of them rides the
 *  buckets above — so an operator chasing "who ate the 5,000" needs them counted apart:
 *  `rest` = the github_issues source's own REST calls; `cli` = the PR watcher's `gh` invocations. */
export type GithubCaller = "rest" | "cli";

// Process-wide counters, monotonic for the process lifetime. Callers report DELTAS (reconcile logs
// the spend per tick) rather than the absolutes, so nothing has to reset them.
const calls: Record<GithubCaller, number> = { rest: 0, cli: 0 };

export function countGithubCall(via: GithubCaller): void {
  calls[via] += 1;
}

/** A snapshot of the counters — subtract two snapshots for the spend over an interval. */
export function githubCallCounts(): Readonly<Record<GithubCaller, number>> {
  return { ...calls };
}
