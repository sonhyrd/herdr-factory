// What the TUI reads, once there is more than one machine: every machine's repos, runs and eligible
// work in one view, plus the client each action has to be sent to.
//
// Three rules carry this module, and they are the same ones `fleet/read.ts` keeps for the CLI:
//
//  1. **Silence is never emptiness.** A machine that stops answering keeps the rows of its last
//     successful read, marked `unverifiable` and carrying when that read was. Blanking them would
//     tell an operator the runs are gone; they are merely unobservable, and still working.
//  2. **One slow machine never blocks the view.** Each machine is read under its own budget
//     (`readMachines`), so the poll costs the slowest machine's *budget*, not its latency.
//  3. **An action goes to the machine that owns the run, and to no other.** `clientFor` is the only
//     way the Dashboard reaches a server, so a routing mistake cannot be spelled.
//
// Eligible work is read in a SECOND phase, exactly as the single-machine dashboard has always done:
// source queries (a Jira poll, a GitHub search) are slow and may fail on their own, and folding them
// into the machine's own budget would make one lagging source turn a healthy machine `unverifiable`.
import { buildFleet, type Fleet, type MachineClient } from "../fleet/index.ts";
import { DEFAULT_MACHINE_TIMEOUT_MS, fileLastSeenStore, readMachines, repoNamesFor, type LastSeenStore, type MachineRead } from "../fleet/read.ts";
import type { EligibleItem, RepoStatus } from "../fleet/shapes.ts";
import type { ListMachinesOpts } from "../fleet/machines.ts";
import type { MachineTransport } from "../fleet/transport.ts";
import { fmtDur } from "../core/explain.ts";

/** One repo on one machine, as the board renders it. `status` is null when the server answered
 *  `/health` but not this repo's status (a repo that failed to load). */
export interface RepoView {
  repo: string;
  status: RepoStatus | null;
  eligible: EligibleItem[];
}

export interface MachineView {
  name: string;
  local: boolean;
  sshTarget: string | null;
  state: "ok" | "unverifiable";
  version: string | null;
  uptimeSec: number | null;
  /** Epoch seconds of the most recent successful read — this one when `ok`, the remembered one
   *  when `unverifiable`, null when the machine has never answered. */
  lastSeenAt: number | null;
  /** Why it is unverifiable. Absent when `ok`. */
  detail?: string;
  /** Host-local machine.yml summary: cap occupancy across all repos, free memory, the active gate. */
  machineLine?: string;
  repos: RepoView[];
  /** True when `repos` is the LAST KNOWN state rather than this read's — i.e. the machine is
   *  unverifiable and these rows are being carried forward. */
  stale: boolean;
}

export interface FleetView {
  /** Epoch seconds the read was taken. */
  readAt: number;
  machines: MachineView[];
}

/** What one reachable machine answered in the quick (status-only) phase. */
export interface MachinePayload {
  uptimeSec: number;
  repos: { repo: string; status: RepoStatus | null }[];
}

const cacheKey = (machine: string, repo: string) => `${machine}|${repo}`;

/**
 * Build one machine's view: this read when it answered, the last known one when it did not.
 *
 * `lastGood` and `eligible` are the carry-forward caches (mutated by the caller, read here), so an
 * unverifiable machine keeps its rows and a reachable one keeps its eligible items across the gap
 * between the two phases.
 */
export function mergeMachine(
  read: MachineRead<MachinePayload>,
  lastGood: Map<string, MachineView>,
  eligible: Map<string, EligibleItem[]>,
): MachineView {
  const base = { name: read.name, local: read.local, sshTarget: read.sshTarget, lastSeenAt: read.lastSeenAt };
  if (!read.payload) {
    const known = lastGood.get(read.name);
    return {
      ...base,
      state: "unverifiable",
      version: known?.version ?? null,
      uptimeSec: null,
      detail: read.detail,
      machineLine: known?.machineLine,
      repos: known?.repos ?? [],
      stale: true,
    };
  }
  const repos = read.payload.repos.map((r) => ({ repo: r.repo, status: r.status, eligible: eligible.get(cacheKey(read.name, r.repo)) ?? [] }));
  const view: MachineView = {
    ...base,
    state: "ok",
    version: read.version,
    uptimeSec: read.payload.uptimeSec,
    machineLine: repos.find((r) => r.status?.machine)?.status?.machine,
    repos,
    stale: false,
  };
  lastGood.set(read.name, view);
  return view;
}

/** The machines this view shows: all of them, or the one the operator filtered to. A filter naming
 *  a machine that has left the fleet falls back to all — an empty board would read as "no work". */
export function filterMachines(view: FleetView, machine: string | null): MachineView[] {
  if (!machine) return view.machines;
  const only = view.machines.filter((m) => m.name === machine);
  return only.length ? only : view.machines;
}

