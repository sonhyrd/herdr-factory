// A WORLD is one hermetic universe for one scenario: its own HOME, herdr config + socket, factory
// config dir and state root, target checkout, bare origin, briefs folder, bin shims and artifact dir.
// Nothing outside `<root>/<id>` is touched, so a scenario can never see the operator's real install.
//
// The root is short on purpose (`/h/<id>` in the container): herdr's unix socket lives under the
// herdr config dir, and a long path overflows sun_path and kills the server at boot.
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify as yamlStringify } from "yaml";
import { Db } from "./db.ts";
import { Factory } from "./factory.ts";
import { HerdrServer, delay, tail } from "./herdr.ts";
import { FakeHerdr } from "./herdr-fake/state.ts";
import { ds4DataHome, ds4Preflight, resolveOpencode, writeOpencodeConfig } from "./ds4.ts";
import { GhFake, initialGhState } from "./gh-fake/state.ts";
import type { AgentScript, Driver, Lane, ScenarioSpec, Tier, WorldPaths } from "./types.ts";

type FleetMachineSpec = NonNullable<ScenarioSpec["fleetMachines"]>[string];

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HARNESS_DIR, "..", "..", "..");

const DEFAULT_GH_REPO = "acme/app";
let seq = 0;

function shortRoot(): string {
  const override = process.env.HF_E2E_ROOT?.trim();
  if (override) return override;
  // `/h` is created by the image; on a host run fall back to a still-short temp root.
  if (existsSync("/h")) return "/h";
  return "/tmp/hfe";
}

function artifactsRoot(): string {
  return process.env.HF_E2E_ARTIFACTS?.trim() || join(REPO_ROOT, "artifacts", "e2e", "local");
}

/** The REAL herdr binary, resolved to an absolute path. Load-bearing: the world's own `herdr`
 *  wrapper (first on PATH) execs this, so a bare "herdr" here would re-resolve to the wrapper and
 *  exec-loop forever. */
function resolveRealHerdr(): string {
  const explicit = process.env.HF_HERDR_REAL?.trim();
  if (explicit) return explicit;
  const r = spawnSync("bash", ["-lc", "command -v herdr"], { encoding: "utf8" });
  const found = (r.stdout ?? "").trim().split("\n").filter(Boolean).pop();
  if (!found) throw new Error("herdr is not on PATH — the real lane needs the herdr binary (set HF_HERDR_REAL)");
  return found;
}

