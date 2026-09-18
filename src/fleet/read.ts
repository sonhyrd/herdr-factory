// The merged fleet view, and the routing rule that keeps an action on the machine that owns its run.
//
// Two invariants carry this file:
//
//  1. **One slow machine never blocks the rest.** Every machine is read concurrently under its own
//     timeout, so the view's latency is the slowest machine's *budget*, not its actual latency.
//  2. **Silence is never emptiness.** A machine that times out or refuses is `unverifiable`, carrying
//     the last time it DID answer. Reporting it as "no runs" would be a lie an operator acts on —
//     the runs are still there, working, on a box we just couldn't ask.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fleetLastSeenPath } from "../config-paths.ts";
import type { MachineClient } from "./client.ts";
import type { ActiveRun, Health, RepoStatus } from "./shapes.ts";

/** Default budget for THIS machine: one loopback round trip to a server that is either up or is
 *  not. A remote one gets `DEFAULT_REMOTE_MACHINE_TIMEOUT_MS` — it has a forward to build first. */
export const DEFAULT_MACHINE_TIMEOUT_MS = 5000;

/**
 * Default budget for a machine reached over an SSH forward.
 *
 * A local read is one loopback round trip; a remote read has to BUILD its transport first — dial
 * the host (or reuse a master), bring the forward up, then poll it until it answers. That routinely
 * costs seconds on a distant box, and the local 5000ms budget cut it off mid-connect and reported
 * `no answer within 5000ms` — hiding whatever ssh or the API was about to say, which is the one
 * thing the row needed. Matched to the transport's own connect budget (10s) plus a read.
 */
export const DEFAULT_REMOTE_MACHINE_TIMEOUT_MS = 15_000;

/** One run, flattened for the fleet table. `machine` is the routing key: it is the ONLY machine an
 *  action on this run may be sent to. */
export interface FleetRun {
  machine: string;
  repo: string;
  key: string;
  source: string | null;
  belt: string | null;
  step: string | null;
  phase: string;
  /** Seconds since the run was created; null when the server didn't report a creation time. */
  ageSeconds: number | null;
  prNumber: number | null;
  /** Human-readable problems for the last column: an attention park's reason, a stuck upload. */
  problems: string[];
}

export interface FleetMachine {
  name: string;
  sshTarget: string | null;
  local: boolean;
  /** `ok` = this read reached it. `unverifiable` = it did not answer in time; `runs` is empty
   *  because we could not ask, NOT because there are none. */
  state: "ok" | "unverifiable";
  /** Server version from /health; null when unverifiable. */
  version: string | null;
  /** Epoch seconds of the most recent successful read — this one when `ok`, the remembered one
   *  when `unverifiable`, null when the machine has never answered. */
  lastSeenAt: number | null;
  /** Why it is unverifiable (timeout / no server / refused). Absent when `ok`. */
  detail?: string;
  /** Host-local machine.yml summary: cap occupancy across all repos, free memory, the active gate.
   *  Absent when the host sets no machine limits. */
  machineLine?: string;
  repos: string[];
  runs: FleetRun[];
  /** Repo-level problems (parked runs, suspended jobs, auth), prefixed with their repo. */
  problems: { repo: string; kind: string; detail: string }[];
}

export interface FleetSnapshot {
  /** Epoch seconds the read was taken. */
  readAt: number;
  machines: FleetMachine[];
  /** Every machine's runs, machine order then server order — what the table prints. */
  runs: FleetRun[];
}

/** Remembers when each machine last answered. File-backed in production (see `fleetLastSeenPath`),
 *  trivially fakeable in a test. */
export interface LastSeenStore {
  get(machine: string): number | null;
  set(machine: string, at: number): void;
}

export function fileLastSeenStore(path = fleetLastSeenPath()): LastSeenStore {
  let cache: Record<string, number> | null = null;
  const load = (): Record<string, number> => {
    if (cache) return cache;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      cache = Object.fromEntries(Object.entries(raw).filter((e): e is [string, number] => typeof e[1] === "number"));
    } catch {
      cache = {};
    }
    return cache;
  };
  return {
    get: (machine) => load()[machine] ?? null,
    set: (machine, at) => {
      const all = load();
      all[machine] = at;
      try {
        // Atomic publish: two `fleet` invocations (or a fleet read beside a TUI poll) can write at
        // once, and a torn file would read back as "never seen" for every machine.
        if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
        const tmp = `${path}.${process.pid}`;
        writeFileSync(tmp, JSON.stringify(all));
        renameSync(tmp, path);
      } catch {
        /* best-effort: losing the memo degrades a later read's detail, never the read itself */
      }
    },
  };
}

