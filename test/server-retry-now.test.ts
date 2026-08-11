import { describe, expect, it, vi } from "vitest";
import { createApp, type RepoRuntime, type ServerContext } from "../src/server/app.ts";

// POST /repos/{repo}/retry-now — the operator due-now: drop the backoff on the deliver lane's pending
// rows and flush them on this request, instead of waiting out a curve that has doubled its way to the
// hour cap. Repo-wide by default; `key` narrows it to one run. Pinned here because the ROUTE, not the
// store, owns two of the contract's promises: the flush runs under the repo tick lock (never beside a
// tick's own Phase 0), and a key that names no active run is a reported refusal, not a 500.

interface RetryNowBody {
  ok: boolean;
  requeued: number;
  flushed: boolean;
  message?: string;
}

function makeRuntime(over: { lockHeld?: boolean } = {}) {
  const retryIntentsNow = vi.fn(() => 3);
  const acquireLock = vi.fn(() => !over.lockHeld);
  const dueIntents = vi.fn(() => []);
  const runtime = {
    ticking: false,
    deps: {
      config: { repoName: "demo", limits: { tickIntervalSeconds: 60 } },
      store: {
        retryIntentsNow,
        // withTickLock
        acquireLock,
        extendLock: () => true,
        releaseLock: vi.fn(),
        // the two flush flows' due() walks (both empty — delivery itself is tested elsewhere)
        dueTransitions: () => [],
        dueIntents,
        dueIntentDeadlines: () => [],
        // resolveActiveRun
        activeRunsForKey: (_repo: string, key: string) => (key === "HF-1" ? [{ id: 7, ticketKey: "HF-1", workSource: "jira" }] : []),
        activeRunForTicket: () => undefined,
      },
      log: vi.fn(),
      now: () => 1000,
    },
  } as unknown as RepoRuntime;
  const context = {
    getRepo: (name: string) => (name === "demo" ? runtime : undefined),
    knownRepos: () => ["demo"], // the not-configured error names the repos that ARE served
  } as unknown as ServerContext;
  return { app: createApp(context), retryIntentsNow, acquireLock, dueIntents };
}

const postRetryNow = (app: ReturnType<typeof createApp>, body: unknown, repo = "demo") =>
  app.request(`/repos/${repo}/retry-now`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("POST /retry-now — operator due-now", () => {
  it("re-queues repo-wide with no key and flushes under the tick lock", async () => {
    const { app, retryIntentsNow, acquireLock, dueIntents } = makeRuntime();
    const res = await postRetryNow(app, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, requeued: 3, flushed: true } satisfies RetryNowBody);
    expect(retryIntentsNow).toHaveBeenCalledWith("demo", { runId: undefined });
    expect(acquireLock).toHaveBeenCalled(); // the flush never runs beside a tick's own Phase 0
    expect(dueIntents).toHaveBeenCalled(); // …and it really did flush, not just re-queue
  });

  it("scopes to one run when a key is given, resolving it like every other run command", async () => {
    const { app, retryIntentsNow } = makeRuntime();
    const res = await postRetryNow(app, { key: "HF-1" });
    expect(await res.json()).toEqual(expect.objectContaining({ ok: true, requeued: 3 }));
    expect(retryIntentsNow).toHaveBeenCalledWith("demo", { runId: 7 });
  });

  it("reports a key with no active run instead of failing, and never re-queues for it", async () => {
    const { app, retryIntentsNow } = makeRuntime();
    const res = await postRetryNow(app, { key: "HF-404" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, requeued: 0, flushed: false, message: "HF-404: no active run" });
    expect(retryIntentsNow).not.toHaveBeenCalled();
  });

  it("still re-queues when a tick holds the lock, reporting flushed:false (that pass delivers them)", async () => {
    const { app, retryIntentsNow, dueIntents } = makeRuntime({ lockHeld: true });
    const res = await postRetryNow(app, {});
    expect(await res.json()).toEqual({ ok: true, requeued: 3, flushed: false } satisfies RetryNowBody);
    expect(retryIntentsNow).toHaveBeenCalled();
    expect(dueIntents).not.toHaveBeenCalled();
  });

  it("404s for a repo the server does not serve", async () => {
    const { app } = makeRuntime();
    const res = await postRetryNow(app, {}, "nope");
    expect(res.status).toBe(404);
  });
});
