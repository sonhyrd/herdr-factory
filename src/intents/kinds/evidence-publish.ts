// evidence_publish: the durable evidence-media publish as a ledger kind (cut over from the
// `evidence_uploads` table in v30 — the drifted mirror of the transition outbox, whose divergences
// live on here as kind policy instead of bespoke columns). The evidence agent published
// deterministic URLs into its handoff immediately; this lands the actual bytes, retrying until the
// backend accepts them — an expired SSO session defers the upload instead of losing it.
//
//  - ordering "latest-wins" per run scope: a re-capture (different key prefix) supersedes the
//    run's earlier undelivered publishes — only the latest handoff's URLs are ever embedded, so
//    retrying an older capture's bytes forever is waste. The SAME prefix re-opens (idempotent
//    backend delivery: an S3 re-put of the same keys is harmless).
//  - the enqueue LEASE (leaseUntil) keeps the Phase-0 flush from claiming a row mid inline-upload
//    (the CLI publishes inline in the agent's process, unlocked); a failed inline attempt clears
//    it, and it doubles as crash recovery if the CLI dies mid-upload.
//  - cause "publisher:<type>" + error class "auth" drive the SSO auto-resume: prePass probes creds
//    (gated on a stuck row — the happy path never probes) and requeues auth-stuck rows due-now the
//    moment creds are live again.
//  - a vanished capture dir (torn down before publish) or removed config is terminal — evidence
//    has no "gone at source" two-phase; the bytes simply can't land anymore.
import { existsSync } from "node:fs";
import type { Deps } from "../../core/deps.ts";
import type { Intent } from "../../types.ts";
import type { IntentKindDef, IntentOutcome } from "../registry.ts";
import { createEvidencePublisher, credsRefreshHint } from "../../clients/evidence.ts";

/** Enqueue lease seconds — see the module doc. Exported for the CLI's enqueue. */
export const EVIDENCE_PUBLISH_LEASE_SECONDS = 300;

/** How often the prePass probes backend creds when nothing is stuck (seconds). Proactive: an
 *  expired SSO session is RECORDED on the problem ledger within this window — before any upload
 *  fails and without the dashboard having to check anything. A stuck row still probes every pass
 *  (recovery must not wait out this interval). */
export const EVIDENCE_PROBE_INTERVAL_SECONDS = 300;
/** Last proactive probe per repo, epoch seconds. In-memory on purpose: a restart just probes once
 *  more, and the problem ledger row (the durable record) survives either way. */
const lastProbeAt = new Map<string, number>();

/** Test seam: forget the probe clock (the Map is process-global — mirrors resetAuthGate). */
export function resetEvidenceProbeClock(): void {
  lastProbeAt.clear();
}

export interface EvidencePublishPayload {
  keyPrefix: string;
  evidenceDir: string; // absolute worktree path; gone ⇒ terminal
}

function payloadOf(row: Intent): EvidencePublishPayload {
  return JSON.parse(row.payload) as EvidencePublishPayload;
}

function publisherOf(deps: Deps) {
  const ev = deps.config.evidence;
  return ev ? { ev, publisher: createEvidencePublisher(ev, { currentLogin: () => deps.github.currentLogin() }) } : undefined;
}

