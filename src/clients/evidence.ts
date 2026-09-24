// Evidence media publishing, shared by the `evidence-upload` CLI command (agent-driven, inline fast
// path) and the reconciler's Phase 0 flush (durable background retry). Delivery is a SEAM: the
// `evidence.publisher` config (default `s3`) selects one of three backends behind the small
// `EvidencePublisher` interface, so both callers agree on the key layout, the URL shape ("prefix +
// filename", so prompts/PR embedding never change), and — crucially — how a delivery error is
// classified: an expired AWS SSO session must be a RETRYABLE `auth` failure the outbox keeps retrying
// (and the dashboard shows red), never a hard failure that drops the evidence (the PR #6541 bug).
//   - `s3`      — S3 + CloudFront (byte-identical to the original). Credentials come from the ambient
//                 AWS chain (env / SSO / ~/.aws / the named `profile`), never stored or logged.
//   - `local`   — copy captures into the dir the resident server serves (config-paths.evidenceServeDir);
//                 URLs point at the server. Zero cloud setup; rarely fails.
//   - `command` — run a user executable with (captureDir, keyPrefix); it uploads + prints public URLs.
import { cpSync, createReadStream, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { lookup as mimeLookup } from "mime-types";
import type { Config } from "../config.ts";
import { serverPort } from "../config.ts";
import { evidenceServeDir } from "../config-paths.ts";
import { run, ExecTimeoutError } from "./exec.ts";

export type EvidenceConfig = NonNullable<Config["evidence"]>;

/** The kind of a delivery failure — decides retry policy and the dashboard SSO light:
 *  - `auth`      → creds/SSO token expired or unresolved (S3 only). Retryable (after `aws sso login`);
 *                  the ONLY kind that means "SSO down".
 *  - `permanent` → config error (no bucket / wrong region / access denied / dir gone). Retrying can't help.
 *  - `transient` → timeout / unknown / a `local` copy or `command` failure. Retryable with backoff. */
export type EvidenceErrorKind = "auth" | "transient" | "permanent";
/** Back-compat alias — the taxonomy predates the multi-publisher seam. */
export type S3ErrorKind = EvidenceErrorKind;

export interface EvidenceClassification {
  kind: EvidenceErrorKind;
  retryable: boolean;
  reason: string;
}
/** Back-compat alias. */
export type S3Classification = EvidenceClassification;

/** One capture's set of files + the public URLs they resolve at (each ending in the file's path). */
export interface EvidenceDelivery {
  files: string[];
  urls: string[];
}

/** The delivery seam. One implementation per `evidence.publisher`; `createEvidencePublisher` selects it. */
export interface EvidencePublisher {
  readonly kind: EvidenceConfig["publisher"];
  /** Deterministic public URLs known WITHOUT delivering (prefix + filename), or `null` when only the
   *  delivery itself can produce them (`command` with no `public_base_url`, whose URLs come from its
   *  stdout). Lets the CLI embed links up-front even when the byte upload is deferred. */
  predictUrls(prefix: string, files: string[]): string[] | null;
  /** Deliver every file under `dir` at `prefix`; returns the files + their public URLs. Throws on
   *  failure (the caller classifies via `classifyError` and defers to the outbox). Idempotent per
   *  prefix — a retry (or a lease-overrun double delivery) just overwrites. */
  publish(opts: { dir: string; prefix: string }): Promise<EvidenceDelivery>;
  /** Map a `publish` failure to a kind + short actionable reason (drives retry + the SSO light). */
  classifyError(e: unknown): EvidenceClassification;
  /** Cheap creds-liveness probe for the auto-resume-on-recovery path (S3 only — `auth:true` == SSO
   *  down). Absent for backends with no auth (`local`/`command`); the flush then never probes. */
  probeLiveness?(): Promise<{ auth: boolean; reason: string }>;
  /** `doctor --deep` active probe — a real round-trip proving the backend works. Returns a success
   *  detail or throws a concise, actionable reason. */
  deepProbe(): Promise<string>;
}

/** External dependencies a publisher may need (kept minimal so the module stays testable). */
export interface EvidencePublisherContext {
  /** gh login resolver for the per-user key folder + the S3 deep-probe target (best-effort). */
  currentLogin?: () => Promise<string | null>;
}

/** Build the publisher for a repo's resolved `evidence` config. */
export function createEvidencePublisher(ev: EvidenceConfig, ctx: EvidencePublisherContext = {}): EvidencePublisher {
  switch (ev.publisher) {
    case "s3":
      return new S3Publisher(ev, ctx);
    case "local":
      return new LocalPublisher(ev);
    case "command":
      return new CommandPublisher(ev);
  }
}

/** Enumerate the evidence dir RECURSIVELY as posix-normalized relative paths (files only, sorted) — the
 *  set of assets to deliver / build URLs for. The dir is frozen once the evidence agent finishes, so this
 *  is deterministic across the inline attempt and every retry. */
export function enumerateEvidenceFiles(dir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir, { recursive: true }) as string[];
  } catch {
    return [];
  }
  return entries
    .map((r) => r.split(sep).join("/"))
    .filter((r) => {
      try {
        return statSync(join(dir, r)).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

/** The per-user evidence folder segment: the config override, else the gh-authenticated login
 *  (best-effort — omitted if it can't be resolved). Shared by every publisher (uniform key layout). */
export async function resolveGithubUsername(ev: EvidenceConfig, currentLogin: () => Promise<string | null>): Promise<string | undefined> {
  return ev.githubUsername ?? (await currentLogin().catch(() => null)) ?? undefined;
}

// ── S3 + CloudFront ───────────────────────────────────────────────────────────────────────────────

/**
 * The one hint every auth-stuck surface prints (doctor, the dashboard light, the notification), so
 * they can't drift. `aws sso login` is the common case but NOT the whole story, and saying only that
 * sends a user in a circle when their credential helper doesn't write `~/.aws`: the resident server
 * is launchd-spawned, so a helper that exports temporary credentials into an interactive shell — or
 * caches its SSO token somewhere the AWS SDK doesn't read, like granted's macOS keychain — is
 * invisible to it no matter how many times you log in. `credential_process` on the profile is what
 * bridges that (a dedicated profile: with `sso_session` present, SSO resolves first and wins).
 */
export function credsRefreshHint(profile?: string): string {
  const p = profile ? ` --profile ${profile}` : "";
  return `refresh AWS credentials (\`aws sso login${p}\`) — and note the background server reads ~/.aws, so a helper that only exports creds into your shell needs \`credential_process\` on the profile`;
}

/** Map an AWS SDK error to a kind + a short, actionable reason (the single source of truth for the S3
 *  taxonomy — `doctor.explainS3Error` delegates to `.reason`). */
export function classifyS3Error(e: unknown): EvidenceClassification {
  const err = e as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  const name = err.name ?? "";
  const status = err.$metadata?.httpStatusCode;
  const msg = err.message ?? String(e);
  if (/Credential|Token|SSO|ExpiredToken/i.test(name) || /could not load credentials|credential|sso session|token.*expired|expired.*token/i.test(msg)) {
    return { kind: "auth", retryable: true, reason: "AWS credentials expired or unresolved" };
  }
  if (name === "NoSuchBucket") return { kind: "permanent", retryable: false, reason: "bucket does not exist" };
  if (name === "PermanentRedirect" || /AuthorizationHeaderMalformed|the bucket is in this region|expecting.*region/i.test(msg)) {
    return { kind: "permanent", retryable: false, reason: "wrong region — the bucket is in a different AWS region" };
  }
  if (status === 403 || /AccessDenied|Forbidden/i.test(name)) {
    return { kind: "permanent", retryable: false, reason: "access denied — credentials lack s3:PutObject on this bucket/prefix" };
  }
  if (/Timeout|Abort/i.test(name) || /timed out|aborted/i.test(msg)) return { kind: "transient", retryable: true, reason: "timed out reaching S3" };
  return { kind: "transient", retryable: true, reason: `${name || "error"}: ${msg}`.slice(0, 160) };
}

type S3EvidenceConfig = Extract<EvidenceConfig, { publisher: "s3" }>;

/**
 * The credential-provider init the evidence client resolves AWS credentials with.
 *
 * `ignoreCache: true` is load-bearing in the RESIDENT SERVER and is why this is its own exported
 * function (test-pinned): `@smithy/core`'s shared-ini loader memoizes `~/.aws/config` in a
 * module-level `filePromises` map, so without it a long-lived process resolves credentials against
 * the snapshot it read on its FIRST upload — forever. A profile added or repointed while the server
 * is up then looks like a permanently broken credential (the SDK reports the unknown profile, which
 * classifies as `auth`), so the SSO auto-resume can never recover and only a restart fixes it. The
 * outbox's contract is "retry until the backend accepts", which has to include re-reading where the
 * credentials come from. Building a fresh client per upload is not enough on its own — the cache is
 * global to the process, not per client (that's what made this look like the earlier client-reuse
 * bug coming back).
 *
 * The SSO *token* cache (`~/.aws/sso/cache/*.json`) is read uncached by `getSSOTokenFromFile`, so a
 * plain `aws sso login` was always picked up by a running server; it's the config file that wasn't.
 */
export function evidenceCredentialInit(profile: string | undefined, logger: SdkLogger): { ignoreCache: true; logger: SdkLogger; profile?: string } {
  return { ignoreCache: true, logger, ...(profile ? { profile } : {}) };
}

/** The subset of the SDK's `Logger` the silencer implements. */
type SdkLogger = { debug(): void; info(): void; warn(): void; error(): void };

/** Build an S3 client for an evidence bucket. `maxAttempts:1` so callers own retry/backoff (the outbox),
 *  and the SDK's own console chatter is silenced. Credentials always come from an explicitly-built node
 *  provider chain (the same chain the client would build itself) so the cache-busting above applies
 *  whether or not a `profile` is configured. */
function evidenceClient(ev: S3EvidenceConfig): S3Client {
  const silent = { debug() {}, info() {}, warn() {}, error() {} };
  return new S3Client({
    region: ev.region,
    maxAttempts: 1,
    logger: silent,
    credentials: fromNodeProviderChain(evidenceCredentialInit(ev.profile, silent)),
  });
}

/** The public CloudFront URL per file (each ends with its filename, so callers can bind it to the right
 *  evidence row). Deterministic from the prefix + filenames — computable without the upload succeeding. */
export function evidenceUrls(cloudfrontDomain: string, prefix: string, files: string[]): string[] {
  return prefixUrls(`https://${cloudfrontDomain}`, prefix, files);
}

/** `<base>/<prefix>/<file>` per file, path segments URL-encoded — the shared "prefix + filename" shape. */
export function prefixUrls(base: string, prefix: string, files: string[]): string[] {
  return files.map((f) => `${base}/${prefix}/${f.split("/").map(encodeURIComponent).join("/")}`);
}

/** Upload every file under `dir` to `s3://<bucket>/<prefix>/…` (re-enumerated here so it always matches
 *  the frozen dir). Throws the raw SDK error on failure (caller classifies via `classifyS3Error`).
 *  Multipart is automatic for large video. Idempotent per key, so a retry (or a lease-overrun double
 *  upload) just overwrites. */
export async function uploadEvidence(opts: { evidence: S3EvidenceConfig; dir: string; prefix: string }): Promise<{ files: string[] }> {
  const { evidence: ev, dir, prefix } = opts;
  const files = enumerateEvidenceFiles(dir);
  const s3 = evidenceClient(ev);
  try {
    for (const rel of files) {
      await new Upload({
        client: s3,
        params: {
          Bucket: ev.bucket,
          Key: `${prefix}/${rel}`,
          Body: createReadStream(join(dir, rel)),
          // ContentType is load-bearing: without it CloudFront serves screenshots/video as downloads.
          ContentType: mimeLookup(rel) || "application/octet-stream",
        },
      }).done();
    }
    return { files };
  } finally {
    s3.destroy();
  }
}

/** Read-only credential liveness probe for the dashboard SSO light: a `HeadBucket` (no write) via the
 *  configured profile, short timeout. `auth:true` == SSO/creds down (the only "SSO is down" signal); a
 *  permanent bucket/perms error or a transient/timeout means creds are FINE (surfaced elsewhere), so the
 *  light stays green. */
export async function probeEvidenceCreds(ev: S3EvidenceConfig): Promise<{ auth: boolean; reason: string }> {
  const s3 = evidenceClient(ev);
  try {
    await s3.send(new HeadBucketCommand({ Bucket: ev.bucket }), { abortSignal: AbortSignal.timeout(3000) });
    return { auth: false, reason: "ok" };
  } catch (e) {
    const c = classifyS3Error(e);
    return { auth: c.kind === "auth", reason: c.reason };
  } finally {
    s3.destroy();
  }
}

class S3Publisher implements EvidencePublisher {
  readonly kind = "s3" as const;
  private ev: S3EvidenceConfig;
  private ctx: EvidencePublisherContext;
  constructor(ev: S3EvidenceConfig, ctx: EvidencePublisherContext) {
    this.ev = ev;
    this.ctx = ctx;
  }
  predictUrls(prefix: string, files: string[]): string[] {
    return evidenceUrls(this.ev.cloudfrontDomain, prefix, files);
  }
  async publish({ dir, prefix }: { dir: string; prefix: string }): Promise<EvidenceDelivery> {
    const { files } = await uploadEvidence({ evidence: this.ev, dir, prefix });
    return { files, urls: this.predictUrls(prefix, files) };
  }
  classifyError(e: unknown): EvidenceClassification {
    return classifyS3Error(e);
  }
  probeLiveness(): Promise<{ auth: boolean; reason: string }> {
    return probeEvidenceCreds(this.ev);
  }
  /** PUT a 0-byte probe object at the REAL upload base `<key_root>/<user>/<key_prefix>/.herdr-doctor`
   *  (a fixed key, overwritten each run) via the SAME ambient credential chain uploads use — this
   *  exercises the exact s3:PutObject permission at the exact prefix. Writes one tiny object by design. */
  async deepProbe(): Promise<string> {
    const ev = this.ev;
    const username = ev.githubUsername ?? (this.ctx.currentLogin ? await this.ctx.currentLogin().catch(() => null) : null) ?? undefined;
    const s3 = evidenceClient(ev);
    const key = [ev.keyRoot, username, ev.keyPrefix, ".herdr-doctor"].filter(Boolean).join("/");
    try {
      await s3.send(new PutObjectCommand({ Bucket: ev.bucket, Key: key, Body: "herdr-factory doctor probe\n", ContentType: "text/plain" }), {
        abortSignal: AbortSignal.timeout(8000),
      });
      return `writable — wrote s3://${ev.bucket}/${key} (${ev.region})`;
    } catch (e) {
      throw new Error(classifyS3Error(e).reason);
    } finally {
      s3.destroy();
    }
  }
}

// ── local (resident server static-serve) ─────────────────────────────────────────────────────────

type LocalEvidenceConfig = Extract<EvidenceConfig, { publisher: "local" }>;

/** The public origin `local` URLs are built from: the configured override, else the loopback bind. */
function localBaseUrl(ev: LocalEvidenceConfig): string {
  return ev.publicBaseUrl ?? `http://127.0.0.1:${serverPort()}`;
}

/** The public URL for one served file: `<base>/evidence/<prefix>/<file>` (prefix + filename). */
export function localEvidenceUrls(baseUrl: string, prefix: string, files: string[]): string[] {
  return files.map((f) => `${baseUrl}/evidence/${prefix}/${f.split("/").map(encodeURIComponent).join("/")}`);
}

class LocalPublisher implements EvidencePublisher {
  readonly kind = "local" as const;
  private ev: LocalEvidenceConfig;
  constructor(ev: LocalEvidenceConfig) {
    this.ev = ev;
  }
  predictUrls(prefix: string, files: string[]): string[] {
    return localEvidenceUrls(localBaseUrl(this.ev), prefix, files);
  }
  async publish({ dir, prefix }: { dir: string; prefix: string }): Promise<EvidenceDelivery> {
    const files = enumerateEvidenceFiles(dir);
    // Copy the frozen capture dir into the server's serve root under the prefix. Idempotent: a retry
    // overwrites. cpSync(recursive) mirrors the tree so nested captures keep their relative paths.
    const dest = join(evidenceServeDir(), prefix);
    mkdirSync(dest, { recursive: true });
    for (const rel of files) {
      const to = join(dest, rel);
      mkdirSync(join(to, ".."), { recursive: true });
      cpSync(join(dir, rel), to);
    }
    return { files, urls: this.predictUrls(prefix, files) };
  }
  classifyError(e: unknown): EvidenceClassification {
    // Local copy rarely fails; when it does (a full/read-only state dir) retrying costs nothing and
    // lands once the operator frees space. No `auth` — the SSO light never lights for `local`.
    return { kind: "transient", retryable: true, reason: e instanceof Error ? e.message.slice(0, 160) : String(e) };
  }
  /** Round-trip: write a probe file into the serve dir, fetch it back through the resident server (via
   *  the loopback bind — the mechanism under test), verify the bytes, then clean up. Proves the server
   *  is up AND actually serving `/evidence/…`. */
  async deepProbe(): Promise<string> {
    const prefix = "herdr-factory/.herdr-doctor";
    const dest = join(evidenceServeDir(), prefix);
    const marker = `herdr-factory local evidence probe ${process.pid}`;
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "probe.txt"), marker);
    const url = `http://127.0.0.1:${serverPort()}/evidence/${prefix}/probe.txt`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) throw new Error(`server returned ${res.status} for ${url}`);
      const body = await res.text();
      if (body.trim() !== marker) throw new Error(`served bytes did not match the probe (is another process serving ${evidenceServeDir()}?)`);
      return `served — round-tripped ${url} · public base ${localBaseUrl(this.ev)}`;
    } catch (e) {
      const reason = e instanceof Error && /fetch failed|ECONNREFUSED|timed out|aborted/i.test(e.message) ? `resident server not reachable at 127.0.0.1:${serverPort()} — start it (\`herdr-factory serve\` / the supervisor)` : e instanceof Error ? e.message : String(e);
      throw new Error(reason);
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  }
}

