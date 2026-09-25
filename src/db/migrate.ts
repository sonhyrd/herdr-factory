import type { DatabaseSync } from "node:sqlite";
import { tx } from "./tx.ts";

/** Exported for the upgrade tests only (migrateTo builds a mid-chain DB to exercise a later
 *  version's in-flight-row conversion). Runtime callers use migrate(). */
export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE repos (
        name TEXT PRIMARY KEY, repo_path TEXT, base_ref TEXT, github TEXT,
        last_tick_at INTEGER, enabled INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL, ticket_key TEXT NOT NULL,
        summary TEXT, issue_type TEXT, branch TEXT,
        phase TEXT NOT NULL,
        workspace_id TEXT, pane_id TEXT, worktree_path TEXT, pr_number INTEGER,
        watch_deadline INTEGER, last_thread_sig TEXT,
        worker_done INTEGER NOT NULL DEFAULT 0,
        attention_reason TEXT, outcome TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ended_at INTEGER
      );
      CREATE INDEX idx_runs_active ON runs(repo) WHERE ended_at IS NULL;
      CREATE INDEX idx_runs_ticket ON runs(repo, ticket_key);
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER REFERENCES runs(id),
        repo TEXT NOT NULL, ticket_key TEXT,
        ts INTEGER NOT NULL, type TEXT NOT NULL, detail TEXT
      );
      CREATE INDEX idx_events_run ON events(run_id, ts);
      CREATE TABLE locks (
        name TEXT PRIMARY KEY, owner TEXT, acquired_at INTEGER, expires_at INTEGER
      );
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE runs ADD COLUMN review_done INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE runs ADD COLUMN review_pane TEXT;
    `,
  },
  {
    version: 3,
    sql: `
      ALTER TABLE runs ADD COLUMN progress_sig TEXT;
      ALTER TABLE runs ADD COLUMN progress_at INTEGER;
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE run_steps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL,
        step TEXT NOT NULL,                  -- fix | review | pr
        pane_id TEXT, session_id TEXT,       -- on-demand cross-agent query handles
        progress_sig TEXT, progress_at INTEGER,   -- per-step heartbeat
        done INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER, done_at INTEGER
      );
      CREATE INDEX idx_run_steps ON run_steps(run_id, step);
    `,
  },
  {
    version: 5,
    // "the active step changed but the user hasn't been shown it yet" — set when a step is
    // (re)spawned, cleared once the focus shift is applied (applyPendingFocus). Persisting it
    // is what lets a transition in an unfocused worktree be deferred across ticks.
    sql: `ALTER TABLE runs ADD COLUMN focus_pending INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    version: 6,
    // Multi-source work. Every run now records WHICH configured work source it was claimed
    // from. The column is left NULLABLE (no DEFAULT) on purpose: a future run that somehow
    // lands without a source should surface loudly (resolveSource → escalate) rather than be
    // silently coerced to 'jira'. The one-time backfill stamps pre-upgrade in-flight runs as
    // 'jira' — the only source that existed before — so they keep resolving after the upgrade.
    // INVARIANT: the pre-existing Jira source MUST keep the default name 'jira' (see config.ts
    // / ARCHITECTURE §10) or backfilled in-flight runs won't match a configured source.
    // The ALTER + UPDATE + CREATE commit atomically (migrate() wraps each version in a txn).
    //
    // work_items is herdr-factory's internal status ledger for sources with no external status
    // of record (local_markdown). Jira keeps its status in Jira; this table is never touched by
    // the Jira source. `runs` remains the dedup source of truth; work_items.status is the
    // best-effort lifecycle label that gates which markdown files are eligible.
    sql: `
      ALTER TABLE runs ADD COLUMN work_source TEXT;
      UPDATE runs SET work_source = 'jira' WHERE work_source IS NULL;
      CREATE TABLE work_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL, source TEXT NOT NULL, key TEXT NOT NULL,
        title TEXT, item_type TEXT, path TEXT,
        status TEXT NOT NULL
          CHECK (status IN ('todo','in_development','in_review','merged','aborted')),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(repo, source, key)
      );
      CREATE INDEX idx_work_items ON work_items(repo, source, status);
    `,
  },
  {
    version: 7,
    // Belts. A run now records which BELT (its ordered steps + lifecycle) is processing it, in
    // addition to its work_source, and which step is active (run.step, set while phase='running').
    // Both columns are NULLABLE: this is a clean-break redesign (see ARCHITECTURE / README) — any
    // run left in-flight across the upgrade lands with belt=NULL and is escalated to attention by
    // the reconciler rather than silently resumed onto a guessed belt. run_steps.step stays TEXT
    // (already unconstrained), so arbitrary custom step names persist with no schema change.
    //
    // work_items.status gains a sixth value 'done' — the terminal state a custom (non-PR) belt
    // writes when its last step finishes. SQLite can't ALTER a CHECK constraint, so the table is
    // rebuilt (copy → drop → rename); the whole version runs in one transaction (see migrate()).
    sql: `
      ALTER TABLE runs ADD COLUMN belt TEXT;
      ALTER TABLE runs ADD COLUMN step TEXT;
      CREATE TABLE work_items_v7 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL, source TEXT NOT NULL, key TEXT NOT NULL,
        title TEXT, item_type TEXT, path TEXT,
        status TEXT NOT NULL
          CHECK (status IN ('todo','in_development','in_review','merged','aborted','done')),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(repo, source, key)
      );
      INSERT INTO work_items_v7 (id, repo, source, key, title, item_type, path, status, created_at, updated_at)
        SELECT id, repo, source, key, title, item_type, path, status, created_at, updated_at FROM work_items;
      DROP TABLE work_items;
      ALTER TABLE work_items_v7 RENAME TO work_items;
      CREATE INDEX idx_work_items ON work_items(repo, source, status);
    `,
  },
  {
    version: 8,
    // Human-in-the-loop questions. These are source-agnostic: the engine records the paused run
    // and the source adapter records whatever external object represents the question (a Jira
    // comment for Jira today, Linear comment / local inbox later). One pending question per run is
    // enough for the current belt model and prevents duplicate comments when an agent retries the
    // ask command or the dispatcher retries a failed post.
    sql: `
      CREATE TABLE human_questions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES runs(id),
        repo TEXT NOT NULL,
        work_source TEXT NOT NULL,
        ticket_key TEXT NOT NULL,
        step TEXT,
        question TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','answered')),
        external_id TEXT,
        external_created_at TEXT,
        answer TEXT,
        answer_external_id TEXT,
        answer_author TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        answered_at INTEGER
      );
      CREATE INDEX idx_human_questions_pending ON human_questions(repo, status);
      CREATE INDEX idx_human_questions_run ON human_questions(run_id, status);
      CREATE UNIQUE INDEX idx_human_questions_one_pending_run ON human_questions(run_id) WHERE status = 'pending';
    `,
  },
  {
    version: 9,
    // Bounce loop-safety counter. A later belt step can send the run BACK to an earlier step for
    // rework (evidence/review → fix); each such bounce increments the target step's `bounces`, and
    // the reconciler escalates to attention once it exceeds limits.max_bounces. NOT NULL DEFAULT 0
    // backfills every existing run_steps row (in-flight runs across the upgrade start at zero).
    sql: `ALTER TABLE run_steps ADD COLUMN bounces INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    version: 10,
    // Pane-death confirmation. When a step's pane is CONFIRMED absent (herdr answered; the pane
    // wasn't listed) the reconciler records when that was first observed instead of respawning
    // immediately; only a second confirmed absence past the confirmation window respawns. NULL =
    // currently believed alive. This is the two-strike guard against a transient herdr blip
    // spawning a duplicate agent into a worktree whose original agent is still working.
    sql: `ALTER TABLE run_steps ADD COLUMN absent_at INTEGER;`,
  },
  {
    version: 11,
    // Transition outbox: source status write-backs are now INTENTS that persist until confirmed
    // delivered, not one-shot best-effort calls. A failed Jira transition used to be logged as
    // "deferred" and then dropped forever — the board's status of record diverged (To Do while a
    // PR was up), and because eligibility queries by status, a torn-down run's still-todo ticket
    // could be claimed AGAIN and merged work re-done. Every intended transition lands here first;
    // the reconciler retries undelivered rows each tick with exponential backoff (attempts /
    // next_attempt_at), in per-run id order so an old intent can't fire after a newer one.
    // UNIQUE(run_id, to_state) makes enqueue idempotent across retried claiming/teardown ticks.
    sql: `
      CREATE TABLE transition_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES runs(id),
        repo TEXT NOT NULL,
        work_source TEXT NOT NULL,
        ticket_key TEXT NOT NULL,
        to_state TEXT NOT NULL
          CHECK (to_state IN ('todo','in_development','in_review','merged','aborted','done')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        delivered_at INTEGER,
        UNIQUE(run_id, to_state)
      );
      CREATE INDEX idx_transition_outbox_pending ON transition_outbox(repo, next_attempt_at) WHERE delivered_at IS NULL;
      CREATE INDEX idx_transition_outbox_key ON transition_outbox(repo, work_source, ticket_key) WHERE delivered_at IS NULL;
    `,
  },
  {
    version: 12,
    // Attention re-notification clock. The one-shot notify on escalation was easy to miss and a
    // parked run then sat invisible indefinitely; the reconciler now re-notifies every
    // limits.attention_renotify_seconds while a run stays parked, tracked here.
    sql: `ALTER TABLE runs ADD COLUMN attention_notified_at INTEGER;`,
  },
  {
    version: 13,
    // Human-reply poll backoff. Waiting runs used to poll their source (a Jira listComments call
    // each) EVERY tick indefinitely — sustained per-minute load that scales with the parked-run
    // count for a reply that takes a human minutes-to-hours. Misses now back the next poll off
    // (60s doubling, capped at 5min), tracked per question. DEFAULT 0 = pre-existing questions
    // are immediately due.
    sql: `
      ALTER TABLE human_questions ADD COLUMN poll_attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE human_questions ADD COLUMN next_poll_at INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 14,
    // Two-phase stale handling. A transition can now report "the item is no longer ours"
    // (deleted/transferred — TransitionResult "stale"): the LOCK-FREE outbox flush only marks the
    // intent delivered + stamps stale_at (mutating the run from there would race the run-locked
    // step machinery); the run-locked Phase A reconcile then consumes unhandled stale intents
    // (abort/park per policy) and stamps stale_handled_at, so one deleted item never double-fires.
    //
    // human_questions.poll_errors counts CONSECUTIVE pollHumanReply throws (reset on success or
    // reply) — distinct from poll_attempts, which counts genuine "no reply yet" misses (a slow
    // human is normal; a persistently-throwing source is not and escalates past a threshold).
    sql: `
      ALTER TABLE transition_outbox ADD COLUMN stale_at INTEGER;
      ALTER TABLE transition_outbox ADD COLUMN stale_handled_at INTEGER;
      ALTER TABLE human_questions ADD COLUMN poll_errors INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX idx_transition_outbox_stale ON transition_outbox(run_id) WHERE stale_at IS NOT NULL AND stale_handled_at IS NULL;
    `,
  },
  {
    version: 15,
    // Capture-attempt safety cap for the evidence step. Each `capture-attempt` signal from an
    // evidence-gathering agent increments this; the reconciler parks the run for attention once it
    // exceeds limits.max_capture_attempts — so a flaky / nondeterministic app can't burn the run in
    // an endless re-record loop. Reset to 0 on each FRESH pass into the step (reconcileStep's forward
    // advance + resumeRun), NOT on crash-recovery respawn (which would let a self-crash game the cap).
    // NOT NULL DEFAULT 0 backfills every existing run_steps row.
    sql: `ALTER TABLE run_steps ADD COLUMN capture_attempts INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    version: 16,
    // Evidence-upload outbox: the S3 media upload is now a durable INTENT retried until it lands, not a
    // one-shot the agent fires. When the AWS SSO session expired mid-run, the upload threw, the CLI
    // hard-failed, the bytes never reached S3, and the PR shipped with broken evidence links. Now the
    // CLI enqueues here (URLs are deterministic, published immediately) + attempts inline; the reconciler
    // retries undelivered rows at Phase 0 with exponential backoff (attempts / next_attempt_at, mirroring
    // transition_outbox) until S3 accepts them — and notifies the human to `aws sso login` when auth keeps
    // failing. `key_prefix` is persisted so retry URLs stay stable. `error_kind` (auth/transient/permanent)
    // drives the dashboard SSO light + the doctor stuck-upload check. `permanent_failed_at` is the single
    // terminal-failure state (no source-stale two-phase machinery — evidence has no "gone at source").
    // `next_attempt_at` doubles as an enqueue LEASE so the CLI's unlocked inline attempt and the server's
    // Phase 0 flush don't double-claim a row. UNIQUE(run_id, key_prefix) keeps enqueue idempotent while
    // still allowing several captures per run (a bounce re-enters evidence with a fresh prefix).
    sql: `
      CREATE TABLE evidence_uploads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES runs(id),
        repo TEXT NOT NULL,
        ticket_key TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        evidence_dir TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_error TEXT,
        error_kind TEXT,
        notified_at INTEGER,
        permanent_failed_at INTEGER,
        abandoned_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        delivered_at INTEGER,
        UNIQUE(run_id, key_prefix)
      );
      CREATE INDEX idx_evidence_uploads_pending ON evidence_uploads(repo, next_attempt_at)
        WHERE delivered_at IS NULL AND permanent_failed_at IS NULL AND abandoned_at IS NULL;
    `,
  },
  {
    version: 17,
    // Dynamic reviewing occupancy — the death of the fixed `watch_hours` deadline. A run in the
    // `reviewing` PR-watch used to hold a max_active_workspaces slot for the WHOLE watch, so
    // `watch_hours` existed only to eventually park it and reclaim that slot (at the cost of also
    // silencing the resolver). Occupancy is now per-run and dynamic: a reviewing run holds a slot
    // ONLY while its resolver agent is actively working. `resolver_active` is that flag — set when a
    // resolver is woken, cleared when its pane goes idle / the PR merges — and countOccupying counts
    // `reviewing AND resolver_active`. A PR can now be watched + auto-resolved for as long as review
    // takes without starving new claims, so the deadline is gone: `watch_deadline` is dropped
    // (nothing reads it). NOT NULL DEFAULT 0 backfills existing runs as "resolver idle" — correct,
    // since a genuinely mid-fix resolver re-asserts the flag on the next tick's pane-state check.
    sql: `
      ALTER TABLE runs ADD COLUMN resolver_active INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE runs DROP COLUMN watch_deadline;
    `,
  },
  {
    version: 18,
    // run_products: PR-watch state (pr_number / resolver_active / last_thread_sig) moves OFF the
    // `runs` table into a per-(run, product) table, so a future plugin product with a watch can
    // carry its own state instead of squatting on run columns. Behavior is UNCHANGED: the store
    // still exposes run.prNumber / resolverActive / lastThreadSig, now backed by this table via a
    // LEFT JOIN on product='pull_request' (absent row ⇒ NULL number/signature, active=0). Backfill
    // every run that had any of the three set into a 'pull_request' row (same transaction), then
    // DROP the now-unread runs columns (SQLite DROP COLUMN, exactly as v17 dropped watch_deadline).
    // UNIQUE(run_id, product) both dedups and indexes the join. Its created_at/updated_at seed from
    // the run's so backfilled rows keep a sensible mtime.
    sql: `
      CREATE TABLE run_products (
        run_id INTEGER NOT NULL REFERENCES runs(id),
        product TEXT NOT NULL,
        number INTEGER,
        active INTEGER NOT NULL DEFAULT 0,
        signature TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(run_id, product)
      );
      INSERT INTO run_products (run_id, product, number, active, signature, created_at, updated_at)
        SELECT id, 'pull_request', pr_number, resolver_active, last_thread_sig, created_at, updated_at
        FROM runs
        WHERE pr_number IS NOT NULL OR resolver_active <> 0 OR last_thread_sig IS NOT NULL;
      ALTER TABLE runs DROP COLUMN pr_number;
      ALTER TABLE runs DROP COLUMN resolver_active;
      ALTER TABLE runs DROP COLUMN last_thread_sig;
    `,
  },
  {
    version: 19,
    // source_auth: per-(repo, source) OAuth tokens for a work source configured with auth.method:
    // oauth (Phase 2). The api_token method keeps its credentials in the per-repo env file and never
    // touches this table. Tokens live in the LOCAL db (WAL, chmod'd) — no secret leaves the machine,
    // consistent with the "local only" guarantee. cloud_id/cloud_url come from Atlassian's
    // accessible-resources (the OAuth API base is https://api.atlassian.com/ex/jira/<cloud_id>).
    // refresh_token ROTATES on every refresh, so it's overwritten in place. PK (repo, source) — one
    // authenticated identity per configured source (INV-9's durable source name is the FK).
    sql: `
      CREATE TABLE source_auth (
        repo TEXT NOT NULL,
        source TEXT NOT NULL,
        method TEXT NOT NULL,
        access_token TEXT,
        refresh_token TEXT,
        expires_at INTEGER,
        cloud_id TEXT,
        cloud_url TEXT,
        scopes TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (repo, source)
      );
    `,
  },
  {
    version: 20,
    // account_label: the authenticated Jira account (whoami /rest/api/3/myself — displayName + email),
    // captured best-effort at login so the dashboard/CLI can show WHICH identity a source is signed in
    // as with no network call. Nullable — set only when the read:jira-user whoami succeeded; a token
    // refresh preserves it (the column isn't part of saveSourceAuth's upsert).
    sql: `ALTER TABLE source_auth ADD COLUMN account_label TEXT;`,
  },
  {
    version: 21,
    // guard_counters: generalize the two single-purpose run_steps counters (bounces / capture_attempts)
    // into one (run, step, guard) table, so a step can carry ANY number of capped guards without a new
    // column — two capped guards on one step would otherwise collide on capture_attempts. The bounce
    // cap now lives here keyed (run, targetStep, 'bounce_cap'); the capture cap keyed (run, step,
    // 'capture_cap'). The old run_steps.bounces / capture_attempts columns are SUPERSEDED and left in
    // place (unread), matching the v2–v3 worker_done/review_done precedent — a one-time counter reset on
    // upgrade is immaterial (they are transient safety backstops, not durable state).
    sql: `
      CREATE TABLE guard_counters (
        run_id INTEGER NOT NULL REFERENCES runs(id),
        step TEXT NOT NULL,
        guard TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, step, guard)
      );
    `,
  },
  {
    version: 22,
    // pending_signals: the non-monotonic agent signals (bounce / ask-human) as durable per-run
    // INTENTS, mirroring the transition outbox. A bounce used to exist only as one in-flight CLI
    // call: if the run's lock stayed contended past the bounded wait (a slow herdr subprocess can
    // hold a reconcile of the same run for minutes), the signal was dropped with no trace — the
    // agent had already been told to stop, and the run degraded to a step_budget park with the
    // findings never acted on. Now the intent is persisted BEFORE the lock is attempted; the
    // immediate apply is just the low-latency path, and reconcileRun consumes any unconsumed intent
    // at the top of each pass, so a contended (or crashed-mid-apply) signal converges on the next
    // tick instead of vanishing. At most one unconsumed intent per run (enforced by
    // supersede-on-enqueue, not an index — a superseded row keeps a consumed_result for the
    // timeline). step-done is NOT here: its done flag is already durable before the nudge.
    sql: `
      CREATE TABLE pending_signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES runs(id),
        repo TEXT NOT NULL,
        ticket_key TEXT NOT NULL,
        signal TEXT NOT NULL CHECK (signal IN ('bounce','ask_human')),
        step TEXT,
        to_step TEXT,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        consumed_at INTEGER,
        consumed_result TEXT
      );
      CREATE INDEX idx_pending_signals_unconsumed ON pending_signals(run_id) WHERE consumed_at IS NULL;
    `,
  },
  {
    version: 23,
    // run_steps.pass: which entry into the step this row's state belongs to — 1 on first entry,
    // bumped on every RE-entry (a bounce rewind opening a rework pass; the forward advance
    // re-entering a cleared intermediate step). Bounces make per-step progress non-monotonic, so a
    // step-done/bounce signal minted for pass N (the commands are rendered into each pass's prompt
    // with --pass N) must not complete or rewind pass N+1 — a duplicated CLI call, a
    // server+fallback double-apply, or an agent re-running a remembered command otherwise lands as
    // a legitimate signal for a pass that never ran. Crash respawns and human resumes CONTINUE a
    // pass (no bump). pending_signals.pass carries the same stamp on a queued bounce so consume-time
    // validation survives the queue delay. Backfill DEFAULT 1 = "first pass", correct for every
    // in-flight run; their already-rendered prompts carry no --pass, which validation treats as
    // "not stamped — skip the pass check" (upgrade safety).
    sql: `
      ALTER TABLE run_steps ADD COLUMN pass INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE pending_signals ADD COLUMN pass INTEGER;
    `,
  },
  {
    version: 24,
    // run_steps.dispatched_at: when the CURRENT pass's prompt actually reached an agent (null = the
    // pass still needs its dispatch). pane_id can no longer carry that meaning alone: it is
    // deliberately KEPT across re-entries as the pane-reuse handle, so after a bounce (or forward
    // re-advance) whose re-dispatch returned "waiting" — the recorded pane died and the configured
    // layout pane isn't resolvable — the row still looked dispatched, reconcileStep skipped the
    // layout-wait branch, and the budget watchdog parked the run on the stale clock with a
    // misleading "over budget (worker: gone)". Keying the spawn branch on dispatched_at routes every
    // undispatched pass through the bounded layout-wait machinery instead. Backfill: any row with a
    // recorded pane is a dispatched pass (started_at is reset at dispatch, so it's the closest
    // truthful stamp) — without this, every in-flight step would be re-prompted on upgrade.
    sql: `
      ALTER TABLE run_steps ADD COLUMN dispatched_at INTEGER;
      UPDATE run_steps SET dispatched_at = started_at WHERE pane_id IS NOT NULL;
    `,
  },
  {
    version: 25,
    // Two uniqueness guarantees the coordination model always assumed but never enforced:
    //
    // (1) runs: at most ONE active run per (repo, work_source, ticket_key). Both claim paths are
    //     check-then-create with a network call between the check and the insert (Phase B's
    //     listEligible, the manual claim's describe()) — and the manual `claim` holds no tick
    //     lock — so two concurrent claimers could each pass activeRunForTicket and create two runs
    //     (two worktrees, two step-1 agents) for one item. The partial unique index makes the DB
    //     the arbiter: the loser's INSERT fails and claimImpl converts that into a friendly
    //     "already claimed" skip. NULL work_source rows (pre-v6 legacy) stay exempt — SQLite
    //     treats NULLs as distinct. Pre-existing duplicate actives (minted by the very race this
    //     closes) are ended as 'abandoned' first, keeping the OLDEST (it owns the worktree the
    //     belt has been driving); the keeper set is materialized into a temp table so the sweep
    //     is not self-referential mid-update.
    //
    // (2) run_steps: exactly ONE row per (run_id, step). upsertRunStep was read-then-insert with
    //     no constraint behind it, and markStepDone runs OUTSIDE the run lock (step-done is the
    //     fire-and-forget monotonic signal), so a cross-process race could double-insert a step
    //     row. Duplicates tracked together (updates hit every copy), so collapsing to the earliest
    //     row loses nothing; the old non-unique index is replaced by a UNIQUE one of the same name
    //     so the store's atomic ON CONFLICT(run_id, step) upsert has its conflict target. An
    //     old-code process still draining through a restart only reads via these columns — an
    //     index swap is invisible to it.
    sql: `
      CREATE TEMP TABLE _v25_keep_runs AS
        SELECT MIN(id) AS id FROM runs WHERE ended_at IS NULL AND work_source IS NOT NULL
         GROUP BY repo, work_source, ticket_key;
      UPDATE runs SET ended_at = unixepoch(), phase = 'done',
                      outcome = COALESCE(outcome, 'abandoned'), updated_at = unixepoch()
       WHERE ended_at IS NULL AND work_source IS NOT NULL
         AND id NOT IN (SELECT id FROM _v25_keep_runs);
      DROP TABLE _v25_keep_runs;
      CREATE UNIQUE INDEX idx_runs_active_ticket ON runs(repo, work_source, ticket_key) WHERE ended_at IS NULL;

      CREATE TEMP TABLE _v25_keep_steps AS SELECT MIN(id) AS id FROM run_steps GROUP BY run_id, step;
      DELETE FROM run_steps WHERE id NOT IN (SELECT id FROM _v25_keep_steps);
      DROP TABLE _v25_keep_steps;
      DROP INDEX IF EXISTS idx_run_steps;
      CREATE UNIQUE INDEX idx_run_steps ON run_steps(run_id, step);
    `,
  },
  {
    version: 26,
    // work_items.last_release: the release an internal-ledger item was last seen/fixed on (the
    // Sentry source records the release of the issue when it materializes the fix). It lets the
    // sentry poll REOPEN a terminal item (merged/done) when the SAME issue recurs on a DIFFERENT
    // release — "we thought we fixed it, but a later release is still hitting it" — instead of the
    // ledger silently suppressing it forever. Nullable: only the sentry source populates it; every
    // other source (and every pre-upgrade row) leaves it NULL, which the reopen check treats as "no
    // release baseline, don't reopen on release alone".
    sql: `ALTER TABLE work_items ADD COLUMN last_release TEXT;`,
  },
  {
    version: 27,
    // transition_outbox gains `to_status`: the SOURCE-NATIVE status key a belt-configured effect
    // delivers (a widened jira `status.<key>` / github `state_labels.<key>` entry), '' for a plain
    // canonical transition. `to_state` STAYS the canonical anchor (its CHECK is untouched — the
    // engine's WorkState vocabulary is unchanged), giving the intent its monotonicity rank; the
    // source resolves the native status from `to_status` when it's set, else maps `to_state`. The
    // uniqueness key widens from (run_id, to_state) to (run_id, to_state, to_status) so a custom
    // status (e.g. QA, anchored at in_review) and a later canonical in_review coexist as distinct
    // intents. SQLite can't ALTER a UNIQUE constraint, so the table is rebuilt (copy → drop →
    // rename), preserving every in-flight intent (expand-only; the whole version is one transaction).
    // `to_status` NOT NULL DEFAULT '' backfills existing rows and keeps NULLs out of the unique key
    // (SQLite treats NULLs as distinct, which would break canonical enqueue idempotence).
    sql: `
      CREATE TABLE transition_outbox_v27 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES runs(id),
        repo TEXT NOT NULL,
        work_source TEXT NOT NULL,
        ticket_key TEXT NOT NULL,
        to_state TEXT NOT NULL
          CHECK (to_state IN ('todo','in_development','in_review','merged','aborted','done')),
        to_status TEXT NOT NULL DEFAULT '',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        delivered_at INTEGER,
        stale_at INTEGER,
        stale_handled_at INTEGER,
        UNIQUE(run_id, to_state, to_status)
      );
      INSERT INTO transition_outbox_v27
        (id, run_id, repo, work_source, ticket_key, to_state, to_status, attempts, next_attempt_at,
         last_error, created_at, updated_at, delivered_at, stale_at, stale_handled_at)
        SELECT id, run_id, repo, work_source, ticket_key, to_state, '', attempts, next_attempt_at,
               last_error, created_at, updated_at, delivered_at, stale_at, stale_handled_at
          FROM transition_outbox;
      DROP TABLE transition_outbox;
      ALTER TABLE transition_outbox_v27 RENAME TO transition_outbox;
      CREATE INDEX idx_transition_outbox_pending ON transition_outbox(repo, next_attempt_at) WHERE delivered_at IS NULL;
      CREATE INDEX idx_transition_outbox_key ON transition_outbox(repo, work_source, ticket_key) WHERE delivered_at IS NULL;
      CREATE INDEX idx_transition_outbox_stale ON transition_outbox(run_id) WHERE stale_at IS NOT NULL AND stale_handled_at IS NULL;
    `,
  },
  {
    version: 28,
    // Two de-aliasing fixes, both expand-only:
    //
    // (1) runs.attention_reason_code — the MACHINE reason code of a run's most recent attention
    //     park, previously recoverable only by JSON-parsing the run's latest `attention` event.
    //     That readback was load-bearing routing state (it selects a park's rescue class:
    //     step-done rescue / bounded respawn / human-only) living in an audit table; it becomes a
    //     first-class column, written by escalateAttention and backfilled here from the events log
    //     (json_valid-guarded — `detail` is engine-written JSON, but an audit row must never brick
    //     a migration). The events rows are untouched (the timeline keeps its gold), and reads keep
    //     an event-log fallback for one release so a park written by a still-draining OLD-code
    //     process around the upgrade restart stays routable. The backfill is SCOPED to runs parked
    //     at upgrade time (phase='attention' — their latest attention event IS their current park):
    //     stamping every run would plant a STALE code on a healthy run, which then SHADOWS a fresher
    //     old-code park during the drain window (the fallback only fires on NULL) and misroutes its
    //     rescue class for the park's whole lifetime. A healthy run needs no carry-over — new code
    //     writes the column at its next park.
    //
    // (2) run_steps.baseline_sig + baseline_frozen_at — the read-only guard's enforcement baseline
    //     (the HEAD sha it tracks-until-frozen, and the freeze marker) used to ALIAS the commit
    //     heartbeat's progress_sig/progress_at, safe only because config rejects heartbeat +
    //     read_only on one step — an aliasing trap for every reader, and it forced each
    //     heartbeat-clock reset site to double as a baseline reset. The baseline gets its own
    //     columns. Backfill copies progress_sig/progress_at into them for EVERY row: a heartbeat
    //     step's copy is inert (only the read-only enforcement branch reads baselines, keyed on the
    //     step's posture), and an in-flight read-only step's live baseline — tracking or frozen —
    //     carries over exactly, so no run parks (or absorbs a violation) across the upgrade.
    sql: `
      ALTER TABLE runs ADD COLUMN attention_reason_code TEXT;
      UPDATE runs SET attention_reason_code = (
        SELECT json_extract(e.detail, '$.reason') FROM events e
        WHERE e.run_id = runs.id AND e.type = 'attention' AND e.detail IS NOT NULL AND json_valid(e.detail)
        ORDER BY e.id DESC LIMIT 1
      ) WHERE phase = 'attention';
      ALTER TABLE run_steps ADD COLUMN baseline_sig TEXT;
      ALTER TABLE run_steps ADD COLUMN baseline_frozen_at INTEGER;
      UPDATE run_steps SET baseline_sig = progress_sig, baseline_frozen_at = progress_at;
    `,
  },
  {
    version: 29,
    // The INTENT LEDGER: one durable-intent table for the deliver lane, absorbing (kind by kind,
    // leaf-first across releases) the four outbox-shaped tables that each re-typed the same
    // scheduling spine — evidence_uploads, pending_signals, human_questions' scheduling half, and
    // transition_outbox last (it gates claiming). Rows carry only the SHARED facts (due time,
    // attempts, lease, terminal status, cause key, notify throttle, the two-phase handoff);
    // everything kind-specific — ordering (FIFO-per-scope / latest-wins / independent), backoff
    // curves, delivery, run reactions — stays code in the INTENT_KINDS registry, dispatched by the
    // kernel (src/core/ledger.ts). `status='waiting'` + deadline_at is the genuinely new
    // capability: a first-class "wait for an external trigger" row resolved by POST /fulfil (a
    // webhook, a CI callback) or escalated when its deadline passes.
    //
    // UNIQUE(kind, scope, dedup_key) makes enqueue idempotent (re-enqueue re-opens, keeping `seq`
    // so a re-opened row holds its original FIFO slot — seq is stamped = id on first insert).
    // Expand-only: nothing existing is touched; the kinds cut over in later versions.
    sql: `
      CREATE TABLE intents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL,
        kind TEXT NOT NULL,
        scope TEXT NOT NULL,
        run_id INTEGER REFERENCES runs(id),
        ticket_key TEXT,
        dedup_key TEXT NOT NULL DEFAULT '',
        seq INTEGER NOT NULL DEFAULT 0,
        payload TEXT NOT NULL DEFAULT '{}',
        state TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
          ('pending','waiting','delivered','superseded','failed','abandoned')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        lease_until INTEGER,
        deadline_at INTEGER,
        last_error TEXT,
        error_class TEXT CHECK (error_class IN ('auth','transient','permanent','stale')),
        cause_scope TEXT,
        notified_at INTEGER,
        handoff_at INTEGER,
        handoff_marker TEXT,
        consumed_at INTEGER,
        consumed_result TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        resolved_at INTEGER,
        UNIQUE(kind, scope, dedup_key)
      );
      CREATE INDEX idx_intents_due ON intents(repo, next_attempt_at) WHERE status = 'pending';
      CREATE INDEX idx_intents_waiting ON intents(repo, deadline_at) WHERE status = 'waiting';
      CREATE INDEX idx_intents_handoff ON intents(run_id) WHERE handoff_at IS NOT NULL AND consumed_at IS NULL;
      CREATE INDEX idx_intents_cause ON intents(repo, cause_scope) WHERE status IN ('pending','waiting');
      CREATE INDEX idx_intents_run ON intents(run_id) WHERE status IN ('pending','waiting');
    `,
  },
  {
    version: 30,
    // evidence_publish cuts over to the ledger: every still-pending evidence upload is CONVERTED
    // to an `evidence_publish` intent (preserving its attempts/backoff/error/notify clocks — an
    // auth-stuck row stays auth-stuck and requeues the moment SSO recovers), then the old rows are
    // closed as migrated so a still-draining old-code flush finds nothing due (a row it had
    // already claimed mid-pass can still double-deliver — harmless: the publish is an idempotent
    // re-put of the same keys). cause_scope is stamped 'publisher:s3' unconditionally: only S3
    // classifies `auth` (the only class the cause requeue targets), so the label is inert for
    // local/command rows. New code never writes evidence_uploads again; its reads stay as a union
    // for one release, and the table drops in a later contract migration.
    sql: `
      INSERT INTO intents (repo, kind, scope, run_id, ticket_key, dedup_key, payload, status, attempts,
                           next_attempt_at, last_error, error_class, cause_scope, notified_at, created_at, updated_at)
      SELECT repo, 'evidence_publish', 'run:' || run_id, run_id, ticket_key, key_prefix,
             json_object('keyPrefix', key_prefix, 'evidenceDir', evidence_dir),
             'pending', attempts, next_attempt_at, last_error, error_kind, 'publisher:s3', notified_at,
             created_at, unixepoch()
        FROM evidence_uploads
       WHERE delivered_at IS NULL AND permanent_failed_at IS NULL AND abandoned_at IS NULL;
      UPDATE intents SET seq = id WHERE seq = 0;
      UPDATE evidence_uploads SET abandoned_at = unixepoch(), last_error = 'migrated to the intent ledger (v30)'
       WHERE delivered_at IS NULL AND permanent_failed_at IS NULL AND abandoned_at IS NULL;
    `,
  },
  {
    version: 31,
    // agent_signal cuts over to the ledger: every unconsumed pending_signals row (a queued
    // bounce/ask-human whose apply lost the run-lock race and is owed to the next reconcile pass)
    // converts to an `agent_signal` intent — status 'waiting' with the 'signal' handoff already
    // stamped, exactly the shape enqueuePendingSignal now writes — then the legacy rows close.
    // The store's pending-signal methods became ADAPTERS over the ledger (same domain shapes, so
    // signals.ts / consumePendingSignal are unchanged), with a lazy drain of any legacy row a
    // still-draining old-code process enqueues around the upgrade. The legacy table drops in a
    // later contract migration.
    sql: `
      INSERT INTO intents (repo, kind, scope, run_id, ticket_key, dedup_key, payload, status,
                           handoff_at, handoff_marker, created_at, updated_at)
      SELECT repo, 'agent_signal', 'run:' || run_id, run_id, ticket_key, 'legacy-' || id,
             json_object('signal', signal, 'step', step, 'toStep', to_step, 'body', payload, 'pass', pass),
             'waiting', unixepoch(), 'signal', created_at, unixepoch()
        FROM pending_signals
       WHERE consumed_at IS NULL;
      UPDATE intents SET seq = id WHERE seq = 0;
      UPDATE pending_signals SET consumed_at = unixepoch(), consumed_result = 'superseded: migrated to the intent ledger (v31)'
       WHERE consumed_at IS NULL;
    `,
  },
  {
    version: 32,
    // The human-question SCHEDULING cuts over to the ledger (kind `human_reply_poll`): each
    // pending question gets one `waiting` row carrying its poll clock — next_attempt_at (was
    // next_poll_at), state.pollAttempts (was poll_attempts) and attempts (was poll_errors) — so a
    // mid-backoff question polls at exactly the cadence it had, and a mid-escalation error run
    // keeps its count. The DOMAIN row stays in human_questions (question/answer/external ids);
    // its legacy poll columns freeze (unread by new code). A pending question with no ledger row
    // (written by a draining old-code process around the upgrade) is armed lazily on first read.
    sql: `
      INSERT INTO intents (repo, kind, scope, run_id, ticket_key, dedup_key, payload, state, status,
                           attempts, next_attempt_at, created_at, updated_at)
      SELECT repo, 'human_reply_poll', 'run:' || run_id, run_id, ticket_key, 'q-' || id,
             json_object('questionId', id), json_object('pollAttempts', poll_attempts),
             'waiting', poll_errors, next_poll_at, created_at, unixepoch()
        FROM human_questions
       WHERE status = 'pending';
      UPDATE intents SET seq = id WHERE seq = 0;
    `,
  },
  {
    version: 33,
    // source_transition cuts over to the ledger — the LAST legacy outbox, deliberately (it gates
    // claiming and feeds effect ranks). Undelivered write-backs convert to pending intents with
    // their attempts/backoff clocks intact and their per-run order preserved (the INSERT..SELECT
    // is ordered (run_id, id) and seq = id at insert, so FIFO slots reproduce the legacy id
    // order); unhandled-stale rows convert to resolved intents still OWING their 'stale' handoff,
    // so the run-locked stale policy fires exactly once post-upgrade. The legacy rows close; a row
    // a draining old-code process writes afterward is converted by drainLegacyTransitions in the
    // transition flow's Phase-0 prePass. The store's transition methods are now ADAPTERS over the
    // ledger — deliverTransition, the FIFO gate, the Phase-B claim veto and fireEffect's rank scan
    // kept their exact code. transition_outbox drops in a later contract migration.
    sql: `
      INSERT INTO intents (repo, kind, scope, run_id, ticket_key, dedup_key, payload, status, attempts,
                           next_attempt_at, last_error, cause_scope, created_at, updated_at)
      SELECT repo, 'source_transition', 'run:' || run_id, run_id, ticket_key, to_state || ':' || to_status,
             json_object('toState', to_state, 'toStatus', to_status, 'workSource', work_source),
             'pending', attempts, next_attempt_at, last_error, 'source:' || work_source, created_at, unixepoch()
        FROM transition_outbox WHERE delivered_at IS NULL ORDER BY run_id, id;
      INSERT INTO intents (repo, kind, scope, run_id, ticket_key, dedup_key, payload, status, attempts,
                           next_attempt_at, last_error, error_class, cause_scope, handoff_at, handoff_marker,
                           resolved_at, created_at, updated_at)
      SELECT repo, 'source_transition', 'run:' || run_id, run_id, ticket_key, to_state || ':' || to_status,
             json_object('toState', to_state, 'toStatus', to_status, 'workSource', work_source),
             'delivered', attempts, next_attempt_at, last_error, 'stale', 'source:' || work_source,
             stale_at, 'stale', delivered_at, created_at, unixepoch()
        FROM transition_outbox WHERE delivered_at IS NOT NULL AND stale_at IS NOT NULL AND stale_handled_at IS NULL
        ORDER BY run_id, id;
      UPDATE intents SET seq = id WHERE seq = 0;
      UPDATE transition_outbox
         SET delivered_at = COALESCE(delivered_at, unixepoch()),
             stale_handled_at = CASE WHEN stale_at IS NOT NULL AND stale_handled_at IS NULL THEN unixepoch() ELSE stale_handled_at END,
             last_error = 'migrated to the intent ledger (v33)', updated_at = unixepoch()
       WHERE delivered_at IS NULL OR (stale_at IS NOT NULL AND stale_handled_at IS NULL);
    `,
  },
  {
    version: 34,
    // watch_state: one row per (run, step, watch) — each harness-evaluated watch owns its clock,
    // completing the de-aliasing the baseline columns (v28) started. `sig` + `based_at` carry the
    // watch's signature and clock (budget: based_at = the budget window's base; heartbeat:
    // sig/based_at = last-seen HEAD + when; read_only: sig = the enforcement baseline, based_at =
    // the freeze marker, null while tracking); `meta` is watch-owned JSON for anything richer. A
    // PLUGIN watch now stores state without a migration — the point of the table. run_steps'
    // started_at stays (it is ALSO the layout-wait window + dispatch bookkeeping, seeded into the
    // budget row here); progress_* and baseline_* freeze as legacy columns, read only as the lazy
    // fallback for rows a draining old-code process touches (evaluators NEVER delete a watch row —
    // re-bases write nulls — so the fallback can't resurrect a cleared clock).
    sql: `
      CREATE TABLE watch_state (
        run_id INTEGER NOT NULL REFERENCES runs(id),
        step TEXT NOT NULL,
        watch TEXT NOT NULL,
        sig TEXT,
        based_at INTEGER,
        meta TEXT NOT NULL DEFAULT '{}',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, step, watch)
      );
      INSERT INTO watch_state (run_id, step, watch, sig, based_at, updated_at)
        SELECT run_id, step, 'heartbeat', progress_sig, progress_at, unixepoch()
          FROM run_steps WHERE progress_sig IS NOT NULL OR progress_at IS NOT NULL;
      INSERT INTO watch_state (run_id, step, watch, sig, based_at, updated_at)
        SELECT run_id, step, 'read_only', baseline_sig, baseline_frozen_at, unixepoch()
          FROM run_steps WHERE baseline_sig IS NOT NULL OR baseline_frozen_at IS NOT NULL;
      INSERT INTO watch_state (run_id, step, watch, sig, based_at, updated_at)
        SELECT run_id, step, 'budget', NULL, started_at, unixepoch()
          FROM run_steps WHERE started_at IS NOT NULL;
    `,
  },
  {
    version: 35,
    // CONTRACT PHASE for the v29–v34 cutovers. Expand/contract discipline (§14): v29–v34 moved the
    // deliver lane onto the intent ledger and the observe lane onto watch_state, but kept the legacy
    // storage alive for ONE release as drain-window shims — a still-draining old-code process could
    // still write a row, and new code read it (unions, lazy drains, frozen-column fallbacks). That
    // release is deployed everywhere, so nothing writes these anymore and the reads go with them.
    //
    // The three outbox-shaped tables drop whole (their live rows converted in v30/v31/v33). The
    // frozen COLUMNS drop too — a column no code reads is not free: it is a second place a clock
    // can appear to live, which is exactly the aliasing v28/v34 spent two migrations undoing.
    // human_questions keeps its domain half (question/answer/external ids); only the scheduling
    // columns v32 moved to the ledger go. run_steps keeps started_at (still the layout-wait window
    // + dispatch bookkeeping); only the watch clocks v34 moved to watch_state go.
    //
    // Plain DROP COLUMN, no table rebuild: none of these columns is indexed, PK, UNIQUE, or named
    // in a CHECK or partial-index predicate, so SQLite (3.35+) drops them in place — verified
    // against a real database, foreign_key_check and integrity_check clean.
    sql: `
      DROP TABLE transition_outbox;
      DROP TABLE evidence_uploads;
      DROP TABLE pending_signals;
      ALTER TABLE human_questions DROP COLUMN poll_attempts;
      ALTER TABLE human_questions DROP COLUMN poll_errors;
      ALTER TABLE human_questions DROP COLUMN next_poll_at;
      ALTER TABLE run_steps DROP COLUMN progress_sig;
      ALTER TABLE run_steps DROP COLUMN progress_at;
      ALTER TABLE run_steps DROP COLUMN baseline_sig;
      ALTER TABLE run_steps DROP COLUMN baseline_frozen_at;
    `,
  },
  {
    version: 36,
    // SUSPENSION: retries are now a flat 30s interval capped at MAX_RETRY_ATTEMPTS (10) — the
    // exponential backoff (60s doubling to 1h) is gone. A pending intent that exhausts the cap
    // stamps `suspended_at` and stops being due: still status 'pending' (the obligation stands —
    // it keeps blocking claims and per-run FIFO order, and the status CHECK needs no rebuild),
    // but the due queries skip it until an operator (`retry-now` / `s` on the TUI board) or a
    // cause-recovery probe clears the stamp and resets `attempts`. Expand-only: NULL everywhere,
    // and rows mid-backoff simply become due on the new flat clock.
    sql: `
      ALTER TABLE intents ADD COLUMN suspended_at INTEGER;
      CREATE INDEX idx_intents_suspended ON intents(repo) WHERE suspended_at IS NOT NULL AND status = 'pending';
    `,
  },
  {
    version: 37,
    // The PROBLEM LEDGER: one generic table of currently-open mechanical problems per repo,
    // recorded BY the machinery that observes them (the auth gate, a failing intent delivery, the
    // evidence creds probe) and cleared by the same machinery on recovery. The dashboard's red
    // repo light reads this — it never has to re-check anything on load. `key` is the problem's
    // stable identity (upsert target — 'source:<name>', 'publisher:<type>', anything a future
    // reporter chooses); `kind` the coarse class for grouping; `detail` the human text with the
    // fix hint. A row present = the problem is open NOW; history lives in events, not here.
    sql: `
      CREATE TABLE problems (
        repo TEXT NOT NULL,
        key TEXT NOT NULL,
        kind TEXT NOT NULL,
        detail TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (repo, key)
      );
    `,
  },
  {
    version: 38,
    // BRANCH STOPS BEING THE RUN'S IDENTITY. `worktree_name` freezes the name the worktree +
    // workspace were created under (the rendered `workspace_name`) — what the layout hook matches a
    // worktree by, and what teardown must still reap — while `branch` becomes TRACKED state: the
    // branch the worktree is currently ON, which an agent may rename to the repo's branch
    // convention mid-run (`herdr-factory set-branch`, or a bare `git branch -m` the engine
    // follows). Expand-only, and the backfill is EXACT: until this migration the two were the same
    // string by construction (the claim rendered one name and created the worktree from it).
    sql: `
      ALTER TABLE runs ADD COLUMN worktree_name TEXT;
      UPDATE runs SET worktree_name = branch WHERE worktree_name IS NULL;
    `,
  },
  {
    version: 39,
    // GATE RECEIPTS. A belt re-ran the same verification command (full spec, unit, typecheck) up to
    // six times on one unchanged SHA, because each step could only discover an earlier step's gates
    // by running them again. A receipt makes "this command was run, at this commit, with this exit
    // code" a FACT the next step reads instead of re-derives.
    // The UNIQUE key is (run, gate, head) — not (run, step, pass, gate) — because the SHA is what
    // makes a receipt trustworthy: two steps running the same gate at the same commit are the SAME
    // fact, and the second write supersedes the first rather than accumulating duplicates. `step` +
    // `pass` are recorded (they attribute the shell time the step-done timing export reads), not
    // part of the identity. ON DELETE CASCADE is rollback safety: pre-PR purge code does not
    // delete from gate_receipts, and PRAGMA foreign_keys = ON would otherwise fail the run delete.
    sql: `
      CREATE TABLE gate_receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        step TEXT NOT NULL,
        pass INTEGER NOT NULL DEFAULT 1,
        gate TEXT NOT NULL,
        command TEXT NOT NULL,
        head TEXT NOT NULL,
        exit_code INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        tail TEXT,
        ran_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX idx_gate_receipts ON gate_receipts(run_id, gate, head);
    `,
  },
  {
    version: 40,
    // repos.claim_deferrals: how many CONSECUTIVE ticks this repo's Phase B gave up on the
    // `machine:claim` lock without reaching claimNewWork. A bounded wait now makes that rare, but
    // when it does happen it is invisible starvation (issue #72: one repo lost the same lockstep
    // race every minute for four hours), so the count is durable state the out-of-process
    // `status` / `explain` can read and report. Cleared by every Phase B pass that does not defer
    // on the lock (not only a later successful claim).
    sql: `
      ALTER TABLE repos ADD COLUMN claim_deferrals INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 41,
    // human_questions.status gains 'abandoned': a run that ends (done / torn down) closes its
    // still-pending question (Store.endRun) instead of leaving it `pending` forever. SQLite can't
    // ALTER a CHECK, so the table is rebuilt (copy → drop → rename, as v7 did for work_items);
    // nothing REFERENCES human_questions, and its three indexes are recreated. Pending questions of
    // runs that ALREADY ended are closed here, with their live poll-clock ledger rows.
    sql: `
      CREATE TABLE human_questions_v41 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES runs(id),
        repo TEXT NOT NULL,
        work_source TEXT NOT NULL,
        ticket_key TEXT NOT NULL,
        step TEXT,
        question TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending','answered','abandoned')),
        external_id TEXT,
        external_created_at TEXT,
        answer TEXT,
        answer_external_id TEXT,
        answer_author TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        answered_at INTEGER
      );
      INSERT INTO human_questions_v41 (id, run_id, repo, work_source, ticket_key, step, question, status, external_id,
                                       external_created_at, answer, answer_external_id, answer_author, created_at, updated_at, answered_at)
        SELECT id, run_id, repo, work_source, ticket_key, step, question, status, external_id,
               external_created_at, answer, answer_external_id, answer_author, created_at, updated_at, answered_at
          FROM human_questions;
      DROP TABLE human_questions;
      ALTER TABLE human_questions_v41 RENAME TO human_questions;
      CREATE INDEX idx_human_questions_pending ON human_questions(repo, status);
      CREATE INDEX idx_human_questions_run ON human_questions(run_id, status);
      CREATE UNIQUE INDEX idx_human_questions_one_pending_run ON human_questions(run_id) WHERE status = 'pending';
      UPDATE intents SET status = 'abandoned', resolved_at = unixepoch(), updated_at = unixepoch()
       WHERE kind = 'human_reply_poll' AND status IN ('waiting','pending')
         AND run_id IN (SELECT id FROM runs WHERE ended_at IS NOT NULL);
      UPDATE human_questions SET status = 'abandoned', updated_at = unixepoch()
       WHERE status = 'pending' AND run_id IN (SELECT id FROM runs WHERE ended_at IS NOT NULL);
    `,
  },
];

/** Apply pending migrations in a transaction. Idempotent. */
export function migrate(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as
    | { v: number | null }
    | undefined;
  const current = row?.v ?? 0;

  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    tx(db, () => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(m.version);
    });
  }
}
