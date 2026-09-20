// The redesigned fleet board, as an OPERATOR meets it: the real TUI, in a real herdr pane, reading a
// MULTI-REPO host — which is the shape the redesign is about. `tui-fleet` proves the fleet contract
// (two headers, routing, a machine that goes silent); this proves what the board chooses to SAY.
//
// The defect it guards against is a board that is technically correct and unreadable: the host-wide
// `machine.yml` gate printed once per repo row, seventeen rows of repos with nothing in them, and
// `⚠ N problems — press d` on three rows that share one cause. Every assertion below is on the pane's
// own text, because "it fits on one screen" is not a property any unit test can hold.
//
// The host: five repos on one machine — one working, two carrying the SAME unauthenticated source,
// two with nothing at all — plus a second machine so the machine headers exist (they are drawn only
// when there IS a fleet).
import { expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scenario } from "../harness/index.ts";
import { REPO_ROOT } from "../harness/world.ts";
import { delay } from "../harness/herdr.ts";
import type { World } from "../harness/index.ts";

// Hardcoded in src/tui/main.ts — the TUI has no writable state of its own at that point in boot.
const STARTUP_LOG = "/tmp/herdr-factory-tui-startup.log";
/** The run that is in flight: its agent never signals, so the board always has one live card. */
const RUNNING = "run-1";
/** Claimed second, after the cap of 1 is spent — so it stays ELIGIBLE, which is not idle. */
const WAITING = "wait-1";
/** The host gate machine.yml sets. High enough that it only reports occupancy, never holds a claim. */
const MACHINE_CAP = 8;
/** The identical problem two repos report: the auth gate's own text for a source with no credentials
 *  (`src/auth/jira-provider.ts`), which is the same string on every repo that names the source. */
const SHARED_PROBLEM = "board: set JIRA_EMAIL + JIRA_API_TOKEN in the repo env";

/** A repo whose only work source is a jira board with no credentials: the auth gate records its
 *  problem on the first tick, before any network call. Two of these = one cause on two repos. */
const unauthenticatedRepo = () => ({
  work_sources: [{ type: "jira", name: "board", jira: { base_url: "http://127.0.0.1:9", project: "APP", board: 1 } }],
  belt: [{ name: "tickets", source: "board", label: "agent", workspace_name: "t/{{work_id}}", steps: [{ type: "work" }] }],
});

/** A repo with nothing: a real config, a real (empty) work folder, no work, no problem. */
const idleRepo = (p: { briefs: string }) => ({
  work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
  belt: [{ name: "quiet", source: "briefs", workspace_name: "q/{{work_id}}", steps: [{ type: "work" }] }],
});

/** Read the pane until `match` shows up, so an assertion waits for the 3s poll instead of racing it. */
async function screenWith(w: World, pane: string, match: RegExp, label: string): Promise<string> {
  let screen = "";
  await w.waitFor(
    () => {
      screen = w.herdr.readPane(pane, 80);
      return match.test(screen);
    },
    { label, timeoutMs: 60_000, pollMs: 1000 },
  );
  return screen;
}

/** The one line of the screen carrying `token` — what gets quoted into a failure message. */
// The LAST line carrying `token`. A pane read is recent scrollback, so a full-screen TUI's buffer
// holds several frames end to end — the last match is the newest one, and the first would be a
// screenshot from before whatever we just waited for.
const lineWith = (screen: string, token: string): string =>
  screen.split("\n").findLast((l) => l.includes(token)) ?? `(no line contains "${token}")`;

