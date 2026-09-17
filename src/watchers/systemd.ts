// Linux counterpart to launchd.ts: a systemd --user oneshot service + timer that runs `ensure-up`
// on a 60s cadence — the same stateless-supervisor model as the macOS launchd job. Uses the baked
// node-path (vendored `runtime/current/bin/node`) so a Node bump propagates without rewriting the
// unit. `loginctl enable-linger` is set best-effort so the timer runs without an active session.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "../clients/exec.ts";
import { resolvedNodePath, serverLogsDir } from "../config.ts";

const PKG_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLI_ENTRY = join(PKG_ROOT, "src", "cli", "index.ts");
const UNIT = "herdr-factory"; // → herdr-factory.service + herdr-factory.timer

// Mirrors launchd.ts PASSTHROUGH_ENV — telemetry + auto-update/channel toggles the daemon must inherit.
const PASSTHROUGH_ENV = [
  "HERDR_CHANNEL",
  "HERDR_FACTORY_AUTO_UPDATE",
  "HERDR_FACTORY_TELEMETRY",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_SERVICE_NAME",
  "OTEL_RESOURCE_ATTRIBUTES",
  "OTEL_METRIC_EXPORT_INTERVAL",
  "OTEL_SDK_DISABLED",
] as const;

export function label(): string {
  return `${UNIT}.timer`;
}
function unitDir(): string {
  return join(homedir(), ".config", "systemd", "user");
}
function serviceFile(): string {
  return join(unitDir(), `${UNIT}.service`);
}
function timerFile(): string {
  return join(unitDir(), `${UNIT}.timer`);
}

async function systemctl(args: string[], allowFail = false): Promise<void> {
  await run("systemctl", ["--user", ...args], { allowFail });
}

/** A quoted+escaped `Environment="KEY=value"` line. systemd's Environment= splits unquoted values
 *  on whitespace (so `OTEL_SERVICE_NAME=My Service` would truncate to `My`), and `%` is a specifier
 *  — so quote the assignment and escape backslash, quote, newline and `%`. */
function envAssign(key: string, value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, " ")
    .replace(/%/g, "%%");
  return `Environment="${key}=${escaped}"`;
}

function envLines(): string {
  const lines: string[] = [];
  for (const key of PASSTHROUGH_ENV) {
    const value = process.env[key]?.trim();
    if (value) lines.push(envAssign(key, value));
  }
  return lines.join("\n");
}

/** KillMode=process: ensure-up spawns a detached `serve` that is still in this oneshot's cgroup, so
 *  the default KillMode=control-group kills it the moment ensure-up exits (issue #8). */
export function serviceUnit(): string {
  const node = resolvedNodePath(process.execPath);
  const env = envLines();
  return `[Unit]
Description=herdr-factory supervisor (ensure-up)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
KillMode=process
WorkingDirectory=${PKG_ROOT}
${envAssign("PATH", process.env.PATH ?? "")}
${envAssign("HOME", homedir())}
${env ? `${env}\n` : ""}ExecStart=${node} ${CLI_ENTRY} ensure-up
`;
}

// Stateless supervisor: a oneshot 'ensure-up' re-run every 60s (immune to resident-process wedging,
// same rationale as the launchd StartInterval).
function timerUnit(): string {
  return `[Unit]
Description=herdr-factory supervisor timer

[Timer]
OnBootSec=30
OnUnitActiveSec=60
AccuracySec=15
Persistent=true

[Install]
WantedBy=timers.target
`;
}

/** The PATH baked into the installed .service unit — the environment the supervisor and resident
 *  `serve` resolve tools in. Undefined if the unit is absent (service not installed) or unreadable.
 *  Mirrors launchd.servicePath(); see that comment for why the doctor uses it. */
export function servicePath(): string | undefined {
  const file = serviceFile();
  if (!existsSync(file)) return undefined;
  try {
    // envAssign writes `Environment="PATH=<escaped>"`; reverse the \, " and %% escaping. (Newlines
    // became spaces at write time and can't be recovered — PATH never contains them anyway.)
    const value = readFileSync(file, "utf8").match(/^Environment="PATH=(.*)"$/m)?.[1];
    return value === undefined ? undefined : value.replace(/%%/g, "%").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  } catch {
    return undefined;
  }
}

export async function install(): Promise<void> {
  mkdirSync(serverLogsDir(), { recursive: true });
  mkdirSync(unitDir(), { recursive: true });
  writeFileSync(serviceFile(), serviceUnit());
  writeFileSync(timerFile(), timerUnit());
  // Let the timer fire without an active login session (a headless daemon box).
  await run("loginctl", ["enable-linger", userInfo().username], { allowFail: true });
  await systemctl(["daemon-reload"]);
  await systemctl(["enable", "--now", `${UNIT}.timer`]);
}
export async function uninstall(): Promise<void> {
  await systemctl(["disable", "--now", `${UNIT}.timer`], true);
  await systemctl(["stop", `${UNIT}.service`], true);
  for (const f of [serviceFile(), timerFile()]) {
    if (existsSync(f)) rmSync(f);
  }
  await systemctl(["daemon-reload"], true);
}
export async function start(): Promise<void> {
  if (!existsSync(timerFile())) {
    await install();
    return;
  }
  await systemctl(["restart", `${UNIT}.timer`]);
}
export async function stop(): Promise<void> {
  await systemctl(["stop", `${UNIT}.timer`], true);
}
export async function isLoaded(): Promise<boolean> {
  const r = await run("systemctl", ["--user", "is-enabled", `${UNIT}.timer`], { allowFail: true });
  return r.stdout.trim() === "enabled";
}
