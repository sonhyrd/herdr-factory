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
import { fileLastSeenStore, readMachines, repoNamesFor, type LastSeenStore, type MachineRead } from "../fleet/read.ts";
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
 * One machine's header: can we reach it, what it is running, how loaded it is, and when it last
 * answered. Two lines rather than one — the terminal clips, and the occupancy gate and the
 * unverifiable caveat are exactly the parts that would fall off the right edge of a pane.
 *
 * The unverifiable head leads with the last-seen time, and its second line says outright that the
 * rows below are last-known: that is the difference between "this box is quiet" and "this box has
 * been gone all morning", and an operator acts differently on each.
 */
export function machineHeader(m: MachineView, readAt: number): { text: string; tone: "accent" | "bad" }[] {
  if (m.state === "unverifiable") {
    // Short lines, each led by the thing that matters most: a pane is often 50 columns, and the
    // half an operator must not miss is that the machine is silent and its runs are NOT gone.
    return [
      { text: `✗ ${m.name} (${where(m)}) — unverifiable`, tone: "bad" },
      { text: `    last seen ${ago(readAt, m.lastSeenAt)} · NOT known to be gone`, tone: "bad" },
      { text: `    ${m.detail ?? "no answer"}`, tone: "bad" },
    ];
  }
  const running = m.repos.reduce((n, r) => n + (r.status?.active.length ?? 0), 0);
  const lines: { text: string; tone: "accent" | "bad" }[] = [
    { text: `✓ ${m.name} (${where(m)}) — v${m.version ?? "?"} · ${running} running`, tone: "accent" },
    { text: `    ${m.repos.length} repo${m.repos.length === 1 ? "" : "s"} · read ${ago(readAt, m.lastSeenAt)}`, tone: "accent" },
  ];
  // The host-local gate (cap occupancy, free memory) is the machine's own line, and long enough to
  // deserve its own row.
  if (m.machineLine) lines.push({ text: `    ${m.machineLine.replace(/^machine: /, "")}`, tone: "accent" });
  // A cause several repos share is one cause: name it here, not once per row.
  for (const detail of sharedProblems(m)) lines.push({ text: `    ⚠ ${shortProblem(detail)} — on several repos`, tone: "bad" });
  return lines;
}

// ── what the board leads with, and what it collapses ─────────────────────────────────────────────
// A fleet board is mostly repos with nothing happening in them. The three helpers below are what let
// the render say the interesting half first and the boring half once:
//   * `needsYou` — the runs and machines that will not move until a human acts;
//   * `sharedProblems`/`shortProblem` — a problem named on the row, and named ONCE per host when
//     several of its repos report the identical one (a single `gh auth` is one login, not five);
//   * `idleRepos` — repos with no run, no eligible work and no problem, which collapse to one line.

/** A problem as a row can carry it: the cause, without the "— press s"/"— run X" hint the detail
 *  appends for the modal. Truncated, because this rides at the end of a repo row. */
export function shortProblem(detail: string): string {
  const cause = detail.split(" — ")[0]!.trim();
  return cause.length > 52 ? `${cause.slice(0, 51)}…` : cause;
}

/** Problem details that MORE THAN ONE of this machine's repos report identically — host-wide causes
 *  (an expired `gh auth`, AWS creds) wearing a per-repo disguise. The header says them once; the rows
 *  stay (so `d` still reaches each repo's full detail) but do not repeat the text. */
export function sharedProblems(m: MachineView): Set<string> {
  const seen = new Map<string, number>();
  for (const r of m.repos) for (const d of new Set((r.status?.problems ?? []).map((p) => p.detail))) seen.set(d, (seen.get(d) ?? 0) + 1);
  return new Set([...seen].filter(([, n]) => n > 1).map(([d]) => d));
}

/** True when a repo has nothing an operator could act on: no active run, no eligible work, no
 *  problem. A repo whose status failed to load is NOT idle — that is news, and keeps its row. */
export function isIdleRepo(r: RepoView): boolean {
  return r.status != null && r.status.active.length === 0 && r.eligible.length === 0 && (r.status.problems?.length ?? 0) === 0;
}

/** The one line that stands in for a machine's idle repos. On an unverifiable machine it says
 *  `unverified`, never `idle`: those rows are a remembered read, and "idle" would claim this one. */
export function idleLine(names: string[], stale: boolean): string {
  return `  ${stale ? "unverified" : "idle"} · ${names.join(" · ")}`;
}

/** One thing that will not move until a human acts, for the board's top section. */
export interface NeedsYouItem {
  text: string;
  tone: "good" | "warn" | "bad";
  machine: string;
  repo: string;
  /** The run it points at; absent for a machine-level entry. */
  key?: string;
  source?: string | null;
  phase?: string;
  stale?: boolean;
}

