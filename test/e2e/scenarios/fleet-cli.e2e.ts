// The fleet, end to end: TWO real factory servers, each with its own config dir, state root, port
// and DB, merged into one `herdr-factory fleet --json`.
//
// What this proves that a unit test cannot: the fleet's machine list really comes out of
// `herdr machine list`, the reads really cross HTTP to a server that knows nothing about the caller,
// and a machine that GOES AWAY mid-session is reported `unverifiable` with the time it last
// answered — rather than as a machine with no runs, which is the reading an operator would act on.
//
// The one thing swapped out is SSH itself (there is no second host in a container): the transport's
// endpoint override points the "remote" machine at the second `serve`. Everything above the
// transport — discovery, the parallel read, the timeout, the verdict, the table — is the shipped code.
import { expect } from "vitest";
import { scenario } from "../harness/index.ts";

interface FleetJson {
  readAt: number;
  machines: {
    name: string;
    local: boolean;
    state: "ok" | "unverifiable";
    version: string | null;
    lastSeenAt: number | null;
    detail?: string;
    repos: string[];
    runs: unknown[];
  }[];
  runs: { machine: string; repo: string; key: string; belt: string | null; step: string | null; phase: string; ageSeconds: number | null }[];
}

const WORK = { type: "work" } as const;

scenario(
  {
    name: "fleet-cli",
    lane: "fake",
    briefs: { "here-1": "# Work on this machine\n" },
    config: (p) => ({
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      belt: [{ name: "local-belt", source: "briefs", steps: [WORK] }],
    }),
    // The second machine: its own factory, its own work, its own briefs folder.
    fleetMachines: {
      "build-box": {
        briefs: { "there-1": "# Work on the other machine\n" },
        config: (p) => ({
          work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
          belt: [{ name: "remote-belt", source: "briefs", steps: [WORK] }],
        }),
      },
    },
    // Both agents sit in `work` rather than finishing: the fleet view is about runs IN FLIGHT, and a
    // run that completes leaves the table before it can be asserted on.
    agent: { default: { hangMs: "forever" } },
  },
  async (w) => {
    const fleet = (args: string[] = []): FleetJson => {
      // Repo-agnostic: `fleet` takes no --repo, which is the point — it spans machines AND repos.
      const r = w.factory.cli(["fleet", "--json", ...args], { repoScoped: false });
      if (r.code !== 0) throw new Error(w.diagnose(`fleet --json failed (exit ${r.code}): ${r.stderr || r.stdout}`));
      return JSON.parse(r.stdout) as FleetJson;
    };

    // Both machines pick their own item up, each in its own DB.
    await w.waitFor(() => fleet().runs.length === 2, { label: "a run in flight on each machine" });

    const both = fleet();
    expect(both.machines.map((m) => [m.name, m.state, m.local])).toEqual([
      ["local", "ok", true],
      ["build-box", "ok", false],
    ]);
    // Each machine reports its OWN run, tagged with the machine that owns it — and its own repo name,
    // which is how a key is disambiguated across the fleet.
    expect(both.runs.map((r) => [r.machine, r.repo, r.key])).toEqual([
      ["local", w.repoName, "here-1"],
      ["build-box", "build-box", "there-1"],
    ]);
    for (const run of both.runs) {
      expect(run.step, `${run.key} is in its work step`).toBe("work");
      expect(run.ageSeconds).not.toBeNull();
    }
    for (const m of both.machines) expect(m.version, `${m.name} reported its server version`).toBeTruthy();

    // The table is the same snapshot, printed. Worth asserting: it is what an operator actually reads.
    const table = w.factory.cli(["fleet"], { repoScoped: false });
    expect(table.code).toBe(0);
    expect(table.stdout).toContain("MACHINE");
    expect(table.stdout).toMatch(/build-box.*there-1|there-1/s);

    const seenAt = both.machines.find((m) => m.name === "build-box")!.lastSeenAt;
    expect(seenAt).not.toBeNull();

    // ── one machine goes away ──────────────────────────────────────────────────────────────────
    await w.machine("build-box").stop();

    const after = fleet(["--timeout", "2000"]);
    const blind = after.machines.find((m) => m.name === "build-box")!;
    expect(blind.state, "a machine that cannot be reached is unverifiable").toBe("unverifiable");
    expect(blind.detail, "and says why").toBeTruthy();
    // The remembered time is the machine's LAST successful read — every read since `seenAt` refreshed
    // it, and it stops moving the moment the machine stops answering.
    expect(blind.lastSeenAt, "carrying the time it last answered").not.toBeNull();
    expect(blind.lastSeenAt!).toBeGreaterThanOrEqual(seenAt!);
    expect(blind.lastSeenAt!).toBeLessThanOrEqual(after.readAt);
    expect(blind.runs, "its runs are not reported — they are unknown, not gone").toEqual([]);

    // The reachable machine is untouched: one silent box costs its own row, not the view.
    const here = after.machines.find((m) => m.name === "local")!;
    expect(here.state).toBe("ok");
    expect(after.runs.map((r) => r.key)).toEqual(["here-1"]);

    // And the operator-facing line says both things: unverifiable, and NOT known to be gone.
    const blindTable = w.factory.cli(["fleet", "--timeout", "2000"], { repoScoped: false });
    expect(blindTable.stdout).toContain("unverifiable");
    expect(blindTable.stdout).toContain("NOT known to be gone");
  },
);
