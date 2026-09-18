// Pure worktree→layout matching (no herdr / telemetry / runner deps) — kept as a leaf so the lean
// event-hook entry (src/cli/layout-hook.ts) can import it without pulling in the layout runner and
// its telemetry graph. The effectful runner (applyLayout/buildPlan) lives in ./layout.ts.

import type { BeltConfig, LayoutConfig, LayoutTab } from "../config.ts";

/** Match a glob pattern against a branch name. Only `*` (any run of chars, incl "/") and `?` (a
 *  single char) are special; the match is full-string anchored. A classic iterative backtracking
 *  wildcard matcher — every other pattern char is literal. (Ported from the plugin's glob_match.) */
export function globMatch(pattern: string, text: string): boolean {
  const p = [...pattern];
  const t = [...text];
  let pi = 0;
  let ti = 0;
  let star = -1;
  let mark = 0;
  while (ti < t.length) {
    if (pi < p.length && (p[pi] === "?" || (p[pi] !== "*" && p[pi] === t[ti]))) {
      pi++;
      ti++;
    } else if (pi < p.length && p[pi] === "*") {
      star = pi;
      mark = ti;
      pi++;
    } else if (star >= 0) {
      pi = star + 1;
      mark++;
      ti = mark;
    } else {
      return false;
    }
  }
  while (pi < p.length && p[pi] === "*") pi++;
  return pi === p.length;
}

/** Which layout (if any) a belt applies to a worktree on `branch`. The belt's `layoutMatching`
 *  rules are tried in written order; the first whose glob matches the branch (and whose layout
 *  exists) wins. With no branch or no matching rule, `defaultLayout` is used. undefined when the
 *  belt yields no applicable layout.
 *
 *  There is no workspace-specificity scoring vs the plugin: a factory belt is already scoped to its
 *  repo (one config file = one repo), so it IS the plugin's "workspace" — layout is per-belt and
 *  automatically repo-linked. */
export function resolveBeltLayout(belt: BeltConfig, branch: string | undefined, layouts: LayoutConfig[]): LayoutConfig | undefined {
  const find = (id: string) => layouts.find((l) => l.id === id);
  if (branch) {
    for (const rule of belt.layoutMatching ?? []) {
      if (globMatch(rule.worktreePattern, branch)) {
        const layout = find(rule.layout);
        if (layout) return layout;
      }
    }
  }
  return belt.defaultLayout ? find(belt.defaultLayout) : undefined;
}

/** The tab titles the belt's steps dispatch into. A step reaches its pane by tab title + pane title
 *  (`tabPaneByLabel`), and needs BOTH to target a layout pane at all — with neither it spawns a
 *  dedicated pane and needs no layout tab. `belt.steps` already excludes steps skipped at load (an
 *  `evidence` step with no tab/pane), so this is exactly what the belt will dispatch. */
export function beltTargetedTabs(belt: BeltConfig): Set<string> {
  return new Set(belt.steps.filter((s) => s.tab && s.pane).map((s) => s.tab!));
}

/** Does anything other than a belt step give this tab a job? Two things a tab does on its own:
 *  it hosts the layout's `setup` pane (the setup command runs nowhere else), or it holds a pane that
 *  carries its own `prompt` — the documented way to put agent work in a pane no step targets. */
const tabHasOwnWork = (tab: LayoutTab, layout: LayoutConfig): boolean =>
  tab.panes.some((p) => (p.setup && layout.setup != null) || p.agent?.prompt != null);

/**
 * Drop the tabs of `layout` that this belt will never use — the layout is a LIBRARY entry, commonly
 * written for the longest belt that shares it, and building a short belt's run into all of it leaves
 * idle terminals and (worse) idle agents for steps that never dispatch.
 *
 * A tab survives when a step on this belt targets it by title, or when it has work of its own
 * (`tabHasOwnWork`). Everything else goes, agents included: an agent nothing will prompt is exactly
 * the waste here.
 *
 * Two deliberate non-prunings: a layout NO step targets is left whole (it can only be furniture the
 * user wants — dev servers, logs — and a layout must have at least one tab to be applied at all),
 * and only a FACTORY-OWNED run prunes (see resolveHookLayout) — a hand-created worktree has no belt
 * dispatching into it and gets the layout as written.
 */
export function pruneLayoutToBelt(layout: LayoutConfig, belt: BeltConfig): { layout: LayoutConfig; prunedTabs: string[] } {
  const targeted = beltTargetedTabs(belt);
  if (targeted.size === 0) return { layout, prunedTabs: [] };
  const keep = layout.tabs.filter((t) => (t.title != null && targeted.has(t.title)) || tabHasOwnWork(t, layout));
  // Nothing left to build means the belt's tab titles don't match this layout's at all (config-load
  // catches that for a `default_layout`, not for a `layout_matching` one) — build it as written and
  // let the step's layout wait report the mismatch, rather than turning it into an empty apply.
  if (keep.length === 0 || keep.length === layout.tabs.length) return { layout, prunedTabs: [] };
  return {
    layout: { ...layout, tabs: keep },
    prunedTabs: layout.tabs.flatMap((t, i) => (keep.includes(t) ? [] : [t.title ?? `(untitled tab ${i})`])),
  };
}

/** The layout to build into a worktree on `branch`, for the event hook (which sees any worktree,
 *  not just factory-claimed ones) — WITH the belt it came from, for the caller's own bookkeeping (a
 *  layout pane names its own agent, so no harness is threaded through). When the worktree is owned by
 *  an active factory run, `ownedBeltName` is that run's belt and that belt decides ALONE: if it yields
 *  no layout the answer is undefined, never another belt's layout — a layout-less belt's steps are
 *  meant to spawn dedicated panes, and painting a foreign layout into their workspace breaks that
 *  spawn. Only for worktrees no run owns (hand-created ones) do we walk the repo's belts in priority
 *  order and take the first that yields a layout. undefined ⇒ nothing to build.
 *
 *  An owned run's layout is also PRUNED to the tabs that belt actually uses (`pruneLayoutToBelt`),
 *  because layouts are a shared library: a short belt reusing a longer belt's layout would otherwise
 *  come up with idle terminals and idle agents for steps it never dispatches. `prunedTabs` names
 *  what was dropped, for the caller's log and timeline. A hand-created worktree keeps every tab —
 *  no belt is dispatching into it, so nothing there is unused. */
export function resolveHookLayout(
  belts: BeltConfig[],
  layouts: LayoutConfig[],
  ownedBeltName: string | undefined,
  branch: string | undefined,
): { layout: LayoutConfig; belt: BeltConfig; prunedTabs: string[] } | undefined {
  if (ownedBeltName) {
    const owner = belts.find((b) => b.name === ownedBeltName);
    if (owner) {
      const layout = resolveBeltLayout(owner, branch, layouts);
      if (!layout) return undefined;
      return { ...pruneLayoutToBelt(layout, owner), belt: owner };
    }
  }
  for (const belt of belts) {
    const layout = resolveBeltLayout(belt, branch, layouts);
    if (layout) return { layout, belt, prunedTabs: [] };
  }
  return undefined;
}
