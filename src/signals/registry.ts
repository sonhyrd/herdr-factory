// The SIGNAL registry: one descriptor per agent→dispatcher signal. Today each signal is a 5–6 file
// hand fan-out (zod body + createRoute + openapi handler + commander command + @@*_CMD@@ token +
// the withRunLock-vs-Waiting choice). This makes each a datum the server + CLI ITERATE to mount
// routes/commands/tokens, so /doc is complete and lock discipline derives from monotonicity — the
// seam a plugin step needs to expose the signal its agent invokes.
import type { SignalScope } from "../types.ts";

/** One argument of a signal's CLI/HTTP shape. `flag:true` ⇒ `--name value`; else positional. */
export interface SignalArg {
  readonly name: string;
  readonly required: boolean;
  readonly flag?: boolean;
}

export interface SignalDescriptor {
  readonly name: string;
  readonly scope: SignalScope;
  /** "waiting" ⇒ the effect is a NON-MONOTONIC run mutation (bounce rewinds step + re-dispatches;
   *  ask-human flips the phase) that must not be dropped on run-lock contention → withRunLockWaiting.
   *  "fire-and-forget" ⇒ a monotonic flag whose stale read only defers an idempotent advance. */
  readonly lockDiscipline: "fire-and-forget" | "waiting";
  /** The @@*_CMD@@ token injected into a step's prompt when the step supports this signal. */
  readonly token?: string;
  readonly args: readonly SignalArg[];
}

export const SIGNAL_DESCRIPTORS: readonly SignalDescriptor[] = [
  {
    // `pass` stamps the signal with the step pass whose prompt rendered it (run_steps.pass), so a
    // replayed/duplicated step-done from pass N is rejected instead of completing pass N+1 — bounce
    // rewinds make per-step progress non-monotonic, so "done" alone is not idempotent across passes.
    // Optional: prompts rendered before the pass column existed carry no stamp (upgrade safety).
    name: "step-done",
    scope: "run",
    lockDiscipline: "fire-and-forget",
    token: "@@STEP_DONE_CMD@@",
    args: [
      { name: "key", required: true },
      { name: "step", required: true },
      { name: "source", required: false, flag: true },
      { name: "pass", required: false, flag: true },
    ],
  },
  {
    // `step` names the ISSUING step (like capture-attempt's explicit step): the engine used to
    // attribute a bounce to whatever run.step was at processing time, so a late/replayed bounce
    // from an old pass could rewind the CURRENT step. `pass` stamps the issuing step's pass, same
    // rationale as step-done. Both optional for upgrade safety.
    name: "bounce",
    scope: "run",
    lockDiscipline: "waiting",
    token: "@@BOUNCE_CMD@@",
    args: [
      { name: "key", required: true },
      { name: "toStep", required: true },
      { name: "source", required: false, flag: true },
      { name: "reason-file", required: false, flag: true },
      { name: "step", required: false, flag: true },
      { name: "pass", required: false, flag: true },
    ],
  },
  {
    // The OPERATOR's rework — the only descriptor here with no `token`: it is never rendered into
    // an agent's prompt (an agent uses `bounce`, which the belt's canBounceTo constrains). It is
    // registered all the same so the HTTP route, the lock discipline and `/doc` derive from the
    // same declaration every other run-scoped signal does.
    name: "rework",
    scope: "run",
    lockDiscipline: "waiting",
    args: [
      { name: "key", required: true },
      { name: "toStep", required: true },
      { name: "source", required: false, flag: true },
      { name: "note-file", required: false, flag: true },
    ],
  },
  {
    name: "ask-human",
    scope: "run",
    lockDiscipline: "waiting",
    token: "@@ASK_HUMAN_CMD@@",
    args: [
      { name: "key", required: true },
      { name: "step", required: true },
      { name: "source", required: false, flag: true },
      { name: "question-file", required: false, flag: true },
    ],
  },
  {
    // Explicit `step` field (was anonymous run.step) — a belt may legitimately have >1 evidence step.
    // WAITING: past the cap this parks the run (running → attention), a non-monotonic flip that must
    // not be dropped or overwritten by a concurrent reconcile on a stale snapshot — same as bounce.
    name: "capture-attempt",
    scope: "run",
    lockDiscipline: "waiting",
    token: "@@CAPTURE_ATTEMPT_CMD@@",
    args: [
      { name: "key", required: true },
      { name: "step", required: true },
      { name: "source", required: false, flag: true },
    ],
  },
  {
    // The run's BRANCH is tracked state, not identity (core/run-branch.ts): the factory can only
    // name a branch from what the work source knows at claim time, while the repo's branching/CI
    // convention may demand a name the agent only learns mid-run (a ticket key it just created, a
    // required prefix). This is the front door for moving the worktree onto that name — validated
    // and recorded, and refused once a PR is open.
    // WAITING: it mutates git AND the run row together, a non-monotonic pair that must not race the
    // reconcile pass which reads the branch for prompts, PR discovery, and cleanup.
    name: "set-branch",
    scope: "run",
    lockDiscipline: "waiting",
    token: "@@SET_BRANCH_CMD@@",
    args: [
      { name: "key", required: true },
      { name: "branch", required: true },
      { name: "source", required: false, flag: true },
    ],
  },
  {
    name: "evidence-upload",
    scope: "product-outbox",
    lockDiscipline: "fire-and-forget",
    token: "@@EVIDENCE_UPLOAD_CMD@@",
    args: [
      { name: "key", required: true },
      { name: "source", required: false, flag: true },
    ],
  },
];

export function signalDescriptorFor(name: string): SignalDescriptor | undefined {
  return SIGNAL_DESCRIPTORS.find((s) => s.name === name);
}

/** Render a signal's CLI invocation from its descriptor — the SINGLE source of truth for the
 *  @@*_CMD@@ prompt tokens, so a token an agent runs can't drift from the mounted command. Args are
 *  emitted in declared order: a positional arg emits its bound value; a flag arg emits `--name value`
 *  only when a binding is provided (so an absent optional flag like --source is simply omitted).
 *  `bindings` is keyed by arg name (e.g. { key, step, source, "reason-file" }). */
export function signalCommand(cliPath: string, repo: string, name: string, bindings: Record<string, string | undefined>): string {
  const d = signalDescriptorFor(name);
  if (!d) throw new Error(`no signal descriptor "${name}"`);
  const parts: string[] = [cliPath, "--repo", repo, name];
  for (const a of d.args) {
    const v = bindings[a.name];
    if (a.flag) {
      if (v !== undefined) parts.push(`--${a.name}`, v);
    } else {
      parts.push(v ?? "");
    }
  }
  return parts.join(" ");
}
