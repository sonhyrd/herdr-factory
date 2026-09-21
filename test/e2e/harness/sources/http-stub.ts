// A tiny canned-response HTTP server for the source backends the engine reaches over `fetch`
// (jira / sentry / github_issues — each has a base the config can move: a `base_url` for the first
// two, `GITHUB_API_URL` in the repo env for the third, which is what makes them stubbable at all).
//
// It is deliberately dumb: a route table of matchers, a request LOG, and per-route failure injection.
// Scenarios assert on the log as much as on the responses — "no request was made at all" is the whole
// point of the auth-gate scenario, and "one batched call per tick" is the whole point of the call
// budgets. The richer per-source fakes (a Jira board that actually transitions issues) grow from here.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface StubRequest {
  ts: number;
  method: string;
  path: string;
  body: string;
}

export interface StubRoute {
  /** Matched against `<METHOD> <pathname>` — a string is a substring test. */
  match: string | RegExp;
  /** Response status (default 200). */
  status?: number;
  /** JSON body, or a function of the request. */
  json?: unknown | ((req: StubRequest) => unknown);
}

/** A canned HTTP backend on 127.0.0.1. `listen()` picks a free port; `url` is what a source's
 *  `base_url` should be set to. */
export class HttpStub {
  private server: Server | null = null;
  private port = 0;
  readonly routes: StubRoute[] = [];
  readonly requests: StubRequest[] = [];
  /** Every request answers this status while set — for "the backend is down" phases. */
  failWith: number | null = null;

  get url(): string {
    if (!this.port) throw new Error("HttpStub: listen() first — the URL is only known once bound");
    return `http://127.0.0.1:${this.port}`;
  }

  route(match: string | RegExp, json: unknown, status = 200): this {
    this.routes.push({ match, json, status });
    return this;
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => void this.handle(req, res));
      this.server.on("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address();
        this.port = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const path = req.url ?? "/";
    const entry: StubRequest = { ts: Date.now(), method: req.method ?? "GET", path, body: Buffer.concat(chunks).toString("utf8") };
    this.requests.push(entry);

    if (this.failWith != null) {
      res.writeHead(this.failWith, { "content-type": "application/json" });
      res.end(JSON.stringify({ errorMessages: ["stubbed failure"] }));
      return;
    }
    const key = `${entry.method} ${path}`;
    const hit = this.routes.find((r) => (typeof r.match === "string" ? key.includes(r.match) : r.match.test(key)));
    const body = typeof hit?.json === "function" ? (hit.json as (r: StubRequest) => unknown)(entry) : (hit?.json ?? {});
    res.writeHead(hit?.status ?? (hit ? 200 : 404), { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  /** Requests seen so far, optionally filtered by a substring of `<METHOD> <path>`. */
  seen(match?: string): StubRequest[] {
    return match ? this.requests.filter((r) => `${r.method} ${r.path}`.includes(match)) : [...this.requests];
  }

  reset(): void {
    this.requests.length = 0;
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server = null;
    });
  }
}

/** A Jira Agile board that always answers "no eligible issues" — enough for the auth/lifecycle
 *  scenarios that care about whether the engine CALLS Jira, not about what it finds. */
export function emptyJiraBoard(): HttpStub {
  return new HttpStub().route("/rest/agile/1.0/board/", { issues: [], total: 0, maxResults: 50 }).route("/rest/api/", {});
}
