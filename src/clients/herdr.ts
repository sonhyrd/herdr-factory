import { basename } from "node:path";
import { run, runJson } from "./exec.ts";
import { HerdrUnreachableError, type LivenessOpts } from "../core/deps.ts";
import { HERDR_AGENT_KINDS, isReadyForInput, type Agent, type FocusedPane, type LayoutDescription, type LayoutDescriptionNode, type LayoutNode, type PaneBox, type PaneDisplay, type PaneSummary, type WorkspaceInfo, type WorktreeResult } from "../types.ts";
import { herdrSocketCall } from "./herdr-socket.ts";

/** The herdr agent KIND (`herdr agent start --kind`) for a spawn argv. herdr uses it to pick the
 *  integration that detects idle/working for the pane, so it must name the real harness — we derive
 *  it from the executable (argv[0]'s basename), which is the configured `agent.command`. A full path
 *  (`/opt/homebrew/bin/claude`) still yields `claude`; an empty/absent argv falls back to `claude`.
 *  Byte-identical to the old hardcoded "claude" whenever argv[0] is `claude`. */
export function agentKindForArgv(argv: readonly string[]): string {
  return (argv[0] ? basename(argv[0]) : "") || "claude";
}

/** How a factory-spawned pane gets its harness running:
 *   • `adopt` — `agent start --kind <k> --pane <id>`: herdr launches the kind's canonical executable
 *     in the pane and BLOCKS until the agent is detected and ready for input. Requires a supported
 *     kind, and (because herdr resolves the executable itself) a BARE `command` — an absolute path
 *     would be silently replaced by whatever herdr resolves.
 *   • `run` — `pane run <argv>`: types the exact argv the user configured. herdr's integrations still
 *     auto-detect the agent (this is how a layout pane's hand-started agent is tracked), but there is
 *     no readiness handshake. The escape hatch for absolute paths and wrapper scripts.
 * Explicit `kind:` config forces `adopt`, which is the point of the key. */
export function spawnStrategyForArgv(argv: readonly string[], explicitKind?: string): { mode: "adopt"; kind: string } | { mode: "run"; kind?: string } {
  if (explicitKind) return { mode: "adopt", kind: explicitKind };
  const command = argv[0] ?? "";
  const kind = agentKindForArgv(argv);
  if (!command.includes("/") && HERDR_AGENT_KINDS.includes(kind)) return { mode: "adopt", kind };
  return { mode: "run", kind: HERDR_AGENT_KINDS.includes(kind) ? kind : undefined };
}

// The pane-readiness predicate lives in the pure types leaf (core/ must not import a client), and is
// re-exported here because this module is where herdr's agent vocabulary is otherwise interpreted.
export { isReadyForInput };

/** Quote an argv into a single POSIX shell command line for `pane run` (which hands its argument to
 *  the pane's shell, unlike the arg-array `agent start`). Single-quote wrapping with `'\''` breaks
 *  is total: it survives quotes, spaces, newlines, and `$`/backtick expansion alike. */
