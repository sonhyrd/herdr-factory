// Direct reads of the factory's SQLite state — the harness's primary assertion surface, because no
// CLI command emits JSON except `eligible`. Read-only by discipline (SELECT only); the engine keeps
// writing through WAL while we read.
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface RunRow {
  id: number;
  repo: string;
  work_source: string | null;
  belt: string | null;
  step: string | null;
  ticket_key: string;
  summary: string | null;
  issue_type: string | null;
  branch: string | null;
  phase: string;
  workspace_id: string | null;
  pane_id: string | null;
  worktree_path: string | null;
  pr_number: number | null;
  resolver_active: number;
  attention_reason: string | null;
  attention_reason_code: string | null;
  attention_notified_at: number | null;
  outcome: string | null;
  created_at: number | null;
  updated_at: number | null;
  ended_at: number | null;
}

export interface EventRow {
  id: number;
  run_id: number | null;
  repo: string | null;
  ticket_key: string | null;
  ts: number;
  type: string;
  detail: string | null;
}

export interface StepRow {
  id: number;
  run_id: number;
  step: string;
  pane_id: string | null;
  session_id: string | null;
  done: number;
  started_at: number | null;
  done_at: number | null;
  pass: number;
  dispatched_at: number | null;
  absent_at: number | null;
}

export interface IntentRow {
  id: number;
  repo: string;
  kind: string;
  scope: string;
  run_id: number | null;
  ticket_key: string | null;
  dedup_key: string;
  payload: string;
  state: string;
  status: string;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  error_class: string | null;
  resolved_at: number | null;
}

export interface WorkItemRow {
  repo: string;
  source: string;
  key: string;
  title: string | null;
  item_type: string | null;
  status: string;
}

export class Db {
  private readonly dbPath: string;
  private readonly repo: string;
  private handle: DatabaseSync | null = null;

  constructor(stateRoot: string, repo: string) {
    this.dbPath = join(stateRoot, "herdr-factory.db");
    this.repo = repo;
  }

  get path(): string {
    return this.dbPath;
  }

  exists(): boolean {
    return existsSync(this.dbPath);
  }

  /** Opened lazily and kept: the DB does not exist until the first `serve`/`tick` creates it. */
  private db(): DatabaseSync {
    if (!this.handle) {
      this.handle = new DatabaseSync(this.dbPath);
      this.handle.exec("PRAGMA busy_timeout=5000;");
    }
    return this.handle;
  }

  close(): void {
    try {
      this.handle?.close();
    } catch {
      /* already gone */
    }
    this.handle = null;
  }

  all<T>(sql: string, ...params: (string | number | null)[]): T[] {
    if (!this.exists()) return [];
    try {
      return this.db().prepare(sql).all(...params) as T[];
    } catch (e) {
      // A mid-migration or half-written DB should read as "nothing yet", not explode a poll loop.
      if (String(e).includes("no such table")) return [];
      throw e;
    }
  }

  one<T>(sql: string, ...params: (string | number | null)[]): T | undefined {
    return this.all<T>(sql, ...params)[0];
  }

  // PR-watch state is NOT on `runs`: migration v18 moved number/active/signature into `run_products`
  // keyed by product, so a future plugin watch-product carries its own. Every run read joins it back
  // so a scenario can keep saying `run.pr_number`.
  private static readonly RUN_SELECT =
    "SELECT r.*, p.number AS pr_number, p.active AS resolver_active, p.signature AS last_thread_sig " +
    "FROM runs r LEFT JOIN run_products p ON p.run_id = r.id AND p.product = 'pull_request'";

  /** Newest run for a work-item key (runs are history — a re-claim makes a new row). */
  run(key: string): RunRow | undefined {
    return this.one<RunRow>(`${Db.RUN_SELECT} WHERE r.repo = ? AND r.ticket_key = ? ORDER BY r.id DESC LIMIT 1`, this.repo, key);
  }

  runs(): RunRow[] {
    return this.all<RunRow>(`${Db.RUN_SELECT} WHERE r.repo = ? ORDER BY r.id`, this.repo);
  }

  activeRuns(): RunRow[] {
    return this.all<RunRow>(`${Db.RUN_SELECT} WHERE r.repo = ? AND r.ended_at IS NULL ORDER BY r.id`, this.repo);
  }

  events(key?: string): EventRow[] {
    return key
      ? this.all<EventRow>("SELECT * FROM events WHERE repo = ? AND ticket_key = ? ORDER BY id", this.repo, key)
      : this.all<EventRow>("SELECT * FROM events WHERE repo = ? ORDER BY id", this.repo);
  }

