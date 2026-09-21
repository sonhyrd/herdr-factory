// The SSH forward itself, under a TUI that stays alive — the half of the fleet no other scenario
// reaches.
//
// `fleet-cli` and `tui-fleet` both point the "remote" machine's API straight at a second `serve`
// through `HERDR_FACTORY_FLEET_ENDPOINTS`, and that override is read BEFORE `SshForwardTransport`
// does anything. So everything the transport does — one open per machine, the tear-down of a
// forward it replaces, the `/health` re-probe that makes a stale ControlMaster recoverable — has
// never been exercised end to end.
//
// Here `build-box` is declared `ssh: true`, so it gets no override and the shipped transport really
// runs: a real ControlPath, a real free port, a real `ssh` spawn with the production argv, real
// `/health` polling, a real `ssh -O cancel`. Only the hop is fake (a container has no second host):
// the harness's `ssh` proxies the forwarded port onto that machine's own `serve`. See
// harness/ssh-fake/README.md.
//
// What the scenario does to it is what the remotes did to themselves in issue #62: it restarts the
// server under a live ControlMaster (`goDown()` — the tunnel still binds, nothing behind it
// answers, and `ssh -O check` still says `Master running`). Before the fix that was terminal: the
// held forward was never re-probed, so the board read `unverifiable` until the TUI was restarted,
// while the retries underneath it forked a fresh `ssh -N` per poll and dropped the losers still
// running.
import { expect } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { scenario } from "../harness/index.ts";
import { REPO_ROOT } from "../harness/world.ts";
import { delay } from "../harness/herdr.ts";
import type { World } from "../harness/index.ts";

// Hardcoded in src/tui/main.ts — the TUI has no writable state of its own at that point in boot.
const STARTUP_LOG = "/tmp/herdr-factory-tui-startup.log";
const WORK = { type: "work" } as const;
/** The machine's second repo. A fleet read fans out per repo (`Promise.all` in both the status and
 *  the eligible phase), so two is what turns "one open per machine" into an assertion. */
const SECOND_REPO = "build-box-2";

const source = (p: { briefs: string }) => ({
  work_sources: [{ type: "local_markdown", name: "briefs", local_markdown: { folder: p.briefs } }],
  belt: [{ name: "b", source: "briefs", steps: [WORK] }],
});

/** Read the pane until `match` shows up, so an assertion waits out the poll instead of racing it. */
async function screenWith(w: World, pane: string, match: RegExp, label: string, timeoutMs = 120_000): Promise<string> {
  let screen = "";
  await w.waitFor(
    () => {
      screen = w.herdr.readPane(pane, 80);
      return match.test(screen);
    },
    { label, timeoutMs, pollMs: 1000 },
  );
  return screen;
}

scenario(
  {
    name: "fleet-forward",
    timeoutMs: 420_000,
    // One brief, claimed on the first tick, purely so there is a workspace to hang the TUI's pane
    // off — the same shape tui-boot uses. No belt work is driven here; the clock is parked and the
    // agent sits still, so nothing moves under the board while the forward is being measured.
    briefs: { "tui-item": "# A brief\n\nSo the dashboard has something to render.\n" },
    config: (p) => ({ limits: { tick_interval_seconds: 3600 }, ...source(p) }),
    agent: { default: { hangMs: "forever" } },
    fleetMachines: {
      "build-box": {
        ssh: true,
        config: (p) => ({ limits: { tick_interval_seconds: 3600 }, ...source(p) }),
        extraRepos: { [SECOND_REPO]: {} },
      },
    },
    beforeStart: async () => {
      // Shared /tmp across scenarios, so start from nothing rather than reading someone else's boot.
      rmSync(STARTUP_LOG, { force: true });
    },
  },
  async (w) => {
    const ssh = w.sshForward("build-box");

    // ── the TUI, launched the way an operator launches it, and kept alive for the whole run ────
    // This has to be the TUI and not a `fleet` CLI per step: every CLI invocation builds a NEW
    // transport, so "it came back without a restart" is not a thing a CLI can be asked.
    const ws = w.herdr.workspaces()[0]!;
    const created = w.herdr.json<{ result?: { root_pane?: { pane_id?: string }; pane_id?: string } }>([
      "tab",
      "create",
      "--workspace",
      ws.workspace_id,
      "--no-focus",
      "--label",
      "tui",
      "--cwd",
      w.paths.repo,
      "--env",
      "HERDR_FACTORY_TUI_TIMING=1",
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

    // ── (1) one open per machine ───────────────────────────────────────────────────────────────
    const up = await screenWith(w, pane!, /✓ build-box/, "the board reached the other machine over a real SSH forward");
    for (const bad of ["requires Node >= 26", "Cannot find", "Error:", "at Module"]) {
      expect(up, `the TUI screen shows no "${bad}"`).not.toContain(bad);
    }
    expect(up, "the machine is reached at its ssh target").toMatch(/✓ build-box \(harness@build-box\)/);
    const first = ssh.ports();
    expect(first, "one forward brought that machine up, not one per repo").toHaveLength(1);

    // …and it STAYS one. Several polls later the cached forward is still the one being used: the
    // `/health` re-probe added for recovery must not itself become a reason to re-open.
    await delay(12_000);
    expect(ssh.ports(), "the held forward is reused across polls").toEqual(first);
    expect(w.herdr.readPane(pane!, 80), "and the machine is still up").toMatch(/✓ build-box/);

    // ── (2) the remote restarts under a live ControlMaster ─────────────────────────────────────
    // The tunnel still binds and `ssh -O check` still answers `Master running`; only the server
    // behind it is gone. This is the state the fleet's own self-update left both remotes in.
    ssh.goDown();
    const blind = await screenWith(w, pane!, /unverifiable/, "the board notices the machine stopped answering", 180_000);
    expect(blind, "it says when it was last heard from").toMatch(/last seen (just now|\d)/);

    // The forward it gave up on was CANCELLED, not dropped on the floor still running — `-O cancel`
    // (that forward) and not `-O exit` (the shared master), naming the port it had taken.
    const cancels = ssh.controlCommands().filter((c) => c.includes("-O cancel"));
    expect(cancels.length, "the replaced forward was torn down").toBeGreaterThanOrEqual(1);
    expect(cancels.join("\n"), "and the command names the port it was holding").toContain(`-L ${first[0]}:127.0.0.1:8765`);

    // ── (3) it comes back on its own, in the same TUI ──────────────────────────────────────────
    ssh.comeUp();
    await screenWith(w, pane!, /✓ build-box/, "the machine recovers without the TUI being restarted", 180_000);
    const ports = ssh.ports();
    expect(ports.length, "recovery re-opened a forward").toBeGreaterThan(first.length);
    expect(ports[ports.length - 1], "on a fresh local port").not.toBe(first[0]);
    // The proof that this is recovery and not a restart: same TUI process, one boot in the log.
    expect(readFileSync(STARTUP_LOG, "utf8").match(/"app_ready"/g) ?? [], "the TUI never restarted").toHaveLength(1);

    // ── and none of it stampeded ───────────────────────────────────────────────────────────────
    // Replayed from the fake ssh's own start/exit log: how many forwards to this machine were open
    // AT ONCE, which is the `ps` the bug was measured with. While the machine is down each failing
    // open costs two connect timeouts (the stale-master retry), which outruns the read budget and
    // lets the next poll start before the last one has let go — the exact window the in-flight
    // dedupe closes.
    expect(ssh.maxConcurrent(), "never more than one forward open at a time").toBe(1);
  },
);
