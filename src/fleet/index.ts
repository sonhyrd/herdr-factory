// Assembling the fleet: discovery (herdr's machines) + transport (server.json / SSH forward) +
// one client per machine. The only thing a caller needs to build the whole machine-aware surface.
import { httpMachineClient, type MachineClient } from "./client.ts";
import { listMachines, type ListMachinesOpts } from "./machines.ts";
import { SshForwardTransport, type MachineTransport } from "./transport.ts";

export type { MachineClient } from "./client.ts";
export type { Machine } from "./machines.ts";
export { LOCAL_MACHINE, localMachine } from "./machines.ts";
export type { MachineTransport } from "./transport.ts";
export { SshForwardTransport } from "./transport.ts";
export * from "./read.ts";

export interface Fleet {
  clients: MachineClient[];
  /** Release the transport's SSH forwards. Always call it — a `fleet` command that skips this leaves
   *  `ssh -N` children behind for as long as the process lives. */
  close(): void;
}

/** The fleet as the CLI and the TUI see it. `transport` is injectable for tests; production gets
 *  the SSH-forward one. */
export async function buildFleet(opts: ListMachinesOpts & { transport?: MachineTransport } = {}): Promise<Fleet> {
  const transport = opts.transport ?? new SshForwardTransport();
  const machines = await listMachines(opts);
  return { clients: machines.map((m) => httpMachineClient(m, transport)), close: () => transport.close() };
}