/** How long ago, in words, for the header's last-seen. */
function ago(readAt: number, at: number | null): string {
  if (at === null) return "never seen";
  const delta = Math.max(0, readAt - at);
  return delta < 2 ? "just now" : `${fmtDur(delta)} ago`;
}

/** Where a machine is, for the header: the local machine says so, a remote one names its SSH target. */
function where(m: MachineView): string {
  return m.local ? "this machine" : (m.sshTarget ?? "?");
}

/**
 * One machine's header line: can we reach it, what it is running, how loaded it is, and when it
 * last answered. The unverifiable line leads with the last-seen time and says outright that the
 * rows below it are last-known — that is the difference between "this box is quiet" and "this box
 * has been gone all morning", and an operator acts differently on each.
 */
export function machineHeader(m: MachineView, readAt: number): { text: string; tone: "accent" | "bad" } {
  if (m.state === "unverifiable") {
    const rows = m.repos.length ? " · the rows below are its last known state, NOT known to be gone" : "";
    return { text: `✗ ${m.name} (${where(m)}) — unverifiable: ${m.detail ?? "no answer"} · last seen ${ago(readAt, m.lastSeenAt)}${rows}`, tone: "bad" };
  }
  const running = m.repos.reduce((n, r) => n + (r.status?.active.length ?? 0), 0);
  const parts = [`v${m.version ?? "?"}`, `${m.repos.length} repo${m.repos.length === 1 ? "" : "s"}`, `${running} running`];
  if (m.machineLine) parts.push(m.machineLine.replace(/^machine: /, ""));
  parts.push(`read ${ago(readAt, m.lastSeenAt)}`);
  return { text: `✓ ${m.name} (${where(m)}) — ${parts.join(" · ")}`, tone: "accent" };
}

/** A run on an unverifiable machine: no card (a card would claim to be live), one line saying what
 *  it was doing when the machine last answered. */
export function staleRunLine(run: { ticketKey: string; belt: string | null; step: string | null; phase: string }): string {
  return `${run.ticketKey}   ${run.belt ?? "-"}/${run.step ?? run.phase}   unverifiable — last known`;
}

/** Remotes whose server is on another version than this machine's, in words. This is the fleet half
 *  of the update warning: a box the updater has not reached is invisible from its own dashboard. */
export function versionDrift(view: FleetView): string[] {
  const local = view.machines.find((m) => m.local);
  if (!local || local.state !== "ok") return [];
  return view.machines
    .filter((m) => !m.local && m.state === "ok" && m.version !== local.version)
    .map((m) => `${m.name} on v${m.version ?? "?"} (this machine v${local.version ?? "?"})`);
}

/**
 * The shell's status text. A one-machine fleet reads exactly as it always has ("● server up · …"):
 * the fleet's chrome appears only when there IS a fleet. With several machines it leads with how
 * many answered, and carries every remote's own summary — an unverifiable box and a version drift
 * are both things you only find out by asking each `/health`.
 */
export function fleetStatusLine(view: FleetView, updateNote: string | null): { text: string; tone: "good" | "warn" } {
  const local = view.machines.find((m) => m.local);
  const notes = [...(updateNote ? [updateNote] : []), ...versionDrift(view)];
  if (view.machines.length <= 1) {
    if (!local || local.state !== "ok") return { text: "⚠ server not running — start it with `herdr-factory serve`", tone: "warn" };
    const uptime = local.uptimeSec === null ? "?" : fmtDur(local.uptimeSec);
    return {
      text: `● server up · v${local.version} · uptime ${uptime}${notes.length ? ` · ⚠ ${notes.join(" · ")}` : ""}`,
      tone: notes.length ? "warn" : "good",
    };
  }
  const blind = view.machines.filter((m) => m.state === "unverifiable");
  for (const m of blind) notes.push(`${m.name} unverifiable (last seen ${ago(view.readAt, m.lastSeenAt)})`);
  const reachable = view.machines.length - blind.length;
  const head = `● fleet ${reachable}/${view.machines.length} machines · v${local?.version ?? "?"} here`;
  return { text: `${head}${notes.length ? ` · ⚠ ${notes.join(" · ")}` : ""}`, tone: notes.length ? "warn" : "good" };
}

/** One line per machine for the Doctor tab: reachable?, what it is running, how loaded it is.
 *  Built from each machine's own `/health` (plus its status line), because a remote box's version
 *  and occupancy are invisible from this machine's checks. The local machine is skipped — every
 *  other check on that tab is already about it. */
export async function fleetHealthLines(opts: FleetSourceOpts = {}): Promise<{ ok: boolean; label: string }[]> {
  const source = createFleetSource(opts);
  const views: FleetView[] = [];
  try {
    // Only the quick phase matters here, so the poll is cancelled the moment it has painted once —
    // the doctor has no use for eligible work, and no reason to make every source query for it.
    await source.poll((v) => void views.push(v), () => views.length > 0);
    const view = views[0];
    if (!view) return [];
    return view.machines.filter((m) => !m.local).map((m) => ({ ok: m.state === "ok", label: machineHeader(m, view.readAt).text.replace(/^[✓✗] /, "") }));
  } finally {
    source.close();
  }
}

