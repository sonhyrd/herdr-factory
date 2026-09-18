// HerdrClient's herdr-0.7.5 CLI contract, exercised against a FAKE `herdr` binary (the client takes
// its bin path, so this drives real subprocesses and asserts the exact argv — the thing that broke
// silently when 0.7.5 changed `agent start` out from under us).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import { HerdrClient, isAtShellPrompt, shellQuoteArgv, spawnStrategyForArgv } from "../src/clients/herdr.ts";
import { HerdrApiError, herdrSocketCall } from "../src/clients/herdr-socket.ts";

const FAKE = `#!/bin/bash
{ printf '===\\n'; for a in "$@"; do printf '%s\\n' "$a"; done; } >> "$HERDR_FAKE_LOG"
case "$1:$2" in
  tab:create) echo '{"result":{"tab":{"tab_id":"w1:t9"},"root_pane":{"pane_id":"w1:p9"}}}' ;;
  agent:start)
    if [ -n "$HERDR_FAKE_ADOPT_FAIL" ]; then echo 'agent not detected' >&2; exit 1; fi
    echo '{"result":{"agent":{"pane_id":"w1:p9"}}}' ;;
  agent:list) if [ -n "$HERDR_FAKE_AGENTS" ]; then echo "$HERDR_FAKE_AGENTS"; else echo '{"result":{"agents":[]}}'; fi ;;
  pane:layout) echo '{"result":{"layout":{"area":{"width":177,"height":48},"panes":[{"pane_id":"w1:p1","rect":{"width":84,"height":48}}]}}}' ;;
  pane:process-info) echo "$HERDR_FAKE_PROCESS_INFO" ;;
  agent:prompt)
    if [ -n "$HERDR_FAKE_PROMPT_STALL" ]; then echo 'agent_prompt_stalled' >&2; exit 1; fi
    echo '{"result":{"type":"ok"}}' ;;
  *) echo '{"result":{"type":"ok"}}' ;;
esac
`;

let dir: string;
let bin: string;
let log: string;
const servers: Server[] = [];

/** Every fake-herdr invocation, as its argv array, in call order. */
function invocations(): string[][] {
  const raw = readFileSync(log, "utf8");
  return raw
    .split("===\n")
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => chunk.split("\n").slice(0, -1));
}
const invocation = (sub: string): string[] | undefined => invocations().find((a) => `${a[0]} ${a[1]}` === sub);
/** The value following `flag` in an argv (the flag's argument). */
const valueOf = (argv: string[], flag: string): string | undefined => argv[argv.indexOf(flag) + 1];
/** Every `--env K=V` / `--token K=V` pair in an argv, as an object. */
function pairs(argv: string[], flag: string): Record<string, string> {
  const out: Record<string, string> = {};
  argv.forEach((a, i) => {
    if (a !== flag) return;
    const [k, ...rest] = (argv[i + 1] ?? "").split("=");
    out[k!] = rest.join("=");
  });
  return out;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "herdr-client-"));
  bin = join(dir, "herdr");
  log = join(dir, "calls.log");
  writeFileSync(bin, FAKE);
  chmodSync(bin, 0o755);
  writeFileSync(log, "");
  process.env.HERDR_FAKE_LOG = log;
});
afterEach(() => {
  for (const s of servers) s.close();
  servers.length = 0;
  delete process.env.HERDR_FAKE_LOG;
  delete process.env.HERDR_FAKE_ADOPT_FAIL;
  delete process.env.HERDR_FAKE_AGENTS;
  delete process.env.HERDR_FAKE_PROMPT_STALL;
  delete process.env.HERDR_FAKE_PROCESS_INFO;
  rmSync(dir, { recursive: true, force: true });
});

