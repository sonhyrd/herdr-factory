import { z } from "zod";
import { JiraSource, type JiraSourceCfg } from "../../clients/jira-source.ts";
import { JiraApiTokenAuth } from "../../auth/jira-provider.ts";
import type { SourceDescriptor } from "../registry.ts";
import { claimGuardField, commonSourceFields } from "../common.ts";

// The Jira source's where-to-poll block. Pickup is by the Agile BOARD (the board's own saved filter),
// narrowed by status + the belt's label. Auth is API-TOKEN ONLY — email + token from the per-repo env
// file (JIRA_EMAIL + JIRA_API_TOKEN): the Agile board API (/rest/agile/1.0) is not reachable with an
// OAuth token, so there is no OAuth here. The pickup label is per-belt (belt.label), not on the source.
const JiraBlockSchema = z
  .object({
    // Required-field errors are worded as directives so they read whether the field is missing or
    // wrong-typed (the raw zod / bare-union messages give a first-time user nothing to act on).
    base_url: z.url({ error: "set `jira.base_url` to your Atlassian site, e.g. https://your-org.atlassian.net" }).transform((s) => s.replace(/\/+$/, "")),
    project: z.string({ error: "set `jira.project` to your Jira project key, e.g. PROJ" }).trim().min(1, "`jira.project` cannot be empty"),
    // The Agile board id to pull work from (REQUIRED). Accepts the numeric id or its string form; the
    // board scopes pickup to its own filter, and the status + label JQL narrows within it.
    board: z
      .union([z.string().trim().min(1), z.number().int().positive()], { error: "set `jira.board` to the Agile board id pickup pulls from, e.g. 254" })
      .transform((v) => String(v).trim()),
    status: z
      .object({
        todo: z.string().default("To Do"),
        in_development: z.string().default("In Progress"),
        review: z.string().default("In Review"),
        // OPT-IN terminal status: when set, a merged PR (and a custom belt's success) moves the ticket
        // here at teardown. Left UNSET by default so a run stays Jira-silent on merge — the ticket's
        // terminal closure is owned by Jira's GitHub integration unless you opt in here.
        done: z.string().trim().min(1).optional(),
      })
      // EXTRA named statuses (`status.<key>: <Jira status name>`) a belt `effects:` block can target
      // (e.g. `qa: QA Review`). catchall (not strict) so those pass validation while a mistyped
      // KNOWN key is still caught by its own schema; a belt effect referencing an undeclared key is
      // rejected at config-load, so a typo can't silently no-op at runtime.
      .catchall(z.string().trim().min(1))
      .prefault({}),
  })
  .strict(); // reject unknown jira keys loudly, not silently strip them

/** Raw parse output of the jira source object (post-zod, pre-resolve). */
interface JiraParsed {
  type: "jira";
  name?: string;
  jira: z.infer<typeof JiraBlockSchema>;
}

// The canonical-mapping keys of the jira `status` map (todo/in_development/in_review + the opt-in
// terminal). Everything else in the map is a belt-effect EXTRA (statusExtra) keyed by its own name.
const JIRA_KNOWN_STATUS_KEYS = new Set(["todo", "in_development", "review", "done"]);

/** Pull the extra `status.<key>` entries (beyond the known canonical-mapping keys) into a name→Jira
 *  status map a belt effect can target. Skips a `done` (its own field) and never emits empty values. */
function jiraStatusExtra(status: Record<string, unknown>): Record<string, string> {
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(status)) {
    if (JIRA_KNOWN_STATUS_KEYS.has(k)) continue;
    if (typeof v === "string" && v.trim()) extra[k] = v;
  }
  return extra;
}

export const jiraDescriptor: SourceDescriptor<JiraSourceCfg> = {
  type: "jira",
  pickupLabel: { noun: "label" },
  configSchema: z.object({ type: z.literal("jira"), ...commonSourceFields, ...claimGuardField, jira: JiraBlockSchema }).strict(),
  resolveConfig(parsed) {
    const s = (parsed as unknown as JiraParsed).jira;
    return {
      baseUrl: s.base_url,
      project: s.project,
      board: s.board,
      statusTodo: s.status.todo,
      statusInDev: s.status.in_development,
      statusReview: s.status.review,
      statusDone: s.status.done, // undefined ⇒ terminal stays unmapped (Jira-silent on merge)
      statusExtra: jiraStatusExtra(s.status as Record<string, unknown>),
    };
  },
  supportsCustomStatuses: true,
  customStatusKeys(cfg) {
    return Object.keys(cfg.statusExtra);
  },
  create(ctx) {
    return new JiraSource(ctx.cfg, new JiraApiTokenAuth(ctx.cfg.baseUrl, ctx.env.JIRA_EMAIL ?? "", ctx.env.JIRA_API_TOKEN ?? ""), ctx.brand);
  },
  secrets: [
    { envKey: "JIRA_EMAIL", required: true, placeholder: "you@org.com", hint: "the Atlassian account email" },
    { envKey: "JIRA_API_TOKEN", required: true, masked: true, hint: "an Atlassian API token (id.atlassian.com → Security → API tokens)" },
  ],
  tui: {
    defaultBlock: () => ({
      base_url: "",
      project: "",
      board: "",
      status: { todo: "To Do", in_development: "In Progress", review: "In Review" },
    }),
    fields: [
      { label: "jira.base_url", path: ["jira", "base_url"], placeholder: "https://org.atlassian.net" },
      { label: "jira.project", path: ["jira", "project"], placeholder: "PROJ" },
      { label: "jira.board", path: ["jira", "board"], placeholder: "254 (Agile board id)" },
      { label: "status.todo", path: ["jira", "status", "todo"], placeholder: "To Do" },
      { label: "status.in_development", path: ["jira", "status", "in_development"], placeholder: "In Progress" },
      { label: "status.review", path: ["jira", "status", "review"], placeholder: "In Review" },
      // Optional: leave blank to keep the ticket Jira-silent on merge (GitHub integration owns closure).
      { label: "status.done", path: ["jira", "status", "done"], placeholder: "Done (optional)" },
    ],
  },
};
