// Issue #115: the live config dir (`~/.config/herdr-factory`) is rolled out by hand — nothing syncs
// it — so it sat behind merged fixes on every host with nothing saying so. `doctor` now compares
// its HEAD with `origin/main` and lists tracked-file edits. The unit tests
// (test/checkout-sync.test.ts) prove the git reads; this proves the row through the real CLI, and
// that `--deep` only FETCHES: the live checkout's HEAD never moves.
//
// The world's config dir is a plain folder, so the scenario makes it a checkout of a local bare
// origin, then lands two commits upstream from a seed clone.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { scenario } from "../harness/index.ts";

/** The `✓ <row> — <detail>` / `⚠ …` line for a check, or undefined if absent. */
function rowOf(text: string, row: string): string | undefined {
  return text.split("\n").find((l) => new RegExp(`^\\s*[✓✗⚠] ${row}\\b`).test(l));
}

scenario(
  {
    name: "doctor-live-config",
    timeoutMs: 180_000,
    briefs: {},
    config: (p) => ({
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      belt: [{ name: "main", source: "briefs", workspace_name: "m/{{work_id}}", steps: [{ type: "work" }] }],
    }),
  },
  async (w) => {
    const live = w.paths.configDir;
    const origin = join(w.paths.home, "live-config-origin.git");
    const seed = join(w.paths.home, "live-config-seed");
    const git = (cwd: string, ...args: string[]) => w.git(args, cwd);
    const row = (deep: boolean) => {
      const r = w.factory.cli(deep ? ["doctor", "--deep"] : ["doctor"]);
      return rowOf(`${r.stdout}${r.stderr}`, "live config up to date") ?? "(no such row)";
    };

    // --- the live dir becomes a checkout of a bare origin -----------------------------------
    git(w.paths.home, "init", "-q", "--bare", "-b", "main", origin);
    git(live, "init", "-q", "-b", "main");
    git(live, "add", "-A");
    git(live, "commit", "-q", "-m", "live config");
    git(live, "remote", "add", "origin", origin);
    git(live, "push", "-q", "-u", "origin", "main");
    const liveHead = git(live, "rev-parse", "HEAD");
    expect(git(origin, "rev-parse", "main"), "the live config really landed on its origin").toBe(liveHead);

    // --- two merged changes upstream, not rolled out ----------------------------------------
    git(w.paths.home, "clone", "-q", origin, seed);
    for (const [file, msg] of [["a.txt", "fix: the port race"], ["b.txt", "feat: a second change"]] as const) {
      writeFileSync(join(seed, file), `${msg}\n`);
      git(seed, "add", "-A");
      git(seed, "commit", "-q", "-m", msg);
    }
    git(seed, "push", "-q", "origin", "HEAD:main");
    expect(git(origin, "rev-list", "--count", "main"), "both upstream commits landed on origin").toBe("3");

    const behind = row(true);
    expect(behind, "--deep fetches and turns the row amber").toMatch(/^\s*⚠ live config up to date/);
    expect(behind, "…with the count and the oldest missing subject").toContain("live config 2 commit(s) behind origin/main (fix: the port race)");
    expect(git(live, "rev-parse", "HEAD"), "doctor only fetches — never pulls, merges or resets").toBe(liveHead);

    // --- rolled out by hand ⇒ green --------------------------------------------------------
    git(live, "merge", "-q", "--ff-only", "origin/main");
    const green = row(true);
    expect(green).toMatch(/^\s*✓ live config up to date/);
    expect(green).toContain("at origin/main");

    // --- a hand edit on the box is named; an untracked file is not ---------------------------
    writeFileSync(join(w.paths.repoConfigDir, "config.yml"), `# hand-edited on the box\n${git(live, "show", "HEAD:repos/app/config.yml")}\n`);
    writeFileSync(join(live, "scratch.txt"), "untracked\n");
    const dirty = row(false);
    expect(dirty, "a tracked-file edit turns the row amber").toMatch(/^\s*⚠ live config up to date/);
    expect(dirty, "…naming the file").toContain("uncommitted changes to repos/app/config.yml");
    expect(dirty, "…and not the untracked one").not.toContain("scratch.txt");

    expect(await w.factory.health(), "the server rode through it").toBeTruthy();
  },
);
