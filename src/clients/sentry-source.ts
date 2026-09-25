// The sentry work source: Sentry issues (production errors) polled by a configured filter
// (organization + projects + environment + a Sentry search query), driven to a fix PR.
//
// STATUS OF RECORD: INTERNAL (like local_markdown). Sentry has no Jira-style status or GitHub-style
// label to mark "being worked on", so the lifecycle (todo -> in_development -> in_review ->
// merged|aborted|done) is tracked in herdr-factory's own `work_items` table and the Sentry issue is
// NEVER mutated for lifecycle. The ONE optional Sentry-side write is a courtesy write-back at merge
// (on_merge: comment | resolve | resolve_in_next_release | none), driven by config.
//
// REPLY CHANNEL: comments (Sentry issue notes). ask-human questions + attention notes post as notes
// on the issue and replies are polled from them (marker-tagged, blockquote-aware — INV-6). NB the
// notes API (/issues/{id}/comments/) is a stable-in-practice but publish_status=PRIVATE endpoint —
// functional across SaaS + self-hosted, but not in the public API reference.
//
// ELIGIBILITY: the source's config query IS the filter (no per-belt pickup label — the descriptor
// declares no pickupLabel, so belts on a sentry source carry no `label` and route via `match`/
// priority, exactly like local_markdown). Items already claimed (a non-todo work_items row, or an
// active run) are filtered out — the internal ledger is what satisfies INV-1 re-claim convergence.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bearsHerdrMarker, DEFAULT_BRAND, isReplyAuthor, markerPrefix, markerPrefixes, type Logger, type SourceAuthStatus, type WorkSource, type WorkSourceSpec } from "../core/deps.ts";
import type { Store } from "../db/store.ts";
import {
  StaleItemError,
  type HumanAskInput,
  type HumanAskResult,
  type HumanPollInput,
  type HumanReply,
  type MatchItem,
  type SentryMatchItem,
  type Ticket,
  type TransitionContext,
  type TransitionResult,
  type WorkDocInfo,
  type WorkState,
} from "../types.ts";
import { isSentryNotFound, type SentryClient, type SentryEvent, type SentryIssue } from "./sentry.ts";

/** Resolved sentry-source config (the descriptor maps YAML onto it). `projects`/`environment` are
 *  [] when unset (all projects / all environments); `query` defaults to `is:unresolved`. */
export interface SentrySourceCfg {
  /** `human_reply.authors`, lowercased; undefined ⇒ any author may answer a question (issue #123). */
  replyAuthors?: string[];
  baseUrl: string;
  organization: string;
  projects: string[]; // project slugs; [] = all accessible projects
  environment: string[]; // [] = all environments
  query: string; // Sentry issue search string
  statsPeriod: string; // window of activity to consider (e.g. "14d")
  onMerge: "comment" | "none" | "resolve" | "resolve_in_next_release";
}

/** INV-7 key safety: a Sentry issue id is a numeric string (always safe), but guard defensively. */
const SAFE_KEY = /^[A-Za-z0-9._-]+$/;

/** Terminal ledger states a recurrence on a NEW release should REOPEN. in_development / in_review are
 *  actively being worked (never yank them); aborted was deliberately abandoned (don't auto-reopen);
 *  todo is already eligible. So only these two — the "we shipped a fix" states — can be re-admitted. */
const REOPENABLE_STATES = new Set<WorkState>(["merged", "done"]);

/** Cap on issue-DETAIL fetches spent chasing a release baseline for Sentry-flagged regressions in one
 *  poll. The org issues LIST endpoint omits the release, so confirming a regressed terminal item's
 *  release costs one detail call each; bound it so a burst of regressions can't blow the tick's Sentry
 *  budget (Sentry rate-limits REST polling hard). The overflow is re-checked on the next poll. */
const MAX_REGRESSION_PROBES_PER_POLL = 20;

const questionMarker = (brand: string): string => `${markerPrefix(brand)} question:`;
const mergedNotePrefix = (brand: string): string => `${markerPrefix(brand)}] Fixed by`;

