import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bearsHerdrMarker, DEFAULT_BRAND, markerPrefix, markerPrefixes, type Logger, type SourceAuthStatus, type WorkSource, type WorkSourceSpec } from "../core/deps.ts";
import { HttpStatusError } from "./http.ts";
import type { JiraAuth } from "../auth/jira-provider.ts";
import type {
  HumanAskInput,
  HumanAskResult,
  HumanPollInput,
  HumanReply,
  JiraMatchItem,
  MatchItem,
  Ticket,
  TransitionResult,
  WorkDocInfo,
  WorkState,
} from "../types.ts";
import { StaleItemError } from "../types.ts";
import { JiraClient, type JiraComment } from "./jira.ts";

// Attachment caps for materialize (images + videos share the count budget). Moved here from
// step.ts — they're Jira-specific (other sources have their own materialize).
const MAX_ATTACHMENTS = 12;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_VIDEO_BYTES = 50 * 1024 * 1024; // 50 MB
const isMedia = (mime: string): boolean => mime.startsWith("image/") || mime.startsWith("video/");

const questionMarker = (brand: string): string => `${markerPrefix(brand)} question:`;

/** Is this failure "the ticket is no longer ours"? Jira answers 404 for an issue that was deleted,
 *  moved to a project the token can't see, or had its permissions revoked, and 410 for a hard-deleted
 *  one — none of which retrying can fix.
 *
 *  Without this the charter's typed escape is unreachable for Jira: `transition` would rethrow, so the
 *  outbox retried a deleted ticket on its 60s→1h backoff forever (and Phase B's claim guard kept the
 *  item un-claimable behind it), and the human loop would poll a ticket nobody can answer instead of
 *  escalating. github_issues has always mapped its own 301/404/410 this way (`classifyGone`); this is
 *  the same rule for the same reason. Found end-to-end while verifying the e2e Jira fake. */
function goneReason(e: unknown): string | null {
  if (!(e instanceof HttpStatusError)) return null;
  if (e.status === 404) return "not found (deleted, moved, or no longer visible to this token)";
  if (e.status === 410) return "deleted";
  return null;
}

/** Resolved Jira-source config (the client owns its config shape; the descriptor maps YAML onto it).
 *  The pickup label is NOT here — it's per-belt and arrives as an argument to listEligible/health.
 *  Auth is api_token only; the built JiraApiTokenAuth provider is passed to the constructor separately. */
export interface JiraSourceCfg {
  baseUrl: string;
  project: string;
  /** The Agile board id pickup pulls from (its saved filter scopes the query). */
  board: string;
  statusTodo: string;
  statusInDev: string;
  statusReview: string;
  /** OPT-IN terminal status. When set, `merged`/`done` map to it (transition at teardown, after the
   *  PR is merged and before the worktree is torn down); when undefined, the terminal stays unmapped
   *  (Jira-silent, no network) exactly as before. `aborted` is never mapped regardless. */
  statusDone?: string;
  /** EXTRA named statuses (`status.<key>: <Jira status name>`) beyond the canonical mapping, that a
   *  belt effect can target by key (INV-13). A `statusOverride` reaching `transition` is one of these
   *  keys (validated at config-load); we resolve it to the Jira status name here. */
  statusExtra: Record<string, string>;
}

function bodyText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  const rec = node as Record<string, unknown>;
  let out = typeof rec.text === "string" ? rec.text : "";
  const content = Array.isArray(rec.content) ? rec.content : [];
  for (const child of content) out += bodyText(child);
  if (rec.type === "paragraph" || rec.type === "heading") out += "\n";
  if (rec.type === "hardBreak") out += "\n";
  return out;
}

function commentText(comment: JiraComment): string {
  return bodyText(comment.body).replace(/\n{3,}/g, "\n\n").trim();
}

function humanQuestionComment(input: HumanAskInput, brand: string): string {
  const step = input.step ?? "unknown";
  return [
    `${questionMarker(brand)} ${input.repo}/${input.runId}/${input.questionId}]`,
    `Work item: ${input.key}`,
    `Step: ${step}`,
    "",
    input.question.trim(),
    "",
    `Reply in a new Jira comment. ${brand} will resume automatically when it sees the reply.`,
  ].join("\n");
}

/**
 * The Jira work source: a thin adapter over JiraClient that maps the canonical WorkState
 * lifecycle onto configured Jira statuses. `aborted` is always UNMAPPED — a closed/abandoned run
 * never touches the ticket. `merged`/`done` are mapped ONLY when the source configures `statusDone`
 * (opt-in): with it set, a merged PR moves the ticket to that status at teardown; without it, the
 * terminal short-circuits to a no-op with NO network call, so teardown stays Jira-silent (its
 * GitHub integration owns closure) exactly as before.
 */
