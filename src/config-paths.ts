import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function configDir(): string {
  return process.env.HERDR_FACTORY_CONFIG_DIR?.trim() || join(homedir(), ".config", "herdr-factory");
}

export function stateRoot(): string {
  // Resolve relative overrides because runtime symlinks store their targets verbatim.
  return resolve(process.env.HERDR_FACTORY_STATE_ROOT?.trim() || join(homedir(), ".local", "state", "herdr-factory"));
}

export function repoConfigDir(name: string): string {
  return join(configDir(), "repos", name);
}

export function listConfiguredRepos(): string[] {
  const dir = join(configDir(), "repos");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, "config.yml")))
    .map((entry) => entry.name)
    .sort();
}

/** Location advertised by the resident server for lightweight clients such as the TUI. */
export function serverInfoPath(): string {
  return join(stateRoot(), "server.json");
}

/** Last time each fleet machine answered a read, by machine name. An unreachable machine is
 *  reported as `unverifiable` *with this timestamp* rather than as having no runs, so the file has
 *  to outlive the `fleet` process that recorded it. Absent/corrupt = "never seen", which is the
 *  honest answer for a machine that has never answered. */
export function fleetLastSeenPath(): string {
  return join(stateRoot(), "fleet-last-seen.json");
}

/** Where the supervised auto-updater records its LAST attempt's outcome (channel, whether it
 *  updated / was skipped for a dirty checkout / failed, and the current-vs-target commit). Sits
 *  next to server.json so `doctor` and the TUI can surface a failed/behind update instead of it
 *  living only in the supervisor log. */
export function updateStatusPath(): string {
  return join(stateRoot(), "update-status.json");
}

/** Root the `local` evidence publisher copies captures into and the resident server serves at
 *  `/evidence/<key>/…`. Global (not per-repo): keys carry a globally-unique run id, so repos never
 *  collide, and one HTTP server serves every repo. Files persist past teardown — a merged PR links
 *  to them — so this dir grows; operators can prune old subtrees. */
export function evidenceServeDir(): string {
  return join(stateRoot(), "evidence");
}
