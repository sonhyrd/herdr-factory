// Keep each configured repo's MAIN checkout (`repo.path`) current with its base branch. Runs from
// the same `ensure-up` tick as the self-updater, throttled to once per {@link CHECKOUT_SYNC_INTERVAL_MS}
// per repo (issue #71): every host's `~/work/<repo>` drifted tens of commits behind origin because
// nothing ever pulled it — runs are unaffected (worktrees fork from `origin/<base>`), but everything
// a human opens there (Orca, the console, herdr's workspace view) was stale.
//
// Deliberately timid — this is somebody's working copy, not ours. It fast-forwards ONLY when the
// checkout is on the branch `base_ref` names, has no staged/unstaged changes (untracked files are
// fine), and the merge is a pure fast-forward. Anything else is a logged skip. It never stashes,
// resets, checks out or rebases, and a failure in one repo never touches the others or the tick.
// Only paths from loaded repo configs — never ~/.config/herdr-factory, which the operator rolls out
// by hand. Every attempt is recorded to a small state file so `doctor` can show the last result.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { listConfiguredRepos, stateRoot } from "../config-paths.ts";
import { loadConfig } from "../config.ts";
import type { Log } from "./supervisor.ts";

/** Budget for one git call here — the same as the updater's, kept local so merely READING the
 *  recorded state (doctor, TUI) doesn't pull updater.ts's Effect + OpenTelemetry stack into the
 *  import graph; the execution path imports it lazily below. */
export const CHECKOUT_GIT_TIMEOUT_MS = 120_000;

/** How often one repo's main checkout is synced, at most. The tick itself runs every 60s. */
export const CHECKOUT_SYNC_INTERVAL_MS = 10 * 60_000;

export interface CheckoutSync {
  repo: string;
  path: string;
  at: number; // epoch ms of this attempt
  outcome: "fast_forwarded" | "up_to_date" | "skipped" | "failed";
  reason?: string; // why it skipped / how it failed (absent on up_to_date)
  head?: string; // HEAD sha after this attempt
}
/** Last attempt per repo name. */
export type CheckoutSyncState = Record<string, CheckoutSync>;

export function checkoutSyncPath(): string {
  return join(stateRoot(), "checkout-sync.json");
}

/** Read the recorded per-repo sync state (empty on absent/malformed — "nothing recorded yet"). */
export function readCheckoutSync(path = checkoutSyncPath()): CheckoutSyncState {
  try {
    const o = JSON.parse(readFileSync(path, "utf8")) as CheckoutSyncState;
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

function writeCheckoutSync(state: CheckoutSyncState, path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    /* a convenience surface, not load-bearing */
  }
}

/** `origin/main` → `{ remote: "origin", branch: "main" }`; a bare `main` assumes `origin`. */
export function splitBaseRef(baseRef: string): { remote: string; branch: string } {
  const i = baseRef.indexOf("/");
  return i === -1 ? { remote: "origin", branch: baseRef } : { remote: baseRef.slice(0, i), branch: baseRef.slice(i + 1) };
}

export interface CheckoutTarget {
  name: string;
  path: string;
  baseRef: string;
}
export interface SyncCheckoutsOpts {
  repos: CheckoutTarget[];
  statePath: string;
  now?: number;
  intervalMs?: number;
  gitTimeoutMs?: number;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Sync every given checkout (throttled, best-effort). Returns the new recorded state. */
export async function syncCheckouts(log: Log, opts: SyncCheckoutsOpts): Promise<CheckoutSyncState> {
  const now = opts.now ?? Date.now();
  const interval = opts.intervalMs ?? CHECKOUT_SYNC_INTERVAL_MS;
  const state = readCheckoutSync(opts.statePath);

  for (const repo of opts.repos) {
    const prev = state[repo.name];
    if (prev && now - prev.at < interval) continue; // throttled — not due yet
    const result = await syncOne(repo, now, opts.gitTimeoutMs);
    // Log once per state CHANGE, so a checkout parked on a feature branch says so once, not every
    // 10 minutes forever. An outcome that repeats with the same reason stays quiet.
    if (!prev || prev.outcome !== result.outcome || prev.reason !== result.reason) {
      const line = `checkout-sync: ${repo.name}: ${result.reason ?? "up to date"}`;
      log(result.outcome === "failed" ? "warn" : "info", line);
    }
    state[repo.name] = result;
  }

  writeCheckoutSync(state, opts.statePath);
  return state;
}

async function syncOne(repo: CheckoutTarget, now: number, timeoutMs = CHECKOUT_GIT_TIMEOUT_MS): Promise<CheckoutSync> {
  const base = { repo: repo.name, path: repo.path, at: now };
  // Lazy so this module is cheap to import for its readers (see CHECKOUT_GIT_TIMEOUT_MS).
  const { execBounded } = await import("./updater.ts");
  const git = (...args: string[]) => execBounded("git", args, repo.path, timeoutMs);
  const skip = (reason: string, head?: string): CheckoutSync => ({ ...base, outcome: "skipped", reason, head });

  if (!existsSync(join(repo.path, ".git"))) return skip("not a git checkout");
  const { remote, branch } = splitBaseRef(repo.baseRef);

  try {
    const head = await git("rev-parse", "--abbrev-ref", "HEAD");
    if (head !== branch) return skip(`on ${head}, skipped (base branch is ${branch})`);
    await git("fetch", remote, "--quiet");
    // Untracked files are fine — a fast-forward can't discard them. Staged/unstaged changes are the
    // signal somebody is working in here.
    if ((await git("status", "--porcelain", "--untracked-files=no")).length > 0) return skip("dirty tree, skipped", await git("rev-parse", "HEAD"));
    const sha = await git("rev-parse", "HEAD");
    const target = await git("rev-parse", repo.baseRef);
    if (sha === target) return { ...base, outcome: "up_to_date", head: sha };
    // Ancestry decides fast-forwardability BEFORE we touch the working tree: local commits that
    // aren't on the base ref mean diverged, and `merge --ff-only` would just fail anyway.
    try {
      await git("merge-base", "--is-ancestor", sha, target);
    } catch {
      return skip("diverged, skipped", sha);
    }
    await git("merge", "--ff-only", "--quiet", repo.baseRef);
    return { ...base, outcome: "fast_forwarded", reason: `${sha.slice(0, 12)} → ${target.slice(0, 12)} (${repo.baseRef})`, head: target };
  } catch (e) {
    return { ...base, outcome: "failed", reason: msg(e) };
  }
}

/** Production wiring: every loaded repo config's checkout. A config that won't load is skipped
 *  silently (the repo's own doctor group already flags it) — never fails the tick. */
export async function syncMainCheckouts(log: Log): Promise<CheckoutSyncState> {
  const repos: CheckoutTarget[] = [];
  for (const name of listConfiguredRepos()) {
    try {
      const { config } = loadConfig(name);
      repos.push({ name, path: config.repo.path, baseRef: config.repo.baseRef });
    } catch {
      /* unloadable config — not ours to report here */
    }
  }
  return syncCheckouts(log, { repos, statePath: checkoutSyncPath() });
}
