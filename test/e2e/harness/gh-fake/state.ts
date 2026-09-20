// Scenario-facing control surface for the fake `gh` CLI (./gh). A scenario mutates PR state through
// `GhFake` and asserts against the argv log the shim appends on every invocation. The shim reads the
// state file fresh on every call, so a mutation here is visible to the very next engine tick — no
// restart, no server reload. See ./README.md for the argv shapes and the file formats.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** One CI check on a PR. `conclusion: null` = still running (pending); the engine's failing-check
 *  test is case-SENSITIVE (/FAIL|ERROR|TIMED_OUT|CANCELLED|FAILURE/ against `conclusion ?? state`),
 *  so use UPPERCASE GitHub vocabulary: SUCCESS, FAILURE, TIMED_OUT, CANCELLED, SKIPPED, NEUTRAL. */
export interface GhCheck {
  name: string;
  conclusion: string | null;
  /** GraphQL union member to render as. Default `CheckRun` (carries `name`/`conclusion`);
   *  `StatusContext` renders as `context`/`state`, which exercises the engine's other branch. */
  kind?: "CheckRun" | "StatusContext";
}

/** One review thread. The engine counts UNRESOLVED threads and hashes their last comment id, so the
 *  id is what makes a new review round distinguishable from the previous one. */
export interface GhThread {
  id: string;
  isResolved: boolean;
}

export interface GhPr {
  number: number;
  /** UPPERCASE, exactly as `gh` reports it — the engine compares against "OPEN"/"MERGED"/"CLOSED". */
  state: "OPEN" | "MERGED" | "CLOSED";
  url: string;
  /** A draft PR is adopted but keeps the step-done gate — it never hands off to the review watch. */
  isDraft: boolean;
  /** ISO-8601, stamped when the fake creates the PR. First-sighting adoption refuses a PR OLDER than
   *  the run (a previous attempt's PR on a reused head-branch name), so a seeded PR that omits this
   *  reads as "unknown age" and is accepted, while one the run opens is genuinely newer. */
  createdAt?: string;
  headRefName: string;
  /** The head commit SHA. The ready-to-merge watch keys its "already notified" mark on it, so a
   *  `push()` is a new green even here, where the fake repo has no checks at all. */
  headRefOid?: string;
  title: string;
  body: string;
  base: string;
  labels: string[];
  reviewers: string[];
  assignees: string[];
  threads: GhThread[];
  checks: GhCheck[];
}

/** Runtime failure/latency injection. The shim re-reads this on every invocation, so unlike the
 *  HF_GH_* env vars (fixed when `serve` spawned the shim's parent) a scenario can turn these on and
 *  off mid-run. `sleepFor`/`fail`/`failOnce` take a subcommand name, a comma-separated list, or `*`. */
export interface GhInject {
  /** Delay every matching call by this many ms — after the log line is written, so a call the engine
   *  kills on its 60s exec timeout is still visible to the suite. */
  sleepMs?: number;
  sleepFor?: string;
  /** Fail every matching call. */
  fail?: string;
  /** Fail the FIRST matching call per subcommand, then behave normally. */
  failOnce?: string;
}

export interface GhState {
  /** What `gh api user --jq .login` prints (the evidence publisher's per-user folder). */
  login: string;
  /** `owner/name`, as the engine passes it to `--repo`. */
  repo: string;
  /** The number `gh pr create` allocates next. */
  nextNumber: number;
  /** Keyed by PR number as a string. */
  prs: Record<string, GhPr>;
  /** Absent = no injection. */
  inject?: GhInject;
}

/** One line of the JSONL call log ($HF_GH_LOG) — how the suite asserts call budgets. */
export interface GhCall {
  ts: number;
  argv: string[];
  /** Stable classification: "api graphql" | "api user" | "pr list" | "pr view" | "pr create" |
   *  "pr checks" | "auth" | "other". */
  subcommand: string;
  exitCode: number;
}

export function initialGhState(opts: { repo: string; login?: string }): GhState {
  return { login: opts.login ?? "factory-bot", repo: opts.repo, nextNumber: 1, prs: {} };
}

/** Reads/writes the fake gh's JSON state file and reads its JSONL call log. Every method touches the
 *  filesystem — there is no cached copy, because the shim is a separate process that may have moved
 *  state (a `gh pr create` from an agent pane) since the last read. */
