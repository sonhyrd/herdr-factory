// The github_issues work source: GitHub Issues polled by a trigger label, driven to a merged PR.
//
// `kind: pull_requests` flips the poll to the repo's PULL REQUESTS instead (the issues list
// endpoint already interleaves them — the filter is simply inverted). Everything else is
// identical: same trigger label consumed on claim, same `herdr:*` state labels, same claim
// ledger, same comment-based human loop (a PR's comments ARE issue comments). The one
// difference is terminal: `close_on` never applies to a PR — closing or merging stays the
// operator's, and a review run must never do it for them.
//
// STATUS OF RECORD: GitHub (spec external — work_items is never touched). The lifecycle
// projection on the issue:
//   eligible          = open + trigger label + the configured `kind` (issue, or PR when
//                       `kind: pull_requests`) + no in-flight state label
//   in_development    = state label swap, then the trigger label is CONSUMED (re-add = retry)
//   in_review         = state label swap
//   merged | done     = strip state labels; close as completed (close_on.*, ISSUES ONLY) — the
//                       idempotent backstop over the PR's `Fixes #n` auto-close (which only fires
//                       on default-branch merges and can be disabled repo-wide)
//   aborted           = strip in-flight labels + add the aborted label; issue stays OPEN
//                       (a visible, retriageable failure artifact) unless close_on.aborted
// Every mapped transition is an idempotent GET → diff → apply (INV-2); "already there" — incl.
// auto-close winning the race — is a noop. 301/410/404 map to `stale` (see classifyGone): those
// are "the item is no longer ours", where retrying cannot help.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bearsHerdrMarker, HERDR_MARKER, type Logger, type SourceAuthStatus, type WorkSource, type WorkSourceSpec } from "../core/deps.ts";
import { isSourceUnauthenticated } from "../auth/errors.ts";
import {
  StaleItemError,
  type GithubIssuesMatchItem,
  type HumanAskInput,
  type HumanAskResult,
  type HumanPollInput,
  type HumanReply,
  type MatchItem,
  type Ticket,
  type TransitionResult,
  type WorkDocInfo,
  type WorkState,
} from "../types.ts";
import { classifyGone, GithubIssuesClient, labelNames, type GhComment, type GhIssue, type GhPull } from "./github-issues.ts";

/** Resolved github_issues-source config (the client/source own the shape; the descriptor maps YAML
 *  onto it). The trigger (pickup) label is NOT here — it's per-belt and arrives as an argument to
 *  listEligible/transition/health. */
export interface GithubIssuesSourceCfg {
  repo: string; // "owner/name" the issues live in
  /** What the trigger label is read off: the repo's issues (default) or its pull requests. */
  kind: "issues" | "pull_requests";
  stateLabels: { inDevelopment: string; inReview: string; aborted: string };
  /** EXTRA named state labels (`state_labels.<key>: <label>`) beyond the canonical three, that a
   *  belt effect can target by key (INV-13). A `statusOverride` reaching `transition` is one of
   *  these keys (validated at config-load); it swaps in the label like an in-flight state change. */
  stateLabelsExtra: Record<string, string>;
  closeOn: { merged: boolean; done: boolean; aborted: boolean };
  typeLabels: Record<string, string>; // issue label (lowercased) -> Ticket.type
  defaultType: string;
  maxPages: number; // listEligible pages of 100
}

const QUESTION_MARKER = `${HERDR_MARKER} question:`;

// Attachment caps (Jira parity — jira-source.ts): images + videos share the count budget.
const MAX_ATTACHMENTS = 12;
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;

/** Hosts we download embedded media from. private-user-images + camo are what body_html
 *  (full+json) rewrites private-repo attachments to — the ONLY form that resolves under a PAT;
 *  the raw-body forms work for public repos. Anything else is left as a link.
 *  SECURITY: matching is on the PARSED hostname (exact, or github.com + the /user-attachments/
 *  path) — issue bodies/comments are attacker-controlled, and a substring check would let
 *  `https://camo.githubusercontent.com.evil.net/x` or a path-embedded lookalike turn materialize
 *  into an SSRF/content-smuggling primitive from the operator's machine. */
