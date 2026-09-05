import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STEP_DESCRIPTORS } from "../src/steps/registry.ts";
import { PRODUCT_CAPABILITIES, productCapabilityFor } from "../src/products/registry.ts";
import { SIGNAL_DESCRIPTORS, signalDescriptorFor } from "../src/signals/registry.ts";
import { watchEvaluatorFor } from "../src/core/watches.ts";
import type { ProductType } from "../src/types.ts";

// The step-primitive contract suite — the analog of test/work-source-contract.test.ts for the
// WorkSource charter. Parametrized over EVERY registered step primitive + product + signal, it is
// the executable definition of "the declarations are coherent, so composing them is reliable".

const PRODUCT_VOCAB: readonly ProductType[] = [
  "work_spec",
  "work_raw",
  "commits",
  "handoff",
  "evidence",
  "pull_request",
  "bounce_feedback",
  "human_reply",
  "close_reference",
];

const promptPath = (slug: string) => fileURLToPath(new URL(`../src/prompts/${slug}.md`, import.meta.url));

describe("StepDescriptor contract (per registered step primitive)", () => {
  for (const d of STEP_DESCRIPTORS) {
    describe(`step "${d.name}"`, () => {
      it("produces handoff (mandatory on every step)", () => {
        expect(d.produces).toContain("handoff");
      });

      it("consumes/produces are drawn only from the closed product vocabulary", () => {
        for (const c of d.consumes) expect(PRODUCT_VOCAB).toContain(c.type);
        for (const p of d.produces) expect(PRODUCT_VOCAB).toContain(p);
      });

      it("every produced AND consumed product maps to a registered ProductCapability", () => {
        for (const p of [...d.produces, ...d.consumes.map((c) => c.type)]) {
          expect(() => productCapabilityFor(p)).not.toThrow();
        }
      });

      it("has a shipped base prompt file, OR requires a prompt_file (the generic custom step)", () => {
        if (d.basePrompt) {
          expect(existsSync(promptPath(d.basePrompt.slug))).toBe(true);
        } else {
          expect(d.promptFileRequired).toBe(true);
        }
      });

      it("a read-only step never declares produces:commits (declared AND enforced)", () => {
        if (d.controls.posture?.readOnly) expect(d.produces).not.toContain("commits");
      });

      it("every guard declares a non-empty escalation reason; counter guards declare their resets", () => {
        for (const g of d.guards) {
          expect(g.escalationReason.length).toBeGreaterThan(0);
          if (g.kind === "capture_cap") {
            // Fresh forward pass + human resume refill the cap; a crash-recovery respawn NEVER does
            // (resetOn has no such trigger — a self-crash must not refill its own budget).
            expect(g.resetOn).toEqual(["forward_entry", "resume"]);
            expect(g.cumulative).toBe(false);
            expect(g.counterScope).toBe("run+step+guard"); // counter lives in the generalized guard_counters table
          }
          if (g.kind === "layout_wait") expect(g.resetOn).toEqual(["dispatch", "resume"]); // respawn budget refunds
          if (g.kind === "heartbeat") expect(g.requiresProduct).toBe("commits");
        }
      });

      it("a read-only posture always carries the read_only guard (and only read-only steps do)", () => {
        const declared = d.controls.posture?.readOnly ?? false;
        expect(d.guards.some((g) => g.kind === "read_only")).toBe(declared);
      });

      it("heartbeat precedes budget in guard order (the harness is first-trip-wins; stall diagnosis beats budget)", () => {
        const kinds = d.guards.map((g) => g.kind);
        if (kinds.includes("heartbeat")) expect(kinds.indexOf("heartbeat")).toBeLessThan(kinds.indexOf("budget"));
      });

      it("a bounce emitter only makes sense with an evidence/gate posture (has a base prompt to bounce from)", () => {
        // Belt-composition resolves the actual target; here we just assert the emit-side shape.
        if (d.controls.bounce) expect(d.controls.bounce.toEarliestConsumerOf).toBe("bounce_feedback");
      });
    });
  }

  it("STEP_WATCHDOG_ATTENTION == the union of autoRescueOnDone guard reasons", () => {
    const union = new Set(
      STEP_DESCRIPTORS.flatMap((d) => d.guards)
        .filter((g) => g.autoRescueOnDone)
        .map((g) => g.escalationReason),
    );
    // layout_wait is deliberately NOT here: it trips before the step's agent exists (no pane ⇒ no
    // agent ⇒ its step-done can never arrive), so it recovers by bounded respawn instead.
    // read_only_violation IS here (via READ_ONLY_GUARD, registry-derived — no hand-added literal):
    // a completed read-only step must never wedge on a commit it didn't make (RWR-18204).
    expect([...union].sort()).toEqual(["capture_limit", "read_only_violation", "step_budget", "step_stalled"]);
  });

  it("layout_wait recovers by bounded respawn, never by step-done (no pane ⇒ no agent ⇒ no signal)", () => {
    const layoutGuards = STEP_DESCRIPTORS.flatMap((d) => d.guards).filter((g) => g.kind === "layout_wait");
    expect(layoutGuards.length).toBeGreaterThan(0);
    for (const g of layoutGuards) {
      expect(g.autoRescueOnDone).toBe(false); // a step-done rescue is categorically wrong for this guard
      expect(g.autoRespawnLimit ?? 0).toBeGreaterThan(0); // the park must be able to self-heal, bounded
      expect(g.attachWhen).toBe("layoutTarget"); // only steps with a configured tab/pane ever wait
    }
    // The respawn-rescued reason set is exactly the layout wait today.
    const respawn = new Set(
      STEP_DESCRIPTORS.flatMap((d) => d.guards)
        .filter((g) => (g.autoRespawnLimit ?? 0) > 0)
        .map((g) => g.escalationReason),
    );
    expect([...respawn]).toEqual(["layout_wait_timeout"]);
  });

  it("the shipped primitives are exactly work/evidence/review/pr/custom", () => {
    expect(STEP_DESCRIPTORS.map((d) => d.name).sort()).toEqual(["custom", "evidence", "pr", "review", "work"]);
  });

  it("watch-harness declarations: every harness-evaluated kind has an evaluator; timers veto on working; read_only is pre-advance", () => {
    // The kinds the harness walks — everything else is spawn-phase (layout_wait), signal-driven
    // (capture_cap) or not a watchdog (exclusive_resource) and must NOT have an evaluator.
    for (const kind of ["budget", "heartbeat", "read_only"]) expect(watchEvaluatorFor(kind)).toBeDefined();
    for (const kind of ["layout_wait", "capture_cap", "exclusive_resource"]) expect(watchEvaluatorFor(kind)).toBeUndefined();
    const byKind = new Map(STEP_DESCRIPTORS.flatMap((d) => d.guards).map((g) => [g.kind, g]));
    expect(byKind.get("budget")!.vetoWhenWorking).toBe(true); // a LIVE agent is never parked by a timer
    expect(byKind.get("heartbeat")!.vetoWhenWorking).toBe(true);
    expect(byKind.get("read_only")!.vetoWhenWorking ?? false).toBe(false); // a working agent that committed still parks
    expect(byKind.get("read_only")!.stage).toBe("pre_advance"); // a done-but-violating step parks, then heals via rescue
  });
});