export interface FleetSourceOpts extends ListMachinesOpts {
  transport?: MachineTransport;
  /** Per-machine budget for the quick read. */
  timeoutMs?: number;
  lastSeen?: LastSeenStore;
  now?: () => number;
}

/**
 * The Dashboard's window onto the fleet: it polls, it remembers, and it hands out the ONE client an
 * action may use. Built lazily on the first poll, because discovery shells out to herdr and the TUI
 * must paint its shell before anything of the sort.
 */
export interface FleetSource {
  /** One poll, painting twice: first the quick status view (eligible items carried forward), then
   *  the same view with fresh eligible work folded in. Both calls are skipped if `cancelled()`. */
  poll(onView: (view: FleetView) => void, cancelled?: () => boolean): Promise<void>;
  /** The client for `machine`, or undefined if it is not in the fleet — the only route to a server. */
  clientFor(machine: string): MachineClient | undefined;
  /** Every machine's name, in fleet order (this machine first). Empty before the first poll. */
  machineNames(): string[];
  /** Warnings raised while discovering the fleet (a herdr that could not be asked). */
  warnings(): string[];
  close(): void;
}

export function createFleetSource(opts: FleetSourceOpts = {}): FleetSource {
  const lastSeen = opts.lastSeen ?? fileLastSeenStore();
  // Keyed `<machine>|<repo>`: the last SUCCESSFUL eligible result, so the rows survive the gap
  // between the two phases and a failed source query (see eligible-cache.ts for the same idea).
  const eligibleCache = new Map<string, EligibleItem[]>();
  // The last view each machine answered with, so an unverifiable one keeps its rows.
  const lastGood = new Map<string, MachineView>();
  const warn: string[] = [];
  let fleet: Fleet | null = null;
  let building: Promise<Fleet> | null = null;
  let closed = false;

  async function ensureFleet(): Promise<Fleet> {
    if (fleet) return fleet;
    building ??= buildFleet({
      readProfiles: opts.readProfiles,
      transport: opts.transport,
      onWarn: (m) => {
        if (!warn.includes(m)) warn.push(m);
      },
    });
    fleet = await building;
    if (closed) fleet.close();
    return fleet;
  }

  const clientFor = (machine: string) => fleet?.clients.find((c) => c.machine.name === machine);

  return {
    async poll(onView, cancelled = () => false) {
      const { clients } = await ensureFleet();
      if (cancelled()) return;
      const quick = await readMachines<MachinePayload>(
        clients,
        async (client, health) => {
          const names = repoNamesFor(health, undefined);
          const statuses = await Promise.all(names.map((name) => client.status(name)));
          return { uptimeSec: health.uptimeSec, repos: names.map((repo, i) => ({ repo, status: statuses[i] ?? null })) };
        },
        { timeoutMs: opts.timeoutMs ?? DEFAULT_MACHINE_TIMEOUT_MS, lastSeen, now: opts.now },
      );
      if (cancelled()) return;
      const machines = quick.machines.map((m) => mergeMachine(m, lastGood, eligibleCache));
      onView({ readAt: quick.readAt, machines });
      if (cancelled()) return;

      // Phase 2: the slow source queries, per reachable repo. A failure keeps the last good answer.
      const wanted = machines.flatMap((m) => (m.state === "ok" ? m.repos.map((r) => ({ machine: m.name, repo: r.repo })) : []));
      const fresh = await Promise.all(wanted.map(({ machine, repo }) => clientFor(machine)?.eligible(repo) ?? Promise.resolve(null)));
      if (cancelled()) return;
      wanted.forEach(({ machine, repo }, i) => {
        const got = fresh[i];
        if (got) eligibleCache.set(cacheKey(machine, repo), got.eligible);
      });
      // Drop cached items for a repo a REACHABLE machine no longer serves; an unverifiable machine's
      // entries stay, since they are the rows it is still being rendered with.
      const live = new Set(wanted.map(({ machine, repo }) => cacheKey(machine, repo)));
      const reachable = new Set(machines.filter((m) => m.state === "ok").map((m) => m.name));
      for (const key of [...eligibleCache.keys()]) {
        if (!live.has(key) && reachable.has(key.slice(0, key.indexOf("|")))) eligibleCache.delete(key);
      }
      onView({
        readAt: quick.readAt,
        machines: machines.map((m) =>
          m.state === "ok" ? { ...m, repos: m.repos.map((r) => ({ ...r, eligible: eligibleCache.get(cacheKey(m.name, r.repo)) ?? [] })) } : m,
        ),
      });
    },
    clientFor,
    machineNames() {
      return fleet?.clients.map((c) => c.machine.name) ?? [];
    },
    warnings() {
      return [...warn];
    },
    close() {
      closed = true;
      fleet?.close();
    },
  };
}
