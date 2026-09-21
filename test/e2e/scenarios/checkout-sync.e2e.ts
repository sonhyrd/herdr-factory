// Issue #71: `ensure-up` fast-forwards each configured repo's MAIN checkout. The unit tests
// (test/checkout-sync.test.ts) prove the git decisions against throwaway repos; what they cannot
// prove is the thing the issue actually asks for — that a checkout which is BEHIND catches up with
// no operator action, through the real `ensure-up` command, with a real `serve` running, and that
// `doctor` then reports it.
//
// This world is the right shape for it: `w.paths.repo` is a main checkout with a local bare
// `origin` (harness/world.ts `buildTargetRepo`), and `HERDR_FACTORY_AUTO_UPDATE=0` keeps the
// self-updater out of the tick so the only thing `ensure-up` does here is the checkout sweep plus
// its health check.
//
// The throttle is real (10 min per repo), so each beat ages `checkout-sync.json` rather than
// waiting — the same file the production path reads, which is itself part of what's under test.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { scenario } from "../harness/index.ts";
import { CHECKOUT_SYNC_INTERVAL_MS } from "../../../src/watchers/checkouts.ts";

/** The `✓ <row> — <detail>` / `⚠ …` line for a check, or undefined if absent. */
function rowOf(text: string, row: string): string | undefined {
  return text.split("\n").find((l) => new RegExp(`^\\s*[✓✗⚠] ${row}\\b`).test(l));
}

scenario(
  {
    name: "checkout-sync",
    timeoutMs: 180_000,
    briefs: {},
    config: (p) => ({
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      belt: [{ name: "main", source: "briefs", workspace_name: "m/{{work_id}}", steps: [{ type: "work" }] }],
    }),
  },
  async (w) => {
    const syncStatePath = join(w.paths.stateRoot, "checkout-sync.json");
    const head = () => w.git(["rev-parse", "HEAD"]);
    const doctorRow = () => {
      const r = w.factory.cli(["doctor"]);
      return rowOf(`${r.stdout}${r.stderr}`, "main checkouts up to date") ?? "(no such row)";
    };

    /** Land a commit on the world's bare origin while leaving the main checkout BEHIND it: commit
     *  in the checkout, push, then rewind the local branch one commit. The remote-tracking ref is
     *  already updated, which is exactly the drifted-host state the issue describes. */
    const landUpstream = (file: string, body: string, msg: string): string => {
      writeFileSync(join(w.paths.repo, file), body);
      w.git(["add", "-A"]);
      w.git(["commit", "-q", "-m", msg]);
      const pushed = head();
      w.git(["push", "-q", "origin", "main"]);
      expect(w.git(["rev-parse", "main"], w.paths.origin), "the commit really landed on the world's origin").toBe(pushed);
      w.git(["reset", "--hard", "-q", "HEAD~1"]);
      return pushed;
    };
    /** Age the recorded attempt past the throttle window, so the next sweep is due. */
    const ageThrottle = (): void => {
      const state = JSON.parse(readFileSync(syncStatePath, "utf8")) as Record<string, { at: number }>;
      for (const entry of Object.values(state)) entry.at -= CHECKOUT_SYNC_INTERVAL_MS + 60_000;
      writeFileSync(syncStatePath, JSON.stringify(state, null, 2));
    };

    // --- 1. behind, clean, on main ⇒ it catches up, with nobody asking -----------------------
    // Push FIRST: `ensure-up` records an attempt per repo, and a recorded attempt throttles the
    // next sweep for 10 minutes — a world that synced while already current would swallow this.
    const behindFrom = head();
    const upstream = landUpstream("upstream.txt", "landed while the checkout slept\n", "feat: something upstream");
    expect(head(), "the main checkout starts BEHIND origin — that is the bug").toBe(behindFrom);

    const up = w.factory.cli(["ensure-up"], { repoScoped: false });
    expect(`${up.stdout}${up.stderr}`, "a healthy same-version serve is still a noop — the sweep must not restart anything").toMatch(/ensure-up: noop/);
    expect(head(), `the clean, on-main checkout fast-forwarded to origin/main — ensure-up said:\n${up.stdout}${up.stderr}`).toBe(upstream);
    expect(w.git(["rev-parse", "--abbrev-ref", "HEAD"]), "…on the same branch it was on").toBe("main");

    // …and `doctor` says so, naming this world's repo rather than the placeholder text.
    const green = doctorRow();
    expect(green, "doctor reports the last sweep").toMatch(/^\s*✓ main checkouts up to date/);
    expect(green, "…for this repo by name, with the fast-forward it just did").toMatch(new RegExp(`app: ${behindFrom.slice(0, 12)} → ${upstream.slice(0, 12)} \\(origin/main\\)`));
    expect(green, "…and not the fresh-box placeholder").not.toMatch(/no sync recorded yet/);

    // --- 2. the throttle is real ------------------------------------------------------------
    const throttled = landUpstream("second.txt", "too soon\n", "feat: a second upstream commit");
    w.factory.cli(["ensure-up"], { repoScoped: false });
    expect(head(), "a second sweep inside the 10-minute window does nothing").toBe(upstream);

    // --- 3. a dirty checkout is skipped, never stashed or reset ------------------------------
    const handPatched = "# hand-patched on the box\n";
    writeFileSync(join(w.paths.repo, "README.md"), handPatched);
    ageThrottle();
    w.factory.cli(["ensure-up"], { repoScoped: false });
    expect(head(), "uncommitted work parks the fast-forward").toBe(upstream);
    expect(readFileSync(join(w.paths.repo, "README.md"), "utf8"), "…and the local edit survives untouched").toBe(handPatched);
    const amber = doctorRow();
    expect(amber, "doctor turns amber while a checkout is stuck").toMatch(/^\s*⚠ main checkouts up to date/);
    expect(amber, "…naming the reason").toMatch(/app: dirty tree, skipped/);

    // --- 4. clean it up and the next sweep catches up on its own -----------------------------
    w.git(["checkout", "--", "README.md"]);
    ageThrottle();
    w.factory.cli(["ensure-up"], { repoScoped: false });
    expect(head(), "no operator action beyond clearing the tree — the sweep does the rest").toBe(throttled);
    expect(doctorRow(), "and the row is green again").toMatch(/^\s*✓ main checkouts up to date/);

    expect(await w.factory.health(), "the server rode through every sweep").toBeTruthy();
  },
);