/**
 * The board's first section: everything blocked on a person, across the whole fleet — a PR that is
 * green and waiting to be merged (the `pr_green` watch already knows), a run parked for `attention`,
 * a run that asked a human a question, and a machine that has stopped answering.
 *
 * Empty means the section is not drawn at all: a heading that is usually "nothing" teaches an
 * operator to skip the top of the screen, which is the one place this board cannot afford to lose.
 *
 * A stale machine's runs still list — they were blocked on a human when it last answered and nothing
 * since says otherwise — but they carry the machine's name and cannot be acted on (`stale`).
 */
export function needsYou(machines: MachineView[]): NeedsYouItem[] {
  const green: NeedsYouItem[] = [];
  const parked: NeedsYouItem[] = [];
  const asking: NeedsYouItem[] = [];
  const blind: NeedsYouItem[] = [];
  for (const m of machines) {
    if (m.state === "unverifiable") {
      blind.push({ text: `✗ ${m.name} unverifiable — ${m.detail ?? "no answer"}`, tone: "bad", machine: m.name, repo: "" });
    }
    for (const r of m.repos) {
      for (const run of r.status?.active ?? []) {
        const at = `${r.repo}${m.local ? "" : ` @${m.name}`}`;
        const base = { machine: m.name, repo: r.repo, key: run.ticketKey, source: run.workSource, phase: run.phase, stale: m.stale };
        if (run.prGreen && run.prNumber != null) {
          green.push({ ...base, text: `✓ ${run.ticketKey}  PR #${run.prNumber} is green — ready to merge  (${at})`, tone: "good" });
        }
        if (run.phase === "attention") {
          parked.push({ ...base, text: `⚠ ${run.ticketKey}  parked — ${run.attentionReason ?? "needs attention"}  (${at})`, tone: "bad" });
        } else if (run.phase === "waiting_for_human") {
          asking.push({ ...base, text: `? ${run.ticketKey}  waiting for a human reply  (${at})`, tone: "warn" });
        }
      }
    }
  }
  return [...green, ...parked, ...asking, ...blind];
}

/** A run on an unverifiable machine: no card (a card would claim to be live), one line saying what
 *  it was doing when the machine last answered. Short, because it sits under a header that already
 *  spells out what `unverifiable` means for the rows below it. */
export function staleRunLine(run: { ticketKey: string; belt: string | null; step: string | null; phase: string }): string {
  return `${run.ticketKey}   ${run.belt ?? "-"}/${run.step ?? run.phase}   unverifiable`;
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
export async function fleetHealthLines(opts: FleetSourceOpts = {}): Promise<{ ok: boolean; label: string; detail: string | null }[]> {
  const source = createFleetSource(opts);
  const views: FleetView[] = [];
  try {
    // Only the quick phase matters here, so the poll is cancelled the moment it has painted once —
    // the doctor has no use for eligible work, and no reason to make every source query for it.
    await source.poll((v) => void views.push(v), () => views.length > 0);
    const view = views[0];
    if (!view) return [];
    return view.machines
      .filter((m) => !m.local)
      .map((m) => {
        const [head, extra] = machineHeader(m, view.readAt);
        return { ok: m.state === "ok", label: head!.text.replace(/^[✓✗] /, ""), detail: extra?.text.trim() ?? null };
      });
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
  /** Warnings raised while discovering the fleet (a herdr that could not be asked). */
  warnings(): string[];
  close(): void;
}

export function createFleetSource(opts: FleetSourceOpts = {}): FleetSource {
  const lastSeen = opts.lastSeen ?? fileLastSeenStore();
  // Keyed `<machine>|<repo>`: the last SUCCESSFUL eligible result, so the rows survive the gap
  // between the two phases and a failed source query. Anything carried this way can collide with a
  // run that has since claimed it — `withoutClaimed` (eligible-cache.ts) is what settles that.
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
        // No default of its own: `readMachines` picks per machine (a remote's budget has to cover bringing
        // its forward up), and pinning the local default here would hold every remote to a loopback number.
        { timeoutMs: opts.timeoutMs, lastSeen, now: opts.now },
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
      const folded = machines.map((m) =>
        m.state === "ok" ? { ...m, repos: m.repos.map((r) => ({ ...r, eligible: eligibleCache.get(cacheKey(m.name, r.repo)) ?? [] })) } : m,
      );
      // Remember the FOLDED view, so a machine that goes away next poll carries forward the rows an
      // operator actually saw — eligible work included.
      for (const m of folded) if (m.state === "ok") lastGood.set(m.name, m);
      onView({ readAt: quick.readAt, machines: folded });
    },
    clientFor,
    warnings() {
      return [...warn];
    },
    close() {
      closed = true;
      fleet?.close();
    },
  };
}
