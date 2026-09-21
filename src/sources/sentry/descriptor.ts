import { z } from "zod";
import { SentryClient } from "../../clients/sentry.ts";
import { SentrySource, type SentrySourceCfg } from "../../clients/sentry-source.ts";
import type { SourceDescriptor } from "../registry.ts";
import { commonSourceFields } from "../common.ts";

// The sentry source's where-to-poll block. Auth is a single env token (SENTRY_AUTH_TOKEN) — there is
// NO OAuth here (Bearer token only). The eligibility filter (organization + projects + environment +
// query) lives on the SOURCE (one source = one filter); for a different filter, configure another
// sentry source. Environment is a Sentry EVENT/query parameter, not an issue field, so it filters at
// poll time. There is no pickup-label concept (the descriptor declares no pickupLabel) — belts on a
// sentry source carry no `label` and route via `match`/priority, like local_markdown.
const SentryBlockSchema = z
  .object({
    // The Sentry base URL: SaaS is https://sentry.io (region hosts like https://us.sentry.io /
    // https://de.sentry.io also work); self-hosted is your own https://sentry.example.com. The
    // OAuth-only region split doesn't apply to token auth. Optional (defaults to sentry.io). Must be
    // http(s) — z.url() alone would accept ftp:/file: etc., and the token rides in the request headers.
    base_url: z
      .url()
      .refine((u) => /^https?:\/\//i.test(u), "base_url must be an http(s) URL")
      .optional(),
    // The organization slug (or numeric id) the issues live in.
    organization: z.string({ error: "set `sentry.organization` to your Sentry org slug (or numeric id)" }).trim().min(1, "`sentry.organization` cannot be empty"),
    // Project slugs to poll; [] (default) = every project the token can see (project=-1).
    projects: z.array(z.string().trim().min(1)).default([]),
    // Environment names to filter on; [] (default) = all environments. A list (not a scalar) so the
    // TUI can edit it uniformly with `projects`.
    environment: z.array(z.string().trim().min(1)).default([]),
    // The Sentry issue search string — the pickup filter. Default is Sentry's own default.
    query: z.string().trim().default("is:unresolved"),
    // Window of activity to consider (issues with events in this period). "14d" surfaces actively-
    // firing errors; raise it to include quieter ones. Suffix s/m/h/d/w.
    stats_period: z
      .string()
      .trim()
      .regex(/^\d+[smhdw]$/, 'a period like "14d" / "24h" / "1w"')
      .default("14d"),
    // What to do to the Sentry issue when the fix PR MERGES. Default posts a note linking the PR;
    // `resolve`/`resolve_in_next_release` move the Sentry issue's status; `none` leaves it untouched.
    // (Lifecycle is tracked internally regardless — this is only the optional courtesy write-back.)
    on_merge: z.enum(["comment", "none", "resolve", "resolve_in_next_release"]).default("comment"),
  })
  .strict(); // an unknown key in the block is a typo — reject loudly

interface SentryParsed {
  type: "sentry";
  name?: string;
  sentry: z.infer<typeof SentryBlockSchema>;
}

export const sentryDescriptor: SourceDescriptor<SentrySourceCfg> = {
  type: "sentry",
  // No pickupLabel: sentry picks up by its config query, not a per-belt label (like local_markdown).
  configSchema: z.object({ type: z.literal("sentry"), ...commonSourceFields, sentry: SentryBlockSchema }).strict(),
  resolveConfig(parsed) {
    const b = (parsed as unknown as SentryParsed).sentry;
    return {
      baseUrl: (b.base_url ?? "https://sentry.io").replace(/\/+$/, ""),
      organization: b.organization,
      projects: b.projects,
      environment: b.environment,
      query: b.query,
      statsPeriod: b.stats_period,
      onMerge: b.on_merge,
    };
  },
  create(ctx) {
    const cfg = ctx.cfg;
    const client = new SentryClient({ baseUrl: cfg.baseUrl, organization: cfg.organization, token: ctx.env.SENTRY_AUTH_TOKEN ?? "", log: ctx.log });
    return new SentrySource(cfg, client, ctx.store, ctx.repoName, ctx.sourceName, ctx.log, ctx.brand);
  },
  supportsCustomStatuses: false, // internal-ledger: canonical states only (custom would need a work_items CHECK migration)
  customStatusKeys: () => [],
  secrets: [
    {
      envKey: "SENTRY_AUTH_TOKEN",
      required: true,
      masked: true,
      placeholder: "sntryu_… or an internal-integration token",
      hint: "a Sentry token with event:read + event:write — an Internal Integration token (Settings → Developer Settings) or a personal token (User Settings → Personal Tokens)",
    },
  ],
  tui: {
    defaultBlock: () => ({ organization: "", projects: [], query: "is:unresolved" }),
    fields: [
      { label: "sentry.organization", path: ["sentry", "organization"], placeholder: "my-org" },
      { label: "sentry.base_url", path: ["sentry", "base_url"], placeholder: "https://sentry.io (or self-hosted)" },
      { label: "sentry.projects", path: ["sentry", "projects"], list: true, placeholder: "project-slug (omit all = every project)" },
      { label: "sentry.environment", path: ["sentry", "environment"], list: true, placeholder: "production (omit all = every environment)" },
      { label: "sentry.query", path: ["sentry", "query"], placeholder: "is:unresolved level:error" },
      { label: "sentry.stats_period", path: ["sentry", "stats_period"], placeholder: "14d" },
      { label: "sentry.on_merge", path: ["sentry", "on_merge"], choices: ["comment", "none", "resolve", "resolve_in_next_release"], enumDefault: "comment" },
    ],
  },
};