export function memoryLastSeenStore(seed: Record<string, number> = {}): LastSeenStore {
  const all = { ...seed };
  return { get: (m) => all[m] ?? null, set: (m, at) => void (all[m] = at) };
}

export interface ReadFleetOpts {
  /** Per-machine budget; one machine exceeding it makes that machine unverifiable and nothing else.
   *  Left unset, each machine gets the default for its kind (local / remote) — set it only to
   *  override BOTH, as `--timeout` does. */
  timeoutMs?: number;
  /** Only these repos (default: every repo each machine's /health reports). */
  repos?: string[];
  /** Epoch seconds. Injected so a test can pin ages. */
  now?: () => number;
  lastSeen?: LastSeenStore;
}

const TIMED_OUT = Symbol("timed-out");

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function runProblems(run: ActiveRun): string[] {
  const out: string[] = [];
  if (run.attentionReason) out.push(`attention: ${run.attentionReason}`);
  if (run.problem) out.push(`${run.problem.kind}: ${run.problem.detail}`);
  return out;
}

function flatten(machine: string, status: RepoStatus, now: number): FleetRun[] {
  return status.active.map((run) => ({
    machine,
    repo: status.repo,
    key: run.ticketKey,
    source: run.workSource,
    belt: run.belt,
    // `phase` is just "running" while a step is dispatched, so the step is the interesting column;
    // both are kept because a phase of `attention` has no step and is the whole story.
    step: run.step,
    phase: run.phase,
    ageSeconds: run.createdAt === null ? null : Math.max(0, now - run.createdAt),
    prNumber: run.prNumber,
    problems: runProblems(run),
  }));
}

/** One machine's verdict, whatever the caller went there to read. `payload` is null exactly when
 *  `state` is `unverifiable` — the machine did not answer, so nothing it owns is known. */
export interface MachineRead<T> {
  name: string;
  sshTarget: string | null;
  local: boolean;
  state: "ok" | "unverifiable";
  version: string | null;
  lastSeenAt: number | null;
  detail?: string;
  payload: T | null;
}

/**
 * Read every machine in parallel, each under its own budget, and turn silence into `unverifiable`
 * rather than emptiness. WHAT is read is the caller's: `readFleet` wants each repo's status, the
 * TUI also wants its eligible items — but the timeout, the verdict and the last-seen memo are the
 * fleet's and must not be reimplemented per surface, or one of them will report a machine it could
 * not reach as a machine with nothing on it.
 *
 * `read` is called only for a machine that answered `/health`, and is handed that health so it
 * needn't ask twice.
 */
export async function readMachines<T>(
  clients: MachineClient[],
  read: (client: MachineClient, health: Health) => Promise<T>,
  opts: ReadFleetOpts = {},
): Promise<{ readAt: number; machines: MachineRead<T>[] }> {
  const now = opts.now?.() ?? Math.floor(Date.now() / 1000);
  const lastSeen = opts.lastSeen ?? fileLastSeenStore();

  const machines = await Promise.all(
    clients.map(async (client): Promise<MachineRead<T>> => {
      const m = client.machine;
      const timeoutMs = opts.timeoutMs ?? (m.local ? DEFAULT_MACHINE_TIMEOUT_MS : DEFAULT_REMOTE_MACHINE_TIMEOUT_MS);
      const base = { name: m.name, sshTarget: m.sshTarget, local: m.local };
      const unverifiable = (detail: string): MachineRead<T> => ({
        ...base,
        state: "unverifiable",
        version: null,
        lastSeenAt: lastSeen.get(m.name),
        detail,
        payload: null,
      });
      let got: { health: Health; payload: T } | null | typeof TIMED_OUT;
      try {
        got = await withTimeout(
          (async () => {
            const health = await client.health();
            return health && { health, payload: await read(client, health) };
          })(),
          timeoutMs,
        );
      } catch (e) {
        return unverifiable(e instanceof Error ? e.message : String(e));
      }
      if (got === TIMED_OUT) return unverifiable(`no answer within ${timeoutMs}ms`);
      // A remote machine's transport usually knows more than "it did not answer" — ssh's own first
      // line of stderr (bad auth, unknown host, a forward it refused). Prefer it over the generic.
      if (got === null) return unverifiable(m.local ? "no server running here" : client.failureDetail() ?? "could not reach its API");
      lastSeen.set(m.name, now);
      return { ...base, state: "ok", version: got.health.version, lastSeenAt: now, payload: got.payload };
    }),
  );
  return { readAt: now, machines };
}