function run(cmd: string, args: string[], cwd: string, env?: Record<string, string>): void {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env: env ?? process.env as Record<string, string> });
  if ((r.status ?? -1) !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed in ${cwd} (${r.status}): ${r.stderr || r.stdout}`);
  }
}

/** Deep-merge one level: the scenario's `repo`/`limits`/`agent` blocks override keys, not blocks. */
function mergeConfig(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    if (v && b && typeof v === "object" && typeof b === "object" && !Array.isArray(v) && !Array.isArray(b)) {
      out[k] = { ...(b as object), ...(v as object) };
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** What a scenario gets as `world.herdr`. The fake lane's control class mirrors `HerdrServer`'s public
 *  surface exactly (including `unreachable`), so both lanes are driven and asserted through one type —
 *  a scenario only needs `lane: "fake"` and the same calls keep working. */
export type HerdrHandle = HerdrServer | FakeHerdr;

export interface WaitOpts {
  /** Shown in the timeout message — always phrase it as the thing you expected to happen. */
  label?: string;
  timeoutMs?: number;
  pollMs?: number;
  /** Issue a tick every N ms while waiting (default: only when driver === "tick"). */
  tickEveryMs?: number;
}

export class World {
  readonly spec: ScenarioSpec;
  readonly id: string;
  readonly repoName: string;
  readonly lane: Lane;
  readonly tier: Tier;
  readonly driver: Driver;
  readonly paths: WorldPaths;
  readonly env: Record<string, string>;
  readonly herdr: HerdrHandle;
  readonly factory: Factory;
  readonly gh: GhFake;
  readonly db: Db;
  readonly ghRepo = DEFAULT_GH_REPO;
  /** Harness-owned files also exported into the child env as HF_* (typed, so they read back safely). */
  readonly files: {
    agentScript: string;
    agentLogDir: string;
    agentStateDir: string;
    ghState: string;
    ghLog: string;
    herdrLog: string;
    herdrDown: string;
    fleetEndpoints: string;
    herdrMachines: string;
  };
  /** The other MACHINES of the fleet: one extra `serve` each (see `ScenarioSpec.fleetMachines`). */
  private readonly fleet = new Map<string, { factory: Factory; paths: WorldPaths; spec: FleetMachineSpec }>();
  private started = false;

  constructor(spec: ScenarioSpec) {
    this.spec = spec;
    this.id = `w${(process.pid % 1000).toString(36)}${(seq++).toString(36)}`;
    this.repoName = spec.repoName ?? "app";
    this.lane = spec.lane ?? "real";
    // A scenario runs as the tier it declares — the env var is a SELECTION filter (see index.ts), not
    // an override. Forcing it here made `--tier ds4` demand a model server for all 28 scripted
    // scenarios and swap their agent shim out from under them.
    this.tier = spec.tier ?? "scripted";
    this.driver = spec.driver ?? "serve";

    const home = join(shortRoot(), this.id);
    this.paths = {
      home,
      repo: join(home, "repo"),
      origin: join(home, "origin.git"),
      briefs: join(home, "briefs"),
      configDir: join(home, ".config", "herdr-factory"),
      repoConfigDir: join(home, ".config", "herdr-factory", "repos", this.repoName),
      stateRoot: join(home, ".state", "herdr-factory"),
      bin: join(home, "bin"),
      art: join(artifactsRoot(), "scenarios", spec.name),
    };

    const port = 8800 + (seq % 100) + (process.pid % 500) * 2;
    // The fake lane must run with no herdr installed at all, so resolution is lane-gated: the shim IS
    // the binary, and HF_HERDR_REAL points at it too (the scripted agent resolves that first, and a
    // real herdr there would answer questions about panes this lane never created).
    const fakeBin = join(this.paths.bin, "herdr");
    const realHerdr = this.lane === "fake" ? fakeBin : resolveRealHerdr();
    this.files = {
      agentScript: join(home, "agent-script.json"),
      agentLogDir: join(this.paths.art, "agent"),
      agentStateDir: join(home, "agent-state"),
      ghState: join(home, "gh-state.json"),
      ghLog: join(this.paths.art, "gh-calls.jsonl"),
      herdrLog: join(this.paths.art, "herdr-calls.jsonl"),
      herdrDown: join(home, "herdr-down"),
      fleetEndpoints: join(home, "fleet-endpoints.json"),
      herdrMachines: join(home, "herdr-machines.json"),
    };
    this.env = {
      ...(process.env as Record<string, string>),
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      // Claude Code's config, which the engine EDITS before starting a claude agent (it pre-answers
      // the folder-trust prompt — src/core/claude-trust.ts). Pinned into the world explicitly: this
      // env spreads the developer's own environment, and an inherited CLAUDE_CONFIG_DIR would send
      // that write to their real config instead of the world's.
      CLAUDE_CONFIG_DIR: home,
      PATH: `${this.paths.bin}:${process.env.PATH ?? ""}`,
      TERM: "xterm-256color",
      // Explicit, because it decides two things: which shell herdr spawns in a pane, and which rc file
      // the world's PATH prepend has to live in. In a container SHELL is usually unset, which would
      // otherwise leave the checks below on /bin/sh (dash) while the panes ran something else.
      SHELL: process.env.SHELL || (existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh"),
      HERDR_FACTORY_CONFIG_DIR: this.paths.configDir,
      HERDR_FACTORY_STATE_ROOT: this.paths.stateRoot,
      HERDR_FACTORY_PORT: String(port),
      HERDR_FACTORY_AUTO_UPDATE: "0",
      HERDR_FACTORY_LAYOUT_STATE_DIR: join(this.paths.stateRoot, "layout-hook"),
      HERDR_BIN_PATH: join(this.paths.bin, "herdr"),
      // The fleet's transport seam: real SSH cannot exist in the container, so each fleet machine's
      // API is named directly. Harmless when no scenario declares any (an absent file = no override,
      // i.e. server.json for the local machine and a real forward for a remote one).
      HERDR_FACTORY_FLEET_ENDPOINTS: this.files.fleetEndpoints,
      HERDR_SOCKET_PATH: join(home, ".config", "herdr", "herdr.sock"),
      HF_HERDR_REAL: realHerdr,
      HF_HERDR_LOG: this.files.herdrLog,
      HF_HERDR_DOWN: this.files.herdrDown,
      HF_HERDR_MACHINES: this.files.herdrMachines,
      HF_AGENT_SCRIPT: this.files.agentScript,
      HF_AGENT_LOG_DIR: this.files.agentLogDir,
      HF_AGENT_STATE_DIR: this.files.agentStateDir,
      HF_GH_STATE: this.files.ghState,
      HF_GH_LOG: this.files.ghLog,
      HF_GH_REPO: this.ghRepo,
      HF_WORLD: this.id,
      GIT_AUTHOR_NAME: "Harness Agent",
      GIT_AUTHOR_EMAIL: "harness@example.test",
      GIT_COMMITTER_NAME: "Harness Agent",
      GIT_COMMITTER_EMAIL: "harness@example.test",
      ...(spec.processEnv ?? {}),
    };

    const herdrOpts = {
      bin: realHerdr,
      env: this.env,
      logPath: join(this.paths.art, "herdr-server.log"),
      callLog: this.files.herdrLog,
    };
    this.herdr = this.lane === "fake" ? new FakeHerdr(herdrOpts) : new HerdrServer({ ...herdrOpts, downFlag: this.files.herdrDown });
    this.factory = new Factory({
      repoRoot: REPO_ROOT,
      repo: this.repoName,
      env: this.env,
      logPath: join(this.paths.art, "factory-serve.log"),
      stateRoot: this.paths.stateRoot,
      port,
    });
    this.gh = new GhFake({ statePath: this.files.ghState, logPath: this.files.ghLog });
    this.db = new Db(this.paths.stateRoot, this.repoName);

    // Each extra machine is a whole second factory: its own config dir, state root and port, so
    // nothing it does can touch this machine's DB — which is the point, since the fleet's job is to
    // merge two independent servers' views. Ports sit 2000 above the main allocation, clear of every
    // other world's main port.
    let i = 0;
    for (const [name, spec] of Object.entries(this.spec.fleetMachines ?? {})) {
      const paths: WorldPaths = {
        ...this.paths,
        configDir: join(home, ".config", `hf-${name}`),
        repoConfigDir: join(home, ".config", `hf-${name}`, "repos", name),
        stateRoot: join(home, ".state", `hf-${name}`),
        briefs: join(home, `briefs-${name}`),
      };
      const machinePort = port + 2000 + i++;
      const factory = new Factory({
        repoRoot: REPO_ROOT,
        repo: name,
        env: {
          ...this.env,
          HERDR_FACTORY_CONFIG_DIR: paths.configDir,
          HERDR_FACTORY_STATE_ROOT: paths.stateRoot,
          HERDR_FACTORY_PORT: String(machinePort),
        },
        logPath: join(this.paths.art, `factory-serve-${name}.log`),
        stateRoot: paths.stateRoot,
        port: machinePort,
      });
      this.fleet.set(name, { factory, paths, spec });
    }
  }

  /** The saved SSH machines the factory's fleet discovery reads (`herdr machine list --json`).
   *
   *  Written as a FILE the world's herdr shim answers from, on both lanes, rather than saved into a
   *  herdr: on the real lane those profiles would be the operator's, and a scenario must not add to
   *  them. The SSH target is cosmetic — `HERDR_FACTORY_FLEET_ENDPOINTS` is what is actually dialled,
   *  since a container has no second host to forward to. */
  private writeMachineList(): void {
    const machines = [...this.fleet.keys()].map((label) => ({ label, target: `harness@${label}`, enabled: true }));
    writeFileSync(this.files.herdrMachines, JSON.stringify(machines));
  }

  /** Another machine's factory (`ScenarioSpec.fleetMachines`) — its CLI, its API, and `stop()` for
   *  the "one machine goes away" half of a fleet scenario. */
  machine(name: string): Factory {
    const entry = this.fleet.get(name);
    if (!entry) throw new Error(`no fleet machine "${name}" in scenario "${this.spec.name}"`);
    return entry.factory;
  }

  /** That machine's on-disk geography — its briefs folder is where work for it is dropped. */
  machinePaths(name: string): WorldPaths {
    const entry = this.fleet.get(name);
    if (!entry) throw new Error(`no fleet machine "${name}" in scenario "${this.spec.name}"`);
    return entry.paths;
  }

  // ── construction ──────────────────────────────────────────────────────────────────────────────

  private layout(): void {
    rmSync(this.paths.home, { recursive: true, force: true });
    rmSync(this.paths.art, { recursive: true, force: true });
    for (const d of [
      this.paths.home,
      this.paths.repo,
      this.paths.briefs,
      this.paths.repoConfigDir,
      this.paths.stateRoot,
      this.paths.bin,
      this.paths.art,
      this.files.agentLogDir,
      this.files.agentStateDir,
      join(this.paths.home, ".config", "herdr"),
      ...[...this.fleet.values()].flatMap(({ paths }) => [paths.repoConfigDir, paths.stateRoot, paths.briefs]),
    ]) {
      mkdirSync(d, { recursive: true });
    }
  }

  /** The synthetic target repo: a MAIN checkout (never a linked worktree), `origin/main` resolvable
   *  from a local bare repo, `.memory/` ignored, and a CLAUDE.md the shipped prompts defer to. */
  private buildTargetRepo(): void {
    const r = this.paths.repo;
    run("git", ["init", "-q", "--initial-branch=main", "."], r, this.env);
    run("git", ["config", "user.email", "harness@example.test"], r, this.env);
    run("git", ["config", "user.name", "Harness"], r, this.env);
    writeFileSync(join(r, "README.md"), `# ${this.ghRepo}\n\nSynthetic target repo for the herdr-factory e2e harness.\n`);
    writeFileSync(
      join(r, "CLAUDE.md"),
      [
        "# Guidelines",
        "",
        "- Tests: `true` (this repo has none; the command exits 0).",
        "- Lint: `true`. Type-check: `true`.",
        "- Commit style: `type(scope): summary`.",
        "",
      ].join("\n"),
    );
    writeFileSync(join(r, ".gitignore"), ".memory/\n");
    for (const [rel, body] of Object.entries(this.spec.repoFiles ?? {})) {
      const p = join(r, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, body);
      if (rel.endsWith(".sh")) chmodSync(p, 0o755);
    }
    run("git", ["add", "-A"], r, this.env);
    run("git", ["commit", "-q", "-m", "chore: initial commit"], r, this.env);
    run("git", ["init", "-q", "--bare", this.paths.origin], this.paths.home, this.env);
    run("git", ["remote", "add", "origin", this.paths.origin], r, this.env);
    run("git", ["push", "-q", "-u", "origin", "main"], r, this.env);
  }

  /** World bin dir, FIRST on PATH: the fake gh, the scripted agent under two herdr kind names, and a
   *  herdr wrapper that records every argv the engine issues (the only way to observe notifications
   *  and pane display metadata) before exec'ing the real binary. */
  private writeShims(): void {
    const b = this.paths.bin;
    const agentImpl = join(HARNESS_DIR, "agent", "agent.cjs");
    // herdr identifies a pane's agent by the foreground process's **argv[0]** (verified: a wrapper
    // that runs `exec node agent.cjs` is never detected and `agent start` times out after 60s, while
    // `exec -a claude node agent.cjs` is adopted in ~3s). So the scripted agent is exec'd UNDER the
    // kind's own name rather than copied to it — which also keeps the implementation editable in
    // place instead of duplicated into every world.
    for (const kind of ["claude", "opencode"]) {
      // The ds4 tier replaces ONE of them with the real model CLI: `opencode` becomes a wrapper that
      // records the argv herdr built (the interesting part — how a prompt reaches that kind is herdr's
      // manifest's business) and execs the real binary. `claude` stays scripted, so a ds4 scenario can
      // still put a deterministic agent on a step it isn't measuring.
      if (this.tier === "ds4" && kind === "opencode") {
        writeFileSync(
          join(b, kind),
          [
            "#!/usr/bin/env bash",
            "# ds4 tier: record what herdr launched, then run the real opencode.",
            `printf '%s\\n' "$*" >> "${join(this.files.agentLogDir, "opencode-argv.log")}" 2>/dev/null || true`,
            `exec -a ${kind} "${resolveOpencode()}" "$@"`,
            "",
          ].join("\n"),
        );
        chmodSync(join(b, kind), 0o755);
        continue;
      }
      writeFileSync(
        join(b, kind),
        ["#!/usr/bin/env bash", `export HF_AGENT_KIND=${kind}`, `exec -a ${kind} ${process.execPath} ${agentImpl} "$@"`, ""].join("\n"),
      );
      chmodSync(join(b, kind), 0o755);
    }
    // Panes run the user's shell as a LOGIN shell, and a login shell reorders PATH: macOS's
    // /etc/zprofile runs `path_helper`, which rebuilds PATH from /etc/paths[.d] and APPENDS whatever
    // it inherited — so the world bin lands behind /opt/homebrew/bin, where a REAL `claude` outranks
    // the scripted agent. (That is not hypothetical: it silently launched actual Claude Code into the
    // panes, which adopted as `claude`, reported `idle`, and never signalled.) These dotfiles run
    // AFTER the system profile and put the world bin back in front, for both zsh and bash.
    const prepend = [
      "# Harness world: a login shell's path_helper moves this bin behind the system dirs, where a",
      "# real agent CLI would outrank the scripted one. Re-prepend it, unconditionally and last.",
      `export PATH="${b}:$PATH"`,
      "",
    ].join("\n");
    for (const rc of [".zshenv", ".zprofile", ".zshrc", ".bash_profile", ".bashrc", ".profile"]) {
      writeFileSync(join(this.paths.home, rc), prepend);
    }

    // `node` too, and for the same reason: the engine's launcher (`bin/herdr-factory`) execs whatever
    // `node` PATH resolves to, and refuses to run below 26. Whose node that is must not depend on the
    // shell — in the real lane a pane's login shell found homebrew's 26 and worked, while a fake-lane
    // agent (a direct child, no login shell) found mise's 24 and every `step-done` died with a version
    // error the agent reported as "not a rejection, not retrying". One shim, one node, both lanes.
    writeFileSync(join(b, "node"), ["#!/usr/bin/env bash", `exec ${process.execPath} "$@"`, ""].join("\n"));
    chmodSync(join(b, "node"), 0o755);

    const ghSrc = join(HARNESS_DIR, "gh-fake", "gh");
    copyFileSync(ghSrc, join(b, "gh"));
    chmodSync(join(b, "gh"), 0o755);

    if (this.lane === "fake") {
      // The fake lane's shim IS herdr: it serves every argv in-process and logs `{ts,argv}` itself, so
      // wrapping it would double-log and there is no real binary to exec.
      FakeHerdr.install(b);
      return;
    }
    writeFileSync(
      join(b, "herdr"),
      [
        "#!/usr/bin/env bash",
        "# Harness wrapper: record the argv the factory issued, then run the real herdr.",
        'if [ -n "${HF_HERDR_LOG:-}" ]; then',
        // `date +%s%3N` is GNU-only: BSD date (macOS) prints a literal "N", which made every logged
        // line invalid JSON and silently emptied calls()/notifications(). Fall back to whole seconds.
        '  ms=$(date +%s%3N 2>/dev/null)',
        '  case "$ms" in *[!0-9]*|"") ms="$(date +%s)000";; esac',
        '  printf \'{"ts":%s,"argv":%s}\\n\' "$ms" "$(printf \'%s\\n\' "$@" | jq -R . | jq -s -c .)" >> "$HF_HERDR_LOG" 2>/dev/null || true',
        "fi",
        "# The fleet's machine list. A scenario's fleet machines are the harness's, never the",
        "# operator's: the real herdr is left alone and this wrapper answers the one query the",
        "# factory's discovery makes. Absent file = no saved machines, i.e. a fleet of one.",
        'if [ "${1:-}" = "machine" ] && [ "${2:-}" = "list" ] && [ -f "${HF_HERDR_MACHINES:-}" ]; then',
        '  cat "$HF_HERDR_MACHINES"',
        "  exit 0",
        "fi",
        "# Injected outage (HerdrServer.unreachable): refuse the way a herdr with no server does. The",
        "# call is logged FIRST, so what the engine attempted during the outage stays observable.",
        'if [ -n "${HF_HERDR_DOWN:-}" ] && [ -e "$HF_HERDR_DOWN" ]; then',
        '  echo "herdr: failed to connect to the herdr server (harness-injected outage)" >&2',
        "  exit 1",
        "fi",
        'exec "${HF_HERDR_REAL:-herdr}" "$@"',
        "",
      ].join("\n"),
    );
    chmodSync(join(b, "herdr"), 0o755);
  }

  private writeConfig(): void {
    const base: Record<string, unknown> = {
      repo: { path: this.paths.repo, base_ref: "origin/main", github: this.ghRepo },
      limits: {
        tick_interval_seconds: 1,
        step_budget_seconds: 120,
        stall_seconds: 120,
        layout_wait_seconds: 15,
        attention_renotify_seconds: 3600,
        max_active_workspaces: 3,
        max_claims_per_tick: 10,
        reconcile_concurrency: 4,
      },
      agent: { command: "claude", flags: [] },
    };
    const render = (over: Record<string, unknown>): string =>
      `# yaml-language-server: $schema=../../config.schema.json\n${yamlStringify(mergeConfig(base, over), { lineWidth: 0 })}`;
    writeFileSync(join(this.paths.repoConfigDir, "config.yml"), render(this.spec.config(this.paths)));

    // Each fleet machine gets the same treatment: its own config.yml (over the same defaults and the
    // same target checkout) and its own briefs. The endpoints file is what makes `fleet` reach them.
    for (const [name, { paths, spec }] of this.fleet) {
      writeFileSync(join(paths.repoConfigDir, "config.yml"), render((spec.config ?? this.spec.config)(paths)));
      for (const [key, body] of Object.entries(spec.briefs ?? {})) writeFileSync(join(paths.briefs, `${key}.md`), body);
    }
    writeFileSync(
      this.files.fleetEndpoints,
      JSON.stringify(Object.fromEntries([...this.fleet].map(([name, { factory }]) => [name, `http://127.0.0.1:${factory.port}`])), null, 2),
    );

    if (this.spec.env) {
      const body = Object.entries(this.spec.env)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n");
      const p = join(this.paths.repoConfigDir, "env");
      writeFileSync(p, `${body}\n`);
      chmodSync(p, 0o600);
    }
    for (const [rel, body] of Object.entries(this.spec.configFiles ?? {})) {
      const p = join(this.paths.repoConfigDir, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, body);
    }
    for (const [key, body] of Object.entries(this.spec.briefs ?? {})) {
      writeFileSync(join(this.paths.briefs, `${key}.md`), body);
    }
    this.setAgentScript(this.spec.agent ?? {});
    writeFileSync(this.files.ghState, JSON.stringify(initialGhState({ repo: this.ghRepo }), null, 2));
    writeFileSync(
      join(this.paths.art, "world.json"),
      JSON.stringify({ id: this.id, lane: this.lane, tier: this.tier, driver: this.driver, paths: this.paths, port: this.factory.port }, null, 2),
    );
  }

  /** Swap the agent's behaviour mid-scenario (it re-reads the script every turn). */
  setAgentScript(script: AgentScript): void {
    writeFileSync(this.files.agentScript, JSON.stringify(script, null, 2));
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.layout();
    if (this.tier === "ds4") {
      // Before anything expensive: a model server that isn't answering must say so here, not as a step
      // that never signalled twenty minutes in.
      const pre = ds4Preflight();
      writeOpencodeConfig(this.paths.home);
      // Set on the world env AFTER construction, since it is tier-specific: opencode's provider package
      // lives here, and a fresh dir means installing it before the first turn.
      this.env.XDG_DATA_HOME = ds4DataHome(this.paths.home);
      writeFileSync(join(this.paths.art, "ds4.json"), JSON.stringify({ ...pre, startedAt: new Date().toISOString() }, null, 2));
    }
    this.buildTargetRepo();
    this.writeShims();
    // Before the config is rendered: a scenario's stub backend must be listening for its URL to exist.
    await this.spec.beforeStart?.(this.paths);
    this.writeConfig();

    if (this.lane === "fake") {
      // No server and no plugin host: `start()` only prepares the state the shim serves. A fake-lane
      // scenario therefore never gets a layout (`worktree.created` has nothing to fire it), which is
      // why layout coverage is real-lane only.
      if (this.spec.config && JSON.stringify(this.spec.config(this.paths)).includes('"layouts"')) {
        throw new Error(`scenario "${this.spec.name}" declares layouts on the fake lane — no plugin host exists there, so no layout would ever be built`);
      }
      await this.herdr.start();
      // After start(), which blanks the shim's state: these are the saved SSH machines the factory's
      // fleet discovery reads. The target is cosmetic — the endpoints file is what is actually dialled.
      if (this.fleet.size) {
        (this.herdr as FakeHerdr).setMachines([...this.fleet.keys()].map((label) => ({ label, target: `harness@${label}`, enabled: true })));
      }
      this.writeMachineList();
    } else {
      // Link before boot so the one-shot [[startup]] hook is registered too; if linking needs the
      // socket, retry once the server is up (a fresh world has no stale claims for the startup hook
      // to reap, so post-boot linking is equivalent for our purposes).
      const linkedEarly = this.herdr.linkPlugin(REPO_ROOT);
      await this.herdr.start();
      this.writeMachineList();
      if (!linkedEarly && !this.herdr.linkPlugin(REPO_ROOT)) {
        throw new Error(`herdr plugin link failed:\n${this.herdr.cli(["plugin", "link", REPO_ROOT]).stderr}`);
      }
    }
    if (this.driver === "serve") {
      await this.factory.serve();
      for (const { factory } of this.fleet.values()) await factory.serve();
    }
    this.assertShimsWin();
    this.started = true;
  }

  /** A pane's agent must be OUR shim. herdr maps `--kind claude` to the command `claude` and resolves
   *  it in the pane's shell, so this is decided entirely by PATH inside a login shell — and when a real
   *  agent CLI wins, every symptom is a lie: herdr adopts it, reports `idle`, and the scenario dies 120s
   *  later on a step that "never signalled". Fail here instead, with the resolution that beat us. */
  private assertShimsWin(): void {
    for (const kind of ["claude", "opencode", "gh", "herdr", "node"]) {
      const r = spawnSync(this.env.SHELL || "/bin/sh", ["-lic", `command -v ${kind}`], { env: this.env, encoding: "utf8", timeout: 20_000 });
      const resolved = (r.stdout ?? "").trim().split("\n").filter(Boolean).pop() ?? "";
      if (resolved !== join(this.paths.bin, kind)) {
        throw new Error(
          `world shim for "${kind}" is not what a pane would run: a login shell resolves it to ` +
            `${resolved || "(nothing)"} instead of ${join(this.paths.bin, kind)}. ` +
            `The world dotfiles are meant to re-prepend ${this.paths.bin} after the system profile — check them and $SHELL (${this.env.SHELL}).`,
        );
      }
    }
    // And the agent's own escape hatch has to work: every signal is `bin/herdr-factory …` run from a
    // pane, so if the launcher cannot start there, no step ever completes — 90 seconds later, as an
    // "awaiting step-done" timeout that says nothing about why.
    const cli = spawnSync(this.env.SHELL || "/bin/sh", ["-lic", `"${join(REPO_ROOT, "bin", "herdr-factory")}" --version`], {
      env: this.env,
      encoding: "utf8",
      timeout: 60_000,
    });
    if ((cli.status ?? -1) !== 0) {
      throw new Error(`the factory CLI does not run in a pane's shell — every step-done would fail:\n${(cli.stderr || cli.stdout || "").trim()}`);
    }
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    // Pane scrollback dies with the server, and it is the ONLY place an agent that failed to start
    // says why (node's own startup errors go to the PTY, not to any log the harness owns). Capture it
    // while the panes are still alive — this is diagnosis, so never let it fail a scenario.
    try {
      mkdirSync(this.paths.art, { recursive: true });
      writeFileSync(join(this.paths.art, "panes.txt"), this.herdr.allScreens(400));
    } catch (e) {
      try {
        writeFileSync(join(this.paths.art, "panes.txt"), `(pane capture failed: ${String(e)})`);
      } catch {
        /* the artifact dir may be gone; nothing more to do */
      }
    }
    try {
      for (const { factory } of this.fleet.values()) await factory.stop();
      await this.factory.stop();
    } finally {
      await this.herdr.stop();
      this.db.close();
      await this.spec.afterStop?.();
    }
    this.started = false;
  }

  /** Copy everything a post-mortem needs into the artifact dir; called on pass AND fail. */
  collect(): void {
    try {
      mkdirSync(this.paths.art, { recursive: true });
      if (this.db.exists()) copyFileSync(this.db.path, join(this.paths.art, "herdr-factory.db"));
      const cfg = join(this.paths.repoConfigDir, "config.yml");
      if (existsSync(cfg)) copyFileSync(cfg, join(this.paths.art, "config.yml"));
      const repoLogs = join(this.paths.stateRoot, this.repoName, "logs");
      if (existsSync(repoLogs)) cpSync(repoLogs, join(this.paths.art, "repo-logs"), { recursive: true });
      const inbox = join(this.paths.briefs, ".herdr-factory-human");
      if (existsSync(inbox)) cpSync(inbox, join(this.paths.art, "human-inbox"), { recursive: true });
      // herdr logs to files in its own config dir, not to the stdout we pipe — and those logs are
      // where a failed adoption / layout apply actually explains itself.
      for (const name of ["herdr-server.log", "herdr-client.log", "herdr.log"]) {
        const p = join(this.paths.home, ".config", "herdr", name);
        if (existsSync(p)) copyFileSync(p, join(this.paths.art, `herdr-${name}`));
      }
      // herdr's own plugin command logs — the only place a layout hook that DECLINED to build says
      // why (the engine log only ever sees a hook that got as far as applying).
      const pluginLogs = join(this.paths.home, ".config", "herdr", "plugins");
      if (existsSync(pluginLogs)) cpSync(pluginLogs, join(this.paths.art, "herdr-plugins"), { recursive: true });
      writeFileSync(join(this.paths.art, "state-dump.txt"), this.db.dump());
      writeFileSync(join(this.paths.art, "plugin-log.txt"), this.herdr.pluginLog());
    } catch (e) {
      writeFileSync(join(this.paths.art, "collect-error.txt"), String(e));
    }
    if (process.env.HF_E2E_KEEP !== "1") rmSync(this.paths.home, { recursive: true, force: true });
  }

  // ── driving + waiting ─────────────────────────────────────────────────────────────────────────

  tick(): Promise<void> {
    return this.factory.tick();
  }

  /** Poll until `pred` is true. Under `driver: "serve"` the server ticks itself (interval 1s), so
   *  this is a pure poll; under `driver: "tick"` it issues the passes. Every failure prints the run
   *  state, the last events, the engine's own log and the agent transcript — the harness lives or
   *  dies on this message. */
  async waitFor(pred: () => boolean | Promise<boolean>, opts: WaitOpts = {}): Promise<void> {
    const label = opts.label ?? "condition";
    const timeoutMs = opts.timeoutMs ?? 90_000;
    const pollMs = opts.pollMs ?? 250;
    const tickEvery = opts.tickEveryMs ?? (this.driver === "tick" ? 500 : 0);
    const deadline = Date.now() + timeoutMs;
    let lastTick = 0;
    for (;;) {
      if (await pred()) return;
      if (Date.now() >= deadline) throw new Error(this.diagnose(`timed out after ${timeoutMs}ms waiting for: ${label}`));
      if (tickEvery && Date.now() - lastTick > tickEvery) {
        lastTick = Date.now();
        await this.tick().catch(() => undefined);
      }
      await delay(pollMs);
    }
  }

  /** Wait for a run to reach a phase (optionally with an outcome). */
  waitForPhase(key: string, phase: string, opts: WaitOpts = {}): Promise<void> {
    return this.waitFor(() => this.db.run(key)?.phase === phase, { label: `run ${key} phase=${phase}`, ...opts });
  }

  waitForEvent(key: string, type: string, opts: WaitOpts = {}): Promise<void> {
    return this.waitFor(() => this.db.eventTypes(key).includes(type), { label: `run ${key} event ${type}`, ...opts });
  }

  waitForEnd(key: string, outcome?: string, opts: WaitOpts = {}): Promise<void> {
    return this.waitFor(
      () => {
        const r = this.db.run(key);
        return !!r?.ended_at && (outcome === undefined || r.outcome === outcome);
      },
      { label: `run ${key} ended${outcome ? ` with outcome=${outcome}` : ""}`, ...opts },
    );
  }

  diagnose(headline: string): string {
    const parts = [
      `${headline}`,
      "",
      `— world ${this.id} (lane=${this.lane} tier=${this.tier} driver=${this.driver}) port=${this.factory.port}`,
      "",
      "— DB state —",
      this.db.dump(),
      "",
      "— engine log (tail) —",
      this.factory.repoLog(40),
      "",
      "— serve log (tail) —",
      this.factory.serveLog(20),
      ...[...this.fleet].flatMap(([name, { factory }]) => ["", `— machine ${name}: serve log (tail) —`, factory.serveLog(20)]),
      "",
      "— agent transcript (tail) —",
      tail(join(this.files.agentLogDir, "agent.log"), 40),
      "",
      "— herdr agents —",
      JSON.stringify(this.herdr.agents(), null, 1),
      "",
      "— pane screens —",
      this.herdr
        .workspaces()
        .filter((ws) => (ws.worktree?.checkout_path ?? "") !== this.paths.repo)
        .map((ws) => this.herdr.screens(ws.workspace_id))
        .join("\n"),
    ];
    return parts.join("\n");
  }

  /** Record numbers the run should REPORT rather than only assert on: they land beside the scenario's
   *  other artifacts as metrics.json, so a trend (drain time, tick p95, RSS growth) is reviewable even
   *  when every assertion passed. */
  recordMetrics(metrics: Record<string, number | string>): void {
    writeFileSync(join(this.paths.art, "metrics.json"), JSON.stringify(metrics, null, 2));
  }

  /** A point-in-time sample of what the resident server is holding: RSS, open file descriptors, the
   *  DB file, and how many worktrees exist. Linux-only (/proc), which is where the suite runs. */
  sample(): { rssKb: number; fds: number; dbBytes: number; worktrees: number } {
    const pid = this.factory.pid;
    let rssKb = 0;
    let fds = 0;
    if (pid) {
      // procfs in the container; `ps`/`lsof` on a dev mac. Measuring BOTH matters more than it looks:
      // with a procfs-only reader every sample on macOS is 0, and "FDs never grew" then passes without
      // ever having looked — a leak assertion that cannot fail is worse than no assertion.
      if (existsSync(`/proc/${pid}/status`)) {
        rssKb = Number(/VmRSS:\s+(\d+)/.exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0);
        try {
          fds = readdirSync(`/proc/${pid}/fd`).length;
        } catch {
          fds = 0;
        }
      } else {
        const ps = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
        rssKb = Number((ps.stdout ?? "").trim()) || 0;
        const lsof = spawnSync("lsof", ["-p", String(pid)], { encoding: "utf8" });
        fds = (lsof.stdout ?? "").split("\n").filter(Boolean).length - 1; // minus the header
      }
    }
    let dbBytes = 0;
    try {
      dbBytes = statSync(this.db.path).size;
    } catch {
      dbBytes = 0;
    }
    const worktrees = this.git(["worktree", "list"]).split("\n").filter(Boolean).length;
    return { rssKb, fds: Math.max(0, fds), dbBytes, worktrees };
  }


  /** The scripted agent's transcript: every turn, every command it ran, and every rejection it saw. */
  agentLog(lines = 500): string {
    return tail(join(this.files.agentLogDir, "agent.log"), lines);
  }

  /** The rendered prompt a step was actually handed (asserting on prompts is a first-class use). */
  renderedPrompt(step: string, pass = 1): string | null {
    const p = join(this.files.agentLogDir, `prompt-${step}-pass${pass}.md`);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  }

  /** The local_markdown human inbox: `<briefs>/.herdr-factory-human/<key>-q<id>.md` + `-notes.md`. */
  humanInbox(file: string): string | null {
    const p = join(this.paths.briefs, ".herdr-factory-human", file);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  }

  /** Resume a parked run until the resume actually NUDGES its agent.
   *
   *  `resume` deliberately never interrupts a `working` pane (it could be mid-answer to another
   *  agent, or human-driven), and a park hands its pane a turn of its own — the operator report. So
   *  a resume can land while that turn runs, or while the engine's ~5s-memoized agent list still
   *  says it does: the phase flips, `resumed {nudged:false}` is recorded, nobody is prompted, and a
   *  step whose clock the resume just re-based expires again. A real operator simply resumes again;
   *  so does this, until the timeline proves one landed. Also pins resume as idempotent. */
  async resumeUntilNudged(key: string, opts: WaitOpts = {}): Promise<void> {
    await this.waitFor(
      () => {
        if (this.db.event(key, "resumed")?.data.nudged === true) return true;
        const r = this.resume(key);
        if (r.code !== 0) throw new Error(`resume ${key} failed (exit ${r.code}): ${r.stderr}`);
        return false;
      },
      { label: `a resume that nudges ${key}'s agent`, pollMs: 3000, ...opts },
    );
  }

  /** Wait for the operator-facing report a park submits INTO the run's pane.
   *
   *  Where a park's explanation lands is decided by what broke and by the source's reply channel
   *  (`escalateAttention`): a MECHANICAL failure (budget, stall, a suspended job) always reports to
   *  the pane, and so does a WORK error on a source whose channel is a file (`local_markdown`) —
   *  only a comments source (jira/github_issues/sentry) gets a note on the item itself
   *  ({@link World.waitForNote}). Every report carries the run's key in its `resume <key>` tail, so
   *  `key` is enough to attribute one. Like the note, it is written just AFTER the phase flips. */
  async waitForPaneReport(key: string, match?: RegExp): Promise<string> {
    const mine = () => this.herdr.paneReports().filter((r) => r.text.includes(key));
    await this.waitFor(() => mine().some((r) => match === undefined || match.test(r.text)), {
      label: `an operator pane report for ${key}${match ? ` matching ${match}` : ""}`,
    });
    return mine().find((r) => match === undefined || match.test(r.text))!.text;
  }

  /** Wait for the operator-facing note a park posts to the work source. `escalateAttention` flips the
   *  phase BEFORE it posts, so a scenario that asserts the note the instant it sees `attention` races
   *  the write. Only for a COMMENTS-channel source — see {@link World.waitForPaneReport}. */
  async waitForNote(key: string, match?: RegExp): Promise<string> {
    await this.waitFor(() => {
      const note = this.humanInbox(`${key}-notes.md`);
      return note !== null && (match === undefined || match.test(note));
    }, { label: `an operator note for ${key}${match ? ` matching ${match}` : ""}` });
    return this.humanInbox(`${key}-notes.md`)!;
  }

  answerHumanQuestion(key: string, answer: string): void {
    const dir = join(this.paths.briefs, ".herdr-factory-human");
    const q = this.db.humanQuestions().find((h) => h.ticket_key === key && h.status === "pending") as
      | { id: number; external_id?: string }
      | undefined;
    const file = q?.external_id ?? join(dir, `${key}-q${q?.id ?? 1}.md`);
    const body = readFileSync(file, "utf8");
    writeFileSync(file, `${body.replace(/_Write the answer below this line[\s\S]*?_/, "")}\n${answer}\n`);
  }

  /** Un-park a run the way an operator does. Returns the CLI result so a scenario can assert on it. */
  resume(key: string): { code: number; stdout: string; stderr: string } {
    return this.factory.cli(["resume", key]);
  }

  /** Write (or replace) the repo's `env` file mid-scenario — how a missing credential gets supplied. */
  writeRepoEnv(env: Record<string, string>): void {
    const p = join(this.paths.repoConfigDir, "env");
    writeFileSync(p, `${Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n")}\n`);
    chmodSync(p, 0o600);
  }

  /** Local git facts about the target repo (branch cleanup, pushed refs, commits). */
  git(args: string[], cwd = this.paths.repo): string {
    const r = spawnSync("git", args, { cwd, encoding: "utf8", env: this.env });
    return (r.stdout ?? "").trim();
  }

  branchExists(branch: string): boolean {
    return this.git(["branch", "--list", branch]) !== "";
  }
}