describe("spawnStrategyForArgv — adopt an agent herdr knows, else type it into the pane", () => {
  it("adopts a bare supported kind (the default claude harness)", () => {
    expect(spawnStrategyForArgv(["claude", "--dangerously-skip-permissions", "P"])).toEqual({ mode: "adopt", kind: "claude" });
    expect(spawnStrategyForArgv(["opencode", "P"])).toEqual({ mode: "adopt", kind: "opencode" });
  });

  it("types an ABSOLUTE path instead of adopting it — herdr would resolve its own executable", () => {
    expect(spawnStrategyForArgv(["/opt/homebrew/bin/claude", "P"])).toEqual({ mode: "run", kind: "claude" });
  });

  it("types an unknown harness, with no kind to hint", () => {
    expect(spawnStrategyForArgv(["my-agent", "P"])).toEqual({ mode: "run", kind: undefined });
  });

  it("an explicit kind forces adoption — the point of the `agent.kind` config key", () => {
    expect(spawnStrategyForArgv(["bin/my-claude", "P"], "claude")).toEqual({ mode: "adopt", kind: "claude" });
  });
});

describe("shellQuoteArgv", () => {
  it("survives quotes, spaces and shell metacharacters", () => {
    expect(shellQuoteArgv(["claude", "it's $HOME `now`", "a b"])).toBe(`'claude' 'it'\\''s $HOME \`now\`' 'a b'`);
  });
});

describe("HerdrClient.agentStart — WE create the pane, herdr adopts the agent (0.7.5)", () => {
  it("creates a tab carrying cwd/label/env, then adopts the harness into its pane", async () => {
    const shellWaits: string[] = [];
    const pane = await new HerdrClient(bin).agentStart({
      workspaceId: "w1",
      cwd: "/wt",
      argv: ["claude", "--dangerously-skip-permissions", "PROMPT"],
      env: { HERDR_FACTORY_TICKET: "K-1" },
      name: "work-k-1",
      // A brand-new pane's shell is still sourcing rc files; `agent start` refuses a pane that isn't
      // at an available prompt, so the caller gets to wait for one first.
      awaitShell: async (id) => void shellWaits.push(id),
    });
    expect(shellWaits).toEqual(["w1:p9"]);
    expect(pane).toBe("w1:p9");

    const tab = invocation("tab create")!;
    expect(valueOf(tab, "--workspace")).toBe("w1");
    expect(valueOf(tab, "--cwd")).toBe("/wt");
    expect(valueOf(tab, "--label")).toBe("work-k-1");
    expect(tab).toContain("--no-focus");
    // The env that used to ride on `agent start` moves here — and NOTHING else. herdr's
    // HERDR_AGENT foreground-process hint must NOT be set on the adopt path: `--kind` already
    // declares the harness, and a pane whose env carries the hint reads to herdr as one that already
    // hosts an agent, so `agent start` refuses it (`agent_pane_busy: … not an available shell`).
    expect(pairs(tab, "--env")).toEqual({ HERDR_FACTORY_TICKET: "K-1" });

    const start = invocation("agent start")!;
    expect(start.slice(0, 3)).toEqual(["agent", "start", "work-k-1"]); // herdr's agent NAME, not the kind
    expect(valueOf(start, "--kind")).toBe("claude");
    expect(valueOf(start, "--pane")).toBe("w1:p9");
    expect(Number(valueOf(start, "--timeout"))).toBeGreaterThan(3000); // herdr's readiness wait
    // argv[0] is NOT passed: --kind names the executable, the rest are its args (prompt included).
    expect(start.slice(start.indexOf("--") + 1)).toEqual(["--dangerously-skip-permissions", "PROMPT"]);
    expect(start).not.toContain("--workspace"); // the pre-0.7.5 form, which herdr now rejects
  });

  it("closes the pane it created when adoption fails, rather than leaking an empty one", async () => {
    process.env.HERDR_FAKE_ADOPT_FAIL = "1";
    const pane = await new HerdrClient(bin).agentStart({ workspaceId: "w1", cwd: "/wt", argv: ["claude", "P"] });
    expect(pane).toBeNull();
    expect(invocation("pane close")).toEqual(["pane", "close", "w1:p9"]);
  });

  it("keeps a pane whose agent is already WORKING when the readiness wait times out", async () => {
    process.env.HERDR_FAKE_ADOPT_FAIL = "1"; // cursor-agent busy on its argv prompt never reports ready
    process.env.HERDR_FAKE_AGENTS = JSON.stringify({ result: { agents: [{ pane_id: "w1:p9", workspace_id: "w1", agent: "cursor", agent_status: "working" }] } });
    const pane = await new HerdrClient(bin).agentStart({ workspaceId: "w1", cwd: "/wt", argv: ["cursor-agent", "P"], kind: "cursor" });
    expect(pane).toBe("w1:p9");
    expect(invocation("pane close")).toBeUndefined();
  });

  it("types the exact argv for a harness it can't adopt (wrapper / absolute path)", async () => {
    const pane = await new HerdrClient(bin).agentStart({ workspaceId: "w1", cwd: "/wt", argv: ["bin/my-agent", "--go", "P"] });
    expect(pane).toBe("w1:p9");
    expect(invocation("agent start")).toBeUndefined();
    expect(invocation("pane run")).toEqual(["pane", "run", "w1:p9", `'bin/my-agent' '--go' 'P'`]);
  });

  it("sets herdr's HERDR_AGENT hint only for a TYPED harness — the case it exists for", async () => {
    // An absolute path is typed into the pane (`run`), and its process tree doesn't tell herdr which
    // integration owns it — the hint does. On the adopt path above the same hint would instead make
    // the pane read as already-occupied, so it is set here and only here.
    await new HerdrClient(bin).agentStart({ workspaceId: "w1", cwd: "/wt", argv: ["/opt/homebrew/bin/claude", "P"] });
    expect(invocation("pane run")).toBeDefined(); // i.e. the `run` strategy
    expect(pairs(invocation("tab create")!, "--env")).toEqual({ HERDR_AGENT: "claude" });
  });
});

