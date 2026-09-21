// GATE RECEIPTS (issue #68 item 1) — "this command ran, at this commit, and this is what it said".
//
// The failure these guard against is a belt paying for the same fact repeatedly: on the run that
// motivated them the full spec suite ran six times, the unit suite six times and the scoped
// typecheck four times, all on one unchanged SHA, because no step could learn what an earlier step
// had already verified. The contract is therefore: a receipt is keyed by the COMMIT it was taken
// at, a re-run at that commit replaces it rather than accumulating, and a reader can tell at a
// glance which receipts cover the tree in front of it.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/index.ts";
import { Store } from "../src/db/store.ts";
import { formatGateReceipts, outputTail, runGate } from "../src/core/gate-receipts.ts";
import type { Deps } from "../src/core/deps.ts";
import type { GateReceipt, Run } from "../src/types.ts";

function harness(head = "sha-aaaaaaaaaaaa") {
  let now = 1000;
  const store = new Store(openDb(":memory:"), () => now);
  const worktree = mkdtempSync(join(tmpdir(), "hf-gate-"));
  const created = store.createRun({ repo: "demo", workSource: "jira", belt: "ship", ticketKey: "K-1", summary: "s", issueType: "Bug", branch: "fix/K-1" });
  store.updateRun(created.id, { phase: "running", step: "work", worktreePath: worktree });
  const run = store.getRun(created.id)!;
  const deps = {
    store,
    config: { repoName: "demo" },
    git: { headSha: async () => head },
    log: () => {},
    now: () => now,
  } as unknown as Deps;
  return { deps, store, run: run as Run, worktree, setNow: (n: number) => { now = n; } };
}

const receipt = (over: Partial<GateReceipt> = {}): Omit<GateReceipt, "id" | "ranAt"> => ({
  runId: 1,
  step: "work",
  pass: 1,
  gate: "test",
  command: "pnpm test",
  head: "sha-aaaaaaaaaaaa",
  exitCode: 0,
  durationMs: 1000,
  tail: null,
  ...over,
});

describe("gate receipts — storage", () => {
  it("a re-run at the SAME commit replaces the receipt instead of adding one", () => {
    const { store, run } = harness();
    store.recordGateReceipt(receipt({ runId: run.id, exitCode: 1, durationMs: 5000 }));
    const second = store.recordGateReceipt(receipt({ runId: run.id, step: "review", pass: 2, exitCode: 0, durationMs: 7000 }));
    const all = store.gateReceiptsFor(run.id);
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe(second.id);
    expect(all[0]!.exitCode).toBe(0); // the later run's verdict wins
    expect(all[0]!.step).toBe("review"); // step/pass are attribution, not identity
  });

  it("the same gate at a DIFFERENT commit is a different receipt (the SHA is what makes one trustworthy)", () => {
    const { store, run } = harness();
    store.recordGateReceipt(receipt({ runId: run.id, head: "sha-old" }));
    store.recordGateReceipt(receipt({ runId: run.id, head: "sha-new" }));
    expect(store.gateReceiptsFor(run.id)).toHaveLength(2);
    expect(store.gateReceipt(run.id, "test", "sha-new")).toBeTruthy();
    expect(store.gateReceipt(run.id, "test", "sha-missing")).toBeUndefined();
  });

  it("gateShellMs sums only the gates of THAT (step, pass) — the timing export's shell half", () => {
    const { store, run } = harness();
    store.recordGateReceipt(receipt({ runId: run.id, gate: "test", durationMs: 30_000 }));
    store.recordGateReceipt(receipt({ runId: run.id, gate: "typecheck", durationMs: 5_000 }));
    store.recordGateReceipt(receipt({ runId: run.id, gate: "lint", step: "review", pass: 1, durationMs: 90_000 }));
    store.recordGateReceipt(receipt({ runId: run.id, gate: "e2e", step: "work", pass: 2, durationMs: 90_000 }));
    expect(store.gateShellMs(run.id, "work", 1)).toBe(35_000);
    expect(store.gateShellMs(run.id, "review", 1)).toBe(90_000);
    expect(store.gateShellMs(run.id, "work", 9)).toBe(0);
  });
});

describe("gate receipts — running a gate", () => {
  it("records the command, the HEAD it ran at, its exit code and an output tail — and reports the exit code", async () => {
    const { deps, store, run } = harness();
    const res = await runGate(deps, run, { gate: "test", step: "work", pass: 1, cmd: "node", args: ["-e", "console.log('42 passed')"] });
    expect(res.exitCode).toBe(0);
    expect(res.receipt.command).toBe("node -e console.log('42 passed')");
    expect(res.receipt.head).toBe("sha-aaaaaaaaaaaa");
    expect(res.receipt.tail).toContain("42 passed");
    expect(store.timeline("demo", "K-1").some((e) => e.type === "gate_recorded")).toBe(true);
  });

  it("a FAILING gate leaves a receipt too — a later step must be able to see the failure, not just its absence", async () => {
    const { deps, store, run } = harness();
    const res = await runGate(deps, run, { gate: "test", step: "work", pass: 1, cmd: "node", args: ["-e", "console.error('boom'); process.exit(3)"] });
    expect(res.exitCode).toBe(3);
    expect(store.gateReceipt(run.id, "test", "sha-aaaaaaaaaaaa")!.exitCode).toBe(3);
    expect(res.receipt.tail).toContain("boom");
  });

  it("runs in the run's worktree", async () => {
    const { deps, run, worktree } = harness();
    writeFileSync(join(worktree, "marker.txt"), "here");
    const res = await runGate(deps, run, { gate: "ls", step: "work", pass: 1, cmd: "node", args: ["-e", "console.log(require('node:fs').readFileSync('marker.txt','utf8'))"] });
    expect(res.exitCode).toBe(0);
    expect(res.receipt.tail).toContain("here");
  });

  it("keeps the tail bounded — a chatty suite must not turn the run DB into a log store", () => {
    const tail = outputTail(Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n"));
    expect(tail.split("\n")).toHaveLength(40);
    expect(tail).toContain("line 499");
    expect(tail).not.toContain("line 400");
  });
});

describe("gate receipts — what the reading step sees", () => {
  it("marks a receipt at the current HEAD CURRENT and everything else STALE", () => {
    const lines = formatGateReceipts(
      [
        { ...receipt({ gate: "test", head: "sha-now" }), id: 1, ranAt: 2 },
        { ...receipt({ gate: "lint", head: "sha-before", exitCode: 1 }), id: 2, ranAt: 1 },
      ],
      "sha-now",
    );
    expect(lines[0]).toContain("CURRENT");
    expect(lines[0]).toContain("✓ pass");
    expect(lines[1]).toContain("STALE");
    expect(lines[1]).toContain("✗ exit 1");
  });

  it("says plainly when no step has recorded one (so an empty list can't read as 'all green')", () => {
    expect(formatGateReceipts([], "sha-now")[0]).toContain("no gate receipts");
  });
});
