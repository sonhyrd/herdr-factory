// Supervised self-updater: pull THIS package's latest code and hard-reset the working tree to its
// channel target, so a `git pull`-equivalent happens unattended. Resolved against the package dir
// (never the caller's cwd — a worker invokes the CLI from other repos' worktrees). Best-effort: any
// problem returns {updated:false, reason} instead of throwing, so it can never break a supervisor
// tick. Strategy is a HARD RESET to the channel target: the box always ends up exactly matching it.
// When it updates, the caller restarts the server — VERSION is derived from the git sha, so the
// freshly spawned process advertises the new version (and migrations re-run on the new DB connection).
//
// Two safety rails on top of the reset (w2-08):
//   - CHANNELS. `HERDR_CHANNEL=main` (default) tracks the branch upstream (`@{u}`) as before;
//     `stable` follows the newest release TAG, so a broken main commit never reaches a stable box.
//   - DIRTY-CHECKOUT GUARD. A checkout with uncommitted changes is NOT reset (that would silently
//     discard a hand-patch) — the tick skips, notifies once, and records the skip so it's visible.
// Every attempt (updated / up-to-date / skipped / failed) is recorded to a small state file next to
// server.json so `doctor` and the TUI can surface a failure or a behind-its-target box, rather than
// it living only in the supervisor log.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import type { Log } from "./supervisor.ts";
import { pinnedNodeVersion, provisionNode } from "./provision.ts";
import { updateStatusPath } from "../config-paths.ts";
import { notifyDue } from "../schedule.ts";
import { recordDependencyDuration, telemetrySpan } from "../telemetry/index.ts";
// The update-status model + pure readers live in a telemetry-free module so surfaces that only READ
// the last attempt (TUI dashboard, doctor) don't pull this execution path — and its Effect + OTel
// stack — into their startup graph. Re-exported below so existing importers keep working unchanged.
import {
  DIRTY_RENOTIFY_MS,
  readUpdateStatusAt,
  updateChannel,
  writeUpdateStatus,
  type UpdateChannel,
  type UpdateResult,
  type UpdateStatus,
} from "./update-status.ts";

export {
  autoUpdateEnabled,
  readUpdateStatus,
  updateChannel,
  updateWarning,
  type UpdateChannel,
  type UpdateResult,
  type UpdateStatus,
} from "./update-status.ts";

const execFileP = promisify(execFile);
const PKG_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Budget for one git call (a fetch over a slow link included). Past it the call is killed and the
 *  tick records a `failed` attempt — so the next tick, 60s later, retries instead of never coming. */
export const GIT_TIMEOUT_MS = 120_000;
/** Budget for the post-update `pnpm`/`npm install`. */
const INSTALL_TIMEOUT_MS = 10 * 60_000;

/** Run a command for the updater, bounded and TTY-free (issue #35). `detached` = setsid: the child
 *  has NO controlling terminal, so an ssh host-key / passphrase or a credential prompt fails fast —
 *  exactly as it does under launchd/systemd — instead of blocking forever on the terminal of a
 *  `while :; do herdr-factory ensure-up; sleep 60; done` loop (a hung fetch froze that loop, and
 *  with it every later update, for hours). Its own process group also lets the timeout kill git AND
 *  its ssh child, which would otherwise hold our stderr pipe open past git's death. */