describe("isAtShellPrompt — the state `agent start` requires of a pane", () => {
  it("true only when the shell owns the foreground alone", () => {
    expect(isAtShellPrompt({ shell_pid: 42, foreground_process_group_id: 42, foreground_processes: [{ pid: 42 }] })).toBe(true);
  });
  it("false while a command runs in the pane", () => {
    expect(isAtShellPrompt({ shell_pid: 42, foreground_process_group_id: 99, foreground_processes: [{ pid: 99 }] })).toBe(false);
  });
  it("false when the shell has a child — zsh sourcing rc files stays in its OWN process group", () => {
    // The group id alone would say "idle" here, which is how a fixed sleep used to be needed.
    expect(isAtShellPrompt({ shell_pid: 42, foreground_process_group_id: 42, foreground_processes: [{ pid: 42 }, { pid: 77 }] })).toBe(false);
  });
  it("false for an EMPTY list — herdr hasn't sampled the pane yet (exactly a just-created pane)", () => {
    expect(isAtShellPrompt({ shell_pid: 42, foreground_process_group_id: 42, foreground_processes: [] })).toBe(false);
  });
  it("falls back to the process group where the platform exposes no list", () => {
    expect(isAtShellPrompt({ shell_pid: 42, foreground_process_group_id: 42 })).toBe(true);
  });
  it("false on an unreadable answer", () => {
    expect(isAtShellPrompt(undefined)).toBe(false);
    expect(isAtShellPrompt({})).toBe(false);
  });
});