const MEDIA_HOSTNAMES = new Set([
  "private-user-images.githubusercontent.com",
  "user-images.githubusercontent.com",
  "camo.githubusercontent.com",
]);

function isAllowedMediaUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (MEDIA_HOSTNAMES.has(url.hostname)) return true;
  return url.hostname === "github.com" && url.pathname.startsWith("/user-attachments/");
}

/** Strip HTML comments + invisible/bidi characters from untrusted text before it reaches a
 *  prompt (INV-4; the raw payload stays in issue.json). */
function sanitize(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars is the point
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "");
}

function humanQuestionComment(input: HumanAskInput): string {
  return [
    `${QUESTION_MARKER} ${input.repo}/${input.runId}/${input.questionId}]`,
    `Work item: #${input.key}`,
    `Step: ${input.step ?? "unknown"}`,
    "",
    input.question.trim(),
    "",
    "Reply in a NEW comment — herdr-factory resumes automatically when it sees the reply. (Edits to existing comments are not seen.)",
  ].join("\n");
}

export class GithubIssuesSource implements WorkSource {
  private readonly gh: GithubIssuesClient;
  private readonly cfg: GithubIssuesSourceCfg;
  private readonly prRepo: string; // the repo PRs are opened against (may differ from cfg.repo)
  private readonly log: Logger;
  private readonly ensuredLabels = new Set<string>(); // memoized ensureLabel results (per process)

  constructor(cfg: GithubIssuesSourceCfg, gh: GithubIssuesClient, prRepo: string, log: Logger = () => {}) {
    this.cfg = cfg;
    this.gh = gh;
    this.prRepo = prRepo;
    this.log = log;
  }

  readonly spec: WorkSourceSpec = {
    statusOfRecord: "external",
    mappedStates: ["in_development", "in_review", "merged", "aborted", "done"],
    replyChannel: "comments",
    terminalAutomation: "PR closing keywords (Fixes #n) auto-close on default-branch merges; the close here is the idempotent backstop",
  };

  /** Local (no-network) auth readiness: can a token be resolved (env GITHUB_TOKEN, else the gh
   *  CLI)? A present-but-rejected token still reads "ok" here; a live 401 surfaces it as rejected
   *  (INV-12). */
  async authStatus(): Promise<SourceAuthStatus> {
    try {
      await this.gh.probeAuth();
      return { state: "ok" };
    } catch (e) {
      if (isSourceUnauthenticated(e)) return { state: "unauthenticated", detail: e.hint ?? e.message };
      return { state: "ok" }; // a transient probe glitch must not mark the source down
    }
  }

  /** True when the poll is over pull requests (`kind: pull_requests`). */
  private get onPulls(): boolean {
    return this.cfg.kind === "pull_requests";
  }

  /** The noun for this source's items, for messages that must not lie about what was polled. */
  private get noun(): string {
    return this.onPulls ? "pull request" : "issue";
  }

  /** Is this payload the kind we poll? The issues list/GET endpoints serve BOTH (a PR carries a
   *  `pull_request` key), so the single membership test below is the whole opt-in: a default
   *  source still skips PRs, an opted-in one skips issues. */
  private wanted(issue: GhIssue): boolean {
    return Boolean(issue.pull_request) === this.onPulls;
  }

  private stateLabelFor(to: WorkState): string | undefined {
    switch (to) {
      case "in_development":
        return this.cfg.stateLabels.inDevelopment;
      case "in_review":
        return this.cfg.stateLabels.inReview;
      case "aborted":
        return this.cfg.stateLabels.aborted;
      default:
        return undefined;
    }
  }

  private allStateLabels(): string[] {
    return [this.cfg.stateLabels.inDevelopment, this.cfg.stateLabels.inReview, this.cfg.stateLabels.aborted, ...Object.values(this.cfg.stateLabelsExtra)];
  }

