// The agent-tooling rows `doctor` grew for issue #49 — `cursor-agent`, its `--model` ids, the skills
// the prompts name, and `ocr` — are CONFIG-driven, and this container is the host that proves it.
//
// The e2e image has no `cursor-agent` and no `ocr` (docker/Dockerfile.e2e installs git/curl/jq and
// herdr, nothing else), and the harness default harness is `agent: { command: "claude", flags: [] }`.
// That is exactly the "Docker e2e host with no Cursor at all" the issue says must NOT be failed by
// these checks: with no belt asking for Cursor, every row reads `not configured` and none of them is
// a ✗. A unit test cannot show this — the gate is about what is really absent from PATH.
//
// The second half writes a config that DOES run a Cursor agent and re-runs `doctor`. On this host
// that must turn the row into a real ✗ naming `cursor-agent`. Without it the scenario would pass
// just as happily against four rows hardcoded to "not configured" — the point is that the gate
// follows the config, not that it is always quiet.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { expect } from "vitest";
import { scenario } from "../harness/index.ts";

/** The four rows, with what each must say on a host whose config never asks for Cursor. */
const QUIET: { row: string; says: RegExp }[] = [
  { row: "cursor-agent", says: /not configured/i },
  { row: "cursor models", says: /none configured/i },
  { row: "agent skills", says: /none named/i },
  { row: "ocr", says: /not configured/i },
];

/** The `✓ <row> — <detail>` / `✗ <row> — <detail>` line for a check, or undefined if absent. The
 *  rows are matched by name so a reworded detail doesn't silently stop asserting anything. */
function rowOf(text: string, row: string): string | undefined {
  return text.split("\n").find((l) => new RegExp(`^\\s*[✓✗⚠] ${row}\\b`).test(l));
}

scenario(
  {
    name: "doctor-agent-tooling",
    timeoutMs: 180_000,
    briefs: {},
    // No layout, no `agent:` override — the harness default (`claude`, no flags) is the whole point.
    config: (p) => ({
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      belt: [{ name: "main", source: "briefs", workspace_name: "m/{{work_id}}", steps: [{ type: "work" }] }],
    }),
  },
  async (w) => {
    const configPath = join(w.paths.repoConfigDir, "config.yml");

    const out = w.factory.cli(["doctor", "--deep"]);
    const text = `${out.stdout}${out.stderr}`;

    // Every row present, saying "this config doesn't ask for it" — and green.
    const wrong: string[] = [];
    for (const { row, says } of QUIET) {
      const line = rowOf(text, row);
      if (!line) wrong.push(`${row} — no such row in \`doctor --deep\``);
      else if (!line.trimStart().startsWith("✓")) wrong.push(`${row} — must never ✗ on a host with no Cursor: ${line.trim()}`);
      else if (!says.test(line)) wrong.push(`${row} — expected ${says}, got: ${line.trim()}`);
    }
    expect(wrong.join("\n"), "a host with no Cursor belt must not be failed by the agent-tooling checks").toBe("");

    // Plain `doctor` stays PATH-only: it never invokes cursor-agent, so the deep-only row title
    // (`cursor-agent (signed in)`) must not appear, and the row is gated by the config just the same.
    const p = w.factory.cli(["doctor"]);
    const plain = `${p.stdout}${p.stderr}`;
    expect(plain, "plain doctor must not run `cursor-agent status`").not.toMatch(/cursor-agent \(signed in\)/);
    expect(rowOf(plain, "cursor-agent"), "the plain row is gated by the config too").toMatch(/not configured/i);

    // --- now make the config ask for Cursor -------------------------------------------------
    // Same host, same PATH — only the config changed. The row must become a real ✗ that names the
    // missing binary, which is what stops a Cursor-configured host from looking ready.
    const withCursor = {
      repo: { path: w.paths.repo, base_ref: "origin/main", github: w.ghRepo },
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: w.paths.briefs } }],
      belt: [{ name: "main", source: "briefs", workspace_name: "m/{{work_id}}", steps: [{ type: "work" }] }],
      agent: { command: "cursor-agent", kind: "cursor", flags: ["--force", "--model", "cursor-grok-4.6-high"] },
    };
    writeFileSync(configPath, stringify(withCursor));
    const cursor = w.factory.cli(["doctor"]);
    const cursorText = `${cursor.stdout}${cursor.stderr}`;
    expect(rowOf(cursorText, "cursor-agent"), "a Cursor-configured host with no cursor-agent must ✗").toMatch(/^\s*✗ cursor-agent/);
    expect(rowOf(cursorText, "cursor models"), "its --model id is reported, and deferred to --deep").toMatch(/cursor-grok-4\.6-high/);
    expect(cursor.code, "and that ✗ fails the command, so a script can gate on it").toBe(1);

    // Put it back, and confirm the server rode through both configs.
    writeFileSync(configPath, stringify({ ...withCursor, agent: { command: "claude", flags: [] } }));
    expect(await w.factory.health(), "the server stayed up").toBeTruthy();
  },
);