describe("SignalDescriptor contract", () => {
  it("signal names are unique and every signal takes a `key`", () => {
    const names = SIGNAL_DESCRIPTORS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const s of SIGNAL_DESCRIPTORS) expect(s.args.some((a) => a.name === "key")).toBe(true);
  });

  it("capture-attempt carries an explicit `step` arg (a belt may legitimately have >1 evidence step)", () => {
    expect(signalDescriptorFor("capture-attempt")!.args.some((a) => a.name === "step")).toBe(true);
  });

  it("non-monotonic signals wait on the run lock; monotonic ones are fire-and-forget", () => {
    // bounce/ask-human/capture-attempt all cause a non-monotonic run mutation (step rewind, phase
    // flip to waiting_for_human, or a cap-exceeded park) → must not be dropped on lock contention.
    expect(signalDescriptorFor("bounce")!.lockDiscipline).toBe("waiting");
    expect(signalDescriptorFor("ask-human")!.lockDiscipline).toBe("waiting");
    expect(signalDescriptorFor("capture-attempt")!.lockDiscipline).toBe("waiting");
    // set-branch mutates git AND the run row together — a concurrent pass must not read or write
    // half of it (the prompt render, PR discovery and cleanup all key on runs.branch).
    expect(signalDescriptorFor("set-branch")!.lockDiscipline).toBe("waiting");
    expect(signalDescriptorFor("step-done")!.lockDiscipline).toBe("fire-and-forget");
  });
});

describe("ProductCapability contract", () => {
  it("every capability's product is in the closed vocabulary and unique", () => {
    const products = PRODUCT_CAPABILITIES.map((p) => p.product);
    expect(new Set(products).size).toBe(products.length);
    for (const p of products) expect(PRODUCT_VOCAB).toContain(p);
  });

  it("pull_request carries adoption identity + a terminal watch + the produce→in_review effect", () => {
    const c = productCapabilityFor("pull_request");
    expect(c.adoption?.observedCompletion).toContain("MERGED");
    expect(c.adoption?.perAttemptBranchUid).toBe(true);
    expect(c.watch?.subPhase).toBe("reviewing");
    expect(c.watch?.idleHoldsSlot).toBe(false); // idle PR-watch holds no max_active_workspaces slot
    expect(c.watch?.resolver.reusesPaneOf).toBe("pull_request");
    expect(c.effectOnProduce?.to).toBe("in_review");
  });

  it("evidence enables the durable S3 upload outbox + the capture signals", () => {
    const c = productCapabilityFor("evidence");
    expect(c.outbox).toBe("evidence_publish");
    expect(c.signals).toContain("capture-attempt");
    expect(c.signals).toContain("evidence-upload");
  });
});