describe("HerdrClient — the layout runner's queries", () => {
  it("tabArea reports the TAB's cell area, not the pane's own rect", async () => {
    // `pane layout` gives both; the tab area is the region a layout's outermost split divides.
    expect(await new HerdrClient(bin).tabArea("w1:p1")).toEqual({ cols: 177, rows: 48 });
  });

  it("paneAtShellPrompt samples `pane process-info`", async () => {
    process.env.HERDR_FAKE_PROCESS_INFO = JSON.stringify({
      result: { process_info: { shell_pid: 7, foreground_process_group_id: 7, foreground_processes: [{ pid: 7 }] } },
    });
    expect(await new HerdrClient(bin).paneAtShellPrompt("w1:p1")).toBe(true);
    expect(invocation("pane process-info")).toEqual(["pane", "process-info", "--pane", "w1:p1"]);
  });

  it("agentAdopt starts a kind in an existing pane, passing its args after `--`", async () => {
    expect(await new HerdrClient(bin).agentAdopt("w1:p1", { name: "claude-w1", kind: "claude", args: ["--yolo"], timeoutMs: 90_000 })).toBe(true);
    const argv = invocation("agent start")!;
    expect(argv.slice(0, 3)).toEqual(["agent", "start", "claude-w1"]);
    expect(valueOf(argv, "--kind")).toBe("claude");
    expect(valueOf(argv, "--pane")).toBe("w1:p1");
    expect(valueOf(argv, "--timeout")).toBe("90000");
    expect(argv.slice(argv.indexOf("--") + 1)).toEqual(["--yolo"]);
  });

  it("agentOpenPrompt waits for the agent to SETTLE only when a timeout is given", async () => {
    const client = new HerdrClient(bin);
    await client.agentOpenPrompt("w1:p1", "go");
    expect(invocation("agent prompt")).toEqual(["agent", "prompt", "w1:p1", "go"]);

    writeFileSync(log, "");
    await client.agentOpenPrompt("w1:p1", "go", { settleTimeoutMs: 120_000 });
    const argv = invocation("agent prompt")!;
    expect(argv).toContain("--wait");
    // idle/done — "the turn finished", the opposite question from agentSend's "did it START?".
    expect(argv.filter((a, i) => argv[i - 1] === "--until")).toEqual(["idle", "done"]);
    expect(valueOf(argv, "--timeout")).toBe("120000");
  });
});

describe("HerdrClient.agentSend — atomic prompt submission with an optional handshake", () => {
  it("submits with no Enter of its own, and does not wait unless asked", async () => {
    expect(await new HerdrClient(bin).agentSend("w1:p1", "hi")).toBe(true);
    expect(invocation("agent prompt")).toEqual(["agent", "prompt", "w1:p1", "hi"]);
    expect(invocation("pane send-keys")).toBeUndefined();
  });

  it("under `confirm`, waits for an observed reaction and reports a stalled submission", async () => {
    const client = new HerdrClient(bin);
    expect(await client.agentSend("w1:p1", "hi", { confirm: true })).toBe(true);
    const argv = invocation("agent prompt")!;
    expect(argv).toContain("--wait");
    expect(argv.filter((a, i) => argv[i - 1] === "--until")).toEqual(["working", "blocked"]);

    process.env.HERDR_FAKE_PROMPT_STALL = "1";
    expect(await client.agentSend("w1:p1", "hi", { confirm: true })).toBe(false);
  });
});

