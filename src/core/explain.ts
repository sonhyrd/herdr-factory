// The plain-language face of `runObligations`: turn the engine's structured "why is this run
// waiting and what would move it" answer into sentences an operator can act on without knowing
// the reconciler. PURE and renderer-free — a `string[]` of lines shared verbatim by the CLI
// (`explain <KEY>`) and the TUI run detail, unit-testable without a terminal. A LEAF module by
// design: type-only imports, no store/Effect/telemetry, so the TUI's eager startup graph
// (test/tui-startup-graph.test.ts) stays clean when the dashboard imports it.
//
// The invisible-by-design robustness — flat 30s retries, bounded waits, outbox suspensions — is
// exactly what makes a healthy-but-retrying factory look wedged, so every clock and counter here
// renders WITH its next firing time and its rescue: what the engine will do on its own, and what
// only a human can do.
import type { RunObligations } from "./obligations-shape.ts";

export interface ExplainInput {
  ob: RunObligations;
  /** The config-folder repo name, used to render ready-made commands. */
  repoName: string;
  /** Epoch SECONDS (matches `deps.now()` and every ledger/watch timestamp). */
  now: number;
  /** Lead with the run-identity line (key, run id, belt, phase). Default true — the CLI wants it;
   *  the TUI detail omits it because its Overview section already says the same. */
  heading?: boolean;
}