export class JiraSource implements WorkSource {
  private readonly jira: JiraClient;
  private readonly cfg: JiraSourceCfg;
  private readonly brand: string; // what our comments call the factory (source_comments.brand)
  readonly spec: WorkSourceSpec;
  constructor(cfg: JiraSourceCfg, auth: JiraAuth, brand: string = DEFAULT_BRAND) {
    this.cfg = cfg;
    this.brand = brand;
    this.jira = new JiraClient(auth);
    // mappedStates must mirror statusFor: with statusDone set, merged/done become network-bearing
    // transitions (and drop out of the contract's zero-network unmapped set); aborted never maps.
    this.spec = {
      statusOfRecord: "external",
      mappedStates: cfg.statusDone
        ? ["todo", "in_development", "in_review", "merged", "done"]
        : ["todo", "in_development", "in_review"],
      replyChannel: "comments",
      terminalAutomation: cfg.statusDone
        ? `merged/done → "${cfg.statusDone}" on success; aborted stays unmapped (human/GitHub owns cancellation)`
        : "Jira's GitHub integration owns terminal closure (merged/aborted/done are unmapped)",
    };
  }

  /** Local (no-network) credential readiness from the auth provider — api_token checks env-value
   *  presence, OAuth checks a stored token. A present-but-wrong credential still reads "ok" here; a
   *  live 401 surfaces it as rejected (INV-12). */
  async authStatus(): Promise<SourceAuthStatus> {
    return this.jira.authStatus();
  }

  async listEligible(pickupLabel?: string): Promise<MatchItem[]> {
    const items = await this.jira.listEligible(this.cfg.board, this.cfg.project, pickupLabel, this.cfg.statusTodo);
    return items.map(
      (i): JiraMatchItem => ({
        sourceType: "jira",
        key: i.key,
        summary: i.summary,
        type: i.type,
        status: i.status,
        labels: i.labels,
        fields: i.fields,
      }),
    );
  }

  async describe(key: string): Promise<Ticket> {
    const issue = await this.jira.getIssue(key);
    return { key: issue.key, summary: issue.fields.summary, type: issue.fields.issuetype?.name ?? "Task" };
  }

  /** Canonical state → configured Jira status name; undefined when unmapped (no transition). */
  private statusFor(to: WorkState): string | undefined {
    switch (to) {
      case "todo":
        return this.cfg.statusTodo;
      case "in_development":
        return this.cfg.statusInDev;
      case "in_review":
        return this.cfg.statusReview;
      case "merged":
      case "done":
        // Success terminals (a merged PR, or a custom belt's completion). Mapped ONLY when the
        // source opts in with `statusDone`; unset ⇒ undefined ⇒ no-op with no network (Jira's
        // GitHub integration owns closure, as before).
        return this.cfg.statusDone;
      case "aborted":
        // A closed/abandoned/timed-out run never moves the ticket — a human decides its fate.
        return undefined;
    }
  }

  async transition(key: string, to: WorkState, _pickupLabel?: string, _ctx?: unknown, statusOverride?: string): Promise<TransitionResult> {
    // A belt effect's custom status wins over the canonical mapping for `to` — the engine still
    // ranks/records `to`, but Jira moves to the effect's named status. The override key was
    // validated against statusExtra at config-load, so an unknown one here is a bug, not user error.
    const status = statusOverride ? this.cfg.statusExtra[statusOverride] : this.statusFor(to);
    if (!status) return { kind: "noop" }; // unmapped → no-op, and crucially NO network call (teardown parity)
    try {
      const moved = await this.jira.transition(key, status);
      return moved ? { kind: "applied" } : { kind: "noop" };
    } catch (e) {
      // `stale` is delivered, not retried: the engine's two-phase handling then aborts a pre-work run
      // and parks a mid-flight one. A plausibly-transient failure must still THROW (throw = retry me).
      const gone = goneReason(e);
      if (gone) return { kind: "stale", detail: `${key} ${gone}` };
      throw e;
    }
  }

