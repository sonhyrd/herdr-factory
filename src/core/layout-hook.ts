// herdr event hook: build the matching layout into a newly-created worktree — the factory's port of
// the workspace-manager plugin's worktree.created/workspace.created/workspace.focused handler, so a
// HAND-created worktree (not just a factory-claimed one) gets its layout too.
//
// Kept dependency-light at module scope: only fs/path/crypto, config-paths, and the pure matcher are
// imported statically. The heavy graph (herdr client, buildDeps, the layout runner, loadConfig) is
// pulled in lazily inside runLayoutHook, so the constantly-firing workspace.focused event — which
// short-circuits at the "decided" cache — pays almost nothing.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { listConfiguredRepos, stateRoot } from "../config-paths.ts";
import { resolveHookLayout } from "./layout-match.ts";
import type { Deps } from "./deps.ts";

// ── Event payload ────────────────────────────────────────────────────────────────────────────────
// herdr passes the event as JSON in HERDR_PLUGIN_EVENT_JSON. Created events nest the workspace under
// `data.workspace`; workspace.focused carries only `data.workspace_id`. We read ONLY this payload —
// never the ambient HERDR_PANE_ID / HERDR_WORKSPACE_ID, which describe whichever pane was focused
// when the event fired (using them would build into the wrong pane).

export interface EventPayload {
  workspaceId?: string;
  tabId?: string;
  rootPaneId?: string;
}