// ── command (bring-your-own backend) ───────────────────────────────────────────────────────────────

type CommandEvidenceConfig = Extract<EvidenceConfig, { publisher: "command" }>;

/** A `command` publish failure. Command failures are always `transient` — they retry on the same
 *  backoff as an S3 transient (the operator fixes the backend/config and the next attempt lands);
 *  there is no cheap way to tell a permanent misconfig from a transient outage, so we don't guess. */
class CommandPublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandPublishError";
  }
}

/** Keep only the lines of stdout that look like URLs (have a scheme), trimmed — the command's contract
 *  is one public URL per file. Log noise on other lines is ignored. */
function parseUrlLines(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[a-z][a-z0-9+.-]*:\/\//i.test(l));
}

class CommandPublisher implements EvidencePublisher {
  readonly kind = "command" as const;
  private ev: CommandEvidenceConfig;
  constructor(ev: CommandEvidenceConfig) {
    this.ev = ev;
  }
  /** With a declared `public_base_url` the layout is known (`<base>/<prefix>/<file>`); without one
   *  the URLs come only from the command's stdout — nothing to predict up-front. */
  predictUrls(prefix: string, files: string[]): string[] | null {
    return this.ev.publicBaseUrl ? prefixUrls(this.ev.publicBaseUrl, prefix, files) : null;
  }
  async publish({ dir, prefix }: { dir: string; prefix: string }): Promise<EvidenceDelivery> {
    const files = enumerateEvidenceFiles(dir);
    const [cmd, ...fixed] = this.ev.command;
    let res: Awaited<ReturnType<typeof run>>;
    try {
      // The capture dir + key prefix are the final two args. allowFail so a non-zero exit is data we
      // classify (not a throw); a timeout still throws ExecTimeoutError (infra failure).
      res = await run(cmd!, [...fixed, dir, prefix], { allowFail: true, timeoutMs: this.ev.timeoutSeconds * 1000 });
    } catch (e) {
      if (e instanceof ExecTimeoutError) throw new CommandPublishError(`publish command timed out after ${this.ev.timeoutSeconds}s`);
      throw new CommandPublishError(`publish command could not run: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.code !== 0) {
      const detail = (res.stderr || res.stdout || "").trim().slice(0, 300);
      throw new CommandPublishError(`publish command exited ${res.code}${detail ? `: ${detail}` : ""}`);
    }
    const urls = parseUrlLines(res.stdout);
    if (urls.length === 0) throw new CommandPublishError("publish command printed no URLs to stdout (expected one public URL per file)");
    return { files, urls };
  }
  classifyError(e: unknown): EvidenceClassification {
    return { kind: "transient", retryable: true, reason: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
  /** Dry-run: publish a single throwaway probe file from a temp dir at a probe prefix and confirm the
   *  command exits 0 and prints ≥1 URL. Uses the real publish path (so a broken command is caught). */
  async deepProbe(): Promise<string> {
    const tmp = mkdtempSync(join(tmpdir(), "hf-evidence-cmd-"));
    writeFileSync(join(tmp, "probe.txt"), "herdr-factory doctor probe\n");
    try {
      const { urls } = await this.publish({ dir: tmp, prefix: "herdr-factory/.herdr-doctor" });
      return `command ran — printed ${urls.length} URL(s), e.g. ${urls[0]}`;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}