export function shellQuoteArgv(argv: readonly string[]): string {
  return argv.map((a) => `'${a.replaceAll("'", `'\\''`)}'`).join(" ");
}

/** What `herdr pane process-info` reports about a pane's foreground. */
export interface PaneProcessInfo {
  shell_pid?: number;
  foreground_process_group_id?: number;
  foreground_processes?: { pid?: number }[];
}

/** Is this pane at an available shell prompt — its shell owning the foreground, with nothing running?
 *
 *  The process group id alone isn't enough: while zsh sources its rc files it spawns children inside
 *  its own group, so the group still looks like the shell's. The pane is only idle once the shell is
 *  the ONLY foreground process. An absent process list means a platform that doesn't expose one, so
 *  the group is all there is to go on; an EMPTY list means herdr hasn't sampled the pane yet — which
 *  is exactly the state a just-created pane is in, and not an idle shell. */
export function isAtShellPrompt(info: PaneProcessInfo | undefined): boolean {
  const shell = info?.shell_pid;
  if (shell == null || info?.foreground_process_group_id !== shell) return false;
  const foreground = info.foreground_processes;
  if (foreground == null) return true;
  return foreground.length === 1 && foreground[0]?.pid === shell;
}

interface RawAgent {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  agent: string;
  agent_status: string;
  cwd: string;
  agent_session?: { value?: string };
  revision?: number;
}
interface AgentListResp {
  result?: { agents?: RawAgent[] };
}
interface WorktreeResp {
  result?: {
    workspace?: { workspace_id?: string; worktree?: { checkout_path?: string } };
    root_pane?: { pane_id?: string; workspace_id?: string; cwd?: string };
  };
}
interface TabListResp {
  result?: { tabs?: { tab_id: string; label?: string }[] };
}
interface PaneListResp {
  result?: { panes?: { pane_id: string; workspace_id: string; tab_id: string; label?: string; focused?: boolean }[] };
}
interface TabCreateResp {
  result?: { tab?: { tab_id?: string }; tab_id?: string; root_pane?: { pane_id?: string }; pane?: { pane_id?: string }; pane_id?: string };
}
interface PaneLayoutResp {
  result?: { layout?: { area?: { width?: number; height?: number } } };
}
interface PaneProcessInfoResp {
  result?: { process_info?: PaneProcessInfo };
}
interface WaitOutputResp {
  result?: { matched_line?: string };
}
interface RawWorkspace {
  workspace_id?: string;
  active_tab_id?: string;
  tab_count?: number;
  pane_count?: number;
  worktree?: { checkout_path?: string; repo_root?: string; repo_name?: string; is_linked_worktree?: boolean };
}
interface WorkspaceGetResp {
  result?: { workspace?: RawWorkspace };
}
interface WorkspaceListResp {
  result?: { workspaces?: RawWorkspace[] };
}
interface WorktreeListResp {
  result?: { worktrees?: { path?: string; branch?: string; open_workspace_id?: string }[] };
}

/**
 * Thin typed wrapper over the `herdr` CLI. herdr owns the worktree / workspace /
 * tab / pane / agent lifecycle — this class only shells out and parses; it
 * reimplements none of it.
 */
export class HerdrClient {
  private readonly bin: string;
  constructor(bin: string = "herdr") {
    this.bin = bin;
  }

  private parseWorktree(j: WorktreeResp): WorktreeResult {
    const workspaceId = j.result?.workspace?.workspace_id ?? j.result?.root_pane?.workspace_id;
    const worktreePath = j.result?.workspace?.worktree?.checkout_path ?? j.result?.root_pane?.cwd;
    const paneId = j.result?.root_pane?.pane_id ?? null;
    if (!workspaceId || !worktreePath) {
      throw new Error(`herdr worktree result missing workspace/path: ${JSON.stringify(j).slice(0, 300)}`);
    }
    return { workspaceId, worktreePath, paneId };
  }

  // Worktree ops run real git checkouts (can be slow on big repos) — give them a bigger budget
  // than the default exec timeout, but still a HARD one (a hung herdr must not wedge the tick).
  private static readonly WORKTREE_TIMEOUT_MS = 180_000;

  async worktreeCreate(repoCwd: string, branch: string, baseRef: string): Promise<WorktreeResult> {
    return this.parseWorktree(
      await runJson<WorktreeResp>(this.bin, [
        "worktree", "create", "--cwd", repoCwd, "--branch", branch, "--base", baseRef, "--no-focus", "--json",
      ], { timeoutMs: HerdrClient.WORKTREE_TIMEOUT_MS }),
    );
  }

  async worktreeOpen(repoCwd: string, branch: string): Promise<WorktreeResult> {
    return this.parseWorktree(
      await runJson<WorktreeResp>(this.bin, ["worktree", "open", "--cwd", repoCwd, "--branch", branch, "--no-focus", "--json"], {
        timeoutMs: HerdrClient.WORKTREE_TIMEOUT_MS,
      }),
    );
  }

  /** Removes the workspace, checkout dir, and git worktree registration (herdr-owned). */
  async worktreeRemove(workspaceId: string): Promise<void> {
    await run(this.bin, ["worktree", "remove", "--workspace", workspaceId, "--force", "--json"], {
      allowFail: true,
      timeoutMs: HerdrClient.WORKTREE_TIMEOUT_MS,
    });
  }

  /** Close the workspace + its panes (independent of git-worktree state). The fallback when
   *  `worktree remove` deregisters the git worktree but then fails to close the workspace. */
  async workspaceClose(workspaceId: string): Promise<void> {
    await run(this.bin, ["workspace", "close", workspaceId], { allowFail: true });
  }

  async workspaceExists(workspaceId: string): Promise<boolean> {
    const r = await run(this.bin, ["workspace", "get", workspaceId], { allowFail: true });
    return r.code === 0;
  }

  // One `herdr agent list` answers every liveness question for ~all runs in a tick, so the
  // result is memoized briefly — at 50-100 active runs this collapses O(runs) subprocess spawns
  // per tick into ~one, and it's what makes the fresh-read confirmation below meaningful.
  private static readonly AGENTS_MEMO_MS = 5_000;
  private agentsMemo: { at: number; agents: Agent[] } | null = null;

  /** Agents herdr currently tracks. THROWS HerdrUnreachableError when herdr can't be queried —
   *  an empty list is a real "no agents", never a masked failure (that masking is exactly what
   *  used to make a herdr hiccup look like mass pane death). */
  async agents(opts: LivenessOpts = {}): Promise<Agent[]> {
    if (!opts.fresh && this.agentsMemo && Date.now() - this.agentsMemo.at < HerdrClient.AGENTS_MEMO_MS) {
      return this.agentsMemo.agents;
    }
    let j: AgentListResp;
    try {
      j = await runJson<AgentListResp>(this.bin, ["agent", "list"]);
    } catch (e) {
      this.agentsMemo = null;
      throw new HerdrUnreachableError(e);
    }
    const agents = (j.result?.agents ?? []).map((a) => ({
      paneId: a.pane_id,
      workspaceId: a.workspace_id,
      tabId: a.tab_id,
      agent: a.agent,
      agentStatus: a.agent_status,
      cwd: a.cwd,
      sessionId: a.agent_session?.value ?? null,
      revision: typeof a.revision === "number" ? a.revision : null,
    }));
    this.agentsMemo = { at: Date.now(), agents };
    return agents;
  }

  async paneState(paneId: string, opts: LivenessOpts = {}): Promise<string> {
    const a = (await this.agents(opts)).find((x) => x.paneId === paneId);
    return a?.agentStatus ?? "gone";
  }

  /** The claude session id herdr tracks for a pane (on-demand cross-agent query handle). */
  async agentSessionId(paneId: string): Promise<string | null> {
    return (await this.agents()).find((x) => x.paneId === paneId)?.sessionId ?? null;
  }

  async paneAlive(paneId: string, opts: LivenessOpts = {}): Promise<boolean> {
    return (await this.agents(opts)).some((x) => x.paneId === paneId);
  }

  /** Resolve the pane with `paneLabel` inside the tab labelled `tabLabel` (or null). */
  async tabPaneByLabel(workspaceId: string, tabLabel: string, paneLabel: string): Promise<string | null> {
    const tabs = await runJson<TabListResp>(this.bin, ["tab", "list", "--workspace", workspaceId], {
      allowFail: true,
    }).catch(() => ({}) as TabListResp);
    const tab = (tabs.result?.tabs ?? []).find((t) => t.label === tabLabel);
    if (!tab) return null;
    const panes = await runJson<PaneListResp>(this.bin, ["pane", "list", "--workspace", workspaceId], {
      allowFail: true,
    }).catch(() => ({}) as PaneListResp);
    const pane = (panes.result?.panes ?? []).find((p) => p.tab_id === tab.tab_id && p.label === paneLabel);
    return pane?.pane_id ?? null;
  }

  /** Spawn a dedicated agent pane in `workspaceId` and return its pane id (null if it couldn't be
   *  brought up). argv[0] is the executable (e.g. "claude", "opencode"), argv[1..] its flags + the
   *  prompt.
   *
   *  herdr 0.7.5 turned `agent start` into an ADOPTION of an existing pane
   *  (`agent start <name> --kind <k> --pane <id>`) — it no longer creates one, and no longer takes
   *  `--workspace`/`--cwd`/`--env`. So the pane is ours to create: a new TAB in the workspace (never
   *  a split — that would resize a pane the belt's layout deliberately sized), carrying the cwd and
   *  the env that used to ride on `agent start`. Adoption BLOCKS until herdr has detected the agent
   *  and it is ready for input, which is what retires the old "sleep and hope the shell is up"
   *  guesswork; a harness herdr can't adopt (absolute path, wrapper script) is typed into the pane
   *  instead (see spawnStrategyForArgv). A failed adoption closes the pane it created rather than
   *  leaving an empty one behind.
   *
   *  `name` is the herdr AGENT name, which herdr constrains to `[a-z][a-z0-9_-]{0,31}` and requires to
   *  be unique among live agents — it is not a display string (the readable `<step>:<KEY>` identity is
   *  published separately as pane metadata; see core/pane-display.ts). */
  async agentStart(opts: {
    workspaceId: string;
    cwd: string;
    argv: string[];
    env?: Record<string, string>;
    /** herdr agent name — MUST satisfy herdr's charset rule; defaults to the kind. */
    name?: string;
    /** Explicit `agent.kind` override — adopt as this kind even when argv[0] isn't a bare kind name. */
    kind?: string;
    /** Called between creating the pane and adopting the agent, to wait for the pane's shell prompt
     *  (`agent start` refuses a pane whose shell isn't idle). Skipped when absent. */
    awaitShell?: (paneId: string) => Promise<void>;
  }): Promise<string | null> {
    const strategy = spawnStrategyForArgv(opts.argv, opts.kind);
    const kind = strategy.kind ?? agentKindForArgv(opts.argv);
    const name = opts.name ?? kind;
    // HERDR_AGENT is herdr's foreground-process hint (0.7.5 added macOS support): it tells herdr
    // which integration owns the pane when the process tree doesn't say so on its own — exactly the
    // wrapped-harness case the `run` strategy exists for, and ONLY that case. It is not harmless on
    // the adopt path: `agent start --kind` already declares the kind, and a pane whose env carries
    // the hint reads to herdr as one that ALREADY hosts an agent — `agent start` then answers
    // `agent_pane_busy: agent target pane <id> is not an available shell` (verified against herdr
    // 0.7.5 while building the e2e harness).
    const env = { ...opts.env, ...(strategy.mode === "run" && strategy.kind ? { HERDR_AGENT: strategy.kind } : {}) };

    let paneId: string;
    try {
      ({ paneId } = await this.tabCreate(opts.workspaceId, { label: name, cwd: opts.cwd, env }));
    } catch {
      return null; // no pane ⇒ no agent; the caller retries on a later tick
    }
    this.agentsMemo = null; // the agent set is about to change — don't serve a pre-spawn snapshot

    // A pane's shell is still sourcing rc files for a moment after it is created, and `agent start`
    // refuses a pane that isn't at an available prompt.
    await opts.awaitShell?.(paneId);

    const started =
      strategy.mode === "adopt"
        ? await this.agentAdopt(paneId, { name, kind: strategy.kind, args: opts.argv.slice(1) })
        : await this.paneRun(paneId, shellQuoteArgv(opts.argv)).then(() => true);
    // `agent start` waits for the agent to be READY for input, but a harness launched with its
    // prompt on argv (cursor-agent) goes straight to work and never reports ready inside the
    // timeout. Closing that pane kills a working agent and the retry repeats it forever — so a
    // pane where herdr already sees an agent counts as started.
    if (!started && strategy.mode === "adopt" && (await this.paneAlive(paneId, { fresh: true }).catch(() => false))) {
      return paneId;
    }
    if (!started) {
      await this.paneClose(paneId); // don't leave an empty pane behind
      return null;
    }
    return paneId;
  }

  /** Start `kind` in an EXISTING pane (which must be sitting at its shell prompt) and report whether
   *  herdr detected it and marked it ready for input. `agent start` BLOCKS until then, which is what
   *  lets a caller know the agent actually came up rather than assuming a typed command worked.
   *
   *  `name` must satisfy herdr's agent-name rule and be unique among LIVE agents. */
  async agentAdopt(paneId: string, opts: { name: string; kind: string; args?: readonly string[]; timeoutMs?: number }): Promise<boolean> {
    const timeout = opts.timeoutMs ?? HerdrClient.AGENT_READY_TIMEOUT_MS;
    const args = ["agent", "start", opts.name, "--kind", opts.kind, "--pane", paneId, "--timeout", String(timeout)];
    if (opts.args?.length) args.push("--", ...opts.args);
    this.agentsMemo = null; // the agent set is about to change — don't serve a pre-spawn snapshot
    const r = await run(this.bin, args, { allowFail: true, timeoutMs: timeout + 30_000 });
    this.agentsMemo = null;
    if (r.code !== 0) {
      const detail = `${r.stderr || r.stdout}`.trim().slice(0, 200);
      if (detail) this.lastAgentError = detail;
    }
    return r.code === 0;
  }

  /** The last `agent start` failure text, for a caller that wants to log WHY (herdr answers with a
   *  machine-readable code, e.g. `invalid_agent_name` / `agent_pane_not_found`). */
  lastAgentError: string | null = null;

  /** A LAYOUT pane's opening prompt (`panes[].prompt`), submitted once its agent is ready. Waiting is
   *  opt-in: with `settleTimeoutMs` the call blocks until the agent settles (idle/done) or that
   *  elapses; without one the prompt is submitted and the build moves on, leaving the agent working.
   *  Distinct from `agentSend`, whose handshake asks the opposite question — "did the agent START?" */
  async agentOpenPrompt(target: string, text: string, opts: { settleTimeoutMs?: number } = {}): Promise<boolean> {
    const args = ["agent", "prompt", target, text];
    if (opts.settleTimeoutMs != null) {
      args.push("--wait", "--until", "idle", "--until", "done", "--timeout", String(opts.settleTimeoutMs));
    }
    const r = await run(this.bin, args, {
      allowFail: true,
      timeoutMs: opts.settleTimeoutMs != null ? opts.settleTimeoutMs + 15_000 : undefined,
    });
    return r.code === 0;
  }

  /** herdr's cap on waiting for a spawned agent to reach interactive readiness (`agent start
   *  --timeout`, max 300_000). Generous: a cold `claude` on a large repo can take tens of seconds,
   *  and the alternative — declaring the pane ready early — drops the first keystrokes. */
  private static readonly AGENT_READY_TIMEOUT_MS = 120_000;

  async paneClose(paneId: string): Promise<void> {
    await run(this.bin, ["pane", "close", paneId], { allowFail: true });
  }

  async paneRun(paneId: string, command: string): Promise<void> {
    await run(this.bin, ["pane", "run", paneId, command], { allowFail: true });
  }

  // ── Layout building (absorbed from the workspace-manager plugin). argv mirrors that plugin's
  //    runner exactly; see src/core/layout.ts for the planner that drives these. ──

  /** Create a new tab in the workspace (opening in `cwd` if given); returns the tab + its root pane.
   *  `env` is exported into the new pane's shell — the only place a spawned agent's environment can
   *  be set now that herdr 0.7.5's `agent start` adopts an existing pane instead of creating one. */
  async tabCreate(workspaceId: string, opts: { label?: string; cwd?: string; env?: Record<string, string> } = {}): Promise<{ tabId: string; paneId: string }> {
    const args = ["tab", "create", "--workspace", workspaceId, "--no-focus"];
    if (opts.label) args.push("--label", opts.label);
    if (opts.cwd) args.push("--cwd", opts.cwd);
    for (const [k, v] of Object.entries(opts.env ?? {})) args.push("--env", `${k}=${v}`);
    const j = await runJson<TabCreateResp>(this.bin, args, { timeoutMs: HerdrClient.WORKTREE_TIMEOUT_MS });
    const tabId = j.result?.tab?.tab_id ?? j.result?.tab_id;
    const paneId = j.result?.root_pane?.pane_id ?? j.result?.pane?.pane_id ?? j.result?.pane_id;
    if (!tabId || !paneId) throw new Error(`herdr tab create missing ids: ${JSON.stringify(j).slice(0, 300)}`);
    return { tabId, paneId };
  }

  async tabRename(tabId: string, label: string): Promise<void> {
    await run(this.bin, ["tab", "rename", tabId, label], { allowFail: true });
  }

  /** The cell area of the TAB the pane belongs to, or null when it can't be read. `pane layout`
   *  reports `layout.area` — the whole tab, not the pane's own rect — so this is the region a layout's
   *  outermost split divides no matter how the tab is currently arranged. Measured ONCE before a build,
   *  which is what lets fixed `cells` sizes convert to exact ratios while walking the tree. */
  async tabArea(paneId: string): Promise<PaneBox | null> {
    const j = await runJson<PaneLayoutResp>(this.bin, ["pane", "layout", "--pane", paneId], { allowFail: true }).catch(
      () => ({}) as PaneLayoutResp,
    );
    const area = j.result?.layout?.area;
    const [cols, rows] = [area?.width, area?.height];
    return typeof cols === "number" && typeof rows === "number" && cols > 0 && rows > 0 ? { cols, rows } : null;
  }

  /** Is the pane sitting at an available shell prompt — the state `agent start` requires? A freshly
   *  created pane is NOT: its shell is still sourcing rc files (mise/asdf activation, prompt setup),
   *  and a pane running a command has to finish and hand back first. Callers poll this instead of
   *  sleeping a fixed guess. False on any read failure ("not yet", never "assume ready"). */
  async paneAtShellPrompt(paneId: string): Promise<boolean> {
    const j = await runJson<PaneProcessInfoResp>(this.bin, ["pane", "process-info", "--pane", paneId], { allowFail: true }).catch(
      () => ({}) as PaneProcessInfoResp,
    );
    return isAtShellPrompt(j.result?.process_info);
  }

  /** Build a whole tab's pane tree in ONE herdr call and return the created panes IN TREE ORDER
   *  (depth-first, first-before-second) alongside the tab's id.
   *
   *  Socket-only — herdr exposes `layout.apply` on its API but not its CLI (see clients/herdr-socket.ts
   *  for why that is worth one non-CLI transport). Three semantics worth knowing:
   *   • `tabId` and `workspaceId` are MUTUALLY EXCLUSIVE. With `tabId`, herdr REBUILDS that tab: it
   *     builds the replacement first and closes the old tab afterwards (so the workspace is never
   *     briefly tabless), and the tab is re-identified. Every previously-held id for it is therefore
   *     stale afterwards — safe for us because layouts are built into a freshly-created 1-pane
   *     worktree, before any pane id is recorded, and steps resolve their panes by LABEL.
   *   • With `workspaceId`, a new tab is appended. So a multi-tab layout is one call per tab and never
   *     needs a separate `tab create`.
   *   • `tabLabel` applies either way — it NAMES the resulting tab, so a rebuild needs no follow-up
   *     `tab rename`. */
  async layoutApply(opts: { workspaceId?: string; tabId?: string; tabLabel?: string; root: LayoutNode }): Promise<{ tabId: string; paneIds: string[] }> {
    if ((opts.tabId == null) === (opts.workspaceId == null)) throw new Error("herdr layout.apply takes exactly one of tabId / workspaceId");
    const res = await herdrSocketCall<{ layout?: LayoutDescription }>(
      "layout.apply",
      {
        ...(opts.tabId ? { tab_id: opts.tabId } : { workspace_id: opts.workspaceId }),
        ...(opts.tabLabel ? { tab_label: opts.tabLabel } : {}),
        root: opts.root,
        focus: false, // never steal the user's focus to build a background worktree
      },
      { timeoutMs: HerdrClient.LAYOUT_APPLY_TIMEOUT_MS },
    );
    const layout = res.layout;
    if (!layout?.tab_id || !layout.root) throw new Error(`herdr layout.apply returned no layout: ${JSON.stringify(res).slice(0, 300)}`);
    const paneIds: string[] = [];
    const walk = (n: LayoutDescriptionNode): void => {
      if (n.type === "pane") {
        if (!n.pane_id) throw new Error("herdr layout.apply returned a pane with no id");
        paneIds.push(n.pane_id);
        return;
      }
      walk(n.first);
      walk(n.second);
    };
    walk(layout.root);
    return { tabId: layout.tab_id, paneIds };
  }

  /** A layout build spawns a shell per pane; give it room, but keep it hard-bounded like every other
   *  external call (§5's load-bearing guarantee). */
  private static readonly LAYOUT_APPLY_TIMEOUT_MS = 120_000;

  /** The workspace's first (root) tab id — the tab a fresh worktree comes up with. */
  async firstTabId(workspaceId: string): Promise<string | null> {
    const j = await runJson<TabListResp>(this.bin, ["tab", "list", "--workspace", workspaceId], { allowFail: true }).catch(
      () => ({}) as TabListResp,
    );
    return j.result?.tabs?.[0]?.tab_id ?? null;
  }

  // ── Worktree/workspace introspection for the layout event hook (src/core/layout-hook.ts). ──

  private static parseWorkspaceInfo(w: RawWorkspace | undefined): WorkspaceInfo | null {
    if (!w) return null;
    const wt = w.worktree ?? {};
    return {
      checkoutPath: wt.checkout_path ?? null,
      repoRoot: wt.repo_root ?? null,
      repoName: wt.repo_name ?? null,
      isLinkedWorktree: wt.is_linked_worktree === true,
      tabCount: typeof w.tab_count === "number" ? w.tab_count : null,
      paneCount: typeof w.pane_count === "number" ? w.pane_count : null,
      activeTabId: w.active_tab_id ?? null,
    };
  }

  /** A workspace's worktree facts + freshness (tab/pane counts) by id. Tries `workspace get`, then
   *  falls back to scanning `workspace list`. null when the id isn't a known workspace. */
  async workspaceInfo(workspaceId: string): Promise<WorkspaceInfo | null> {
    const got = await runJson<WorkspaceGetResp>(this.bin, ["workspace", "get", workspaceId], { allowFail: true }).catch(
      () => ({}) as WorkspaceGetResp,
    );
    if (got.result?.workspace) return HerdrClient.parseWorkspaceInfo(got.result.workspace);
    const list = await runJson<WorkspaceListResp>(this.bin, ["workspace", "list"], { allowFail: true }).catch(
      () => ({}) as WorkspaceListResp,
    );
    const found = (list.result?.workspaces ?? []).find((w) => w.workspace_id === workspaceId);
    return found ? HerdrClient.parseWorkspaceInfo(found) : null;
  }

  /** The git branch of a workspace's worktree (or null for a detached HEAD / unresolvable). Matches
   *  on the open workspace id, falling back to the checkout path. */
  async worktreeBranch(workspaceId: string, checkoutPath?: string | null): Promise<string | null> {
    const j = await runJson<WorktreeListResp>(this.bin, ["worktree", "list", "--workspace", workspaceId, "--json"], {
      allowFail: true,
    }).catch(() => ({}) as WorktreeListResp);
    const worktrees = j.result?.worktrees ?? [];
    const byWorkspace = worktrees.find((w) => w.open_workspace_id === workspaceId);
    const byPath = checkoutPath ? worktrees.find((w) => w.path === checkoutPath) : undefined;
    const branch = (byWorkspace ?? byPath)?.branch;
    return branch && branch.length > 0 ? branch : null;
  }

  /** Every pane in a workspace, with the label herdr shows for it. [] when herdr can't be asked. */
  async listPanes(workspaceId: string): Promise<PaneSummary[]> {
    const j = await runJson<PaneListResp>(this.bin, ["pane", "list", "--workspace", workspaceId], { allowFail: true }).catch(
      () => ({}) as PaneListResp,
    );
    return (j.result?.panes ?? []).map((p) => ({ paneId: p.pane_id, tabId: p.tab_id, label: p.label ?? null }));
  }

  /** The first pane in a tab (a fresh worktree's root pane), or null. */
  async firstPaneOfTab(workspaceId: string, tabId: string): Promise<string | null> {
    return (await this.listPanes(workspaceId)).find((p) => p.tabId === tabId)?.paneId ?? null;
  }

  /** Submit `text` as a prompt to the agent in `paneId`. herdr 0.7.5 split the old `agent send` into
   *  logical `agent send-keys` (key presses) and **atomic** `agent prompt` (types the text, honors
   *  bracketed-paste, and presses Enter itself) — dispatching a step's instruction is the latter, and
   *  callers must NOT follow it with their own Enter.
   *
   *  With `confirm`, herdr's `--wait --until` turns the submission into a HANDSHAKE: it returns only
   *  once the agent has been observed entering one of the requested states, and fails
   *  (`agent_prompt_stalled`) when no state change followed the submission at all — i.e. the
   *  keystrokes were dropped. That is the failure this replaces: a silently-lost prompt used to look
   *  like a successful dispatch, so the step's budget clock started against an agent that never got
   *  the work and the run parked at budget instead of retrying.
   *
   *  A stalled verdict is NOT taken at face value, because herdr's state detection is per-harness and
   *  not every harness flips: `cursor-agent` on Linux takes the prompt and works while herdr keeps
   *  reporting the pane `idle`, so `--until working` always times out. Believing that verdict re-sends
   *  the prompt on every tick, and the agent queues each copy as a follow-up. So a stall falls back to
   *  a PROGRESS PROBE — did the pane visibly react? — and only a pane that did nothing is unconfirmed.
   *
   *  Returns whether the prompt is confirmed to have landed. `false` (only possible under `confirm`)
   *  means "treat this dispatch as not having happened" — never that the agent misbehaved. */
  async agentSend(paneId: string, text: string, opts: { confirm?: boolean } = {}): Promise<boolean> {
    const args = ["agent", "prompt", paneId, text];
    if (opts.confirm) {
      // `working` is the state a real prompt drives the agent into; `blocked` covers a harness that
      // comes straight back for input (a permission gate) — both prove the text arrived. NOT the
      // default (idle/done/blocked), which waits out the agent's whole TURN and would hold the tick.
      args.push("--wait", "--until", "working", "--until", "blocked", "--timeout", String(HerdrClient.PROMPT_CONFIRM_TIMEOUT_MS));
    }
    const before = opts.confirm ? await this.paneRevision(paneId) : null;
    const r = await run(this.bin, args, {
      allowFail: true,
      timeoutMs: opts.confirm ? HerdrClient.PROMPT_CONFIRM_TIMEOUT_MS + 15_000 : undefined,
    });
    if (r.code === 0 || !opts.confirm) return r.code === 0;
    return await this.paneMadeProgress(paneId, before);
  }

  /** herdr's `revision` for a pane — a counter it bumps every time the pane's terminal content
   *  changes — read FRESH (never the agents memo, whose whole point is to be a few seconds stale).
   *  null when the pane is gone, herdr is unreachable, or this herdr doesn't report the field. */
  private async paneRevision(paneId: string): Promise<number | null> {
    const agents = await this.agents({ fresh: true }).catch(() => [] as Agent[]);
    return agents.find((a) => a.paneId === paneId)?.revision ?? null;
  }

  /** Did the pane visibly react to a submission whose handshake stalled?
   *
   *  The signal is herdr's own per-pane `revision`: it is already carried by `agent list` (the call
   *  every liveness question makes, so this costs one extra invocation per dispatch and no new herdr
   *  surface), it is monotonic, and it moves for ANY change to the pane's screen — including the
   *  agent echoing the prompt it just received. The alternatives are worse: `agent_session` is
   *  present for any live agent and so says nothing about THIS submission, and diffing the worktree
   *  or `pane read` output costs a git scan or a screen capture per dispatch to answer the same
   *  question later and less directly.
   *
   *  Deliberately optimistic: unrelated output (a harness redrawing its spinner) can advance the
   *  revision and confirm a dispatch that never landed. That trade is the right way round — a false
   *  confirm starts the step's budget clock, which the budget watchdog already backstops by
   *  re-prompting, whereas a false stall re-submits the prompt every tick for the whole layout
   *  window and buries the agent in duplicate queued messages. */
  private async paneMadeProgress(paneId: string, before: number | null): Promise<boolean> {
    if (before == null) return false; // no baseline ⇒ nothing to compare; keep herdr's stalled verdict
    const after = await this.paneRevision(paneId);
    return after != null && after > before;
  }

  /** How long to wait for a submitted prompt to visibly move the agent. herdr needs ≥5s to call a
   *  submission stalled; this is generous over that (a cold harness can take a few seconds to react)
   *  while still far below any step budget — an unconfirmed dispatch is retried, not parked. */
  private static readonly PROMPT_CONFIRM_TIMEOUT_MS = 20_000;

  /** Focus the agent's pane (and its tab) so a worktree view follows the active step. */
  async agentFocus(paneId: string): Promise<void> {
    await run(this.bin, ["agent", "focus", paneId], { allowFail: true });
  }

  /** The one globally-focused pane (what the user is looking at), or null if none/herdr is
   *  not frontmost. herdr has no focus-change event, so the dispatcher polls this each tick. */
  async focusedPane(): Promise<FocusedPane | null> {
    const j = await runJson<PaneListResp>(this.bin, ["pane", "list"], { allowFail: true }).catch(
      () => ({}) as PaneListResp,
    );
    const p = (j.result?.panes ?? []).find((x) => x.focused);
    return p ? { paneId: p.pane_id, workspaceId: p.workspace_id, tabId: p.tab_id, label: p.label ?? null } : null;
  }

  /** Publish the factory's view of a pane as DISPLAY-ONLY metadata (herdr 0.7.5
   *  `pane report-metadata`), namespaced to this reporter.
   *
   *  This replaced `agent rename` for conveying run state. A rename MUTATES the pane's real label —
   *  the same label a step's `pane:` targets — so every dispatch destroyed the handle the next
   *  dispatch had to resolve by, which is why resolution needed a chain of fallbacks. Metadata is a
   *  parallel display layer: `label` stays exactly what the layout built, while the operator still
   *  sees which step and which work item owns the pane. `seq` (wall-clock ms) makes a stale write
   *  from an overlapping tick lose to a newer one rather than clobber it.
   *
   *  Best-effort by design: display state is never worth failing a tick over. */
  async reportPaneDisplay(paneId: string, d: PaneDisplay): Promise<void> {
    const args = ["pane", "report-metadata", paneId, "--source", HerdrClient.METADATA_SOURCE, "--seq", String(Date.now())];
    if (d.agentName != null) args.push("--display-agent", d.agentName);
    if (d.title != null) args.push("--title", d.title);
    else if (d.clearTitle) args.push("--clear-title");
    for (const [k, v] of Object.entries(d.tokens ?? {})) {
      if (v == null) args.push("--clear-token", k);
      else args.push("--token", `${k}=${v}`);
    }
    if (d.ttlMs != null) args.push("--ttl-ms", String(d.ttlMs));
    await run(this.bin, args, { allowFail: true });
  }

  /** The reporter namespace for every metadata write (herdr keys stored display state by source, so
   *  the factory's tokens/title never collide with another plugin's). */
  private static readonly METADATA_SOURCE = "herdr-factory";

  async notify(title: string, body: string): Promise<void> {
    await run(this.bin, ["notification", "show", title, "--body", body, "--sound", "request"], { allowFail: true });
  }
}