export function execBounded(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        /* already gone */
      }
      reject(new Error(`${cmd} ${args.join(" ")} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`${cmd} ${args.join(" ")} exited ${code}: ${err.trim().slice(0, 400)}`));
    });
  });
}

async function git(args: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  const startedAt = Date.now();
  return telemetrySpan("updater.git", { "dependency.name": "git", "process.args.count": args.length }, async () => {
    try {
      return await execBounded("git", args, cwd, timeoutMs);
    } finally {
      recordDependencyDuration(Date.now() - startedAt, { "dependency.name": "git", "dependency.method": "updater" });
    }
  });
}

interface ManifestChanges {
  deps: boolean; // package.json / pnpm-lock.yaml
  node: boolean; // .node-version (the pinned Node runtime)
}

/** Which provisioning-relevant manifests changed between two commits — so we know whether to
 *  re-run `pnpm install` and/or re-provision the vendored Node runtime. */
async function manifestChanges(from: string, to: string, cwd: string): Promise<ManifestChanges> {
  try {
    const files = (await git(["diff", "--name-only", from, to], cwd)).split("\n");
    return {
      deps: files.some((f) => f === "package.json" || f === "pnpm-lock.yaml"),
      node: files.some((f) => f === ".node-version"),
    };
  } catch {
    return { deps: false, node: false };
  }
}

async function have(cmd: string, cwd: string): Promise<boolean> {
  try {
    await execFileP(cmd, ["--version"], { cwd, timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

/** (Re)install dependencies after a code update. No native modules → no rebuild needed. Best-effort:
 *  a failed install doesn't abort the update (the restart still picks up the code), but the reason is
 *  returned so the caller can surface it (a partially-updated box with stale deps is worth an amber
 *  line); null on success. */
async function installDeps(log: Log, cwd: string): Promise<string | null> {
  try {
    if (await have("pnpm", cwd)) {
      log("info", "self-update: dependencies changed — pnpm install");
      await execBounded("pnpm", ["install"], cwd, INSTALL_TIMEOUT_MS);
    } else {
      log("info", "self-update: dependencies changed — npm install");
      await execBounded("npm", ["install", "--no-audit", "--no-fund"], cwd, INSTALL_TIMEOUT_MS);
    }
    return null;
  } catch (e) {
    log("warn", `self-update: dependency install failed — ${msg(e)} (continuing)`);
    return `dependency install failed — ${msg(e)}`;
  }
}

/** Is the working tree dirty (any staged/unstaged/untracked change)? A dirty checkout is the signal
 *  a human has hand-patched this box, so the updater must not hard-reset over it. */
async function isDirty(cwd: string): Promise<boolean> {
  return (await git(["status", "--porcelain"], cwd)).length > 0;
}

/** The newest release tag on this checkout, as a `vX.Y.Z`/`X.Y.Z` string, or null if there are none.
 *  Pre-release tags (`v1.2.3-rc1`) are ignored — `stable` follows finished releases only. Compared
 *  numerically by (major, minor, patch), NOT lexically, so v1.10.0 > v1.9.0. */
async function newestReleaseTag(cwd: string): Promise<string | null> {
  const parse = (t: string): [number, number, number] | null => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(t.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  let best: { tag: string; v: [number, number, number] } | null = null;
  for (const t of (await git(["tag", "--list"], cwd)).split("\n")) {
    const v = parse(t);
    if (!v) continue;
    if (!best || v[0] > best.v[0] || (v[0] === best.v[0] && (v[1] > best.v[1] || (v[1] === best.v[1] && v[2] > best.v[2])))) {
      best = { tag: t.trim(), v };
    }
  }
  return best?.tag ?? null;
}

/** Notify the operator (via the herdr notification surface) that a dirty checkout blocked an update.
 *  Best-effort and shell-free (mirrors HerdrClient.notify's argv) — kept local so the low-level
 *  updater doesn't drag in the whole herdr/deps/config graph. */
async function notifyOperator(title: string, body: string): Promise<void> {
  const bin = process.env.HERDR_BIN_PATH?.trim() || "herdr";
  try {
    await execFileP(bin, ["notification", "show", title, "--body", body, "--sound", "request"], { timeout: 30_000 });
  } catch {
    /* no herdr on PATH / notification failed — the state file still records the skip for doctor */
  }
}

/** The channel target for a tick: the commit to reset to, plus a human ref for it. Throws (caught by
 *  the caller and recorded as a `failed`/`skipped` attempt) when it can't be resolved — no upstream
 *  on `main`, or no release tags yet on `stable`. */
interface ChannelTarget {
  sha: string;
  ref: string;
}
async function resolveTarget(channel: UpdateChannel, cwd: string, timeoutMs?: number): Promise<ChannelTarget> {
  if (channel === "stable") {
    await git(["fetch", "--tags", "--quiet"], cwd, timeoutMs);
    const tag = await newestReleaseTag(cwd);
    if (!tag) throw new Error("no release tags yet (stable channel)");
    return { sha: await git(["rev-parse", `${tag}^{commit}`], cwd), ref: tag };
  }
  // main: track the branch's configured upstream, exactly as before.
  const upstream = await git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], cwd); // e.g. origin/main
  await git(["fetch", "--quiet"], cwd, timeoutMs);
  return { sha: await git(["rev-parse", upstream], cwd), ref: upstream };
}

/** Fetch + hard-reset this package to its channel target. Returns whether the working tree changed. */
export async function selfUpdate(log: Log): Promise<UpdateResult> {
  return telemetrySpan("updater.self_update", { "update.channel": updateChannel() }, () =>
    runUpdate(log, { cwd: PKG_ROOT, channel: updateChannel(), statusPath: updateStatusPath(), notify: notifyOperator }),
  );
}

/** Options for {@link runUpdate}. Everything the module resolves from the environment is injectable
 *  so the update logic can be exercised against a throwaway git repo in tests. */
export interface RunUpdateOpts {
  cwd: string;
  channel: UpdateChannel;
  statusPath: string;
  notify: (title: string, body: string) => Promise<void>;
  /** Per-git-call budget (default {@link GIT_TIMEOUT_MS}); tests shrink it to prove a hung fetch ends the tick. */
  gitTimeoutMs?: number;
}

/** The channel-aware update core, injectable for tests (see selfUpdate for the production wiring). */
export async function runUpdate(log: Log, opts: RunUpdateOpts): Promise<UpdateResult> {
  const { cwd, channel, statusPath } = opts;
  const record = (s: Omit<UpdateStatus, "channel" | "at">): void => writeUpdateStatus({ channel, at: Date.now(), ...s }, statusPath);

  if (!existsSync(join(cwd, ".git"))) {
    record({ outcome: "skipped", reason: "not a git checkout", behind: false });
    return { updated: false, reason: "not a git checkout" };
  }

  let before: string;
  try {
    before = await git(["rev-parse", "HEAD"], cwd);
  } catch {
    record({ outcome: "failed", reason: "cannot read HEAD", behind: false });
    return { updated: false, reason: "cannot read HEAD" };
  }

  let target: ChannelTarget;
  try {
    target = await resolveTarget(channel, cwd, opts.gitTimeoutMs);
  } catch (e) {
    // Couldn't resolve where to land. `stable` with no release tags yet is a benign SKIP (you just
    // haven't cut a release); everything else — no upstream on `main`, a failed fetch (network) — is
    // a FAILURE worth surfacing. Either way the box may not be on its target, so flag `behind`.
    const reason = msg(e);
    log("warn", `self-update: ${reason}`);
    const benignSkip = channel === "stable" && /no release tags/.test(reason);
    record({ outcome: benignSkip ? "skipped" : "failed", reason, head: before, behind: true });
    return { updated: false, reason };
  }

  if (target.sha === before) {
    record({ outcome: "up_to_date", head: before, target: target.sha, targetRef: target.ref, behind: false });
    return { updated: false, reason: "up to date" };
  }

  // Dirty-checkout guard: a hand-patched box must survive the tick. Skip the reset, record the skip
  // (so doctor shows the reason + that we're behind the target), and notify once (throttled).
  if (await isDirty(cwd)) {
    const prev = readUpdateStatusAt(statusPath);
    // The shared throttle, in MILLISECONDS here (this file's clock is Date.now()): a prior skip that
    // never notified — or one outside the window — fires; anything else stays quiet.
    const notified = !notifyDue(prev?.dirtySkip ? prev.notifiedAt : null, DIRTY_RENOTIFY_MS, Date.now());
    const reason = `dirty checkout — reset to ${target.ref} skipped (uncommitted local changes)`;
    log("warn", `self-update: ${reason}`);
    if (!notified) {
      await opts.notify(
        "herdr-factory: auto-update skipped",
        `The herdr-factory checkout has uncommitted changes, so the ${channel} update to ${target.ref} was skipped to avoid discarding them. Commit/stash or discard them to resume auto-update.`,
      );
    }
    record({ outcome: "skipped", reason, head: before, target: target.sha, targetRef: target.ref, behind: true, dirtySkip: true, notifiedAt: notified ? prev!.notifiedAt : Date.now() });
    return { updated: false, reason: "dirty checkout" };
  }

  try {
    await git(["reset", "--hard", target.sha], cwd);
  } catch (e) {
    const reason = `reset failed — ${msg(e)}`;
    log("warn", `self-update: git ${reason}`);
    record({ outcome: "failed", reason, head: before, target: target.sha, targetRef: target.ref, behind: true });
    return { updated: false, reason: "reset failed" };
  }
  log("info", `self-update: ${before.slice(0, 12)} → ${target.sha.slice(0, 12)} (hard reset to ${target.ref})`);

  const changes = await manifestChanges(before, target.sha, cwd);
  // The reset landed new code — track any post-step failure as a non-fatal WARNING (the box is
  // updated but degraded: stale deps / old runtime), so doctor/TUI can surface it rather than it
  // sitting only in the supervisor log.
  let warning: string | undefined;
  // A .node-version bump: fetch + verify + extract the new official Node and flip the runtime
  // symlink. Best-effort — a failure leaves the old runtime in place and the launchers fall back to
  // it, so the box keeps running rather than breaking on a bad network. A Node bump also implies a
  // reinstall (the @opentui/core-<platform> optional dep may need re-resolving for the new ABI),
  // so force the pnpm install path even if the lockfile itself was untouched.
  if (changes.node) {
    try {
      const res = await provisionNode(pinnedNodeVersion(), log);
      if (res.changed) log("info", `self-update: vendored Node → ${res.version}`);
    } catch (e) {
      warning = `Node provisioning failed — ${msg(e)}`;
      log("warn", `self-update: ${warning} (continuing on the existing runtime)`);
    }
  }
  if (changes.deps || changes.node) warning = (await installDeps(log, cwd)) ?? warning;

  record({ outcome: "updated", reason: `${before.slice(0, 12)} → ${target.sha.slice(0, 12)} (${target.ref})`, head: target.sha, target: target.sha, targetRef: target.ref, behind: false, warning });
  return { updated: true, from: before, to: target.sha };
}