/** Neutralize untrusted text before it reaches an agent prompt (INV-4; the raw payload stays in
 *  issue.json). Sentry titles/messages/stacktraces/tags are ATTACKER-INFLUENCED — an exception value
 *  or a request URL can be anything a crafted request produced — and the work agent runs with
 *  --dangerously-skip-permissions, so a prompt-injection here is high-impact. Every rendered value
 *  goes through this: strip HTML comments + control/invisible/bidi chars, neutralize markdown
 *  code-fence breakout (a ``` inside a value can't close our fence), and collapse ALL whitespace
 *  (incl. newlines) to single spaces so a multi-line value can't inject its own markdown
 *  headings/lines into the single-line + fenced contexts it is rendered in. */
function sanitize(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
    .replace(/`{3,}/g, "``") // a run of 3+ backticks would break out of a ``` fence — collapse it
    .replace(/\s+/g, " ")
    .trim();
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function humanQuestionComment(input: HumanAskInput, brand: string): string {
  return [
    `${questionMarker(brand)} ${input.repo}/${input.runId}/${input.questionId}]`,
    `Work item: ${input.key}`,
    `Step: ${input.step ?? "unknown"}`,
    "",
    input.question.trim(),
    "",
    `Reply in a NEW comment on this Sentry issue — ${brand} resumes automatically when it sees the reply.`,
  ].join("\n");
}

export class SentrySource implements WorkSource {
  private readonly cfg: SentrySourceCfg;
  private readonly sentry: SentryClient;
  private readonly store: Store;
  private readonly repo: string;
  private readonly name: string;
  private readonly log: Logger;
  private readonly brand: string; // what our comments call the factory (source_comments.brand)

  constructor(cfg: SentrySourceCfg, sentry: SentryClient, store: Store, repo: string, name: string, log: Logger = () => {}, brand: string = DEFAULT_BRAND) {
    this.cfg = cfg;
    this.sentry = sentry;
    this.store = store;
    this.repo = repo;
    this.name = name;
    this.log = log;
    this.brand = brand;
  }

  readonly spec: WorkSourceSpec = {
    statusOfRecord: "internal",
    mappedStates: ["todo", "in_development", "in_review", "merged", "aborted", "done"],
    replyChannel: "comments",
    terminalAutomation: "lifecycle tracked internally; Sentry issues are never moved (optional on_merge write-back only)",
  };

  /** Local (no-network) auth readiness: is a token present? A present-but-rejected token still
   *  reads "ok" here; a live 401/403 surfaces it as rejected (INV-12). */
  async authStatus(): Promise<SourceAuthStatus> {
    return this.sentry.authStatus();
  }

  /** Ticket.type drives the branch prefix (fix|chore|feature). Sentry surfaces bugs to fix, so
   *  errors map to "Bug" (-> fix/). */
  private typeOf(issue: SentryIssue): string {
    return issue.issueCategory === "performance" ? "Performance" : "Bug";
  }

  private summaryOf(issue: SentryIssue): string {
    return (
      issue.title ||
      issue.metadata?.value ||
      issue.metadata?.type ||
      issue.culprit ||
      `Sentry issue ${issue.shortId ?? issue.id}`
    ).trim();
  }

  private toItem(issue: SentryIssue): SentryMatchItem {
    const rawCount = typeof issue.count === "string" ? Number(issue.count) : issue.count;
    return {
      sourceType: "sentry",
      key: issue.id,
      displayKey: issue.shortId ?? issue.id,
      url: issue.permalink ?? undefined,
      summary: this.summaryOf(issue) || `Sentry issue ${issue.id}`,
      type: this.typeOf(issue),
      labels: [], // Sentry issues have no labels — [] keeps match predicates source-uniform
      fields: issue as Record<string, unknown>,
      shortId: issue.shortId ?? null,
      project: issue.project?.slug ?? "",
      status: issue.status ?? "unresolved",
      level: issue.level ?? null,
      culprit: issue.culprit ?? null,
      count: Number.isFinite(rawCount as number) ? (rawCount as number) : null,
      userCount: issue.userCount ?? null,
      permalink: issue.permalink ?? null,
    };
  }

  /** The release an issue was last seen on (its `lastRelease.version`), or null when absent/blank.
   *  Present on the issue DETAIL payload; the org issues LIST payload omits it (→ null there). */
  private releaseOf(issue: SentryIssue): string | null {
    const v = issue.lastRelease?.version;
    return typeof v === "string" && v.trim() ? v.trim() : null;
  }

  async listEligible(): Promise<MatchItem[]> {
    const issues = await this.sentry.listIssues({
      projects: this.cfg.projects,
      environment: this.cfg.environment,
      query: this.cfg.query,
      statsPeriod: this.cfg.statsPeriod,
    });
    const out: SentryMatchItem[] = [];
    let probes = 0;
    let probesDeferred = 0;
    for (const issue of issues) {
      const key = issue.id;
      if (!key || !SAFE_KEY.test(key)) {
        this.log("warn", `sentry: skipping issue with unusable id "${key}" (${issue.shortId ?? "?"})`);
        continue;
      }
      // Internal ledger gates eligibility (INV-1): a non-todo status = already claimed/terminal.
      const wi = this.store.getWorkItem(this.repo, this.name, key);
      const status = wi?.status ?? "todo";
      if (status !== "todo") {
        // A previously-handled issue is normally suppressed by the ledger forever. REOPEN it when the
        // same Sentry issue recurs on a DIFFERENT release than the one we fixed it on — the "we
        // thought we fixed it, but a later release still hits it" regression. Only merged/done reopen
        // (see REOPENABLE_STATES); everything else stays suppressed.
        if (!REOPENABLE_STATES.has(status)) continue;
        const regressed = issue.substatus === "regressed";
        let current = this.releaseOf(issue); // list payload omits release → usually null here
        if (current == null && regressed) {
          // Sentry itself flags a regression but the list payload carries no release: spend one
          // bounded detail call to learn which release re-introduced it (overflow retried next poll).
          if (probes < MAX_REGRESSION_PROBES_PER_POLL) {
            probes += 1;
            try {
              current = this.releaseOf(await this.sentry.getIssue(key));
            } catch (e) {
              this.log("warn", `sentry: could not fetch issue ${key} to check its release for reopen: ${errMsg(e)}`);
            }
          } else {
            probesDeferred += 1;
          }
        }
        const prior = wi?.lastRelease ?? null;
        const releaseMoved = current != null && prior != null && current !== prior;
        // Reopen when the release moved, OR when Sentry flags a regression and we hold no release
        // baseline to compare against (trust Sentry's own regression detection as the fallback).
        if (!releaseMoved && !(regressed && prior == null)) continue;
        // Reopen by RESETTING the ledger row to todo (NOT deleting it) — the resilient choice: the
        // row's id/history survive, the reset is an idempotent transition, and re-materialize will
        // re-stamp the new release so the next poll sees a fresh baseline (no re-trigger loop).
        this.store.setWorkItemStatus(this.repo, this.name, key, "todo", { lastRelease: current });
        this.log("info", `sentry: reopening ${issue.shortId ?? key} — recurred on release ${current ?? "(unknown)"} (last fixed on ${prior ?? "unknown"})`);
      }
      // Backstop over the run-table dedup (covers the claim -> in_development write window).
      if (this.store.activeRunForTicket(this.repo, this.name, key)) continue;
      out.push(this.toItem(issue));
    }
    if (probesDeferred) {
      this.log("info", `sentry: ${probesDeferred} more regressed issue(s) not release-checked this poll (probe cap ${MAX_REGRESSION_PROBES_PER_POLL}) — retried next poll`);
    }
    return out;
  }

  async describe(key: string): Promise<Ticket> {
    // Accept either the numeric id or a shortId (e.g. "BACKEND-1AB"); the canonical key is the
    // numeric id (INV-11 — the engine re-dedups on what we return).
    let issue: SentryIssue;
    if (/^\d+$/.test(key)) {
      issue = await this.sentry.getIssue(key);
    } else {
      const resolved = await this.sentry.resolveShortId(key);
      if (!resolved) throw new Error(`sentry: no issue for "${key}" in organization ${this.cfg.organization}`);
      issue = await this.sentry.getIssue(resolved.id);
    }
    return { key: issue.id, displayKey: issue.shortId ?? issue.id, url: issue.permalink ?? undefined, summary: this.summaryOf(issue), type: this.typeOf(issue) };
  }

  async transition(key: string, to: WorkState, _pickupLabel?: string, ctx?: TransitionContext): Promise<TransitionResult> {
    // Tolerant idempotent upsert of the internal ledger — any state -> any state, noop if already
    // there. `stale` is never returned: the ledger row is ours, so a write always applies.
    const moved = this.store.setWorkItemStatus(this.repo, this.name, key, to);
    // The one optional Sentry-side write-back, at PR merge only. Best-effort: a Sentry hiccup must
    // not wedge teardown, and the internal ledger transition (the load-bearing part) already applied.
    if (to === "merged" && this.cfg.onMerge !== "none") {
      await this.applyMergeWriteBack(key, ctx).catch((e) => this.log("warn", `${key}: Sentry on_merge write-back failed (best-effort): ${errMsg(e)}`));
    }
    return { kind: moved ? "applied" : "noop" };
  }

  /** on_merge courtesy write-back. Idempotent so a retried `merged` intent can't double-post/double-
   *  resolve. `ctx` may be absent (a retried intent for an ended run) — degrade gracefully. */
  private async applyMergeWriteBack(key: string, ctx?: TransitionContext): Promise<void> {
    if (this.cfg.onMerge === "resolve") {
      await this.sentry.updateIssue(key, { status: "resolved" }); // idempotent (already resolved -> noop)
      return;
    }
    if (this.cfg.onMerge === "resolve_in_next_release") {
      await this.sentry.updateIssue(key, { status: "resolvedInNextRelease" });
      return;
    }
    // "comment": drop a marker-tagged note linking the PR, unless a retried intent already left one.
    // Both spellings: a note left before this host switched brands still counts as already-posted.
    const prefixes = markerPrefixes(this.brand).map((p) => `${p}] Fixed by`);
    const existing = (await this.sentry.listComments(key)).find((c) => prefixes.some((m) => (c.data?.text ?? "").startsWith(m)));
    if (existing) return;
    const prRef = ctx?.prUrl ?? (ctx?.prNumber != null ? `PR #${ctx.prNumber}` : "a merged pull request");
    await this.sentry.addComment(key, `${mergedNotePrefix(this.brand)} ${prRef} (merged by ${this.brand}).`);
  }

  /** Render the issue + its latest event's stacktrace/breadcrumbs/request into memDir as task.md
   *  (the fix spec) + issue.json (raw). Idempotent on task.md; best-effort throughout (INV-4). */
  async materialize(key: string, memDir: string, log: Logger): Promise<void> {
    if (existsSync(join(memDir, "task.md"))) return; // idempotent across claiming ticks
    let issue: SentryIssue;
    let event: SentryEvent | null = null;
    try {
      issue = await this.sentry.getIssue(key);
    } catch (e) {
      log("warn", `${key}: could not fetch the Sentry issue for materialize: ${errMsg(e)}`);
      return; // next claiming tick retries (task.md not written)
    }
    // Record the release we're fixing this issue on, so a later recurrence on a DIFFERENT release
    // reopens it (see listEligible). The detail payload carries lastRelease; no-op if it's absent.
    this.store.setWorkItemRelease(this.repo, this.name, key, this.releaseOf(issue));
    try {
      event = await this.sentry.getLatestEvent(key, this.cfg.environment);
    } catch (e) {
      log("warn", `${key}: could not fetch the latest Sentry event (materializing without stacktrace): ${errMsg(e)}`);
    }
    try {
      writeFileSync(join(memDir, "issue.json"), JSON.stringify({ issue, event }, null, 2));
    } catch {
      log("warn", `${key}: could not save issue.json`);
    }
    writeFileSync(join(memDir, "task.md"), `${this.renderTask(issue, event)}\n`);
  }

  private renderTask(issue: SentryIssue, event: SentryEvent | null): string {
    const meta = issue.metadata ?? {};
    const lines: string[] = [
      `# Sentry issue ${issue.shortId ?? issue.id}: ${sanitize(this.summaryOf(issue))}`,
      "",
      `- URL: ${issue.permalink ?? "(none)"}`,
      `- Project: ${sanitize(issue.project?.slug ?? "?")}${issue.project?.name ? ` (${sanitize(issue.project.name)})` : ""}`,
      `- Level: ${issue.level ?? "?"}  ·  Status: ${issue.status ?? "?"}${issue.substatus ? ` (${issue.substatus})` : ""}  ·  Platform: ${issue.platform ?? "?"}`,
      `- Events: ${issue.count ?? "?"}  ·  Users affected: ${issue.userCount ?? "?"}  ·  Unhandled: ${issue.isUnhandled ? "yes" : "no"}`,
      `- First seen: ${issue.firstSeen ?? "?"}  ·  Last seen: ${issue.lastSeen ?? "?"}`,
      `- Culprit: ${sanitize(issue.culprit ?? "(none)")}`,
    ];
    if (meta.type || meta.value) {
      lines.push(`- Exception: ${sanitize(`${meta.type ?? ""}${meta.type && meta.value ? ": " : ""}${meta.value ?? ""}`)}`);
    }
    if (meta.filename || meta.function) lines.push(`- Location: ${sanitize(`${meta.function ?? ""}${meta.function && meta.filename ? " in " : ""}${meta.filename ?? ""}`)}`);
    lines.push("", "## What to do", "", "This is a production error captured by Sentry. Reproduce the failure from the stacktrace below, find the root cause, and fix it. Add a regression test where practical.");

    if (event) {
      const envTag = (event.tags ?? []).find((t) => t.key === "environment")?.value;
      const releaseTag = (event.tags ?? []).find((t) => t.key === "release")?.value;
      lines.push("", "## Latest event", "", `- Event: ${event.eventID ?? event.id ?? "?"}  ·  When: ${event.dateCreated ?? "?"}${envTag ? `  ·  Environment: ${sanitize(envTag)}` : ""}${releaseTag ? `  ·  Release: ${sanitize(releaseTag)}` : ""}`);
      lines.push(...renderEntries(event));
      const tags = (event.tags ?? []).filter((t) => t.key !== "environment" && t.key !== "release").slice(0, 25);
      if (tags.length) lines.push("", "### Tags", "", tags.map((t) => `- ${sanitize(t.key)}: ${sanitize(String(t.value))}`).join("\n"));
    } else {
      lines.push("", "_(No event payload was available at materialize time — see issue.json for the issue metadata.)_");
    }
    lines.push("", "> Full raw issue + event JSON: `issue.json` (in this same folder).");
    return lines.join("\n");
  }

  async workDoc(): Promise<WorkDocInfo> {
    return { path: "task.md", kind: "Sentry issue (markdown: metadata, culprit, stacktrace, breadcrumbs, request; raw JSON in issue.json)" };
  }

  async postNote(key: string, note: string): Promise<void> {
    await this.sentry.addComment(key, `${markerPrefix(this.brand)}] ${note}`);
  }

  async askHuman(input: HumanAskInput): Promise<HumanAskResult> {
    // Both spellings: a question posted before this host switched brands must not be re-asked.
    const markers = markerPrefixes(this.brand).map((p) => `${p} question: ${input.repo}/${input.runId}/${input.questionId}]`);
    try {
      // Idempotent per questionId (INV-5): scan for this question's marker before posting so a lost
      // response doesn't ask the human twice.
      const existing = (await this.sentry.listComments(input.key)).find((c) => markers.some((m) => (c.data?.text ?? "").startsWith(m)));
      if (existing) return { externalId: String(existing.id), externalCreatedAt: existing.dateCreated ?? null };
      const posted = await this.sentry.addComment(input.key, humanQuestionComment(input, this.brand));
      return { externalId: String(posted.id), externalCreatedAt: posted.dateCreated ?? null };
    } catch (e) {
      if (isSentryNotFound(e)) throw new StaleItemError(`sentry: issue ${input.key} is gone`);
      throw e;
    }
  }

  async pollHumanReply(input: HumanPollInput): Promise<HumanReply | null> {
    try {
      const notes = await this.sentry.listComments(input.key);
      const cutoff = input.externalCreatedAt ? Date.parse(input.externalCreatedAt) : Number.NaN;
      const qId = Number(input.externalId);
      const candidates = notes
        .filter((c) => String(c.id) !== input.externalId)
        .filter((c) => {
          if (Number.isFinite(cutoff)) {
            const t = c.dateCreated ? Date.parse(c.dateCreated) : Number.NaN;
            return Number.isFinite(t) && t > cutoff; // strictly after the question (also drops edited-old notes)
          }
          // No usable question timestamp: fall back to Sentry's monotonic activity ids so an OLDER
          // human note can't be mistaken for the reply. If neither is comparable, drop it (never
          // falsely resume) rather than accept an unordered note.
          const cId = Number(c.id);
          return Number.isFinite(cId) && Number.isFinite(qId) ? cId > qId : false;
        })
        .sort((a, b) => (a.dateCreated ?? "").localeCompare(b.dateCreated ?? "")); // earliest reply first
      for (const c of candidates) {
        const text = c.data?.text ?? "";
        // INV-6: skip our own artifacts (questions AND marked notes), blockquote-aware — the marker,
        // not the author, disambiguates: an operator using their own token IS the token's user.
        if (bearsHerdrMarker(text, this.brand)) continue;
        if (!text.trim()) continue;
        const author = c.user?.name ?? c.user?.email ?? c.user?.username ?? null;
        if (!isReplyAuthor(this.cfg.replyAuthors, c.user?.name, c.user?.email, c.user?.username, c.user?.id)) {
          input.onIgnored?.({ externalId: String(c.id), author });
          continue;
        }
        return { body: text, externalId: String(c.id), externalCreatedAt: c.dateCreated ?? null, author };
      }
      return null;
    } catch (e) {
      if (isSentryNotFound(e)) throw new StaleItemError(`sentry: issue ${input.key} is gone`);
      throw e;
    }
  }

  async health(): Promise<void> {
    try {
      await this.sentry.getOrganization();
    } catch (e) {
      throw new Error(`sentry: cannot reach organization "${this.cfg.organization}" at ${this.cfg.baseUrl} — bad token or wrong org/base_url (${errMsg(e)})`);
    }
    for (const project of this.cfg.projects) {
      try {
        await this.sentry.getProject(project);
      } catch (e) {
        throw new Error(`sentry: project "${project}" is not reachable in ${this.cfg.organization} — fix the slug or the token's access (${errMsg(e)})`);
      }
    }
  }
}

// --- event rendering -------------------------------------------------------------------------

const MAX_FRAMES = 40;
const MAX_BREADCRUMBS = 20;

interface StackFrame {
  function?: string | null;
  filename?: string | null;
  absPath?: string | null;
  module?: string | null;
  lineNo?: number | null;
  colNo?: number | null;
  inApp?: boolean;
  context?: [number, string][];
}

/** Turn an event's `entries` (exception/stacktrace, breadcrumbs, request) into fenced markdown the
 *  work agent can read. Discriminated by entry `type`; unknown types are ignored. */
function renderEntries(event: SentryEvent): string[] {
  const out: string[] = [];
  for (const entry of event.entries ?? []) {
    if (entry.type === "exception") {
      const values = (entry.data as { values?: { type?: string; value?: string; module?: string; stacktrace?: { frames?: StackFrame[] } }[] })?.values ?? [];
      for (const v of values) {
        out.push("", "### Exception", "", "```", `${sanitize(v.type ?? "Error")}: ${sanitize(v.value ?? "")}`.trim());
        const frames = v.stacktrace?.frames ?? [];
        // Sentry orders frames outermost-first, so the crashing frame is LAST — render bottom-up
        // (most-recent call first).
        const ordered = [...frames].reverse();
        let kept = ordered;
        if (ordered.length > MAX_FRAMES) {
          // Prioritize in-app frames under the cap, but render the survivors in TRUE call order
          // (concatenating the two groups would fabricate a call sequence that never happened).
          const keep = new Set([...ordered.filter((f) => f.inApp), ...ordered.filter((f) => !f.inApp)].slice(0, MAX_FRAMES));
          kept = ordered.filter((f) => keep.has(f));
        }
        for (const f of kept) {
          const loc = `${f.filename ?? f.module ?? "?"}${f.lineNo != null ? `:${f.lineNo}` : ""}`;
          out.push(`  at ${sanitize(f.function ?? "?")} (${sanitize(loc)})${f.inApp ? "  <- in-app" : ""}`);
        }
        if (ordered.length > kept.length) out.push(`  … ${ordered.length - kept.length} more frame(s) omitted`);
        out.push("```");
      }
    } else if (entry.type === "breadcrumbs") {
      const crumbs = (entry.data as { values?: { timestamp?: string; category?: string; level?: string; message?: string; type?: string }[] })?.values ?? [];
      if (!crumbs.length) continue;
      out.push("", "### Breadcrumbs (most recent last)", "", "```");
      for (const c of crumbs.slice(-MAX_BREADCRUMBS)) {
        out.push(`${sanitize(c.timestamp ?? "")} [${sanitize(c.category ?? c.type ?? "?")}] ${sanitize(c.level ?? "")}: ${sanitize(c.message ?? "")}`.trim());
      }
      out.push("```");
    } else if (entry.type === "request") {
      const req = entry.data as { method?: string; url?: string; query?: [string, string][] };
      if (req?.url) out.push("", "### Request", "", "```", `${sanitize(req.method ?? "GET")} ${sanitize(req.url)}`, "```");
    }
  }
  return out;
}
