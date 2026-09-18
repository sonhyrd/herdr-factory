// Who is in the fleet. No new config: the answer is THIS machine plus every *enabled* saved SSH
// machine herdr already knows about (`herdr machine list --json`), which is the same list the herdr
// sidebar shows. A disabled profile is excluded — disabling one in herdr is how an operator takes a
// box out of the fleet.
//
// A herdr that cannot answer (not installed, no server, an older CLI without `machine list`) leaves
// the fleet as the local machine alone, which is exactly the single-machine behaviour that shipped
// before: the fleet view of a one-machine install must never be worse than `status` was.
//
// The one subprocess here is spawned with node's own `execFile` rather than `clients/exec.ts`: the
// TUI's eagerly-built Dashboard reads the fleet, and `clients/exec.ts` pulls the Effect + OTel
// telemetry stack (~2s of cold module load) onto the startup path — the pull that
// `test/tui-startup-graph.test.ts` exists to catch. Same posture as `watchers/update-status.ts`:
// a telemetry-free leaf for the readers, the instrumented path for the engine.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexecFile = promisify(execFile);

/** The fleet's name for the machine the command runs on. Not a herdr profile — there is no SSH
 *  target and no forward; its API is read through server.json like the TUI has always done. */
export const LOCAL_MACHINE = "local";

export interface Machine {
  /** Routing identity and the `machine` column's value. herdr labels are unique per install. */
  name: string;
  /** What `ssh` is given for the forward; null on the local machine. */
  sshTarget: string | null;
  /** An explicit remote herdr session, when the profile pins one. Carried for display only — the
   *  factory API is reached by port forward, not through herdr's session. */
  session: string | null;
  local: boolean;
}

/** One entry of `herdr machine list --json`. Every field is optional on purpose: this is another
 *  tool's output, and a herdr that renames or adds one must degrade to "skip that entry", never to
 *  a crash in the middle of a fleet read. Both spellings of each field are accepted because the
 *  profile shape is herdr's to change (it has carried `label`/`target` since it was added). */
interface RawMachine {
  label?: unknown;
  name?: unknown;
  target?: unknown;
  ssh_target?: unknown;
  session?: unknown;
  remote_session?: unknown;
  enabled?: unknown;
}

function str(...candidates: unknown[]): string | null {
  for (const c of candidates) if (typeof c === "string" && c.trim()) return c.trim();
  return null;
}

/** Parse `herdr machine list --json`. Entries without a label or an SSH target are dropped (there is
 *  nothing to name or dial), and so is anything explicitly `enabled: false`. An absent `enabled` is
 *  treated as enabled: a profile herdr does not mark is one it is willing to connect to. */
export function parseMachineList(raw: unknown): Machine[] {
  const entries = Array.isArray(raw) ? raw : Array.isArray((raw as { machines?: unknown })?.machines) ? ((raw as { machines: unknown[] }).machines) : [];
  const out: Machine[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const m = entry as RawMachine;
    if (m.enabled === false) continue;
    const name = str(m.label, m.name);
    const sshTarget = str(m.target, m.ssh_target);
    if (!name || !sshTarget) continue;
    if (name === LOCAL_MACHINE) continue; // the local entry's name is ours; a profile may not shadow it
    out.push({ name, sshTarget, session: str(m.session, m.remote_session), local: false });
  }
  return out;
}

export const localMachine: Machine = { name: LOCAL_MACHINE, sshTarget: null, session: null, local: true };

export interface ListMachinesOpts {
  /** Injected in tests and by the e2e harness; defaults to the real `herdr machine list --json`. */
  readProfiles?: () => Promise<unknown>;
  /** Called with the reason the remote half of the fleet is missing. */
  onWarn?: (message: string) => void;
}

async function readProfilesViaHerdr(): Promise<unknown> {
  // Short budget: fleet discovery runs ahead of every fleet read, and a wedged herdr must not hold
  // the whole view. A non-zero exit (an older herdr has no `machine list`) is a reason, not a crash.
  try {
    const { stdout } = await pexecFile(process.env.HERDR_BIN_PATH ?? "herdr", ["machine", "list", "--json"], { timeout: 5000, encoding: "utf8" });
    return JSON.parse(stdout || "[]");
  } catch (e) {
    const err = e as { stderr?: string; stdout?: string; message?: string };
    throw new Error(`herdr machine list failed: ${(err.stderr || err.stdout || err.message || "").trim().slice(0, 200)}`);
  }
}

/** The fleet: the local machine first, then herdr's enabled saved machines in herdr's own order. */
export async function listMachines(opts: ListMachinesOpts = {}): Promise<Machine[]> {
  try {
    return [localMachine, ...parseMachineList(await (opts.readProfiles ?? readProfilesViaHerdr)())];
  } catch (e) {
    opts.onWarn?.(`could not list herdr machines — showing this machine only: ${e instanceof Error ? e.message : String(e)}`);
    return [localMachine];
  }
}