  /** The in-flight state labels (an item wearing one is mid-run): the canonical dev/review markers
   *  plus every belt-effect custom label. Gates listEligible (belt-and-braces over run dedup). */
  private inFlightStateLabels(): string[] {
    return [this.cfg.stateLabels.inDevelopment, this.cfg.stateLabels.inReview, ...Object.values(this.cfg.stateLabelsExtra)];
  }

  /** Ticket.type: GitHub's native issue type when present, else the first type_labels hit over
   *  the issue's labels, else default_type. Drives the branch prefix + @@TYPE@@. */
  private typeOf(issue: GhIssue): string {
    const native = issue.type?.name?.trim();
    if (native) return native;
    for (const label of labelNames(issue)) {
      const mapped = this.cfg.typeLabels[label.toLowerCase()];
      if (mapped) return mapped;
    }
    return this.cfg.defaultType;
  }

  private toItem(issue: GhIssue): GithubIssuesMatchItem {
    return {
      sourceType: "github_issues",
      key: String(issue.number),
      displayKey: `#${issue.number}`,
      url: issue.html_url,
      summary: issue.title,
      type: this.typeOf(issue),
      labels: labelNames(issue),
      fields: issue as Record<string, unknown>,
      number: issue.number,
      repo: this.cfg.repo,
      state: "open",
      assignees: (issue.assignees ?? []).map((a) => a.login),
      author: issue.user?.login ?? null,
      body: issue.body ?? "",
    };
  }

  async listEligible(pickupLabel?: string): Promise<MatchItem[]> {
    // The belt's `label` IS the trigger label here — the poll filter. A github_issues belt always
    // carries one (config enforces it); guard so a stray call can't silently poll every open issue.
    if (!pickupLabel) throw new Error("github_issues: listEligible needs the belt's pickup label (its `label`)");
    const out: GithubIssuesMatchItem[] = [];
    // GitHub label names are case-insensitively unique and the API returns the repo's CANONICAL
    // casing — every membership check here (and in transition) must fold case, or a config that
    // spells "herdr" against a repo label "Herdr" silently breaks the guards.
    const inFlight = new Set(this.inFlightStateLabels().map((l) => l.toLowerCase()));
    for (let page = 1; page <= this.cfg.maxPages; page++) {
      const batch = await this.gh.listOpenIssuesByLabel(pickupLabel, page);
      let kept = 0;
      for (const issue of batch) {
        if (!this.wanted(issue)) continue; // the list endpoint interleaves issues and PRs
        // Belt-and-braces: an in-flight state label means a claim's label swap partially landed
        // (or a human hand-edited) — don't double-claim. The aborted label deliberately does NOT
        // gate here: re-adding the trigger is the whole retry affordance.
        if (labelNames(issue).some((l) => inFlight.has(l.toLowerCase()))) continue;
        out.push(this.toItem(issue));
        kept += 1;
      }
      if (batch.length === 100 && kept === 0) {
        // A FULL page yielded nothing claimable (e.g. 100 trigger-labeled items of the OTHER
        // kind occupying the oldest-first slots) — eligible issues beyond this page would starve silently at the
        // max_pages cap. Surface it; the operator fixes the stray labels or raises max_pages.
        this.log(
          "warn",
          `github_issues: page ${page} of "${pickupLabel}" was entirely non-claimable (${this.onPulls ? "issues" : "PRs"}/in-flight) — newer ${this.noun}s may be starving; check for trigger-labeled ${this.onPulls ? "issues" : "PRs"} or raise max_pages`,
        );
      }
      if (batch.length < 100) break;
    }
    return out; // oldest-first (sort=created asc) — overflow beyond maxPages surfaces on later ticks
  }