  async materialize(key: string, memDir: string, log: Logger): Promise<void> {
    if (existsSync(join(memDir, "ticket.json"))) return; // idempotent across claiming ticks
    mkdirSync(join(memDir, "attachments"), { recursive: true });
    let mediaCount = 0;
    try {
      const issue = await this.jira.getIssue(key);
      writeFileSync(join(memDir, "ticket.json"), JSON.stringify(issue, null, 2));
      mediaCount = (issue.fields.attachment ?? []).filter((a) => isMedia(a.mimeType ?? "")).length;
    } catch {
      log("warn", `${key}: could not save ticket.json`);
    }
    try {
      const saved = await this.jira.downloadAttachments(
        key,
        join(memDir, "attachments"),
        MAX_ATTACHMENTS,
        MAX_IMAGE_BYTES,
        MAX_VIDEO_BYTES,
      );
      // Don't silently swallow truncation — the fix agent is told to study every attachment.
      if (mediaCount > saved.length) {
        log(
          "warn",
          `${key}: saved ${saved.length}/${mediaCount} media attachments — rest skipped (over the ${MAX_ATTACHMENTS} cap or size limit)`,
        );
      }
    } catch {
      log("warn", `${key}: attachment download had issues`);
    }
  }

  async workDoc(): Promise<WorkDocInfo> {
    return { path: "ticket.json", kind: "Jira ticket (JSON)" };
  }

  async postNote(key: string, note: string): Promise<void> {
    // Marker-tagged so pollHumanReply never mistakes our own attention note for a human reply
    // (INV-6 — an unmarked note posted while a question was pending used to poison the loop).
    await this.jira.addComment(key, `${markerPrefix(this.brand)}] ${note}`);
  }

  async askHuman(input: HumanAskInput): Promise<HumanAskResult> {
    // Idempotent per questionId (INV-5): askHuman is re-invoked every tick until an externalId is
    // PERSISTED — if an earlier POST succeeded but the response was lost, re-posting would ask
    // the human twice. Scan for this question's marker first.
    // Both spellings: a question posted before this host switched brands must not be re-asked.
    const markers = markerPrefixes(this.brand).map((p) => `${p} question: ${input.repo}/${input.runId}/${input.questionId}]`);
    try {
      const existing = (await this.jira.listComments(input.key)).find((c) => markers.some((m) => commentText(c).includes(m)));
      if (existing) return { externalId: existing.id, externalCreatedAt: existing.created ?? null };
      const comment = await this.jira.addComment(input.key, humanQuestionComment(input, this.brand));
      return { externalId: comment.id, externalCreatedAt: comment.created ?? null };
    } catch (e) {
      // A question can't be asked on a ticket that no longer exists — escalate the run rather than
      // retrying the post forever (the charter's typed escape; §5).
      const gone = goneReason(e);
      if (gone) throw new StaleItemError(`${input.key} ${gone}`);
      throw e;
    }
  }

  async pollHumanReply(input: HumanPollInput): Promise<HumanReply | null> {
    let comments: JiraComment[];
    try {
      comments = await this.jira.listComments(input.key);
    } catch (e) {
      // Same rule as askHuman: polling a ticket that is gone can never produce an answer, so the
      // waiting run must escalate instead of backing off against a 404 until a human notices.
      const gone = goneReason(e);
      if (gone) throw new StaleItemError(`${input.key} ${gone}`);
      throw e;
    }
    const questionIndex = comments.findIndex((c) => c.id === input.externalId);
    const cutoff = input.externalCreatedAt ? Date.parse(input.externalCreatedAt) : Number.NaN;
    const candidates = questionIndex >= 0
      ? comments.slice(questionIndex + 1)
      : Number.isFinite(cutoff)
        ? comments.filter((c) => (c.created ? Date.parse(c.created) : 0) > cutoff)
        : comments;
    for (const comment of candidates) {
      if (comment.id === input.externalId) continue;
      const text = commentText(comment);
      // Skip EVERY herdr-authored artifact — questions AND marked notes (INV-6). Blockquote-aware:
      // a human reply that quotes the question must still be accepted as a reply.
      if (bearsHerdrMarker(text, this.brand)) continue;
      if (!text && !comment.body) continue;
      return {
        body: text || "(Jira comment had no extractable text.)",
        externalId: comment.id,
        externalCreatedAt: comment.created ?? null,
        author: comment.author?.displayName ?? comment.author?.accountId ?? null,
      };
    }
    return null;
  }

  // Claim ledger hooks (INV-10). Raw bodies: the marker IS the whole comment.
  async postClaimComment(key: string, body: string): Promise<void> {
    await this.jira.addComment(key, body);
  }

  async listClaimComments(key: string): Promise<{ id: string; body: string }[]> {
    return (await this.jira.listComments(key, true)).map((c) => ({ id: c.id, body: commentText(c) }));
  }

  async health(pickupLabels: string[] = []): Promise<void> {
    // Probe the pickup query for each belt's label (auth + project + JQL reachability); with none, a
    // label-less probe still exercises the connection. Jira belts always carry a label in practice.
    for (const label of pickupLabels.length ? pickupLabels : [undefined]) {
      await this.jira.listEligible(this.cfg.board, this.cfg.project, label, this.cfg.statusTodo);
    }
  }
}
