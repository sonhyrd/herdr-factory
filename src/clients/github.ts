import { createHash } from "node:crypto";
import { run, runJson } from "./exec.ts";
import { countGithubCall } from "./github-budget.ts";
import type { PrInfo, PrSnapshot, PrState, ReviewSig } from "../types.ts";

interface ThreadsResp {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: { nodes?: { isResolved: boolean; comments?: { nodes?: { id: string }[] } }[] };
      };
    };
  };
}
interface CheckRollup {
  statusCheckRollup?: RollupContext[];
}

const FAILING = /FAIL|ERROR|TIMED_OUT|CANCELLED|FAILURE/;
/** Not concluded yet. A CheckRun reports `conclusion: null` until it finishes, a StatusContext
 *  reports state PENDING/EXPECTED — both land here, and both mean "not green YET". */
const PENDING = /^(|PENDING|EXPECTED|QUEUED|IN_PROGRESS|WAITING|REQUESTED|ACTION_REQUIRED)$/;

type RollupContext = { name?: string; context?: string; conclusion?: string | null; state?: string | null };

/** Split a status-check rollup into the failing check NAMES (they feed the signature hash, so the
 *  resolver re-wakes when WHICH check is red changes) and a count of checks still running. Shared by
 *  the batched GraphQL path and the single-PR path so both agree bit-for-bit. */
function rollupCounts(contexts: RollupContext[]): { failing: string[]; pending: number } {
  const verdict = (c: RollupContext) => c.conclusion ?? c.state ?? "";
  return {
    failing: contexts.filter((c) => FAILING.test(verdict(c))).map((c) => c.name ?? c.context ?? "check"),
    pending: contexts.filter((c) => PENDING.test(verdict(c))).length,
  };
}

/** GitHub's ISO-8601 timestamps → epoch SECONDS (the clock the store and `Run.createdAt` use);
 *  undefined for a missing/unparseable value, so a caller can tell "older than the run" from
 *  "unknown" instead of treating an absent field as 1970. */
function epochSeconds(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
}

/** Read-only GitHub queries via the `gh` CLI (uses the user's gh auth). */
export class GitHubClient {
  private readonly gh: string;
  private login?: string | null; // memoized authenticated login (null = looked up, unavailable)
  constructor(gh: string = "gh") {
    this.gh = gh;
  }

  /** Every `gh` invocation goes through these two, so the account's budget has ONE place that
   *  counts what the CLI transport spent — the REST client's buckets never see these calls, but
   *  GitHub's per-account limit does. */
  private run(args: string[], opts: { allowFail?: boolean } = {}) {
    countGithubCall("cli");
    return run(this.gh, args, opts);
  }

  private runJson<T>(args: string[], opts: { allowFail?: boolean } = {}): Promise<T> {
    countGithubCall("cli");
    return runJson<T>(this.gh, args, opts);
  }

  /** The authenticated gh user's login (e.g. for the per-user evidence folder). Memoized; returns
   *  null when it can't be determined (gh missing / not authenticated). */
  async currentLogin(): Promise<string | null> {
    if (this.login !== undefined) return this.login;
    const r = await this.run(["api", "user", "--jq", ".login"], { allowFail: true });
    this.login = r.code === 0 ? r.stdout.trim() || null : null;
    return this.login;
  }

  /** Discover a PR by its head branch. Used only for the FIRST sighting of a run's PR (before we've
   *  recorded its number) — `--head` stops matching once the head branch is deleted, so once a number
   *  is known callers poll `prByNumber` instead, which survives head-branch deletion on merge.
   *
   *  `createdAt` rides along because a head branch name is NOT unique over time: a re-claim, or a
   *  branch an agent renamed to the repo's convention (no per-claim uid), can resolve to a PREVIOUS
   *  attempt's already-merged PR. The caller compares it against the run's own start before adopting
   *  (see reconcile's currentPr). */
  async prForBranch(repo: string, branch: string): Promise<PrInfo | null> {
    type Row = { number: number; state: string; url: string; isDraft: boolean; createdAt?: string };
    const arr = await this.runJson<Row[]>(
      ["pr", "list", "--repo", repo, "--head", branch, "--state", "all", "--json", "number,state,url,isDraft,createdAt", "--limit", "1"],
      { allowFail: true },
    ).catch(() => [] as Row[]);
    const first = arr[0];
    return first
      ? { number: first.number, state: first.state as PrState, url: first.url, isDraft: !!first.isDraft, createdAt: epochSeconds(first.createdAt) }
      : null;
  }

