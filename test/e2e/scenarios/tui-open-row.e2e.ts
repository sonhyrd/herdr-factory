// Getting from a row to the thing it is about. The board tells an operator that `PR #69 is green —
// ready to merge`; until now the only way to act on that was to copy the number out and find it on
// GitHub by hand, once per row, for six rows at a time.
//
// `o` opens the run's PR, falling back to its work item while there is no PR; `O` always opens the
// work item. What a unit test cannot show, and this scenario does:
//
//   * the URLs are real — resolved by the engine from a live github_issues source and a live `gh`,
//     not assembled in a fixture — and the key really reaches `doOpen` through the TUI's own
//     keymap, on a needs-you row AND on a belt card;
//   * a run on ANOTHER machine opens in THIS machine's browser (the URL travels on `/status`);
//   * a source with no web page for its items says so instead of doing nothing;
//   * over SSH with no display the URL lands on the action line rather than failing silently;
//   * a second CLICK on the highlighted needs-you row opens its PR the same way, while the same run's
//     card on the board still opens the timeline on a click — and `↵` on the needs-you row does too.
//
// The browser is a recorder script on `$BROWSER`: the container has no display, and the point is
// which URL was handed to the opener, which is exactly what the recorder writes down.
import { expect } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scenario } from "../harness/index.ts";
import { REPO_ROOT } from "../harness/world.ts";
import { delay } from "../harness/herdr.ts";
import { GithubFake } from "../harness/sources/github-fake.ts";
import type { World } from "../harness/index.ts";

const STARTUP_LOG = "/tmp/herdr-factory-tui-startup.log";

const gh = new GithubFake({ repo: "acme/app" });

/** Goes all the way to a PR and waits for a human to merge it — the green needs-you row. */
const SHIP = "501";
/** Claimed, never signals: a run with a work item and NO PR, which is what `o`'s fallback is for. */
const HOLD = "502";
/** Claimed by the OTHER machine — its URL has to be openable from this one. */
const BOX = "503";
/** local_markdown: a source with no web page for its items at all. */
const MD = "md-1";

const RECORDER = (home: string) => join(home, "browser-recorder");
const OPENED = (home: string) => join(home, "opened.log");

const opened = (w: World): string[] => {
  const p = OPENED(w.paths.home);
  return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean) : [];
};

async function screenWith(w: World, pane: string, match: RegExp, label: string): Promise<string> {
  let screen = "";
  await w.waitFor(
    () => {
      screen = w.herdr.readPane(pane, 80);
      return match.test(screen);
    },
    { label, timeoutMs: 90_000, pollMs: 1000 },
  );
  return screen;
}

/** Launch the shipped TUI launcher in a pane of its own, the way an operator starts it. */
async function bootTui(w: World, label: string, env: string[]): Promise<string> {
  const ws = w.herdr.workspaces()[0]!;
  const created = w.herdr.json<{ result?: { root_pane?: { pane_id?: string }; pane_id?: string } }>([
    "tab", "create", "--workspace", ws.workspace_id, "--no-focus", "--label", label, "--cwd", w.paths.repo,
    "--env", "HERDR_FACTORY_TUI_TIMING=1", ...env.flatMap((e) => ["--env", e]),
  ]);
  const pane = created?.result?.root_pane?.pane_id ?? created?.result?.pane_id;
  expect(pane, `herdr created a pane for ${label}: ${JSON.stringify(created)?.slice(0, 200)}`).toBeTruthy();
  await delay(1500); // the pane's shell needs to reach its prompt before `pane run` lands
  const before = existsSync(STARTUP_LOG) ? readFileSync(STARTUP_LOG, "utf8").split("app_ready").length : 1;
  w.herdr.cli(["pane", "run", pane!, join(REPO_ROOT, "bin", "herdr-factory-tui")]);
  await w.waitFor(() => existsSync(STARTUP_LOG) && readFileSync(STARTUP_LOG, "utf8").split("app_ready").length > before, {
    label: `${label} reached app_ready`,
    timeoutMs: 120_000,
    pollMs: 500,
  });
  return pane!;
}

/** The highlighted row, as the newest frame in the pane buffer shows it. A pane read is scrollback,
 *  so several frames sit end to end — the LAST `▶` is the current one. */