scenario(
  {
    name: "tui-board",
    timeoutMs: 300_000,
    briefs: { [RUNNING]: "# Running\n", [WAITING]: "# Waiting\n" },
    config: (p) => ({
      // ONE slot: the second brief is claimed by nobody and stays ELIGIBLE, which is the case the
      // idle collapse must never swallow.
      limits: { tick_interval_seconds: 2, max_active_workspaces: 1 },
      work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
      belt: [{ name: "here", source: "briefs", workspace_name: "h/{{work_id}}", steps: [{ type: "work" }] }],
    }),
    // Two repos with the SAME uncredentialed source, and two with nothing at all.
    extraRepos: {
      "probe-a": { config: unauthenticatedRepo },
      "probe-b": { config: unauthenticatedRepo },
      "idle-a": { config: idleRepo },
      "idle-b": { config: idleRepo },
    },
    // A second machine, so the machine headers are drawn at all — and one whose only repo is idle,
    // so stopping it proves the collapsed line reads `unverified`, never `idle`.
    fleetMachines: {
      "build-box": {
        config: (p) => ({ limits: { tick_interval_seconds: 2 }, ...idleRepo(p) }),
      },
    },
    agent: { default: { hangMs: "forever" } },
    beforeStart: (p) => {
      // Shared /tmp across scenarios, so start from nothing rather than reading someone else's boot.
      rmSync(STARTUP_LOG, { force: true });
      // The host-local gate. Its whole point here is that it EXISTS: the old board appended it to
      // every repo row, so "no machine line on a row" is only a real assertion when there is one.
      mkdirSync(p.configDir, { recursive: true });
      writeFileSync(join(p.configDir, "machine.yml"), `max_active_workspaces: ${MACHINE_CAP}\n`);
    },
  },
  async (w) => {
    await w.waitFor(() => w.db.run(RUNNING)?.phase === "running", { label: "a run in flight on this machine", timeoutMs: 120_000 });
    // The two uncredentialed repos have recorded their identical problem (the gate runs on the tick,
    // before any network call). Read through the API the board reads, so the text is the board's.
    const problemsOn = async (repo: string) =>
      (await w.factory.api<{ problems?: { detail: string }[] }>("GET", `/repos/${repo}/status?quick=1`)).problems?.map((p) => p.detail) ?? [];
    await w.waitFor(async () => (await problemsOn("probe-a")).length > 0 && (await problemsOn("probe-b")).length > 0, {
      label: "both uncredentialed repos record a problem",
      timeoutMs: 120_000,
    });
    expect(await problemsOn("probe-a"), "the cause is one cause, spelled the same way on both repos").toEqual(await problemsOn("probe-b"));
    const cause = (await problemsOn("probe-a"))[0]!;

    // ── the TUI, launched the way an operator launches it ──────────────────────────────────────
    const ws = w.herdr.workspaces()[0]!;
    const created = w.herdr.json<{ result?: { root_pane?: { pane_id?: string }; pane_id?: string } }>([
      "tab", "create", "--workspace", ws.workspace_id, "--no-focus", "--label", "tui", "--cwd", w.paths.repo, "--env", "HERDR_FACTORY_TUI_TIMING=1",
    ]);
    const pane = created?.result?.root_pane?.pane_id ?? created?.result?.pane_id;
    expect(pane, `herdr created a pane for the TUI: ${JSON.stringify(created)?.slice(0, 200)}`).toBeTruthy();
    await delay(1500); // the pane's shell needs to reach its prompt before `pane run` lands
    w.herdr.cli(["pane", "run", pane!, join(REPO_ROOT, "bin", "herdr-factory-tui")]);
    await w.waitFor(() => existsSync(STARTUP_LOG) && /"app_ready"/.test(readFileSync(STARTUP_LOG, "utf8")), {
      label: "the TUI reached app_ready",
      timeoutMs: 120_000,
      pollMs: 500,
    });

    const board = await screenWith(w, pane!, /idle ·/, "the board collapses this host's idle repos");
    for (const bad of ["requires Node >= 26", "Cannot find", "ERR_DLOPEN", "Error:", "at Module"]) {
      expect(board, `the TUI screen shows no "${bad}"`).not.toContain(bad);
    }

    // ── 1. the host gate is printed ONCE, on the header — never per repo row ───────────────────
    const gate = "working across all repos";
    expect(board.split("\n").filter((l) => l.includes(gate)).length, `the host gate is on exactly one line:\n${board}`).toBe(1);
    expect(lineWith(board, gate), "and it is the machine's own line, with this host's occupancy").toMatch(
      new RegExp(`cap \\d+/${MACHINE_CAP} working across all repos`),
    );
    // The repo row's old form carried the raw `machine: …` string (machineHeader strips that prefix),
    // so its absence is exactly "no repo row repeats the machine line".
    expect(board, "no repo row repeats the host-wide machine line").not.toContain("machine: cap");
    expect(lineWith(board, `${w.repoName}  @local`), "the repo row is the repo, its machine and its occupancy").toMatch(
      new RegExp(`${w.repoName}\\s+@local\\s+active 1/1`),
    );

    // ── 2. a cause two repos share is named once, on the machine header ────────────────────────
    expect(cause, "the gate's own wording, which is what makes the two repos' problems identical").toBe(SHARED_PROBLEM);
    const hoisted = lineWith(board, "⚠ board:");
    expect(hoisted, "the shared cause is named, not counted").toContain("board: set JIRA_EMAIL");
    expect(hoisted, "…on the machine header rather than on a repo row").not.toContain("@local");
    for (const repo of ["probe-a", "probe-b"]) {
      expect(lineWith(board, `${repo}  @local`), `${repo}'s row does not repeat the host's cause`).not.toContain("⚠");
      expect(lineWith(board, `${repo}  @local`), `${repo} keeps its row — a problem repo is never idle`).toContain("active 0/");
    }
    expect(board, "and never the old count-and-a-keypress").not.toMatch(/\d+ problems? — press d/);

    // ── 4. a repo with eligible-but-unclaimed work is not idle ─────────────────────────────────
    expect(board, "the unclaimed item is a card on the board").toContain(WAITING);
    // This host's own idle line — named by its repos, because the other machine has one too and the
    // pane buffer holds both.
    const localIdleIn = (screen: string) => screen.split("\n").findLast((l) => /idle · idle-/.test(l)) ?? "(no `idle · idle-…` line)";
    const idleLine = localIdleIn(board);
    expect(idleLine, "the working repo is not on the idle line").not.toContain(w.repoName);
    for (const repo of ["probe-a", "probe-b"]) expect(idleLine, `${repo} has a problem, so it is not idle`).not.toContain(repo);

    // ── 6. the repos with nothing in them are one line ─────────────────────────────────────────
    expect(idleLine, "the empty repos collapse into one line").toMatch(/idle · idle-[ab] · idle-[ab]/);
    for (const repo of ["idle-a", "idle-b"]) expect(board, `${repo} has no row of its own`).not.toContain(`${repo}  @local`);

    // ── 7. a belt of one or two cards is one line per run, not a column grid ───────────────────
    expect(lineWith(board, `● ${RUNNING}`), "the run is one compact line: icon, key, step, age").toMatch(new RegExp(`● ${RUNNING}\\s+work\\s`));
    expect(board, "…and the column grid is not drawn for it").not.toMatch(/ready · \d/);

    // ── 5 (the empty half): nothing needs a human here, so the section is not drawn ────────────
    expect(board, "no green PR, no park, no question, every machine answering ⇒ no section").not.toContain("needs you");

    // ── 6b. `i` brings the full list back, and says so ─────────────────────────────────────────
    w.herdr.sendKeys(pane!, "i");
    const expanded = await screenWith(w, pane!, /idle-a  @local/, "`i` expands the collapsed repos");
    expect(expanded, "idle-b comes back too").toContain("idle-b  @local");
    expect(expanded, "and with rows of their own they are no longer on an idle line").not.toContain("idle · idle-a");
    // (The `(showing idle repos — press i to collapse them)` note rides at the BOTTOM of the list,
    // like the machine filter's, so an expanded seven-repo board pushes it past the pane. What the
    // collapse is for is proved by the rows themselves coming and going.)
    w.herdr.sendKeys(pane!, "i");
    await screenWith(w, pane!, /idle ·/, "`i` collapses them again");

    // ── 2b. `d` on a problem row still opens the full doctor detail ────────────────────────────
    // Walk to the last focusable row and back up one: build-box's header is last, so `up` lands on
    // probe-b — a repo whose cause was hoisted OFF its row, which is exactly the row that must not
    // have lost its detail along with it.
    for (let i = 0; i < 20; i++) {
      w.herdr.sendKeys(pane!, "down");
      await delay(100);
    }
    w.herdr.sendKeys(pane!, "up");
    await delay(400);
    w.herdr.sendKeys(pane!, "d");
    const detail = await screenWith(w, pane!, /General diagnostics|⚠ Problems/, "`d` opens the repo's detail");
    expect(detail, "and the hoisted cause is still there in full, which is what `d` is for").toContain("JIRA_EMAIL");
    // Esc closes the modal and pops focus to the tab bar; `1` comes back down into the board.
    w.herdr.sendKeys(pane!, "escape");
    await delay(300);
    w.herdr.sendKeys(pane!, "escape");
    await delay(300);
    w.herdr.sendKeys(pane!, "1");
    await delay(400);

    // ── 3 (the new half): a silent machine's collapsed repos read `unverified`, never `idle` ───
    await w.machine("build-box").stop();
    const blind = await screenWith(w, pane!, /unverifiable/, "the board reports the machine it can no longer reach");
    // A machine that stops answering is something a human has to look at, so it leads the board.
    expect(blind, "a silent machine is listed under `needs you`").toContain("needs you");
    expect(lineWith(blind, "needs you ·"), "…and the section counts it").toContain("needs you · 1");
    // This machine's own board is untouched by the other's silence — its idle line still reads `idle`.
    expect(localIdleIn(blind), "the machine that IS answering still collapses its repos as idle").toMatch(/idle · idle-[ab]/);

    // The silent machine's own rows are below the fold on a five-repo host, so narrow the board to it
    // with `m` — which also says that every key that worked before the redesign still works.
    w.herdr.sendKeys(pane!, "m");
    await delay(600);
    w.herdr.sendKeys(pane!, "down");
    await delay(200);
    w.herdr.sendKeys(pane!, "down");
    await delay(200);
    w.herdr.sendKeys(pane!, "return");
    const carried = await screenWith(w, pane!, /unverified ·/, "the silent machine's collapsed repos say what they are");
    expect(lineWith(carried, "unverified ·"), "its repo is named, carried forward from the last read").toContain("build-box");
    expect(carried, "and it is reported as silent — the rows are last-known, not gone").toContain("NOT known to be gone");
    expect(carried, "`idle` would be a claim about now, which this read cannot make").not.toContain("idle · build-box");
  },
);