export const evidencePublishKind: IntentKindDef = {
  kind: "evidence_publish",
  ordering: "latest-wins",
  // A run parked by the evidence gate (a suspended upload) resumes straight into a fresh attempt.
  refundOnResume: "due_now",

  // The creds probe (S3 only — `local`/`command` expose no probeLiveness, and only S3 classifies
  // `auth`, so nothing is ever auth-stuck for them). Two jobs on one probe:
  //  - PROACTIVE detection, every EVIDENCE_PROBE_INTERVAL_SECONDS: an expired session is reported
  //    on the problem ledger (the dashboard's red repo light) before any upload fails;
  //  - SSO auto-resume, every pass while a row is auth-stuck: on recovery, clear the problem and
  //    make every auth-stuck row due now so THIS pass uploads it.
  // A probe THROW is unknown (a network blip is not "creds down") — change nothing, try later.
  prePass: async (deps) => {
    const p = publisherOf(deps);
    if (!p?.publisher.probeLiveness) return;
    const repo = deps.config.repoName;
    const stuck = deps.store.authStuckIntents(repo, "evidence_publish");
    if (!stuck && deps.now() - (lastProbeAt.get(repo) ?? 0) < EVIDENCE_PROBE_INTERVAL_SECONDS) return;
    lastProbeAt.set(repo, deps.now());
    let probe: { auth: boolean; reason: string };
    try {
      probe = await p.publisher.probeLiveness();
    } catch {
      return;
    }
    const cause = `publisher:${p.ev.publisher}`;
    if (probe.auth) {
      const profile = p.ev.publisher === "s3" ? p.ev.profile : undefined;
      deps.store.reportProblem(repo, cause, "auth", `evidence uploads blocked on AWS creds (${probe.reason}) — ${credsRefreshHint(profile)}`);
      return;
    }
    if (deps.store.clearProblem(repo, cause)) deps.log("info", "evidence publish: creds recovered — problem cleared");
    if (stuck) {
      const requeued = deps.store.requeueIntentsByCause(repo, cause, "auth");
      if (requeued > 0) deps.log("info", `evidence publish: creds recovered — re-queued ${requeued} stuck upload(s) for immediate retry`);
    }
  },

  deliver: async (deps, row): Promise<IntentOutcome> => {
    const p = publisherOf(deps);
    if (!p) return { kind: "failed", reason: "evidence config removed" };
    const { keyPrefix, evidenceDir } = payloadOf(row);
    // Best-effort drop policy: the bytes live in the worktree, which teardown removes. If the dir
    // is gone the publish can never land — stop retrying (covers the manual-teardown race too).
    if (!existsSync(evidenceDir)) {
      deps.log("warn", `${row.ticketKey}: evidence publish dropped — worktree removed before it landed`);
      return { kind: "failed", reason: "evidence dir gone (torn down before publish)" };
    }
    try {
      const { files } = await p.publisher.publish({ dir: evidenceDir, prefix: keyPrefix });
      deps.store.recordEvent({
        runId: row.runId,
        repo: row.repo,
        ticketKey: row.ticketKey,
        type: "evidence_uploaded",
        detail: { files: files.length, prefix: keyPrefix, attempts: row.attempts, publisher: p.ev.publisher },
      });
      deps.log("info", `${row.ticketKey}: evidence published (${files.length} file(s)) after ${row.attempts} retr${row.attempts === 1 ? "y" : "ies"}`);
      return { kind: "delivered" };
    } catch (e) {
      const c = p.publisher.classifyError(e);
      if (c.kind === "permanent") {
        deps.store.recordEvent({ runId: row.runId, repo: row.repo, ticketKey: row.ticketKey, type: "evidence_upload_failed", detail: { reason: c.reason } });
        return { kind: "failed", reason: c.reason };
      }
      return { kind: "retry", error: c.reason, errorClass: c.kind };
    }
  },

  notify: (deps, row, failure) => {
    const ev = deps.config.evidence;
    const repo = deps.config.repoName;
    if (failure.errorClass === "auth") {
      const profile = ev?.publisher === "s3" ? ev.profile : undefined;
      return {
        title: "herdr-factory: AWS SSO expired",
        body: `Evidence publish for ${row.ticketKey} is blocked on AWS creds — ${credsRefreshHint(profile)}. It uploads automatically on the next tick after they resolve.`,
      };
    }
    if (failure.errorClass === "permanent") {
      return {
        title: `herdr-factory: ${row.ticketKey} evidence publish failed`,
        body: `Evidence publish can't proceed: ${failure.reason}. Run \`herdr-factory --repo ${repo} doctor --deep\`; the published URLs won't resolve until it's fixed.`,
      };
    }
    return null; // transient: retried quietly (matches the legacy flow)
  },
};