  async describe(key: string): Promise<Ticket> {
    const n = Number(key.replace(/^#/, "")); // tolerate the "#123" spelling; canonical key is bare
    if (!Number.isInteger(n) || n <= 0) throw new Error(`github_issues: "${key}" is not an ${this.noun} number`);
    const issue = await this.gh.getIssue(n);
    if (!this.wanted(issue)) throw new Error(`github_issues: #${n} is ${this.onPulls ? "an issue, not a pull request" : "a pull request, not an issue"}`);
    return { key: String(n), displayKey: `#${n}`, url: issue.html_url, summary: issue.title, type: this.typeOf(issue) };
  }

  /** Lazily make sure a state label exists in the repo (memoized), so a fresh repo works on the
   *  first claim without manual label setup. Failures propagate — the outbox retries. */
  private async ensureLabel(name: string): Promise<void> {
    if (this.ensuredLabels.has(name)) return;
    if (!(await this.gh.labelExists(name))) {
      await this.gh.createLabel(name, "5319e7", "managed by herdr-factory");
    }
    this.ensuredLabels.add(name);
  }

  async transition(key: string, to: WorkState, pickupLabel?: string, _ctx?: unknown, statusOverride?: string): Promise<TransitionResult> {
    // A canonical `to` that isn't mapped costs ZERO network (INV-3); a belt-effect custom status
    // (statusOverride) is always a real, validated label swap, so it bypasses the mapped-state gate.
    if (!statusOverride && !this.spec.mappedStates.includes(to)) return { kind: "noop" };
    const n = Number(key);
    try {
      // Idempotent GET → diff → apply. The GET is also the stale probe: 301/410/404 end here.
      const issue = await this.gh.getIssue(n);
      if (!this.wanted(issue)) return { kind: "stale", detail: `#${n} is ${this.onPulls ? "an issue" : "a pull request"}` };
      // Case-folded membership (GitHub's label namespace is case-insensitive and the API returns
      // the repo's canonical casing); writes keep the configured spelling — GitHub matches them.
      const have = new Set(labelNames(issue).map((l) => l.toLowerCase()));
      const has = (label: string) => have.has(label.toLowerCase());
      const want = this.stateLabelFor(to);
      let applied = false;

      if (statusOverride) {
        // A belt-effect custom status: a mid-flight state-label swap (like in_development/in_review),
        // but it never consumes the trigger and never closes the issue. Validated at config-load, so
        // the label exists in stateLabelsExtra. A closed issue here is a human cancel (no PR yet at a
        // pre-PR custom status → no Fixes-#n auto-close to race) → stale/park.
        if (issue.state === "closed") return { kind: "stale", detail: `${this.noun} #${n} was closed (${issue.state_reason ?? "no reason"}) before ${statusOverride}` };
        const wantCustom = this.cfg.stateLabelsExtra[statusOverride]!;
        await this.ensureLabel(wantCustom);
        if (!has(wantCustom)) {
          await this.gh.addLabels(n, [wantCustom]);
          applied = true;
        }
        for (const l of this.allStateLabels()) {
          if (l.toLowerCase() !== wantCustom.toLowerCase() && has(l)) applied = (await this.gh.removeLabel(n, l)) || applied;
        }
        return { kind: applied ? "applied" : "noop" };
      }

      if (to === "in_development" || to === "in_review") {
        if (issue.state === "closed") {
          // A closed issue at claim time (in_development) is a cancel signal — abort via stale.
          // At in_review time, state_reason disambiguates: "completed" is what Fixes-#n
          // auto-close writes, so it's almost always the auto-close racing a fast merge ahead of
          // this delayed write-back → noop (the PR watch owns the real signal). EVERYTHING else
          // (not_planned, duplicate, null — none producible by auto-close) is a human cancel →
          // stale (park).
          if (to === "in_review" && issue.state_reason === "completed") return { kind: "noop" };
          return { kind: "stale", detail: `${this.noun} #${n} was closed (${issue.state_reason ?? "no reason"}) before ${to}` };
        }
        await this.ensureLabel(want!);
        if (!has(want!)) {
          await this.gh.addLabels(n, [want!]);
          applied = true;
        }
        for (const l of this.allStateLabels()) {
          if (l !== want && has(l)) applied = (await this.gh.removeLabel(n, l)) || applied;
        }
        if (to === "in_development" && pickupLabel && has(pickupLabel)) {
          // Consume the trigger (the belt's pickup label) LAST: if the swap partially fails and
          // retries, the still-present trigger keeps the item filtered by the in-flight guard,
          // never double-claimed. Skipped only if the belt (hence its label) is gone — an
          // already-stranded run (INV-9); the item can't re-list while the run is active anyway.
          applied = (await this.gh.removeLabel(n, pickupLabel)) || applied;
        }
        return { kind: applied ? "applied" : "noop" };
      }

      // Terminal states. An already-CLOSED issue is converged (auto-close / a human beat us):
      // pure noop for `aborted` (never decorate work a human deliberately killed — the aborted
      // label is a retriage affordance for OPEN issues, DP-5); for merged/done only strip
      // leftover in-flight labels (hygiene). Never reopen, never complain.
      if (issue.state === "closed" && to === "aborted") return { kind: "noop" };
      for (const l of [this.cfg.stateLabels.inDevelopment, this.cfg.stateLabels.inReview]) {
        if (has(l)) applied = (await this.gh.removeLabel(n, l)) || applied;
      }
      if (to === "aborted") {
        await this.ensureLabel(want!);
        if (!has(want!)) {
          await this.gh.addLabels(n, [want!]);
          applied = true;
        }
      } else if (has(this.cfg.stateLabels.aborted)) {
        applied = (await this.gh.removeLabel(n, this.cfg.stateLabels.aborted)) || applied;
      }
      // `close_on` is an ISSUES-only policy: closing (or merging) a pull request stays the
      // operator's call, so a PR run only ever strips its state labels.
      const close = !this.onPulls && (to === "merged" ? this.cfg.closeOn.merged : to === "done" ? this.cfg.closeOn.done : this.cfg.closeOn.aborted);
      if (close && issue.state === "open") {
        await this.gh.closeIssue(n, to === "aborted" ? "not_planned" : "completed");
        applied = true;
      }
      return { kind: applied ? "applied" : "noop" };
    } catch (e) {
      const gone = classifyGone(e);
      if (gone) return { kind: "stale", detail: `${this.noun} #${n} ${gone}` };
      throw e; // transient (throw = retry me, INV-2)
    }
  }

  /** Render the issue (title, body, every comment) + its media into memDir as task.md /
   *  attachments/ / issue.json. Idempotent on task.md; best-effort throughout (INV-4). */
  async materialize(key: string, memDir: string, log: Logger): Promise<void> {
    if (existsSync(join(memDir, "task.md"))) return; // idempotent across claiming ticks
    const n = Number(key);
    let issue: GhIssue;
    let comments: GhComment[];
    try {
      // full+json: body_html carries the JWT-signed attachment URLs that resolve on private
      // repos. Download IMMEDIATELY below — those JWTs expire within minutes.
      issue = await this.gh.getIssue(n, { full: true });
      comments = await this.gh.listComments(n, { full: true });
    } catch (e) {
      log("warn", `${key}: could not fetch the ${this.noun} for materialize: ${e instanceof Error ? e.message : String(e)}`);
      return; // next claiming tick retries (task.md not written)
    }
    try {
      writeFileSync(join(memDir, "issue.json"), JSON.stringify({ issue, comments }, null, 2));
    } catch {
      log("warn", `${key}: could not save issue.json`);
    }

    mkdirSync(join(memDir, "attachments"), { recursive: true });
    const media = new MediaCollector(this.gh, join(memDir, "attachments"), log, key);

    const lines: string[] = [
      `# ${this.onPulls ? "Pull request" : "Issue"} #${n}: ${sanitize(issue.title)}`,
      "",
      `- URL: ${issue.html_url ?? `https://github.com/${this.cfg.repo}/${this.onPulls ? "pull" : "issues"}/${n}`}`,
      `- Repo: ${this.cfg.repo}`,
      `- Author: ${issue.user?.login ?? "unknown"}`,
      `- State: ${issue.state}`,
      `- Labels: ${labelNames(issue).join(", ") || "(none)"}`,
      // A PR work doc carries its BRANCHES instead of a closing reference: the head ref is what a
      // review belt checks out (`gh pr checkout <n>`), and "Fixes #<pr>" would be nonsense.
      ...(this.onPulls
        ? await this.pullRefLines(n)
        : // The pr step copies this line into the PR body VERBATIM — linkage + auto-close on merge.
          // Short form when the issue lives in the PR repo is the docs-guaranteed spelling; the
          // descriptor passes prRepo so cross-repo issues get the qualified form.
          [`- Closing reference: Fixes ${this.cfg.repo === this.prRepo ? `#${n}` : `${this.cfg.repo}#${n}`}`]),
      "",
      "## Description",
      "",
      await media.rewrite(sanitize(issue.body ?? "_(no description)_"), issue.body_html),
    ];
    for (const c of comments) {
      const text = c.body ?? "";
      if (bearsHerdrMarker(text)) continue; // our own questions/notes are not task content
      lines.push("", `## Comment by ${c.user?.login ?? "unknown"} (${c.created_at})`, "", await media.rewrite(sanitize(text), c.body_html));
    }
    if (media.failed > 0) lines.push("", `> note: ${media.failed} attachment(s) could not be downloaded — follow the original links above.`);
    writeFileSync(join(memDir, "task.md"), `${lines.join("\n")}\n`);
  }

  /** The head/base branch bullets of a PR work doc. Best-effort (INV-4): the refs live only on
   *  the pulls endpoint, and a failed extra GET must not cost us the whole work doc — the run can
   *  still `gh pr checkout <n>` from the number. */
  private async pullRefLines(n: number): Promise<string[]> {
    let pull: GhPull;
    try {
      pull = await this.gh.getPull(n);
    } catch {
      this.log("warn", `github_issues: could not read the branches of pull request #${n} — the work doc omits them`);
      return [`- Checkout: \`gh pr checkout ${n}\``];
    }
    return [
      `- Head branch: ${pull.head?.ref ?? "(unknown)"}${pull.head?.repo?.full_name && pull.head.repo.full_name !== this.cfg.repo ? ` (fork ${pull.head.repo.full_name})` : ""}`,
      `- Base branch: ${pull.base?.ref ?? "(unknown)"}`,
      `- Draft: ${pull.draft ? "yes" : "no"}`,
      `- Checkout: \`gh pr checkout ${n}\``,
    ];
  }

  async workDoc(): Promise<WorkDocInfo> {
    return this.onPulls
      ? { path: "task.md", kind: "GitHub pull request (markdown: title, body, all comments, head/base branch; raw JSON in issue.json; media in attachments/)" }
      : { path: "task.md", kind: "GitHub issue (markdown: title, body, all comments; raw JSON in issue.json; media in attachments/)" };
  }

  async postNote(key: string, note: string): Promise<void> {
    await this.gh.createComment(Number(key), `${HERDR_MARKER}] ${note}`);
  }

  async askHuman(input: HumanAskInput): Promise<HumanAskResult> {
    const n = Number(input.key);
    try {
      // Idempotent per questionId (INV-5): askHuman is re-invoked every tick until an externalId
      // is PERSISTED — if our earlier POST succeeded but the response was lost, re-posting would
      // ask the human twice. Scan for the marker first (blockquote-aware via the exact first line).
      const marker = `${QUESTION_MARKER} ${input.repo}/${input.runId}/${input.questionId}]`;
      const existing = (await this.gh.listComments(n)).find((c) => (c.body ?? "").startsWith(marker));
      if (existing) return { externalId: String(existing.id), externalCreatedAt: existing.created_at };
      const posted = await this.gh.createComment(n, humanQuestionComment(input));
      return { externalId: String(posted.id), externalCreatedAt: posted.created_at };
    } catch (e) {
      const gone = classifyGone(e);
      if (gone) throw new StaleItemError(`${this.noun} #${n} ${gone}`);
      throw e;
    }
  }

  async pollHumanReply(input: HumanPollInput): Promise<HumanReply | null> {
    const n = Number(input.key);
    try {
      // `since` filters on updated_at (cheap server-side narrowing); the created_at guard below is
      // the real cutoff — it also drops EDITED old comments (hence "reply in a NEW comment").
      const comments = await this.gh.listComments(n, { since: input.externalCreatedAt ?? undefined });
      const cutoff = input.externalCreatedAt ? Date.parse(input.externalCreatedAt) : Number.NaN;
      for (const c of comments) {
        if (String(c.id) === input.externalId) continue;
        if (Number.isFinite(cutoff) && Date.parse(c.created_at) <= cutoff) continue;
        const text = c.body ?? "";
        // INV-6: skip every herdr-authored artifact (questions AND marked notes) — but a human
        // QUOTE-REPLY that embeds the question as `> …` blockquote lines IS a reply. NO author
        // filtering: under gh-CLI auth the bot login IS the operator's login.
        if (bearsHerdrMarker(text)) continue;
        if (!text.trim()) continue;
        return { body: text, externalId: String(c.id), externalCreatedAt: c.created_at, author: c.user?.login ?? null };
      }
      return null;
    } catch (e) {
      const gone = classifyGone(e);
      if (gone) throw new StaleItemError(`${this.noun} #${n} ${gone}`);
      throw e;
    }
  }

  // Claim ledger hooks (INV-10). Raw bodies: the marker IS the whole comment.
  async postClaimComment(key: string, body: string): Promise<void> {
    await this.gh.createComment(Number(key), body);
  }

  async listClaimComments(key: string): Promise<{ id: string; body: string }[]> {
    return (await this.gh.listComments(Number(key))).map((c) => ({ id: String(c.id), body: c.body ?? "" }));
  }

  async health(pickupLabels: string[] = []): Promise<void> {
    let repo: { has_issues?: boolean; permissions?: { push?: boolean } };
    try {
      repo = await this.gh.getRepo();
    } catch (e) {
      throw new Error(`github_issues: cannot reach ${this.cfg.repo} — bad auth, or the token lacks access (${e instanceof Error ? e.message : String(e)})`);
    }
    // Issues being disabled only matters when we poll issues — a `kind: pull_requests` source
    // reads PRs, which exist regardless (and whose comments are still the issue-comment API).
    if (!this.onPulls && repo.has_issues === false) throw new Error(`github_issues: issues are disabled on ${this.cfg.repo} — enable them in repo settings`);
    if (repo.permissions && repo.permissions.push === false) {
      throw new Error(`github_issues: the token has no push/write access to ${this.cfg.repo} — labels and comments will fail`);
    }
    // Each feeding belt's trigger label (its `label`) must exist in the repo, or that belt's poll
    // can never surface work. Case-fold to match GitHub's case-insensitive label namespace.
    for (const label of pickupLabels) {
      if (!(await this.gh.labelExists(label))) {
        throw new Error(`github_issues: trigger label "${label}" does not exist in ${this.cfg.repo} — create it (or fix the belt's \`label\`) and add it to ${this.noun}s you want worked`);
      }
    }
  }
}

/** Downloads embedded media (capped, allowlisted hosts) and rewrites links to local paths.
 *  Prefers body_html's URLs (JWT-signed private-repo form) by mapping raw-body URLs to their
 *  html counterparts when both reference the same asset id. */
class MediaCollector {
  private count = 0;
  failed = 0;
  private readonly seen = new Map<string, string>(); // url -> local relative path
  // NOTE: no constructor parameter properties — the CLI runs under Node's strip-only
  // type-stripping, which doesn't support them (same constraint as http.ts's TokenBucket).
  private readonly gh: GithubIssuesClient;
  private readonly dir: string;
  private readonly log: Logger;
  private readonly key: string;
  constructor(gh: GithubIssuesClient, dir: string, log: Logger, key: string) {
    this.gh = gh;
    this.dir = dir;
    this.log = log;
    this.key = key;
  }

  /** Every downloadable URL in `text`, with the html variant (when given) consulted first so
   *  private-repo signed URLs win over their raw-body 404-under-PAT counterparts. Once one form
   *  of an asset downloads, the OTHER forms of the same asset id are rewritten to the local copy
   *  and never fetched — on a private repo the raw-body form 404s by design, and fetching it
   *  anyway would both waste budget and footnote a false failure. */
  async rewrite(text: string, html?: string): Promise<string> {
    const urls = new Set<string>([...extractMediaUrls(html ?? ""), ...extractMediaUrls(text)]);
    let out = text;
    for (const url of urls) {
      const assetId = assetIdOf(url);
      const already = assetId ? this.byAssetId.get(assetId) : undefined;
      const local = already ?? (await this.fetch(url));
      if (!local) continue;
      out = out.split(url).join(local);
      // Rewrite the asset's OTHER url forms too — but anchored to the allowlisted hosts, never a
      // bare "any https:// containing the id" scan (a short id would eat unrelated links).
      if (assetId) {
        this.byAssetId.set(assetId, local);
        out = out.replace(
          new RegExp(`https://[^\\s)"'<>\\]]*${assetId}[^\\s)"'<>\\]]*`, "g"),
          (m) => (isAllowedMediaUrl(m) ? local : m),
        );
      }
    }
    return out;
  }

  private readonly byAssetId = new Map<string, string>(); // asset id -> local relative path

  private async fetch(url: string): Promise<string | null> {
    const cached = this.seen.get(url);
    if (cached) return cached;
    if (this.count >= MAX_ATTACHMENTS) {
      // Over the cap = an attachment the agent will NOT have locally — that must show in the
      // footnote, not silently read as "everything captured" (INV-4 honesty).
      this.failed += 1;
      this.log("warn", `${this.key}: attachment cap (${MAX_ATTACHMENTS}) reached — leaving the link (${url.slice(0, 120)})`);
      return null;
    }
    try {
      const bytes = await this.gh.downloadBytes(url);
      if (bytes.length > MAX_MEDIA_BYTES) {
        this.log("warn", `${this.key}: attachment over the ${MAX_MEDIA_BYTES / 1024 / 1024}MB cap — skipped (${url.slice(0, 120)})`);
        this.failed += 1;
        return null;
      }
      this.count += 1;
      const name = `attachment-${this.count}${extensionOf(url)}`;
      writeFileSync(join(this.dir, name), bytes);
      const rel = `attachments/${name}`;
      this.seen.set(url, rel);
      return rel;
    } catch {
      this.failed += 1;
      this.log("warn", `${this.key}: attachment download failed — leaving the link (${url.slice(0, 120)})`);
      return null;
    }
  }
}

/** The durable id shared by an asset's URL forms (raw /user-attachments/assets/<uuid> vs the
 *  signed private-user-images form). Minimum 8 chars — a short capture ("1-a.png" → "a") would
 *  make the rewrite regex match unrelated URLs. */
function assetIdOf(url: string): string | null {
  const id = url.match(/user-attachments\/assets\/([\w-]{8,})/)?.[1] ?? url.match(/\/\d+-([\w-]{8,})\.\w+/)?.[1];
  return id ?? null;
}

function extensionOf(url: string): string {
  const m = url.match(/\.(png|jpe?g|gif|webp|svg|mp4|mov|webm)(\?|$)/i);
  return m ? `.${m[1]!.toLowerCase()}` : "";
}

/** Markdown/HTML image + asset URLs on the allowlisted hosts (parsed-hostname check — see
 *  MEDIA_HOSTNAMES). */
function extractMediaUrls(text: string): string[] {
  const urls = text.match(/https:\/\/[^\s)"'<>\]]+/g) ?? [];
  return urls.filter(isAllowedMediaUrl);
}
