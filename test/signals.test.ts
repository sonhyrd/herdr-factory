import { describe, expect, it } from "vitest";
import { SIGNAL_DESCRIPTORS, signalCommand, signalDescriptorFor } from "../src/signals/registry.ts";
import { askHumanRoute, bounceRoute, captureAttemptRoute, reworkRoute, setBranchRoute, stepDoneRoute } from "../src/server/schemas.ts";

// Registry ↔ agent-signal-surface parity. The agent→dispatcher signals are the load-bearing seam an
// agent invokes (step-done / bounce / ask-human / capture-attempt / evidence-upload). SIGNAL_DESCRIPTORS
// is the single source of truth; these tests keep the mounted HTTP routes + the prompt-token command
// strings from drifting from it. (The CLI commands stay hand-defined — importing cli/index.ts runs
// program.parse() — but the @@*_CMD@@ tokens agents actually run are rendered from the registry via
// signalCommand and pinned below, so the CLI must accept exactly this shape.)

const CLI = "/bin/herdr-factory";
const REPO = "demo";

describe("signal registry ↔ HTTP route parity", () => {
  // Every scope:'run' signal is dispatched over the server as POST /repos/{repo}/<name>; scope
  // 'product-outbox' (evidence-upload) and 'machine' (capture-lock) are deliberately CLI/in-process only.
  const ROUTES = [stepDoneRoute, askHumanRoute, bounceRoute, captureAttemptRoute, setBranchRoute, reworkRoute];

  it("every scope:'run' signal has a POST route at /repos/{repo}/<name>", () => {
    const byPath = new Map<string, (typeof ROUTES)[number]>(ROUTES.map((r) => [r.path, r]));
    for (const s of SIGNAL_DESCRIPTORS.filter((s) => s.scope === "run")) {
      const route = byPath.get(`/repos/{repo}/${s.name}`);
      expect(route, `no HTTP route mounted for run-signal "${s.name}"`).toBeTruthy();
      expect(route!.method).toBe("post");
    }
  });

  it("rework is an OPERATOR signal: a run-scoped route, but no prompt token (agents use bounce)", () => {
    const d = signalDescriptorFor("rework")!;
    expect(d.scope).toBe("run");
    expect(d.token).toBeUndefined();
    expect(d.lockDiscipline).toBe("waiting"); // it stops one step and re-dispatches another
  });

  it("evidence-upload is a product-outbox signal (no per-run HTTP route)", () => {
    expect(signalDescriptorFor("evidence-upload")!.scope).toBe("product-outbox");
  });
});

describe("signalCommand renders the exact agent-facing invocation (token ↔ command can't drift)", () => {
  it("step-done", () => {
    expect(signalCommand(CLI, REPO, "step-done", { key: "K-1", step: "work", source: "jira" })).toBe(
      `${CLI} --repo ${REPO} step-done K-1 work --source jira`,
    );
  });
  it("step-done carries the pass stamp when bound (what renderStepPrompt renders)", () => {
    expect(signalCommand(CLI, REPO, "step-done", { key: "K-1", step: "work", source: "jira", pass: "2" })).toBe(
      `${CLI} --repo ${REPO} step-done K-1 work --source jira --pass 2`,
    );
  });
  it("bounce (positional toStep + --reason-file flag)", () => {
    expect(signalCommand(CLI, REPO, "bounce", { key: "K-1", toStep: "work", source: "jira", "reason-file": ".memory/herdr-factory/bounce-review.md" })).toBe(
      `${CLI} --repo ${REPO} bounce K-1 work --source jira --reason-file .memory/herdr-factory/bounce-review.md`,
    );
  });
  it("bounce carries the issuing step + its pass stamp when bound (what renderStepPrompt renders)", () => {
    expect(
      signalCommand(CLI, REPO, "bounce", { key: "K-1", toStep: "work", source: "jira", "reason-file": ".memory/herdr-factory/bounce-review.md", step: "review", pass: "1" }),
    ).toBe(`${CLI} --repo ${REPO} bounce K-1 work --source jira --reason-file .memory/herdr-factory/bounce-review.md --step review --pass 1`);
  });
  it("ask-human (--question-file flag)", () => {
    expect(signalCommand(CLI, REPO, "ask-human", { key: "K-1", step: "work", source: "jira", "question-file": ".memory/herdr-factory/human-question-work.md" })).toBe(
      `${CLI} --repo ${REPO} ask-human K-1 work --source jira --question-file .memory/herdr-factory/human-question-work.md`,
    );
  });
  it("capture-attempt now carries the explicit step", () => {
    expect(signalCommand(CLI, REPO, "capture-attempt", { key: "K-1", step: "evidence", source: "jira" })).toBe(
      `${CLI} --repo ${REPO} capture-attempt K-1 evidence --source jira`,
    );
  });
  it("set-branch renders the placeholder the agent substitutes", () => {
    // `<new-branch-name>` is the ONE token a prompt hands over unresolved: the repo's branch
    // convention isn't knowable at render time, so the agent fills it in.
    expect(signalCommand(CLI, REPO, "set-branch", { key: "K-1", branch: "<new-branch-name>", source: "jira" })).toBe(
      `${CLI} --repo ${REPO} set-branch K-1 <new-branch-name> --source jira`,
    );
  });
  it("evidence-upload", () => {
    expect(signalCommand(CLI, REPO, "evidence-upload", { key: "K-1", source: "jira" })).toBe(
      `${CLI} --repo ${REPO} evidence-upload K-1 --source jira`,
    );
  });
  it("an optional flag with no binding is omitted (e.g. --source)", () => {
    expect(signalCommand(CLI, REPO, "step-done", { key: "K-1", step: "work" })).toBe(`${CLI} --repo ${REPO} step-done K-1 work`);
  });
});

describe("signal lock discipline", () => {
  it("derives from the registry: non-monotonic → waiting, monotonic → fire-and-forget", () => {
    expect(signalDescriptorFor("step-done")!.lockDiscipline).toBe("fire-and-forget");
    for (const name of ["bounce", "ask-human", "capture-attempt", "set-branch"]) {
      expect(signalDescriptorFor(name)!.lockDiscipline, `${name} must wait on the run lock`).toBe("waiting");
    }
  });

  it("capture-attempt takes an explicit step arg (a belt may have >1 evidence step)", () => {
    expect(signalDescriptorFor("capture-attempt")!.args.map((a) => a.name)).toContain("step");
  });
});
