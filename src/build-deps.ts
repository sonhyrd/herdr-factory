import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, type Config } from "./config.ts";
import { openDb } from "./db/index.ts";
import { Store } from "./db/store.ts";
import { availableMemoryMb, loadMachineConfig } from "./machine.ts";
import { systemClock } from "./types.ts";
import type { BeltMatch } from "./types.ts";
import { HerdrClient } from "./clients/herdr.ts";
import { descriptorFor } from "./sources/registry.ts";
import { GitHubClient } from "./clients/github.ts";
import { GitClient, parseGhRepo } from "./clients/git.ts";
import type { BeltRuntime, Deps, Logger, SourceRuntime } from "./core/deps.ts";
import { instrumentObject, telemetrySpan } from "./telemetry/index.ts";

/** Load a belt's `match` predicate from its resolved `.ts` module (default export). Node strips
 *  types on import, so the module runs as-is with no build step. Throws if the default export
 *  isn't a function — a misconfigured predicate should fail loudly at startup, not silently match
 *  nothing. Returns undefined when the belt has no match file (⇒ it accepts anything). */
async function loadMatch(matchFile: string | undefined): Promise<BeltMatch | undefined> {
  if (!matchFile) return undefined;
  const mod = (await import(pathToFileURL(matchFile).href)) as { default?: unknown };
  if (typeof mod.default !== "function") {
    throw new Error(`belt match file ${matchFile} must \`export default\` a function (got ${typeof mod.default})`);
  }
  return mod.default as BeltMatch;
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function makeLogger(config: Config): Logger {
  mkdirSync(config.paths.logsDir, { recursive: true });
  return (level, msg) => {
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${msg}\n`;
    process.stderr.write(line);
    try {
      appendFileSync(join(config.paths.logsDir, `${today()}.log`), line);
    } catch {
      /* logging to file is best-effort */
    }
  };
}

/** Construct the injected `Deps` for one repo: open the (shared) DB, build a live client per
 *  configured work source, wire the herdr/gh/git clients. Used by every CLI command's local
 *  fallback path AND by the resident server (once per repo it serves). */
export async function buildDeps(repoName: string): Promise<Deps> {
  return telemetrySpan("deps.build", { repo: repoName }, async () => {
    const { config, env } = loadConfig(repoName);
    mkdirSync(config.paths.stateDir, { recursive: true });
    const store = new Store(openDb(config.paths.dbPath), systemClock);
    const log = makeLogger(config);
    const git = instrumentObject(new GitClient(), "git");
    const ghRepo = config.repo.github ?? parseGhRepo(await git.originUrl(config.repo.path)) ?? "";
    // Build a live client per work source via its registry descriptor (backends only — the
    // pipeline lives on belts). A descriptor's create() may throw on an unbuildable config —
    // startup fails loudly rather than at claim time.
    const sources: SourceRuntime[] = config.sources.map((s) => {
      const sourceAttrs = { repo: repoName, "work.source": s.name, "source.type": s.type };
      const client = descriptorFor(s.type).create({ repoName, sourceName: s.name, cfg: s.cfg, env, store, ghRepo, log });
      return {
        name: s.name,
        type: s.type,
        client: instrumentObject(client, "source", sourceAttrs),
        pollIntervalSeconds: s.pollIntervalSeconds,
        maxActiveWorkspaces: s.maxActiveWorkspaces,
        claimGuard: s.claimGuard,
        lastPolledAt: new Map<string, number>(),
      };
    });
    const sourceByName = new Map(sources.map((s) => [s.name, s]));
    // config.belts is already priority-ordered; load each belt's match predicate (if any).
    const belts: BeltRuntime[] = await Promise.all(
      config.belts.map(async (b) => ({ ...b, match: await loadMatch(b.matchFile) })),
    );
    const beltByName = new Map(belts.map((b) => [b.name, b]));
    return {
      config,
      env,
      store,
      ghRepo,
      herdr: instrumentObject(new HerdrClient(process.env.HERDR_BIN_PATH ?? "herdr"), "herdr", { repo: repoName }),
      sources,
      resolveSource: (name) => (name == null ? undefined : sourceByName.get(name)),
      belts,
      resolveBelt: (name) => (name == null ? undefined : beltByName.get(name)),
      github: instrumentObject(new GitHubClient(), "github", { repo: repoName }),
      git,
      log,
      now: systemClock,
      uid: () => randomBytes(3).toString("hex"), // 6 hex chars — unique per claim, ample for branch suffixes
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      rmrf: (p) => rm(p, { recursive: true, force: true }),
      machine: loadMachineConfig(),
      availableMemoryMb,
    };
  });
}