const focused = (w: World, pane: string): string => w.herdr.readPane(pane, 80).split("\n").findLast((l) => l.includes("▶ ")) ?? "";

/** Walk the highlight down until it lands on a row carrying `token`, and say where it stopped. The
 *  board's exact row order is a layout detail; what the scenario is about is which row `o` acts on. */
async function focusRow(w: World, pane: string, token: string, max = 30): Promise<string> {
  for (let i = 0; i < max; i++) {
    const line = focused(w, pane);
    if (line.includes(token)) return line;
    w.herdr.sendKeys(pane, "down");
    await delay(300);
  }
  throw new Error(`the highlight never reached a row containing "${token}"; it stopped on: ${focused(w, pane)}`);
}

/** Click the highlighted card, where the newest visible frame draws it. A click on a card that is
 *  already highlighted is the "act on it" click. */
function clickFocused(w: World, pane: string): void {
  const screen = w.herdr.cli(["pane", "read", pane, "--source", "visible", "--format", "text"]).stdout.split("\n");
  const y = screen.findIndex((l) => l.includes("▶ "));
  expect(y, `a highlighted row is on screen:\n${screen.join("\n")}`).toBeGreaterThanOrEqual(0);
  // Cells, not UTF-16 units — land two cells into the card, on its text rather than its edge.
  const x = [...screen[y]!.slice(0, screen[y]!.indexOf("▶ "))].length + 3;
  // An SGR mouse press + release typed into the PTY: the TUI turns mouse tracking on, so this is
  // exactly what a terminal delivers for a real click.
  const click = `\x1b[<0;${x};${y + 1}M\x1b[<0;${x};${y + 1}m`;
  const r = w.herdr.cli(["pane", "send-text", pane, click]);
  expect(r.code, `pane send-text delivered the click: ${r.stderr}`).toBe(0);
}

/** The timeline modal is up (its title is `<key>… — timeline`). */
const timelineUp = (w: World, pane: string) => /— timeline/.test(w.herdr.cli(["pane", "read", pane, "--source", "visible", "--format", "text"]).stdout);

/** Press a key on the focused row and return the action line it left behind. */
async function press(w: World, pane: string, key: string): Promise<string> {
  w.herdr.sendKeys(pane, key);
  await delay(1200);
  return w.herdr.readPane(pane, 80);
}

