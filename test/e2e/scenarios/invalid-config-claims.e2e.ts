// A repo config on disk that the running code can't load stops CLAIMS (issue #95). The resident
// server keeps its in-memory config, so without the gate it would go on claiming work into
// workspaces the layout hook — a fresh process that reads the file — then refuses to build.
//
//   * with an unknown key in config.yml: no claim, `/status` carries `config invalid: …`, and
//     `doctor` names it;
//   * restoring the file resumes claiming — no restart, no reload.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { parse, stringify } from "yaml";
import { scenario } from "../harness/index.ts";

interface StatusBody {
  problems?: { kind: string; detail: string }[];
}

scenario(
  {
    name: "invalid-config-claims",
    timeoutMs: 180_000,
    briefs: {},
    config: (p) => ({
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      belt: [{ name: "main", source: "briefs", workspace_name: "m/{{work_id}}", steps: [{ type: "work" }] }],
    }),
  },
  async (w) => {
    const configPath = join(w.paths.repoConfigDir, "config.yml");
    const good = readFileSync(configPath, "utf8");
    const bad = parse(good) as { belt: Record<string, unknown>[] };
    bad.belt[0]!.key_from_a_newer_version = true; // what a config edit ahead of the code looks like
    writeFileSync(configPath, stringify(bad));

    const configProblem = async () =>
      (await w.factory.repoApi<StatusBody>("GET", "status?quick=1")).problems?.find((p) => p.kind === "config");
    await w.waitFor(async () => (await configProblem()) != null, { label: "the tick reports the config error", timeoutMs: 30_000 });
    expect((await configProblem())!.detail).toMatch(/^config invalid: .*key_from_a_newer_version/);

    writeFileSync(join(w.paths.briefs, "late.md"), "# Late\n\nArrives while the config is broken.\n");
    await new Promise((r) => setTimeout(r, 5_000)); // several 1s ticks
    expect(w.db.runs(), "nothing is claimed on a config that doesn't load").toEqual([]);

    const doctor = w.factory.cli(["doctor"]);
    expect(`${doctor.stdout}${doctor.stderr}`).toMatch(/✗ config loads \+ sources buildable.*config invalid: .*key_from_a_newer_version/);

    // ── the operator fixes the file — nothing else ────────────────────────────────────────────
    writeFileSync(configPath, good);
    await w.waitForEnd("late", "completed", { label: "claiming resumes without a restart", timeoutMs: 120_000 });
    expect(await configProblem(), "and the problem clears").toBeUndefined();
  },
);
