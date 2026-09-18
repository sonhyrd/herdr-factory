// Pure worktree→layout matching (no herdr / telemetry / runner deps) — kept as a leaf so the lean
// event-hook entry (src/cli/layout-hook.ts) can import it without pulling in the layout runner and
// its telemetry graph. The effectful runner (applyLayout/buildPlan) lives in ./layout.ts.

import type { BeltConfig, LayoutConfig } from "../config.ts";

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

/** The layout to build into a worktree on `branch`, for the event hook (which sees any worktree,
 *  not just factory-claimed ones) — WITH the belt it came from, for the caller's own bookkeeping (a
 *  layout pane names its own agent, so no harness is threaded through). When the worktree is owned by
 *  an active factory run, `ownedBeltName` is that run's belt and that belt decides ALONE: if it yields
 *  no layout the answer is undefined, never another belt's layout — a layout-less belt's steps are
 *  meant to spawn dedicated panes, and painting a foreign layout into their workspace breaks that
 *  spawn. Only for worktrees no run owns (hand-created ones) do we walk the repo's belts in priority
 *  order and take the first that yields a layout. undefined ⇒ nothing to build. */
export function resolveHookLayout(
  belts: BeltConfig[],
  layouts: LayoutConfig[],
  ownedBeltName: string | undefined,
  branch: string | undefined,
): { layout: LayoutConfig; belt: BeltConfig } | undefined {
  if (ownedBeltName) {
    const owner = belts.find((b) => b.name === ownedBeltName);
    if (owner) {
      const layout = resolveBeltLayout(owner, branch, layouts);
      return layout ? { layout, belt: owner } : undefined;
    }
  }
  for (const belt of belts) {
    const layout = resolveBeltLayout(belt, branch, layouts);
    if (layout) return { layout, belt };
  }
  return undefined;
}