  eventTypes(key?: string): string[] {
    return this.events(key).map((e) => e.type);
  }

  /** Parsed `detail` of the first/last event of a type. */
  event(key: string, type: string, which: "first" | "last" = "last"): (EventRow & { data: Record<string, unknown> }) | undefined {
    const hits = this.events(key).filter((e) => e.type === type);
    const row = which === "first" ? hits[0] : hits[hits.length - 1];
    if (!row) return undefined;
    let data: Record<string, unknown> = {};
    try {
      data = row.detail ? (JSON.parse(row.detail) as Record<string, unknown>) : {};
    } catch {
      data = { raw: row.detail };
    }
    return Object.assign({}, row, { data });
  }

  steps(runId: number): StepRow[] {
    return this.all<StepRow>("SELECT * FROM run_steps WHERE run_id = ? ORDER BY id", runId);
  }

  step(runId: number, step: string): StepRow | undefined {
    return this.one<StepRow>("SELECT * FROM run_steps WHERE run_id = ? AND step = ?", runId, step);
  }

  guardCounter(runId: number, step: string, guard: string): number {
    const row = this.one<{ count: number }>("SELECT count FROM guard_counters WHERE run_id = ? AND step = ? AND guard = ?", runId, step, guard);
    return row?.count ?? 0;
  }

  intents(filter: { kind?: string; runId?: number; status?: string } = {}): IntentRow[] {
    const where = ["repo = ?"];
    const params: (string | number)[] = [this.repo];
    if (filter.kind) (where.push("kind = ?"), params.push(filter.kind));
    if (filter.runId !== undefined) (where.push("run_id = ?"), params.push(filter.runId));
    if (filter.status) (where.push("status = ?"), params.push(filter.status));
    return this.all<IntentRow>(`SELECT * FROM intents WHERE ${where.join(" AND ")} ORDER BY id`, ...params);
  }

  /** Make a run's intents of `kind` due immediately — the harness's way past an engine backoff the
   *  config can't compress (the human-reply poll's miss cadence is a flat 30s). The engine's own operator
   *  endpoint only covers `pending` rows, and the poll clock is a `waiting` one, so this writes the
   *  clock the same way the reconciler would. Returns how many rows it moved. */
  dueNow(kind: string, runId: number): number {
    if (!this.exists()) return 0;
    const info = this.db()
      .prepare("UPDATE intents SET next_attempt_at = 0 WHERE repo = ? AND kind = ? AND run_id = ? AND resolved_at IS NULL")
      .run(this.repo, kind, runId);
    return Number(info.changes);
  }

  workItem(source: string, key: string): WorkItemRow | undefined {
    return this.one<WorkItemRow>("SELECT * FROM work_items WHERE repo = ? AND source = ? AND key = ?", this.repo, source, key);
  }

  humanQuestions(runId?: number): Record<string, unknown>[] {
    return runId === undefined
      ? this.all<Record<string, unknown>>("SELECT * FROM human_questions WHERE repo = ? ORDER BY id", this.repo)
      : this.all<Record<string, unknown>>("SELECT * FROM human_questions WHERE run_id = ? ORDER BY id", runId);
  }

  /** Compact human-readable state dump — the body of every harness timeout/assertion failure. */
  dump(key?: string): string {
    const runs = key ? [this.run(key)].filter(Boolean) : this.runs();
    const lines: string[] = [];
    for (const r of runs as RunRow[]) {
      lines.push(
        `run #${r.id} ${r.ticket_key} belt=${r.belt} step=${r.step} phase=${r.phase} outcome=${r.outcome ?? "-"} ` +
          `pr=${r.pr_number ?? "-"} attention=${r.attention_reason_code ?? "-"} ended=${r.ended_at ? "yes" : "no"}`,
      );
      for (const s of this.steps(r.id)) {
        lines.push(`  step ${s.step} pass=${s.pass} done=${s.done} pane=${s.pane_id ?? "-"} dispatched=${s.dispatched_at ? "yes" : "no"}`);
      }
      const ev = this.events(r.ticket_key).slice(-18);
      for (const e of ev) lines.push(`  ev ${e.type} ${(e.detail ?? "").slice(0, 160)}`);
      const pending = this.intents({ runId: r.id }).filter((i) => i.status !== "delivered");
      for (const i of pending) lines.push(`  intent ${i.kind} ${i.status} attempts=${i.attempts} err=${(i.last_error ?? "").slice(0, 120)}`);
    }
    if (!lines.length) lines.push("(no runs)");
    return lines.join("\n");
  }
}