export class GhFake {
  readonly statePath: string;
  readonly logPath: string;

  constructor(paths: { statePath: string; logPath: string }) {
    this.statePath = paths.statePath;
    this.logPath = paths.logPath;
  }

  read(): GhState {
    return JSON.parse(readFileSync(this.statePath, "utf8")) as GhState;
  }

  /** Atomic (temp file + rename), so a concurrent shim invocation never reads a half-written file. */
  write(s: GhState): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2));
    renameSync(tmp, this.statePath);
  }

  patch(fn: (s: GhState) => void): GhState {
    const s = this.read();
    fn(s);
    this.write(s);
    return s;
  }

  pr(n: number): GhPr | undefined {
    return this.read().prs[String(n)];
  }

  /** First (highest-numbered, i.e. newest) PR on a head branch — the same order `gh pr list` uses,
   *  which is what makes a reused branch resolve to the current attempt's PR, not a stale merged one. */
  prForBranch(branch: string): GhPr | undefined {
    return Object.values(this.read().prs)
      .filter((p) => p.headRefName === branch)
      .sort((a, b) => b.number - a.number)[0];
  }

  setChecks(n: number, checks: GhPr["checks"]): void {
    this.patch((s) => void (this.must(s, n).checks = checks));
  }

  /** Add an unresolved review thread (a new review round). Returns the thread id, which is what the
   *  engine's review signature hashes. */
  addUnresolvedThread(n: number, id?: string): string {
    const threadId = id ?? `T_${n}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    this.patch((s) => void this.must(s, n).threads.push({ id: threadId, isResolved: false }));
    return threadId;
  }

  resolveAllThreads(n: number): void {
    this.patch((s) => void this.must(s, n).threads.forEach((t) => (t.isResolved = true)));
  }

  /** Move the PR's head to a new commit — what the engine sees after the agent pushes. Nothing else
   *  about the PR changes, which is the point: on a repo with no CI the head is the ONLY signal that
   *  a green PR has become a new green. */
  push(n: number, oid?: string): string {
    const next = oid ?? `sha${Date.now().toString(36)}`;
    this.patch((s) => void (this.must(s, n).headRefOid = next));
    return next;
  }

  markReady(n: number): void {
    this.patch((s) => void (this.must(s, n).isDraft = false));
  }

  merge(n: number): void {
    this.patch((s) => {
      const pr = this.must(s, n);
      pr.state = "MERGED";
      pr.isDraft = false;
    });
  }

  close(n: number): void {
    this.patch((s) => void (this.must(s, n).state = "CLOSED"));
  }

  /** Every logged invocation, oldest first. Missing/empty log ⇒ `[]`. A truncated final line (the log
   *  is appended to by live processes) is skipped rather than thrown on. */
  calls(filter?: { subcommand?: string }): GhCall[] {
    if (!existsSync(this.logPath)) return [];
    const out: GhCall[] = [];
    for (const line of readFileSync(this.logPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let call: GhCall;
      try {
        call = JSON.parse(line) as GhCall;
      } catch {
        continue;
      }
      if (filter?.subcommand != null && call.subcommand !== filter.subcommand) continue;
      out.push(call);
    }
    return out;
  }

  /** Turn runtime injection on (merged over whatever is already set) or, with `null`, off. */
  inject(i: GhInject | null): void {
    this.patch((s) => void (s.inject = i == null ? undefined : { ...s.inject, ...i }));
  }

  graphqlCallCount(): number {
    return this.calls({ subcommand: "api graphql" }).length;
  }

  /** Truncate the call log (and clear any consumed HF_GH_FAIL_ONCE markers), so a scenario can assert
   *  a per-phase call budget rather than a whole-run total. */
  reset(): void {
    mkdirSync(dirname(this.logPath), { recursive: true });
    writeFileSync(this.logPath, "");
    for (const s of ["api_graphql", "api_user", "pr_list", "pr_view", "pr_create", "pr_checks", "auth", "other"]) {
      rmSync(`${this.logPath}.failonce.${s}`, { force: true });
    }
  }

  private must(s: GhState, n: number): GhPr {
    const pr = s.prs[String(n)];
    if (!pr) throw new Error(`gh-fake: no PR #${n} in ${this.statePath} (have: ${Object.keys(s.prs).join(", ") || "none"})`);
    return pr;
  }
}