scenario(
  {
    name: "tui-open-row",
    timeoutMs: 480_000,
    beforeStart: async (p) => {
      rmSync(STARTUP_LOG, { force: true });
      rmSync(OPENED(p.home), { force: true });
      // The "browser": records the argv it was handed. `openUrl` spawns it WITHOUT a shell, so it
      // needs its own shebang — which is also what proves the spawn really happened.
      writeFileSync(RECORDER(p.home), `#!/bin/sh\nprintf '%s\\n' "$1" >> ${OPENED(p.home)}\n`, { mode: 0o755 });
      mkdirSync(p.briefs, { recursive: true });
      await gh.listen();
      gh.seed({ number: Number(SHIP), kind: "issue", title: "Ship me", body: "Goes to a PR and waits for a human.", labels: ["hf-ship"] });
      gh.seed({ number: Number(HOLD), kind: "issue", title: "Hold me", body: "Claimed and then quiet — no PR.", labels: ["hf-hold"] });
      gh.seed({ number: Number(BOX), kind: "issue", title: "Box me", body: "Worked on the other machine.", labels: ["hf-box"] });
    },
    afterStop: () => gh.close(),
    env: () => ({ GITHUB_TOKEN: "ghp_e2e", GITHUB_API_URL: gh.url }),
    briefs: { [MD]: "# A markdown brief\n\nA source with no web page for its items.\n" },
    config: (p) => ({
      // Generous watchdogs: two of these runs deliberately never signal, and a stall/budget park
      // would rewrite the needs-you section out from under the assertions.
      limits: { tick_interval_seconds: 2, max_active_workspaces: 4, stall_seconds: 900, step_budget_seconds: 900 },
      work_sources: [
        { type: "github_issues", name: "gh", poll_interval_seconds: 1, github_issues: { repo: gh.repo } },
        { type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } },
      ],
      belt: [
        // Steps are NAMED: the scripted agent resolves its behaviour by step name, and all three
        // belts would otherwise share one `work`.
        { name: "ship-gh", source: "gh", label: "hf-ship", workspace_name: "s/{{work_id}}", steps: [{ type: "work", name: "shipwork" }, { type: "pr", name: "shippr" }] },
        { name: "hold-gh", source: "gh", label: "hf-hold", workspace_name: "h/{{work_id}}", steps: [{ type: "work", name: "holdwork" }] },
        { name: "md", source: "briefs", workspace_name: "m/{{work_id}}", steps: [{ type: "work", name: "mdwork" }] },
      ],
    }),
    fleetMachines: {
      "build-box": {
        env: () => ({ GITHUB_TOKEN: "ghp_e2e", GITHUB_API_URL: gh.url }),
        config: () => ({
          limits: { tick_interval_seconds: 2, stall_seconds: 900, step_budget_seconds: 900 },
          work_sources: [{ type: "github_issues", name: "gh", poll_interval_seconds: 1, github_issues: { repo: gh.repo } }],
          belt: [{ name: "box-gh", source: "gh", label: "hf-box", workspace_name: "b/{{work_id}}", steps: [{ type: "work", name: "boxwork" }] }],
        }),
      },
    },
    agent: {
      steps: {
        shipwork: { commit: true },
        // Opens the PR and signals done: the belt's PR is not a draft and the gh fake's PR has no checks
        // and no threads, so the review watch marks it green — the row this scenario is named for. It
        // must signal: a PR whose pr step is still running is never called green.
        shippr: {},
        holdwork: { signal: "none" },
        mdwork: { signal: "none" },
        boxwork: { signal: "none" },
      },
    },
  },
  async (w) => {
    await w.waitFor(() => w.db.run(HOLD) !== undefined && w.db.run(MD) !== undefined, { label: "the local runs are claimed", timeoutMs: 150_000 });
    await w.waitForEvent(SHIP, "pr_green", { label: "the PR goes green and the board says so", timeoutMs: 300_000 });
    const pr = w.db.run(SHIP)!.pr_number!;

    // The URLs are on the API before anything is pressed — resolved from config by the machine that
    // owns the run, which is what lets a remote row open locally.
    const status = await w.factory.repoApi<{ active: { ticketKey: string; prUrl?: string | null; itemUrl?: string | null }[] }>("GET", "status?quick=1");
    const row = (key: string) => status.active.find((r) => r.ticketKey === key);
    expect(row(SHIP)?.prUrl, "the green run carries its PR").toBe(`https://github.com/${w.ghRepo}/pull/${pr}`);
    expect(row(SHIP)?.itemUrl, "…and the issue it came from").toBe(`https://github.com/${gh.repo}/issues/${SHIP}`);
    expect(row(HOLD)?.prUrl, "a run with no PR yet carries none").toBeNull();
    expect(row(MD)?.itemUrl, "local_markdown has no web page for its items").toBeNull();

    // ── the TUI, with a recorder standing in for the browser ───────────────────────────────────
    const pane = await bootTui(w, "tui", [`BROWSER=${RECORDER(w.paths.home)}`]);
    const board = await screenWith(w, pane, new RegExp(`PR #${pr} is green`), "the board leads with the green PR");
    // The footer is one un-wrapped line and this pane is ~52 columns, so the hint is clipped where it
    // sits: assert it is THERE and placed with the other read actions, not the whole label.
    expect(board, "the footer advertises the key, next to the other read actions").toMatch(/timeline: ↵\s*\|\s*open pr/);

    // ── 1. `o` on the green needs-you row opens THAT PR ────────────────────────────────────────
    // The highlight starts on the first focusable row, which is the first `needs you` entry.
    expect(focused(w, pane), "the board opens with the green PR highlighted").toContain(`PR #${pr} is green`);
    const afterO = await press(w, pane, "o");
    expect(opened(w).at(-1), "`o` handed the PR to the browser").toBe(`https://github.com/${w.ghRepo}/pull/${pr}`);
    expect(afterO, "…and said so on the action line").toContain(`opened https://github.com/${w.ghRepo}/pull/${pr}`);

    // ── 2. `O` on the same row opens the WORK ITEM, not the PR ─────────────────────────────────
    await press(w, pane, "O");
    expect(opened(w).at(-1), "`O` opens the issue even though the run has a PR").toBe(`https://github.com/${gh.repo}/issues/${SHIP}`);

    // ── 2b. a second click on the highlighted needs-you row opens its PR, like `o` — not the timeline ─
    const clicks = opened(w).length;
    clickFocused(w, pane);
    await delay(1200);
    expect(opened(w).length, "the click handed exactly one URL to the browser").toBe(clicks + 1);
    expect(opened(w).at(-1), "…the PR's").toBe(`https://github.com/${w.ghRepo}/pull/${pr}`);
    expect(timelineUp(w, pane), "…and no timeline opened").toBe(false);

    // ── 2c. `↵` on the same needs-you row still opens the timeline ─────────────────────────────
    await press(w, pane, "return");
    await w.waitFor(() => timelineUp(w, pane), { label: "↵ opens the timeline from needs you", timeoutMs: 15_000, pollMs: 500 });
    await press(w, pane, "escape");
    expect(timelineUp(w, pane), "Esc closed the timeline").toBe(false);

    // ── 2d. the same run's card under its machine: a second click opens the timeline, not the PR ─
    // Step off the needs-you row first — it names the key too — then walk to the board card.
    w.herdr.sendKeys(pane, "down");
    await delay(300);
    await focusRow(w, pane, SHIP);
    const boardClicks = opened(w).length;
    clickFocused(w, pane);
    await w.waitFor(() => timelineUp(w, pane), { label: "a click on the highlighted board card opens the timeline", timeoutMs: 15_000, pollMs: 500 });
    expect(opened(w).length, "…and hands nothing to the browser").toBe(boardClicks);
    await press(w, pane, "escape");

    // ── 3. a belt card, and `o`'s fallback before there is a PR ────────────────────────────────
    await focusRow(w, pane, HOLD);
    const afterHold = await press(w, pane, "o");
    expect(opened(w).at(-1), "`o` falls back to the work item while the run has no PR").toBe(`https://github.com/${gh.repo}/issues/${HOLD}`);
    expect(afterHold, "the action line names what was opened").toContain(`issues/${HOLD}`);

    // ── 4. a source with no web page says so, and opens nothing ────────────────────────────────
    await focusRow(w, pane, MD);
    const before = opened(w).length;
    const afterMd = await press(w, pane, "o");
    expect(afterMd, "a markdown item has nowhere to go, and the board says that rather than nothing").toContain(
      "no PR or work item URL",
    );
    expect(opened(w).length, "…and nothing was handed to the browser").toBe(before);

    // ── 5. the OTHER machine's run opens in THIS machine's browser ─────────────────────────────
    // The other machine's rows are below the fold on this pane; walking the highlight scrolls to them.
    await focusRow(w, pane, BOX, 40);
    await press(w, pane, "o");
    expect(opened(w).at(-1), "a remote run's URL is opened locally — it travelled on /status").toBe(
      `https://github.com/${gh.repo}/issues/${BOX}`,
    );

    // ── 6. over SSH with no display, the URL is printed instead of opened ───────────────────────
    // A second TUI with no `$BROWSER` and an SSH session in its environment: `chooseOpener` has
    // nothing to draw into, so the URL goes on the action line where it can be clicked or copied.
    const sshPane = await bootTui(w, "tui-ssh", ["SSH_CONNECTION=10.0.0.2 51000 10.0.0.9 22"]);
    await screenWith(w, sshPane, new RegExp(`PR #${pr} is green`), "the ssh TUI draws the same board");
    const quiet = opened(w).length;
    const afterSsh = await press(w, sshPane, "o");
    expect(afterSsh, "the URL itself is the message").toContain(`https://github.com/${w.ghRepo}/pull/${pr}`);
    expect(afterSsh, "…and it is not reported as opened").not.toContain("opened https://");
    expect(opened(w).length, "nothing was spawned — there was nowhere to open it").toBe(quiet);
  },
);