function strAt(v: unknown, path: string[]): string | undefined {
  let cur: unknown = v;
  for (const key of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === "string" && cur.length > 0 ? cur : undefined;
}

export function parseEventPayload(env: Record<string, string | undefined>): EventPayload {
  let ev: unknown = null;
  try {
    ev = JSON.parse(env.HERDR_PLUGIN_EVENT_JSON ?? "");
  } catch {
    ev = null;
  }
  const root = ev && typeof ev === "object" ? (ev as Record<string, unknown>) : {};
  const data = root.data && typeof root.data === "object" ? (root.data as Record<string, unknown>) : root;
  const workspace = data.workspace && typeof data.workspace === "object" ? (data.workspace as Record<string, unknown>) : {};
  return {
    workspaceId: strAt(workspace, ["workspace_id"]) ?? strAt(workspace, ["id"]) ?? strAt(data, ["workspace_id"]),
    tabId: strAt(data, ["tab", "tab_id"]) ?? strAt(workspace, ["active_tab_id"]),
    rootPaneId: strAt(data, ["root_pane", "pane_id"]) ?? strAt(data, ["pane", "pane_id"]),
  };
}

// ── Idempotency + freshness state (filesystem, cross-process) ───────────────────────────────────
// Both worktree.created and workspace.created fire for one CLI creation, and focus fires constantly;
// these guards apply a layout exactly once per worktree, only when the workspace is brand new. Ported
// from the plugin's apply_core.rs (mkdir claim keyed by checkout path + inode/birthtime staleness).

function hookStateDir(): string {
  return process.env.HERDR_FACTORY_LAYOUT_STATE_DIR?.trim() || join(stateRoot(), "layout-hook");
}
function appliedDir(): string {
  return join(hookStateDir(), "applied");
}
function decidedDir(): string {
  return join(hookStateDir(), "decided");
}
function claimDir(checkoutPath: string): string {
  return join(appliedDir(), createHash("sha1").update(resolve(checkoutPath)).digest("hex"));
}
function claimMetaPath(dir: string): string {
  return join(dir, "meta.json");
}

interface Identity {
  ino?: string;
  birthtimeMs?: number;
}
// A delete+recreate at the same path gets a new inode and (where recorded) a new birth time — either
// marks a prior worktree's claim stale so the layout re-applies on recreate.
function worktreeIdentity(checkoutPath: string): Identity {
  try {
    const st = statSync(checkoutPath);
    return { ino: String(st.ino), birthtimeMs: st.birthtimeMs > 0 ? Math.floor(st.birthtimeMs) : undefined };
  } catch {
    return {};
  }
}
function readClaimMeta(dir: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(claimMetaPath(dir), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}
function writeClaimMeta(dir: string, checkoutPath: string): void {
  const id = worktreeIdentity(checkoutPath);
  try {
    writeFileSync(claimMetaPath(dir), JSON.stringify({ path: resolve(checkoutPath), ino: id.ino ?? null, birthtimeMs: id.birthtimeMs ?? null }));
  } catch {
    /* best effort — a missing record just falls back to the mtime heuristic */
  }
}
function isStaleClaim(dir: string, checkoutPath: string): boolean {
  const cur = worktreeIdentity(checkoutPath);
  if (cur.ino == null && cur.birthtimeMs == null) return false; // identity unknowable
  const meta = readClaimMeta(dir);
  const recordedIno = typeof meta?.ino === "string" ? meta.ino : undefined;
  if (recordedIno && cur.ino && recordedIno !== cur.ino) return true;
  let claimAt = typeof meta?.birthtimeMs === "number" ? meta.birthtimeMs : undefined;
  if (claimAt == null) {
    try {
      claimAt = Math.floor(statSync(dir).mtimeMs);
    } catch {
      /* leave undefined */
    }
  }
  return claimAt != null && cur.birthtimeMs != null && cur.birthtimeMs > claimAt;
}

/** Atomically claim a worktree for application. true = we won (first to see it); false = a valid
 *  claim already exists. mkdir is atomic across processes, so concurrent created/focused hooks can't
 *  both win. A stale claim (from a removed+recreated worktree at the same path) is detected and reset. */
export function claimApply(checkoutPath: string): boolean {
  const dir = claimDir(checkoutPath);
  mkdirSync(appliedDir(), { recursive: true });
  try {
    mkdirSync(dir);
    writeClaimMeta(dir, checkoutPath);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    if (isStaleClaim(dir, checkoutPath)) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir);
      writeClaimMeta(dir, checkoutPath);
      return true;
    }
    return false;
  }
}
export function releaseApply(checkoutPath: string): void {
  try {
    rmSync(claimDir(checkoutPath), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
export function alreadyApplied(checkoutPath: string): boolean {
  return existsSync(claimDir(checkoutPath));
}

// "Decided" cache by workspace id: the hot workspace.focused event skips instantly once a workspace
// has been handled, without re-querying herdr. The persistent claim (by path) remains the real guard.
// Workspace ids are per-SERVER-SESSION and recycled (w1, w2, …), so this cache is only valid for the
// life of one herdr server — the `[[startup]]` hook clears it (see runLayoutStartup).
function decidedPath(workspaceId: string): string {
  return join(decidedDir(), workspaceId.replace(/[^A-Za-z0-9_.-]/g, "_"));
}
export function isDecided(workspaceId: string): boolean {
  return existsSync(decidedPath(workspaceId));
}
export function markDecided(workspaceId: string): void {
  try {
    mkdirSync(decidedDir(), { recursive: true });
    mkdirSync(decidedPath(workspaceId));
  } catch {
    /* already marked — fine */
  }
}

/** Drop the whole per-workspace "decided" cache. Called from the one-shot `[[startup]]` hook: a new
 *  herdr server hands out workspace ids from scratch, so every entry is either stale or — worse —
 *  about to collide with a DIFFERENT workspace that recycles the id, which would make the hook skip a
 *  layout it never actually applied. Returns whether anything was there. */
export function clearDecided(): boolean {
  const dir = decidedDir();
  if (!existsSync(dir)) return false;
  try {
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false; // a stale cache only costs one redundant (idempotent) evaluation
  }
}

/** Drop claims whose worktree no longer exists on disk, so a future worktree at a reclaimed path
 *  starts clean and the `applied/` dir doesn't grow without bound. Returns the count reaped. */
export function reapOrphanClaims(): number {
  const readEntries = () => {
    try {
      return readdirSync(appliedDir(), { withFileTypes: true });
    } catch {
      return []; // nothing claimed yet
    }
  };
  let reaped = 0;
  for (const entry of readEntries()) {
    if (!entry.isDirectory()) continue;
    const dir = join(appliedDir(), entry.name);
    const p = readClaimMeta(dir)?.path;
    if (typeof p !== "string") continue; // legacy/in-progress — leave it
    if (!existsSync(p)) {
      try {
        rmSync(dir, { recursive: true, force: true });
        reaped += 1;
      } catch {
        /* keep it */
      }
    }
  }
  return reaped;
}

// ── Plugin-owned panes ──────────────────────────────────────────────────────────────────────────
// A herdr plugin may add a pane of its own to every new tab (herdr-sidebar's `Sidebar`), so the raw
// pane count of a brand-new workspace is not 1 on such a host. Only a pane the user/agent could have
// opened counts as arrangement; the rest is plugin furniture and is ignored.

/** Pane labels ignored when machine.yml says nothing (`layout_hook.ignore_pane_labels`). */
export const DEFAULT_IGNORED_PANE_LABELS: readonly string[] = ["Sidebar"];

/** The panes that aren't plugin furniture. Labels match case-insensitively, trimmed. */
export function ownPanes<T extends { label?: string | null }>(panes: readonly T[], ignoredLabels: readonly string[]): T[] {
  const ignored = new Set(ignoredLabels.map((l) => l.trim().toLowerCase()).filter((l) => l.length > 0));
  return panes.filter((p) => !ignored.has((p.label ?? "").trim().toLowerCase()));
}

// ── The handler ─────────────────────────────────────────────────────────────────────────────────

export interface HookResult {
  applied?: string;
  skipped?: string;
}

/** The one-shot `[[startup]]` hook (herdr 0.7.5): runs once per herdr server start, before any
 *  worktree event can fire. It owns the state hygiene the per-event path used to pay for on every
 *  single invocation — reaping claims for worktrees that vanished while herdr was down, and clearing
 *  the session-scoped "decided" cache. Correctness never depended on the reap (a recreated worktree
 *  is caught by the inode/birthtime staleness check); it was there to keep `applied/` from growing
 *  without bound, which is exactly the kind of work that belongs at startup rather than in a
 *  constantly-firing focus handler. */
export function runLayoutStartup(): { reaped: number; decidedCleared: boolean } {
  return { reaped: reapOrphanClaims(), decidedCleared: clearDecided() };
}

/** Handle a herdr worktree/workspace event: build the matching layout into a freshly-created, fresh
 *  (1-tab/1-pane) LINKED worktree, exactly once. Mirrors the plugin's cmd_event. Heavy modules are
 *  imported lazily so the already-decided focus path stays cheap. Throws on an apply failure (after
 *  releasing the claim) so herdr surfaces it; returns {skipped}/{applied} otherwise. */
export async function runLayoutHook(env: Record<string, string | undefined> = process.env): Promise<HookResult> {
  const payload = parseEventPayload(env);
  const workspaceId = payload.workspaceId;
  if (!workspaceId) return { skipped: "no workspace id in event" };

  const isFocus = (env.HERDR_PLUGIN_EVENT ?? "").includes("focus");
  // The focus event exists only because herdr's in-app "new worktree" has historically emitted
  // NEITHER worktree.created NOR workspace.created to plugins. It fires on every workspace switch, so
  // it is by far the most frequent reason this runs — set HERDR_FACTORY_FOCUS_HOOK=0 in herdr's
  // environment to drop it entirely on a build whose UI worktree creation does emit worktree.created
  // (check with `herdr plugin log list --plugin herdr-factory` after creating one in the app).
  if (isFocus && env.HERDR_FACTORY_FOCUS_HOOK?.trim() === "0") return { skipped: "focus hook disabled" };
  if (isFocus && isDecided(workspaceId)) return { skipped: "already decided" };

  const done = (skipped: string): HookResult => {
    if (isFocus) markDecided(workspaceId);
    return { skipped };
  };

  const { HerdrClient } = await import("../clients/herdr.ts");
  const herdr = new HerdrClient(env.HERDR_BIN_PATH ?? "herdr");

  const info = await herdr.workspaceInfo(workspaceId);
  if (!info?.checkoutPath) return done("not a worktree workspace");
  if (!info.isLinkedWorktree) return done("main checkout — never touch");
  const checkoutPath = info.checkoutPath;

  // Which factory repo owns this worktree? Its main checkout (repo.path) is the worktree's repo_root.
  const { loadConfig } = await import("../config.ts");
  const repoRoot = info.repoRoot ? resolve(info.repoRoot) : null;
  let repoName: string | undefined;
  if (repoRoot) {
    for (const name of listConfiguredRepos()) {
      try {
        if (resolve(loadConfig(name).config.repo.path) === repoRoot) {
          repoName = name;
          break;
        }
      } catch {
        /* skip a repo whose config doesn't currently load */
      }
    }
  }
  if (!repoName) return done(`no factory repo config for ${repoRoot ?? checkoutPath}`);

  const { buildDeps } = await import("../build-deps.ts");
  const deps: Deps = await buildDeps(repoName);

  // Which run owns this worktree? By checkout PATH first (immune to anything an agent does inside
  // it — including renaming the branch), then by name: at CREATE time — the event this hook exists
  // for — no path is recorded yet, and the worktree's branch is still the name the run was claimed
  // under (`worktree_name`), which the store matches alongside the run's current branch.
  const branch = await deps.herdr.worktreeBranch(workspaceId, checkoutPath);
  const ownerRun = deps.store.activeRunForWorktree(repoName, { path: checkoutPath, branch });
  const matched = resolveHookLayout(deps.config.belts, deps.config.layouts, ownerRun?.belt ?? undefined, branch ?? undefined);
  if (!matched) return done(`no layout matches ${checkoutPath}`);
  const { layout } = matched;

  // Fresh workspace only — never clobber an arranged/restored one. A pane a herdr PLUGIN put there
  // is not arrangement: a plugin that adds its own pane (a sidebar) to every new tab would otherwise
  // make every brand-new workspace look arranged and no layout would ever be built on that host. So
  // when the raw pane count is off we ask herdr for the actual panes and ignore the plugin-owned
  // labels; a pane the USER opened still (rightly) declines the build.
  const ignoredLabels = deps.machine?.layoutHookIgnorePaneLabels ?? DEFAULT_IGNORED_PANE_LABELS;
  const ownPaneCount = async () => ownPanes(await deps.herdr.listPanes(workspaceId), ignoredLabels).length;
  if (info.tabCount !== 1 || (info.paneCount !== 1 && (await ownPaneCount()) !== 1)) {
    return done(`workspace ${workspaceId} is not a fresh 1-tab/1-pane workspace; skipping`);
  }

  if (!claimApply(checkoutPath)) return done(`layout already applied for ${checkoutPath}; skipping`);

  // Resolve the build target. herdr ids are workspace-prefixed; discard any ambient id that isn't
  // this workspace's and re-resolve from the workspace.
  const prefix = `${workspaceId}:`;
  const rootTabId =
    (payload.tabId?.startsWith(prefix) ? payload.tabId : undefined) ?? info.activeTabId ?? (await deps.herdr.firstTabId(workspaceId));
  if (!rootTabId) {
    releaseApply(checkoutPath);
    throw new Error(`layout hook: no tab found for workspace ${workspaceId}`);
  }
  // The root pane is only MEASURED now (its box sizes `cells` panes; `layout.apply` rebuilds the tab
  // rather than splitting from it), so an unresolvable one is not fatal — cell sizes just fall back to
  // even splits.
  const rootPaneId =
    (payload.rootPaneId?.startsWith(prefix) ? payload.rootPaneId : undefined) ?? (await deps.herdr.firstPaneOfTab(workspaceId, rootTabId)) ?? undefined;

  const { applyLayout } = await import("./layout.ts");
  try {
    await applyLayout(
      deps,
      {
        workspaceId,
        rootTabId,
        rootPaneId,
        cwd: checkoutPath,
        // The work key rides into every pane's shell (it used to reach only the panes the factory
        // spawned itself). A layout pane names its own agent, so no harness is threaded through.
        env: ownerRun?.ticketKey ? { HERDR_FACTORY_TICKET: ownerRun.ticketKey } : undefined,
      },
      layout,
    );
  } catch (e) {
    releaseApply(checkoutPath); // allow a retry on transient failure
    deps.store.recordEvent({
      runId: ownerRun?.id ?? null,
      repo: repoName,
      ticketKey: ownerRun?.ticketKey ?? null,
      type: "layout_apply_failed",
      detail: { layout: layout.id, workspaceId, error: e instanceof Error ? e.message : String(e) },
    });
    // The hook runs headless: without this the failure reaches only the plugin log and the run's
    // timeline, while the operator sits looking at a worktree that never got its panes.
    await deps.herdr
      .notify("herdr-factory: layout failed", `Layout "${layout.id}" for ${checkoutPath}: ${e instanceof Error ? e.message : String(e)}`)
      .catch(() => {});
    throw e;
  }
  deps.store.recordEvent({
    runId: ownerRun?.id ?? null,
    repo: repoName,
    ticketKey: ownerRun?.ticketKey ?? null,
    type: "layout_applied",
    detail: { layout: layout.id, workspaceId, checkoutPath },
  });
  if (isFocus) markDecided(workspaceId);
  deps.log("info", `layout hook: built "${layout.id}" into ${checkoutPath}`);
  return { applied: layout.id };
}
