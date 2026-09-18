// `herdr-factory fleet` — every run on every machine, in one table.
//
// Rendering only: the reading, the timeouts and the `unverifiable` verdict all live in
// `fleet/read.ts`, so the `--json` payload and the table are the same snapshot printed two ways.
import { fmtDur } from "../core/explain.ts";
import type { FleetMachine, FleetSnapshot } from "../fleet/read.ts";

const COLUMNS = ["MACHINE", "REPO", "KEY", "BELT", "STEP", "PHASE", "AGE", "PROBLEMS"] as const;

function cells(snapshot: FleetSnapshot): string[][] {
  return snapshot.runs.map((run) => [
    run.machine,
    run.repo,
    run.key,
    run.belt ?? "-",
    run.step ?? "-",
    run.phase,
    run.ageSeconds === null ? "-" : fmtDur(run.ageSeconds),
    run.problems.length ? run.problems.join(" · ") : "-",
  ]);
}

/** Pad every column to its widest cell, except the last (a long problem string must not pad the
 *  line out to the terminal's width and beyond). */
function table(rows: string[][]): string[] {
  const widths = COLUMNS.map((_, i) => Math.max(...rows.map((r) => r[i]?.length ?? 0)));
  return rows.map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i]!))).join("  ").trimEnd());
}

/** One machine's own line: is it answering, what version, and what its host-local gate says. The
 *  `unverifiable` line leads with WHEN it last answered — that number is what tells an operator
 *  whether they are looking at a blip or a box that has been gone all morning. */
function machineLine(m: FleetMachine, readAt: number, localVersion: string | null): string {
  const where = m.local ? "this machine" : (m.sshTarget ?? "?");
  if (m.state === "unverifiable") {
    const seen = m.lastSeenAt === null ? "never seen" : `last seen ${fmtDur(readAt - m.lastSeenAt)} ago`;
    return `  ✗ ${m.name} (${where}) — unverifiable: ${m.detail ?? "no answer"} · ${seen} · its runs are NOT known to be gone`;
  }
  const parts = [`v${m.version ?? "?"}`, `${m.repos.length} repo${m.repos.length === 1 ? "" : "s"}`, `${m.runs.length} running`];
  if (m.machineLine) parts.push(m.machineLine.replace(/^machine: /, ""));
  // A box the updater has not reached is invisible from its own dashboard (issue #35).
  if (!m.local && localVersion && m.version !== localVersion) parts.push(`⚠ build differs from this machine (v${localVersion})`);
  return `  ✓ ${m.name} (${where}) — ${parts.join(" · ")}`;
}

export function renderFleet(snapshot: FleetSnapshot): string {
  const reachable = snapshot.machines.filter((m) => m.state === "ok").length;
  const blind = snapshot.machines.length - reachable;
  const local = snapshot.machines.find((m) => m.local);
  const out: string[] = [
    `herdr-factory fleet — ${snapshot.machines.length} machine${snapshot.machines.length === 1 ? "" : "s"} (${reachable} reachable${
      blind ? `, ${blind} unverifiable` : ""
    }) · ${snapshot.runs.length} run${snapshot.runs.length === 1 ? "" : "s"}`,
    "",
    ...snapshot.machines.map((m) => machineLine(m, snapshot.readAt, local?.state === "ok" ? local.version : null)),
    "",
  ];
  out.push(...(snapshot.runs.length ? table([[...COLUMNS], ...cells(snapshot)]).map((l) => `  ${l}`) : ["  (no runs in flight on any reachable machine)"]));
  const problems = snapshot.machines.flatMap((m) => m.problems.map((p) => `  ⚠ ${m.name}/${p.repo}: ${p.kind} — ${p.detail}`));
  if (problems.length) out.push("", ...problems);
  return out.join("\n");
}
