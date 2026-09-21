import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolvedNodePath, serverInfoPath } from "../config.ts";
import { pingHealth, readHealth, readServerInfo } from "../server/client.ts";
import { VERSION } from "../version.ts";
import { autoUpdateEnabled, selfUpdate } from "./updater.ts";
import { syncMainCheckouts } from "./checkouts.ts";
import { telemetrySpan } from "../telemetry/index.ts";

const CLI_ENTRY = fileURLToPath(new URL("../cli/index.ts", import.meta.url));
const SERVE_ENV_KEYS = [
  "HERDR_CHANNEL",
  "HERDR_FACTORY_AUTO_UPDATE",
  "HERDR_FACTORY_CONFIG_DIR",
  "HERDR_FACTORY_PORT",
  "HERDR_FACTORY_STATE_ROOT",
  "HERDR_FACTORY_TELEMETRY",
  "HERDR_BIN_PATH",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_METRIC_EXPORT_INTERVAL",
  "OTEL_RESOURCE_ATTRIBUTES",
  "OTEL_SDK_DISABLED",
  "OTEL_SERVICE_NAME",
] as const;

export type Log = (level: "info" | "warn" | "error", msg: string) => void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false; // ESRCH (gone) or EPERM (not ours) — either way, not a process we manage
  }
};
const signal = (pid: number, sig: NodeJS.Signals) => {
  try {
    process.kill(pid, sig);
  } catch {
    /* already gone */
  }
};

/** Spawn a fully-detached `serve` that outlives this (one-shot) supervisor process. Uses the baked
 *  node-path (the vendored `runtime/current/bin/node` in a managed install) rather than this
 *  process's execPath, so a `.node-version` bump that provisioning just applied takes effect on the
 *  very next spawn — falling back to our own execPath in a plain dev checkout. */
function spawnServe(): void {
  const env: NodeJS.ProcessEnv = { HOME: process.env.HOME, PATH: process.env.PATH };
  for (const key of SERVE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  const node = resolvedNodePath(process.execPath);
  const child = spawn(node, [CLI_ENTRY, "serve"], { detached: true, env, stdio: "ignore" });
  child.unref();
}

/** Gracefully ask a reachable server to shut down, then make sure its process is gone (so the
 *  port is free for a restart). Clears server.json. Best-effort throughout. */
async function killServer(pid: number, port: number): Promise<void> {
  if (await pingHealth(port)) {
    try {
      await fetch(`http://127.0.0.1:${port}/shutdown`, { method: "POST", signal: AbortSignal.timeout(3000) });
    } catch {
      /* fall through to signals */
    }
  }
  // SIGTERM triggers the same graceful shutdown as /shutdown (its shuttingDown guard makes the
  // two idempotent), so send it regardless of whether the POST landed.
  signal(pid, "SIGTERM");
  // serve's drain lets in-flight ticks finish for up to 15s (+ a 250ms response defer + telemetry
  // flush). SIGKILL only after that window has clearly closed: hard-killing a mid-tick pass leaves
  // its heartbeat-extended tick/run locks to TTL-expire (~5min of skipped runs on the new server).
  // The common case (no tick in flight) exits the loop in one beat.
  for (let waited = 0; waited < 18_000 && alive(pid); waited += 200) await sleep(200);
  if (alive(pid)) signal(pid, "SIGKILL");
  try {
    rmSync(serverInfoPath());
  } catch {
    /* already removed by graceful shutdown */
  }
}

/**
 * The stateless supervisor tick. Ensure a healthy, current `serve` is running:
 *  - healthy + same version → no-op (the common case);
 *  - missing / unhealthy / wedged / outdated → (re)start it.
 * Being a one-shot, this is itself immune to the resident-process wedging that motivated the
 * redesign — launchd just re-runs it on a schedule.
 */
export async function ensureUp(
  opts: { force?: boolean; skipAutoUpdate?: boolean },
  log: Log,
): Promise<{ action: "noop" | "started" | "restarted" }> {
  return telemetrySpan("supervisor.ensure_up", { "supervisor.force": opts.force === true }, () => ensureUpImpl(opts, log));
}

async function ensureUpImpl(
  opts: { force?: boolean; skipAutoUpdate?: boolean },
  log: Log,
): Promise<{ action: "noop" | "started" | "restarted" }> {
  let force = opts.force ?? false;

  // Auto-update (on by default; HERDR_FACTORY_AUTO_UPDATE=0 disables). A successful update changes
  // the code on disk, so force a restart: VERSION is read at process start, so THIS process's
  // VERSION is now stale — the freshly spawned serve recomputes it from the new git sha.
  if (!opts.skipAutoUpdate && autoUpdateEnabled()) {
    try {
      const res = await selfUpdate(log);
      if (res.updated) force = true;
    } catch (e) {
      log("warn", `self-update errored — ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Keep each configured repo's MAIN checkout current with its base branch (throttled to once per
  // 10min per repo, inside). Independent of the server's health — a failure here never blocks the
  // restart decision below.
  try {
    await syncMainCheckouts(log);
  } catch (e) {
    log("warn", `checkout-sync errored — ${e instanceof Error ? e.message : String(e)}`);
  }

  const info = readServerInfo();

  if (info && !force) {
    // Read the full health payload, not just liveness: a wedged tick loop (hung subprocess mid-
    // reconcile) keeps answering /health while no repo makes progress. Each repo's tickStale flag
    // is the watchdog for that — restart on it exactly like on an unresponsive server.
    const health = await readHealth(info.port);
    const staleRepos = health ? health.repos.filter((r) => r.tickStale).map((r) => r.name) : [];
    if (health && info.version === VERSION && staleRepos.length === 0) {
      log("info", `server healthy on :${info.port} (v${info.version})`);
      return { action: "noop" };
    }
    log(
      "info",
      !health
        ? "server not responding — restarting"
        : info.version !== VERSION
          ? `server v${info.version} != v${VERSION} — restarting`
          : `tick loop stale for ${staleRepos.join(", ")} — restarting wedged server`,
    );
  }

  if (info) {
    await killServer(info.pid, info.port);
    spawnServe();
    log("info", "restarted serve");
    return { action: "restarted" };
  }

  spawnServe();
  log("info", "started serve");
  return { action: "started" };
}

/** Stop the running server (for `uninstall`/`stop`). No-op if none is running. */
export async function stopServer(log: Log): Promise<void> {
  return telemetrySpan("supervisor.stop_server", {}, async () => {
    const info = readServerInfo();
    if (!info) {
      log("info", "no server running");
      return;
    }
    await killServer(info.pid, info.port);
    log("info", "server stopped");
  });
}