/** "42s" / "12m" / "2h 5m" / "3d 4h" — coarse on purpose; ticks quantize everything anyway. */
export function fmtDur(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** A future instant relative to now. A past-due instant says so — "due now" reads as "the next
 *  tick runs it", which is the truthful unit of time here. */
const inAbout = (now: number, ts: number): string => (ts <= now ? "due now (the next tick runs it)" : `in ~${fmtDur(ts - now)}`);
const ago = (now: number, ts: number): string => `${fmtDur(now - ts)} ago`;

interface Story {
  headline: string;
  body: string[];
  next: string[];
}

/** The per-code attention narratives. Keyed by `attention_reason_code`; enriched from the
 *  obligations facts where they carry more than the frozen reason text. An unknown (plugin) code
 *  falls back to the reason text + the guard's derived rescue class. */
function attentionStory(ob: RunObligations, resumeCmd: string, teardownCmd: string, now: number): Story {
  const code = ob.run.attentionReasonCode ?? "";
  const step = ob.run.step ?? ob.watches.step ?? "?";
  const reason = ob.run.attentionReason ?? "needs attention";
  const backstop = "The park is a backstop, not a verdict: a genuine step-done or bounce from the parked step still un-parks the run on its own.";
  // The fact that separates a WEDGED agent from a merely slow one: the engine already sent this
  // step's idle agent the "if you're done, signal" nudge, and it still never signalled.
  const nudgedAt = ob.watches.idleNudge?.nudgedAt ?? null;
  const nudgeLine =
    nudgedAt != null
      ? `The engine already nudged this idle agent ${ago(now, nudgedAt)} and it still never signalled — that is a wedged agent, not a slow one.`
      : "";
  switch (code) {
    case "step_budget":
      return {
        headline: `The run is parked: the ${step} step ran past its time budget (${reason}).`,
        body: [
          nudgeLine || "The commonest cause is an agent that finished but never ran its step-done command — resume re-prompts an idle agent, so it completes instead of re-parking.",
          backstop,
        ],
        next: [resumeCmd, `If it parks here repeatedly, raise the step's budget_seconds.`],
      };
    case "step_stalled":
      return {
        headline: `The run is parked: the ${step} step stopped committing (${reason}).`,
        body: [nudgeLine, backstop].filter(Boolean),
        next: [resumeCmd, "If the work legitimately needs long silent stretches, raise limits.stall_seconds."],
      };
    case "read_only_violation":
      return {
        headline: `The run is parked: the ${step} step is read-only, but the branch HEAD moved (${reason}).`,
        body: [
          "If the commit was legitimate — or a prior step's agent left a trailing commit — resume clears the enforcement baseline.",
          backstop,
        ],
        next: [resumeCmd],
      };
    case "dirty_tree":
      return {
        headline: `The run is parked: the ${step} step never commits, but the worktree is not clean (${reason}).`,
        body: [
          "A step that only films or reviews would otherwise pass judgement on code that is about to change — the uncommitted edit is usually a previous step's agent that was prompted again after its step-done.",
          "The diff stat is in the parked event's detail (`timeline <KEY>`) and in the run's pane.",
        ],
        next: [
          "In the run's worktree: commit the change on the step that owns it, or `git checkout -- .` / `git stash` to drop it.",
          resumeCmd,
          `${resumeCmd.replace(" resume ", " rework ")} <step> --note "…"   # if the work itself must be redone`,
        ],
      };
    case "evidence_upload_failed":
      return {
        headline: `The run is parked: the PR-opening step can't start — its evidence upload never landed (${reason}).`,
        body: ["Opening the PR now would embed dead evidence links, so the evidence gate holds it until `evidence_uploaded`."],
        next: [
          `${resumeCmd.replace(/ resume .*/, " doctor --deep")}   # prove the publisher works`,
          resumeCmd + "   # retries a stuck upload at once; the step starts once it lands",
          `${resumeCmd.replace(" resume ", " rework ")} <evidence step>   # a FAILED upload can't be retried — re-capture`,
        ],
      };
    case "capture_limit":
      return {
        headline: `The run is parked: the evidence step re-captured past the attempt cap (${reason}).`,
        body: [
          "The usual cause is a flaky app or a change the evidence cannot demonstrate — the cap only stops a stuck loop.",
          backstop,
        ],
        next: [resumeCmd + "   # refunds the capture budget"],
      };
    case "layout_wait_timeout": {
      const g = ob.watches.guards.find((x) => x.kind === "layout_wait");
      const used = g ? `${g.facts.respawnsUsed} of ${g.facts.respawnLimit}` : "all";
      // The park carries the layout hook's failure line for the workspace when the build failed —
      // that, not the generic causes, is what to fix. Only a config-load line points at doctor.
      const hook = reason.split(" — layout hook: ")[1];
      const configLine = hook != null && /no factory repo config|config failed to load/.test(hook);
      // The pane IS up, but herdr never detected the agent running in it — no plugin or tab-name fix
      // applies, and the engine's one relaunch (quit + retype the layout's command) did not take.
      const undetected = reason.includes("was never detected by Herdr");
      return {
        headline: undetected
          ? `The run is parked: Herdr never detected the ${step} step's agent (${reason}).`
          : `The run is parked: the ${step} step's pane never became available (${reason}).`,
        body: [
          `The engine already re-attempted the spawn on its own (${used} respawn windows used)${undetected ? "" : " — this park means the pane is genuinely not coming up"}.`,
          undetected
            ? "The agent is running in its pane, but `herdr agent list` shows it `unknown` with no agent label, so no prompt lands. The engine relaunched it once already. By hand: quit the agent in the pane, re-type its command at the shell prompt, and resume once herdr lists it."
            : hook
            ? `The layout build failed for this workspace: ${hook}. Fix that first${configLine ? " (a config that doesn't load: `herdr-factory doctor` names it)" : ""}.`
            : "Common causes: the factory isn't linked as a herdr plugin, or the step's tab/pane names don't match the layout's real titles.",
        ],
        next: [resumeCmd + "   # refunds the respawn budget", "herdr plugin link ~/.local/share/herdr-factory   # if the layout never builds at all"],
      };
    }
    case "bounce_limit": {
      const caps = ob.watches.bounceCaps.map((b) => `${b.step} ×${b.count} of ${b.max}`).join(", ");
      return {
        headline: `The run is parked: the rework loop hit the bounce cap (${reason}).`,
        body: [
          caps ? `Bounce counters: ${caps}.` : "",
          "The steps disagree about the work — this park always needs a human judgement.",
        ].filter(Boolean),
        next: [resumeCmd + "   # refunds the bounce budget belt-wide", teardownCmd + "   # abandon the run instead"],
      };
    }
    case "pr_closed":
      return {
        headline: `The run is parked: PR ${ob.run.prNumber ? `#${ob.run.prNumber} ` : ""}was closed without merging.`,
        body: ["A later merge still tears the run down on its own."],
        next: ["Reopen the PR, then: " + resumeCmd, teardownCmd + "   # abandon the run instead"],
      };
    case "source_item_stale":
      return {
        headline: `The run is parked: the work item is gone at the source (${reason}).`,
        body: ["Retrying cannot help — the item was deleted, transferred, or closed underneath the run."],
        next: [resumeCmd + "   # continue anyway (a PR may exist)", teardownCmd],
      };
    case "belt_missing":
      return {
        headline: `The run is parked: ${reason}.`,
        body: ["The run's belt is no longer in config. Resume refuses while it is missing."],
        next: [`Re-add the belt under its old name (or rename via the TUI, which migrates runs), then: ${resumeCmd}`],
      };
    case "source_missing":
      return {
        headline: `The run is parked: ${reason}.`,
        body: ["The run's work source is no longer in config. Source names are append-only for this reason."],
        next: [`Re-add the source under its old name, then: ${resumeCmd}`],
      };
    case "unknown_step":
      return {
        headline: `The run is parked: ${reason}.`,
        body: ["The belt was edited under the run — its active step no longer exists."],
        next: [`Restore the step name in the belt, then: ${resumeCmd}`, teardownCmd],
      };
    case "human_reply_unknown_step":
      return {
        headline: `The run is parked: ${reason}.`,
        body: ["The human reply already landed in the worktree — only the step name is missing."],
        next: [`Restore the step name in the belt, then: ${resumeCmd}`],
      };
    case "human_wait_missing_question":
      return {
        headline: `The run is parked: it was waiting for a human, but no pending question is recorded.`,
        body: ["This is a state inconsistency, not a normal park."],
        next: [resumeCmd, teardownCmd],
      };
    case "human_poll_failing":
      return {
        headline: `The run is parked: ${reason}.`,
        body: ["Polling the source for the reply keeps throwing — usually credentials or connectivity, not the human."],
        next: [`herdr-factory --repo … doctor --deep   # find the failing source`, resumeCmd + "   # fresh poll window once fixed"],
      };
    case "external_wait_deadline":
      return {
        headline: `The run is parked: ${reason}.`,
        body: ["An external wait passed its deadline before being fulfilled."],
        next: ["POST /repos/<repo>/intents/<id>/fulfil   # deliver the result late", resumeCmd, teardownCmd],
      };
    default: {
      const g = ob.watches.guards.find((x) => x.escalationReason === code);
      const rescue =
        g?.rescue === "terminal-signal"
          ? backstop
          : g?.rescue === "respawn"
            ? "The engine retries this park by re-attempting the spawn, within a bounded budget."
            : "This park needs a human decision — the engine will not clear it on its own.";
      return { headline: `The run is parked: ${reason}.`, body: [rescue], next: [resumeCmd, teardownCmd] };
    }
  }
}

/** The active-phase story (everything except `attention`). */
function phaseStory(ob: RunObligations, input: ExplainInput, resumeCmd: string): Story {
  const { now } = input;
  const step = ob.run.step ?? ob.watches.step ?? "?";
  const guards = ob.watches.guards;
  const fact = (kind: string) => guards.find((g) => g.kind === kind)?.facts;

  const layoutWaitLines = (): string[] => {
    const f = fact("layout_wait");
    if (!f || f.waitingSince == null) return [];
    const windowEnds = Number(f.waitingSince) + Number(f.windowSeconds);
    const lines = [`It waits for the step's pane and agent (waiting ${ago(now, Number(f.waitingSince))}; this window expires ${inAbout(now, windowEnds)}).`];
    const used = Number(f.respawnsUsed ?? 0);
    if (used > 0) lines.push(`The wait was already re-armed ${used} of ${f.respawnLimit} times; once the budget is spent the run parks for attention.`);
    return lines;
  };

  switch (ob.run.phase) {
    case "claiming":
      return {
        headline: `The run is claiming: the first step (${step}) has not been dispatched yet.`,
        body: layoutWaitLines(),
        next: [],
      };
    case "running": {
      const body: string[] = [];
      const pass = ob.watches.engine.find((w) => w.kind !== "pane_liveness")?.facts;
      if (pass && pass.dispatchedAt == null) {
        body.push("The current pass's prompt has not reached an agent yet — the dispatch retries under the bounded layout wait.");
        body.push(...layoutWaitLines());
      }
      const budget = fact("budget");
      if (budget?.deadlineAt != null) {
        const d = Number(budget.deadlineAt);
        body.push(
          d > now
            ? `The step budget expires ${inAbout(now, d)} (${fmtDur(Number(budget.budgetSeconds))} total). A working agent is never parked by the timer.`
            : "The step is over its time budget — the next tick parks it for attention (auto-rescuable by the step's own step-done or bounce).",
        );
      }
      const hb = fact("heartbeat");
      if (hb?.lastProgressAt != null) {
        const stallsAt = Number(hb.stallsAt);
        body.push(
          stallsAt > now
            ? `Last commit progress: ${ago(now, Number(hb.lastProgressAt))}. With no new commit it reads as stalled ${inAbout(now, stallsAt)}.`
            : "No new commits for longer than the stall window — the next tick parks it for attention (auto-rescuable).",
        );
      }
      const ro = fact("read_only");
      if (ro) {
        body.push("This step is read-only — enforced: a commit from it parks the run, and its step-done is refused while the tree is dirty.");
        if (ro.treeRefusedWhy) {
          body.push(
            `⚠ Its step-done was REFUSED ${ro.treeRefusedAt != null ? ago(now, Number(ro.treeRefusedAt)) : "earlier"}: ${ro.treeRefusedWhy}. ` +
              "The step cannot finish until the worktree is clean again — commit or revert the change on the step that owns it; the agent can then re-run its step-done.",
          );
        }
      }
      const cap = fact("capture_cap");
      if (cap && Number(cap.attempts) > 0) body.push(`Capture attempts this pass: ${cap.attempts} of ${cap.cap}.`);
      return { headline: `The ${step} step is active.`, body, next: [] };
    }
    case "waiting_for_human": {
      const q = ob.intents.humanQuestion;
      if (!q) {
        return {
          headline: "The run waits for a human answer, but no pending question is recorded.",
          body: ["The next tick parks it for attention (state inconsistency)."],
          next: [resumeCmd],
        };
      }
      const body = [
        q.posted
          ? "The question is posted on the work item."
          : "The question is still queued to post to the source — the outbox retries it until it lands.",
        `Reply checks so far: ${q.pollAttempts}; the next check runs ${inAbout(now, q.nextPollAt)} (checks run every 30s).`,
      ];
      if (q.pollErrors > 0) body.push(`⚠ ${q.pollErrors} reply checks in a row have FAILED — at 10 the run parks for attention. Check the source's credentials.`);
      body.push("The wait is not a trap: an agent that gets past the blocker and signals step-done (or bounces) resumes the run and closes the question.");
      return {
        headline: `The run waits for a human answer to the ${q.step ?? step} step's question. It holds no workspace slot while it waits.`,
        body,
        next: ["Reply on the work item in a NEW comment — the run resumes on its own."],
      };
    }
    case "reviewing":
      return {
        headline: ob.run.prNumber
          ? `The run watches PR #${ob.run.prNumber} until it merges or closes — the watch has no time limit.`
          : "The run is in the PR watch, but no PR number is recorded yet.",
        body: [
          ob.run.resolverActive
            ? "A resolver agent is active in the worktree right now (it holds a workspace slot while it works)."
            : "The watch is idle and holds no workspace slot; a resolver wakes when review threads or checks change.",
        ],
        next: [],
      };
    case "tearing_down":
      return { headline: "The run is tearing down: the worktree is being removed and the branch deleted.", body: [], next: [] };
    case "done":
      return { headline: "The run is finished.", body: [], next: [] };
    default:
      return { headline: `The run is in phase "${ob.run.phase}".`, body: [], next: [] };
  }
}

/** Deliver-lane: durable intents the engine still owes the world — the invisible retries that make
 *  a healthy run look stalled. Kinds already narrated by the phase story (the human-reply poll,
 *  the pending signal) are itemized here only in their generic ledger form when something is owed
 *  beyond what the phase said. */
function owedLines(ob: RunObligations, now: number): string[] {
  const lines: string[] = [];
  const suspendedNote = "SUSPENDED after 10 failed attempts — retries stopped; fix the cause, then press s on the dashboard (or run retry-now)";
  for (const t of ob.intents.transitions) {
    if (t.staleUnhandled) {
      lines.push(`· status write-back → ${t.toStatus || t.toState}: the item is GONE at the source — the stale policy runs on the next pass.`);
      continue;
    }
    lines.push(`· status write-back → ${t.toStatus || t.toState}: ${t.suspended ? suspendedNote : `attempt ${t.attempts}, next try ${inAbout(now, t.nextAttemptAt)}`}.`);
    if (t.lastError) lines.push(`    last error: ${t.lastError}`);
  }
  for (const u of ob.intents.evidenceUploads) {
    const cause =
      u.errorKind === "auth"
        ? " — auth failure: refresh your credentials (e.g. AWS SSO); the engine retries the moment they come back"
        : u.errorKind === "permanent"
          ? " — config error: run `doctor --deep`"
          : "";
    lines.push(
      `· evidence upload${u.keyPrefix ? ` (${u.keyPrefix})` : ""}: ${u.suspended ? suspendedNote : `attempt ${u.attempts}, next try ${inAbout(now, u.nextAttemptAt)}`}${cause}.`,
    );
    if (u.lastError) lines.push(`    last error: ${u.lastError}`);
  }
  const sig = ob.intents.pendingSignal;
  if (sig) lines.push(`· a ${sig.signal} signal from the agent is recorded (${ago(now, sig.createdAt)}) — the next reconcile pass applies it.`);
  const narrated = new Set(["source_transition", "evidence_publish", "human_reply_poll", "agent_signal"]);
  for (const row of ob.intents.ledger) {
    if (row.handoffOwed) {
      lines.push(`· ${row.kind} #${row.id} finished — the run applies its result on the next pass.`);
      continue;
    }
    if (narrated.has(row.kind)) continue;
    const when = row.suspended
      ? suspendedNote
      : row.deadlineAt != null
        ? `deadline ${inAbout(now, row.deadlineAt)}`
        : `next attempt ${inAbout(now, row.nextAttemptAt)}`;
    lines.push(`· ${row.kind} #${row.id} (${row.status}): ${when}.${row.lastError ? ` last error: ${row.lastError}` : ""}`);
  }
  return lines;
}

/** Render the whole narrative. Line 1 identifies the run; then the phase (or park) story, the
 *  deliver-lane debts, the bounce counters, and the ready-made next actions. */
export function explainRun(input: ExplainInput): string[] {
  const { ob, repoName, now } = input;
  const resumeCmd = `herdr-factory --repo ${repoName} resume ${ob.run.key}`;
  const teardownCmd = `herdr-factory --repo ${repoName} teardown ${ob.run.key}`;
  const story = ob.run.phase === "attention" ? attentionStory(ob, resumeCmd, teardownCmd, input.now) : phaseStory(ob, input, resumeCmd);

  const where = ob.run.phase === "running" && ob.run.step ? `${ob.run.step} step` : ob.run.phase;
  const lines: string[] = input.heading === false ? [] : [`${ob.run.key} — run #${ob.run.id} on belt ${ob.run.belt ?? "?"} (${where})`, ""];
  lines.push(story.headline);
  lines.push(...story.body);
  const ev = ob.evidence;
  if (ev && ob.run.phase !== "done") {
    const e7 = ev.evidenceHead.slice(0, 7);
    const h7 = ev.prHead.slice(0, 7);
    lines.push(
      ev.stale
        ? `⚠ Evidence + review judged ${e7}; the PR head is ${h7} with code changes since (${ev.files.length ? ev.files.slice(0, 5).join(", ") + (ev.files.length > 5 ? ", …" : "") : "files unknown"}). Not ready to merge until they pass at the new head.`
        : ev.evidenceHead === ev.prHead
          ? `Evidence + review judged the PR head ${h7}.`
          : `Evidence + review judged ${e7}; the PR head ${h7} differs only in docs/translations, so the verdict still holds.`,
    );
  }

  const owed = owedLines(ob, now);
  if (owed.length) {
    lines.push("", "Owed to the world (durable — retried every 30s, suspended after 10 failures):");
    lines.push(...owed.map((l) => `  ${l}`));
  }

  if (ob.run.phase !== "attention" || ob.run.attentionReasonCode !== "bounce_limit") {
    const caps = ob.watches.bounceCaps;
    if (caps.length) lines.push("", `Rework bounces so far: ${caps.map((b) => `${b.step} ×${b.count} of ${b.max}`).join(", ")}.`);
  }

  if (story.next.length) {
    lines.push("", "Next:");
    lines.push(...story.next.map((n) => `  ${n}`));
  }
  return lines;
}
