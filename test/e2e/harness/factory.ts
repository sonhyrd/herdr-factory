// The factory under test: the real `serve` daemon (or discrete `tick` calls) run from the repo's own
// sources with Node's type-stripping — no build step, exactly as production runs it.
//
// `serve` is the default driver because a long list of behaviours exist ONLY there: the auth gate's
// one-shot notify, per-source poll cadence, `viaServerOrLocal`'s server branch, `/evidence` serving,
// hot reload, the single-instance port bind, graceful drain. It is spawned directly rather than via
// `ensure-up`, whose env allowlist would drop HERDR_SOCKET_PATH and the harness's own vars.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { delay, tail } from "./herdr.ts";

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class Factory {
  private readonly repoRoot: string;
  private readonly repo: string;
  private readonly env: Record<string, string>;
  private readonly logPath: string;
  private readonly stateRoot: string;
  readonly port: number;
  private proc: ChildProcess | null = null;

  constructor(opts: { repoRoot: string; repo: string; env: Record<string, string>; logPath: string; stateRoot: string; port: number }) {
    this.repoRoot = opts.repoRoot;
    this.repo = opts.repo;
    this.env = opts.env;
    this.logPath = opts.logPath;
    this.stateRoot = opts.stateRoot;
    this.port = opts.port;
  }

  private get cliEntry(): string {
    return join(this.repoRoot, "src", "cli", "index.ts");
  }

  /** A CLI invocation, always through the real entry point (never an in-process import), so the
   *  harness exercises the same argument parsing and server-routing an agent or operator would. */
  cli(args: string[], opts: { repoScoped?: boolean; timeoutMs?: number } = {}): CliResult {
    const full = opts.repoScoped === false ? args : ["--repo", this.repo, ...args];
    const r = spawnSync(process.execPath, [this.cliEntry, ...full], {
      env: this.env,
      encoding: "utf8",
      timeout: opts.timeoutMs ?? 120_000,
      cwd: this.repoRoot,
    });
    return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  }

  /** The same invocation, spawned ASYNCHRONOUSLY. `cli()` is `spawnSync`, which blocks the test
   *  process's event loop for the whole run — so a command that talks to a fake backend HOSTED in
   *  that process (a `JiraFake`, a `GhFake` over HTTP) deadlocks: the request can never be answered
   *  and the CLI is killed at its timeout. Use this for any CLI read that dials a stub backend. */
  cliAsync(args: string[], opts: { repoScoped?: boolean; timeoutMs?: number } = {}): Promise<CliResult> {
    const full = opts.repoScoped === false ? args : ["--repo", this.repo, ...args];
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [this.cliEntry, ...full], { env: this.env, cwd: this.repoRoot, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 120_000);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr });
      });
    });
  }

  async serve(): Promise<void> {
    const out = createWriteStream(this.logPath, { flags: "a" });
    this.proc = spawn(process.execPath, [this.cliEntry, "serve"], {
      env: this.env,
      stdio: ["ignore", "pipe", "pipe"],
      cwd: this.repoRoot,
    });
    this.proc.stdout?.pipe(out);
    this.proc.stderr?.pipe(out);
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (this.proc.exitCode !== null) {
        throw new Error(`factory serve exited (${this.proc.exitCode}) during startup:\n${tail(this.logPath, 40)}`);
      }
      const h = await this.health();
      if (h) return;
      await delay(200);
    }
    throw new Error(`factory serve did not answer /health in 45s:\n${tail(this.logPath, 40)}`);
  }

  get running(): boolean {
    return !!this.proc && this.proc.exitCode === null;
  }

  /** The resident server's pid — what the resource-soak scenario samples RSS and open FDs from. */
  get pid(): number | undefined {
    return this.proc?.pid;
  }

  /** One pass, timed. The number is the whole round trip an operator would feel, which is what the
   *  latency budget is about — not an internal span. */
  async tickTimed(): Promise<number> {
    const started = Date.now();
    await this.tick();
    return Date.now() - started;
  }

  async health(): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/health`, { signal: AbortSignal.timeout(3000) });
      return res.ok ? ((await res.json()) as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  async api<T = unknown>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const url = `http://127.0.0.1:${this.port}${path.startsWith("/repos/") || path.startsWith("/") ? path : `/${path}`}`;
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* keep the text */
    }
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${text.slice(0, 500)}`);
    return parsed as T;
  }

  /** Repo-scoped read/mutate endpoints, e.g. `repoApi("GET", "obligations?key=X")`. */
  repoApi<T = unknown>(method: "GET" | "POST", suffix: string, body?: unknown): Promise<T> {
    return this.api<T>(method, `/repos/${this.repo}/${suffix}`, body);
  }

  /** One reconcile pass. Through the server when it's up (a warm in-process reconcile — the same
   *  path a CLI nudge takes), else in-process via the CLI fallback. */
  async tick(): Promise<void> {
    if (this.running) {
      await this.repoApi("POST", "tick", {});
      return;
    }
    const r = this.cli(["tick"]);
    if (r.code !== 0) throw new Error(`tick failed: ${r.stderr || r.stdout}`);
  }

  /** Kill without draining — the crash-safety scenarios' entry point. */
  crash(): void {
    this.proc?.kill("SIGKILL");
    this.proc = null;
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    try {
      await this.api("POST", "/shutdown", {});
    } catch {
      /* it may already be gone */
    }
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && this.proc.exitCode === null) await delay(150);
    if (this.proc.exitCode === null) {
      this.proc.kill("SIGTERM");
      await delay(1500);
      if (this.proc.exitCode === null) this.proc.kill("SIGKILL");
    }
    this.proc = null;
  }

  /** The per-repo work log (`<stateRoot>/<repo>/logs/<date>.log`) — the engine's own narration. */
  repoLog(lines = 60): string {
    const dir = join(this.stateRoot, this.repo, "logs");
    if (!existsSync(dir)) return "(no repo log yet)";
    const files = readdirSync(dir).sort();
    const last = files[files.length - 1];
    return last ? tail(join(dir, last), lines) : "(no repo log yet)";
  }

  serveLog(lines = 40): string {
    return tail(this.logPath, lines);
  }

  /** GET /evidence/<key> — the `local` publisher's public URL surface. */
  async evidence(key: string): Promise<{ status: number; body: string }> {
    const res = await fetch(`http://127.0.0.1:${this.port}/evidence/${key}`, { signal: AbortSignal.timeout(5000) });
    return { status: res.status, body: await res.text() };
  }

  evidenceFile(rel: string): string | null {
    const p = join(this.stateRoot, "evidence", rel);
    return existsSync(p) ? readFileSync(p, "utf8") : null;
  }
}