describe("herdrSocketCall — the one non-CLI transport (layout.apply has no CLI surface)", () => {
  /** A stand-in herdr socket. `reply` maps a received request to what the server writes back (a
   *  string is written raw, so a test can also send a partial frame or close silently). */
  async function fakeServer(reply: (req: { method: string; params: unknown }) => string | null): Promise<string> {
    const path = join(dir, `sock-${Math.random().toString(36).slice(2)}`);
    const server = createServer((sock) => {
      sock.on("data", (chunk) => {
        const out = reply(JSON.parse(chunk.toString().trim()) as { method: string; params: unknown });
        if (out == null) sock.end();
        else sock.write(out);
      });
    });
    await new Promise<void>((res) => server.listen(path, res));
    servers.push(server);
    return path;
  }

  it("round-trips a request and returns the result payload", async () => {
    let seen: { method: string; params: unknown } | undefined;
    const socketPath = await fakeServer((req) => {
      seen = req;
      return `${JSON.stringify({ id: "x", result: { type: "layout_apply", layout: { tab_id: "w1:t2" } } })}\n`;
    });
    const res = await herdrSocketCall<{ layout: { tab_id: string } }>("layout.apply", { workspace_id: "w1" }, { socketPath });
    expect(res.layout.tab_id).toBe("w1:t2");
    expect(seen).toMatchObject({ method: "layout.apply", params: { workspace_id: "w1" } });
  });

  it("reassembles a response split across chunks", async () => {
    const socketPath = join(dir, "sock-split");
    const server = createServer((sock) => {
      sock.on("data", () => {
        sock.write(`{"id":"x","result":{"half`);
        setTimeout(() => sock.write(`":"joined"}}\n`), 5);
      });
    });
    await new Promise<void>((res) => server.listen(socketPath, res));
    servers.push(server);
    expect(await herdrSocketCall<{ half: string }>("ping", {}, { socketPath })).toEqual({ half: "joined" });
  });

  it("surfaces herdr's own rejection as a typed error carrying its code", async () => {
    const socketPath = await fakeServer(() => `${JSON.stringify({ id: "x", error: { code: "invalid_params", message: "unknown tab" } })}\n`);
    const err = await herdrSocketCall("layout.apply", {}, { socketPath }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HerdrApiError);
    expect((err as HerdrApiError).code).toBe("invalid_params");
    expect((err as Error).message).toContain("unknown tab");
  });

  it("fails (never hangs) when the socket closes without answering", async () => {
    const socketPath = await fakeServer(() => null);
    await expect(herdrSocketCall("layout.apply", {}, { socketPath })).rejects.toThrow(/closed before a response/);
  });

  it("fails when there is no socket at all", async () => {
    await expect(herdrSocketCall("layout.apply", {}, { socketPath: join(dir, "nope.sock") })).rejects.toThrow();
  });

  it("is hard-bounded — a server that never answers times out", async () => {
    const path = join(dir, "sock-silent");
    const server = createServer(() => {}); // accepts, never replies
    await new Promise<void>((res) => server.listen(path, res));
    servers.push(server);
    await expect(herdrSocketCall("layout.apply", {}, { socketPath: path, timeoutMs: 60 })).rejects.toThrow(/timed out after 60ms/);
  });
});

describe("HerdrClient.reportPaneDisplay — display-only state, never a rename", () => {
  it("publishes the agent name, title and tokens under the factory's source namespace", async () => {
    await new HerdrClient(bin).reportPaneDisplay("w1:p1", {
      agentName: "fix:K-1",
      title: "⚠ ATTENTION K-1",
      tokens: { hf_step: "fix", hf_state: "attention", hf_gone: null },
    });
    const argv = invocation("pane report-metadata")!;
    expect(argv.slice(0, 3)).toEqual(["pane", "report-metadata", "w1:p1"]);
    expect(valueOf(argv, "--source")).toBe("herdr-factory");
    expect(valueOf(argv, "--display-agent")).toBe("fix:K-1");
    expect(valueOf(argv, "--title")).toBe("⚠ ATTENTION K-1");
    expect(pairs(argv, "--token")).toEqual({ hf_step: "fix", hf_state: "attention" });
    expect(valueOf(argv, "--clear-token")).toBe("hf_gone"); // a null token value CLEARS it
    expect(Number(valueOf(argv, "--seq"))).toBeGreaterThan(0); // ordering vs. an overlapping tick
    expect(argv).not.toContain("rename");
  });

  it("clears the title override when asked (the healthy state)", async () => {
    await new HerdrClient(bin).reportPaneDisplay("w1:p1", { agentName: "fix:K-1", clearTitle: true });
    const argv = invocation("pane report-metadata")!;
    expect(argv).toContain("--clear-title");
    expect(argv).not.toContain("--title");
  });
});