/** The repos of `health` this read is interested in — every one, or the asked-for subset a machine
 *  actually serves. */
export function repoNamesFor(health: Health, repos: string[] | undefined): string[] {
  if (repos === undefined) return health.repos.map((r) => r.name);
  return repos.filter((name) => health.repos.some((r) => r.name === name));
}

/**
 * The merged view. Machines are read in parallel, each under `timeoutMs`; the result keeps the
 * clients' order (the local machine first, then herdr's), so the table is stable between reads.
 */
export async function readFleet(clients: MachineClient[], opts: ReadFleetOpts = {}): Promise<FleetSnapshot> {
  const read = await readMachines(
    clients,
    async (client, health) => {
      const names = repoNamesFor(health, opts.repos);
      return { names, statuses: (await Promise.all(names.map((name) => client.status(name)))).filter((s): s is RepoStatus => s !== null) };
    },
    opts,
  );
  const machines = read.machines.map((m): FleetMachine => {
    const common = { name: m.name, sshTarget: m.sshTarget, local: m.local, version: m.version, lastSeenAt: m.lastSeenAt };
    if (!m.payload) return { ...common, state: "unverifiable", detail: m.detail, repos: [], runs: [], problems: [] };
    const { names, statuses } = m.payload;
    return {
      ...common,
      state: "ok",
      machineLine: statuses.find((s) => s.machine)?.machine,
      repos: names,
      runs: statuses.flatMap((s) => flatten(m.name, s, read.readAt)),
      problems: statuses.flatMap((s) => (s.problems ?? []).map((p) => ({ repo: s.repo, kind: p.kind, detail: p.detail }))),
    };
  });
  return { readAt: read.readAt, machines, runs: machines.flatMap((m) => m.runs) };
}

/** An action's target: the one machine that owns the run, and the run itself. */
export type RunRoute = { ok: true; machine: FleetMachine; run: FleetRun } | { ok: false; error: string };

/**
 * Which machine an action on `key` must go to — and only that one. A key is unique per repo, not per
 * fleet: two machines can both be working an item with the same key (different repos, or the same
 * repo cloned on both), so an ambiguous key is REFUSED rather than resolved by guessing. Acting on
 * the wrong machine would claim, tear down or resume a stranger's run.
 */
export function routeRun(snapshot: FleetSnapshot, key: string, filter: { repo?: string; machine?: string } = {}): RunRoute {
  const candidates = snapshot.runs.filter(
    (r) => r.key === key && (filter.repo === undefined || r.repo === filter.repo) && (filter.machine === undefined || r.machine === filter.machine),
  );
  if (candidates.length === 1) {
    const run = candidates[0]!;
    return { ok: true, machine: snapshot.machines.find((m) => m.name === run.machine)!, run };
  }
  if (candidates.length > 1) {
    const where = candidates.map((r) => `${r.machine}/${r.repo}`).join(", ");
    return { ok: false, error: `${key} is active on more than one machine (${where}) — narrow it with --machine or --repo` };
  }
  // A machine we could not read may well be running it; say so instead of "no such run".
  const blind = snapshot.machines.filter((m) => m.state === "unverifiable").map((m) => m.name);
  const caveat = blind.length ? ` (${blind.join(", ")} ${blind.length === 1 ? "was" : "were"} unverifiable this read)` : "";
  return { ok: false, error: `no active run for ${key} on any machine in the fleet${caveat}` };
}