  /** Look up a PR by number — the durable identity once a run has adopted one. Unlike `--head`,
   *  this keeps resolving after the head branch is deleted (e.g. GitHub auto-delete-on-merge). */
  async prByNumber(repo: string, prNumber: number): Promise<PrInfo | null> {
    const pr = await this.runJson<{ number: number; state: string; url: string; isDraft: boolean; title?: string }>(
      ["pr", "view", String(prNumber), "--repo", repo, "--json", "number,state,url,isDraft,title"],
      { allowFail: true },
    ).catch(() => null);
    return pr && pr.number ? { number: pr.number, state: pr.state as PrState, url: pr.url, isDraft: !!pr.isDraft, title: pr.title } : null;
  }

  /**
   * State + review signature for MANY PRs in one GraphQL request (chunked at 25/query, aliased
   * `pr<n>` fields). This is what keeps the reviewing watch inside GitHub's rate budget at scale:
   * per tick it replaces 3 `gh` calls per watched PR with ~1 call total. PRs that don't resolve
   * are simply absent from the returned map. The signature hash is bit-identical to
   * reviewSignature's, so runs freely mix batched and direct polling.
   */
  async prSnapshots(repo: string, prNumbers: number[]): Promise<Map<number, PrSnapshot>> {
    const slash = repo.indexOf("/");
    const owner = repo.slice(0, slash);
    const name = repo.slice(slash + 1);
    const out = new Map<number, PrSnapshot>();

    const CHUNK = 25;
    for (let i = 0; i < prNumbers.length; i += CHUNK) {
      const chunk = prNumbers.slice(i, i + CHUNK);
      const fields = chunk
        .map(
          (n) =>
            `pr${n}: pullRequest(number: ${n}) { number state url isDraft title ` +
            `reviewThreads(first: 100) { nodes { isResolved comments(last: 1) { nodes { id } } } } ` +
            `commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { ` +
            `__typename ... on CheckRun { name conclusion } ... on StatusContext { context state } } } } } } } }`,
        )
        .join(" ");
      const query = `query($owner:String!,$name:String!){ repository(owner:$owner,name:$name){ ${fields} } }`;
      interface BatchPr {
        number: number;
        state: string;
        url: string;
        isDraft?: boolean;
        title?: string;
        reviewThreads?: { nodes?: { isResolved: boolean; comments?: { nodes?: { id: string }[] } }[] };
        commits?: {
          nodes?: {
            commit?: {
              statusCheckRollup?: { contexts?: { nodes?: { name?: string; conclusion?: string; context?: string; state?: string }[] } } | null;
            };
          }[];
        };
      }
      // allowFail: a missing PR makes gh exit non-zero while still printing the partial data —
      // use whatever resolved and let absent entries stay absent.
      const resp = await this.runJson<{ data?: { repository?: Record<string, BatchPr | null> } }>(
        ["api", "graphql", "-f", `query=${query}`, "-F", `owner=${owner}`, "-F", `name=${name}`],
        { allowFail: true },
      ).catch(() => ({}) as { data?: { repository?: Record<string, BatchPr | null> } });
      for (const pr of Object.values(resp.data?.repository ?? {})) {
        if (!pr || typeof pr.number !== "number") continue;
        const unresolvedIds = (pr.reviewThreads?.nodes ?? [])
          .filter((t) => t.isResolved === false)
          .map((t) => t.comments?.nodes?.[0]?.id ?? "x");
        const { failing, pending } = rollupCounts(pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? []);
        const sig = createHash("sha1").update(JSON.stringify({ t: unresolvedIds, c: failing })).digest("hex");
        out.set(pr.number, {
          number: pr.number,
          state: pr.state as PrState,
          url: pr.url,
          isDraft: !!pr.isDraft,
          title: pr.title,
          sig: { unresolved: unresolvedIds.length, failing: failing.length, pending, sig },
        });
      }
    }
    return out;
  }

  async reviewSignature(repo: string, prNumber: number): Promise<ReviewSig> {
    const slash = repo.indexOf("/");
    const owner = repo.slice(0, slash);
    const name = repo.slice(slash + 1);

    const query =
      "query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){reviewThreads(first:100){nodes{isResolved comments(last:1){nodes{id}}}}}}}";
    const threads = await this.runJson<ThreadsResp>(
      ["api", "graphql", "-f", `query=${query}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `n=${prNumber}`],
      { allowFail: true },
    ).catch(() => ({}) as ThreadsResp);
    const unresolvedIds = (threads.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [])
      .filter((t) => t.isResolved === false)
      .map((t) => t.comments?.nodes?.[0]?.id ?? "x");

    const rollup = await this.runJson<CheckRollup>(
      ["pr", "view", String(prNumber), "--repo", repo, "--json", "statusCheckRollup"],
      { allowFail: true },
    ).catch(() => ({}) as CheckRollup);
    const { failing, pending } = rollupCounts(rollup.statusCheckRollup ?? []);

    const sig = createHash("sha1").update(JSON.stringify({ t: unresolvedIds, c: failing })).digest("hex");
    return { unresolved: unresolvedIds.length, failing: failing.length, pending, sig };
  }
}
