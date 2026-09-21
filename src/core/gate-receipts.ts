// GATE RECEIPTS — "this command was run, at this commit, and this is what it said".
//
// Why this exists: on a 126-minute run of a one-cell UI change, the full spec suite ran six times,
// the unit suite six times and the scoped typecheck four times, all on the same unchanged SHA. The
// belt had no way for a later step to LEARN that an earlier one had already verified this exact
// tree, so every step re-derived the same fact by paying for it again — the review step alone
// re-ran 6.2 minutes of the work step's gates.
//
// A receipt is the cheap alternative: the work step wraps each verification command in
// `herdr-factory gate <key> <name> -- <cmd>`, the factory runs it (streaming, so the agent still
// sees the output), and records command + HEAD + exit code + a short output tail against the run.
// A later step lists the receipts (`herdr-factory gates <key>`) and re-runs a gate only when its
// receipt is missing, stale (a different HEAD) or it has a concrete reason to disbelieve it.
//
// The SHA is what makes a receipt trustworthy, so it is part of the row's identity: the same gate
// re-run at the same commit REPLACES its receipt instead of adding one. `gates --json` is the
// machine-readable form; the human form marks each receipt current (`✓ HEAD`) or stale.
import { spawn } from "node:child_process";
import type { Deps } from "./deps.ts";
import type { GateReceipt, Run } from "../types.ts";

/** How much of a gate's combined output the receipt keeps. Enough to see which assertion failed;
 *  not so much that a chatty suite turns the run DB into a log store. */
const TAIL_LINES = 40;
const TAIL_CHARS = 4000;

export interface GateRunResult {
  receipt: GateReceipt;
  exitCode: number;
}

/** Keep the last `TAIL_LINES` lines (and at most `TAIL_CHARS`) of a command's combined output. */
export function outputTail(text: string): string {
  const lines = text.split("\n").slice(-TAIL_LINES).join("\n");
  return lines.length > TAIL_CHARS ? lines.slice(-TAIL_CHARS) : lines;
}

/**
 * Run one gate command in the run's worktree and record its receipt. The child's stdout/stderr are
 * TEED to this process's own streams — the agent that invoked the wrapper must still see its test
 * output — while a bounded tail is kept for the receipt.
 *
 * No shell and no timeout: the argv comes from the prompt's `-- <cmd>` verbatim (so a gate cannot
 * be a shell injection seam), and a gate is a whole test suite, which the engine's 60 s default
 * exec budget would kill. The step's own budget/heartbeat watchdog is the real bound here.
 */
export async function runGate(
  deps: Deps,
  run: Run,
  opts: { gate: string; step: string; pass: number; cmd: string; args: string[] },
): Promise<GateRunResult> {
  const cwd = run.worktreePath;
  if (!cwd) throw new Error(`${run.ticketKey}: run has no worktree to run a gate in`);
  const head = (await deps.git.headSha(cwd)) ?? "";
  const startedAt = Date.now();
  let captured = "";
  const keep = (chunk: string) => {
    captured = outputTail(captured + chunk);
  };
  const exitCode = await new Promise<number>((resolve, reject) => {
    const child = spawn(opts.cmd, opts.args, { cwd, stdio: ["inherit", "pipe", "pipe"] });
    child.stdout.on("data", (b: Buffer) => {
      process.stdout.write(b);
      keep(b.toString());
    });
    child.stderr.on("data", (b: Buffer) => {
      process.stderr.write(b);
      keep(b.toString());
    });
    child.on("error", reject);
    // A command killed by a signal has no exit code; report it as a failure so the receipt can
    // never read "passed" for a run that did not finish.
    child.on("close", (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
  const durationMs = Date.now() - startedAt;
  const command = [opts.cmd, ...opts.args].join(" ");
  const receipt = deps.store.recordGateReceipt({
    runId: run.id,
    step: opts.step,
    pass: opts.pass,
    gate: opts.gate,
    command,
    head,
    exitCode,
    durationMs,
    tail: outputTail(captured) || null,
  });
  deps.store.recordEvent({
    runId: run.id,
    repo: deps.config.repoName,
    ticketKey: run.ticketKey,
    type: "gate_recorded",
    detail: { gate: opts.gate, step: opts.step, pass: opts.pass, head, exitCode, durationMs, command },
  });
  return { receipt, exitCode };
}

/** Render the receipts for a run as agent-readable lines. `head` is the worktree's current HEAD:
 *  a receipt taken at it is CURRENT (trust it); any other is stale (re-run that gate). */
export function formatGateReceipts(receipts: readonly GateReceipt[], head: string | null): string[] {
  if (receipts.length === 0) return ["(no gate receipts — no step has run a verification command through `herdr-factory gate` yet)"];
  return receipts.map((r) => {
    const current = head && r.head === head;
    return (
      `${r.exitCode === 0 ? "✓ pass" : `✗ exit ${r.exitCode}`}  ${r.gate.padEnd(14)} ` +
      `${current ? "CURRENT" : "STALE  "} ${r.head.slice(0, 12)}  ${(r.durationMs / 1000).toFixed(1)}s  ` +
      `${r.step} pass ${r.pass}  ${r.command}`
    );
  });
}
