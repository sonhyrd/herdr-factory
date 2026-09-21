// Issue #70 — what the factory CALLS ITSELF in the comments it writes, and what it calls the HOST.
//
// Three worlds, because the thing under test is configuration and the whole point is that the two
// settings change what a real `serve` posts onto a real (fake) tracker:
//
//   1. `comment-brand`          — `source_comments.brand: hf` + `machine.yml: host_alias: contabo`:
//                                 the claim ledger is written in the new brand under the alias, a
//                                 LEGACY claim this host left under its raw hostname is recognised
//                                 as its own and released (no self-fence across a rollout), and
//                                 another host's legacy claim still fences the item.
//   2. `comment-brand-default`  — the control: no `source_comments`, no `host_alias`. The ledger
//                                 lines must be byte-identical to the pre-brand factory
//                                 (`[herdr-factory claim id=<run> host=<hostname>]`).
//   3. `comment-brand-legacy-question` — the reply channel across the same switch: a question posted
//                                 under the OLD marker is found by the idempotence scan (the human is
//                                 not asked twice), a note bearing the OLD marker is still ignored as
//                                 a reply (INV-6), and the NEXT question is written in the new brand.
//
// Why a real lane and not just units: every one of these is a string the engine posts to a backend
// through its own client, read back by its own parser, across a process boundary — a unit test can
// prove the function and still miss a brand that never reaches the wire.
import { expect } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { GithubFake } from "../harness/sources/github-fake.ts";
import { scenario } from "../harness/index.ts";

/** The placeholder brand and host alias. Deliberately not a real tenant's names — this repo is public. */
const BRAND = "hf";
const ALIAS = "contabo";

/** What `src/config.ts` folds this machine's own name to, and therefore the host token a LEGACY
 *  ledger line written here before the alias existed carries. */
const RAW_HOST = hostname().replace(/[^A-Za-z0-9._-]/g, "-");

/** Run ids for the SEEDED legacy claims. Far above anything this world will allocate, so
 *  `claimIsLive` can only answer "no such run here" — which is the case under test. */
const OLD_OWN_RUN = 90_001;
const OLD_OTHER_RUN = 90_002;

const PLAIN = 501; // an ordinary item: claim + release, both in the new brand under the alias
const OWN_LEGACY = 502; // carries OUR pre-alias claim — must be released, then re-claimed
const OTHER_LEGACY = 503; // carries ANOTHER host's legacy claim — must fence us, untouched

const legacyClaim = (runId: number, host: string) => `[herdr-factory claim id=${runId} host=${host}]`;

// ────────────────────────────────────────────────────────────────────────────────────────────────
// 1. branded + aliased
// ────────────────────────────────────────────────────────────────────────────────────────────────

const branded = new GithubFake({ repo: "acme/app" });

scenario(
  {
    name: "comment-brand",
    timeoutMs: 300_000,
    beforeStart: async (p) => {
      await branded.listen();
      branded.seed({ number: PLAIN, title: "An ordinary item", labels: ["hf-ship"] });
      branded.seed({ number: OWN_LEGACY, title: "Claimed here before the rename", labels: ["hf-ship"] });
      branded.seed({ number: OTHER_LEGACY, title: "Claimed by another host, long ago", labels: ["hf-ship"] });
      // The ledger as a half-migrated fleet leaves it: lines in the OLD brand, one of them written by
      // THIS host under the name it had before `host_alias`.
      branded.addComment(OWN_LEGACY, legacyClaim(OLD_OWN_RUN, RAW_HOST), "herdr-factory");
      branded.addComment(OTHER_LEGACY, legacyClaim(OLD_OTHER_RUN, "other-host"), "herdr-factory");
      // The alias is HOST-local — it names the machine, not the repo, so it lives next to repos/.
      mkdirSync(p.configDir, { recursive: true });
      writeFileSync(join(p.configDir, "machine.yml"), `host_alias: ${ALIAS}\n`);
    },
    afterStop: () => branded.close(),
    env: () => ({ GITHUB_TOKEN: "ghp_e2e", GITHUB_API_URL: branded.url }),
    config: () => ({
      limits: { max_active_workspaces: 4 },
      source_comments: { brand: BRAND },
      work_sources: [
        {
          type: "github_issues",
          name: "gh",
          poll_interval_seconds: 1,
          // The ledger only runs when the guard is on — this is the code path the brand and the
          // alias are FOR. A short settle keeps the scenario honest without making it slow.
          claim_guard: { enabled: true, settle_ms: 200 },
          github_issues: { repo: branded.repo },
        },
      ],
      belt: [{ name: "ship", source: "gh", label: "hf-ship", workspace_name: "s/{{work_id}}", steps: [{ type: "work" }] }],
    }),
  },
  async (w) => {
    const bodies = (n: number) => branded.comments(n).map((c) => c.body);

    // ── 1. an ordinary claim is written in the new brand, under the ALIAS ────────────────────────
    await w.waitFor(() => w.db.run(String(PLAIN)) !== undefined, { label: "the plain item is claimed", timeoutMs: 120_000 });
    const plainRun = w.db.run(String(PLAIN))!;
    await w.waitFor(() => bodies(PLAIN).includes(`[${BRAND} claim id=${plainRun.id} host=${ALIAS}]`), {
      label: "the claim comment carries the brand and the alias",
      timeoutMs: 60_000,
    });
    expect(bodies(PLAIN).join("\n"), "the machine's real name never reaches the tracker").not.toContain(RAW_HOST);
    expect(bodies(PLAIN).join("\n"), "and neither does the default brand").not.toContain("[herdr-factory");

    // Teardown posts the release — same brand, same alias.
    await w.waitForEnd(String(PLAIN), undefined, { label: "the plain item runs to the end", timeoutMs: 240_000 });
    await w.waitFor(() => bodies(PLAIN).includes(`[${BRAND} release id=${plainRun.id} host=${ALIAS}]`), {
      label: "the release comment matches the claim",
      timeoutMs: 60_000,
    });

    // ── 2. our OWN pre-alias claim is ours: released, not fenced ─────────────────────────────────
    // The whole rollout hinges on this. The seeded line says `host=<hostname>`; this factory now
    // calls itself `contabo`. If the alias did not fold onto the raw hostname, the host would read
    // its own dead claim as a foreign one and fence itself off the item forever.
    await w.waitFor(() => bodies(OWN_LEGACY).includes(`[${BRAND} release id=${OLD_OWN_RUN} host=${ALIAS}]`), {
      label: "our own legacy claim is released under the new name",
      timeoutMs: 120_000,
    });
    await w.waitFor(() => w.db.run(String(OWN_LEGACY)) !== undefined, { label: "…and the item is then claimed", timeoutMs: 120_000 });
    const ownRun = w.db.run(String(OWN_LEGACY))!;
    await w.waitFor(() => bodies(OWN_LEGACY).includes(`[${BRAND} claim id=${ownRun.id} host=${ALIAS}]`), {
      label: "the fresh claim is written in the new brand",
      timeoutMs: 60_000,
    });
    // Order matters: the release of the stale claim comes BEFORE the new claim, or there is a
    // window in which two open claims by the same host exist on one item.
    const owned = bodies(OWN_LEGACY);
    expect(owned.indexOf(`[${BRAND} release id=${OLD_OWN_RUN} host=${ALIAS}]`)).toBeLessThan(
      owned.indexOf(`[${BRAND} claim id=${ownRun.id} host=${ALIAS}]`),
    );
    // ── 3. another host's legacy claim still fences us — and nothing is posted ───────────────────
    // "Fence, never reap" has to survive the rename too: a host we cannot identify as ourselves is
    // another host, whatever brand its line is in.
    await w.waitFor(() => w.db.events(String(OTHER_LEGACY)).some((e) => e.type === "claimed_elsewhere"), {
      label: "the foreign legacy claim is recognised and the item skipped",
      timeoutMs: 120_000,
    });
    expect(w.db.run(String(OTHER_LEGACY)), "a fenced item is never claimed").toBeUndefined();
    expect(bodies(OTHER_LEGACY), "…and nothing is posted onto it — re-posting every tick would bury the ticket").toEqual([
      legacyClaim(OLD_OTHER_RUN, "other-host"),
    ]);
    const elsewhere = w.db.event(String(OTHER_LEGACY), "claimed_elsewhere")!;
    expect(elsewhere.data.host).toBe("other-host");
    expect(elsewhere.data.runId).toBe(OLD_OTHER_RUN);
  },
);

// ────────────────────────────────────────────────────────────────────────────────────────────────
// 2. the control: default config, byte-identical to the pre-brand factory
// ────────────────────────────────────────────────────────────────────────────────────────────────

const plain = new GithubFake({ repo: "acme/app" });
const CONTROL = 601;

scenario(
  {
    name: "comment-brand-default",
    timeoutMs: 240_000,
    beforeStart: async () => {
      await plain.listen();
      plain.seed({ number: CONTROL, title: "The unbranded control", labels: ["hf-ship"] });
      // No machine.yml, no source_comments — deliberately. This is what every existing install is.
    },
    afterStop: () => plain.close(),
    env: () => ({ GITHUB_TOKEN: "ghp_e2e", GITHUB_API_URL: plain.url }),
    config: () => ({
      work_sources: [
        {
          type: "github_issues",
          name: "gh",
          poll_interval_seconds: 1,
          claim_guard: { enabled: true, settle_ms: 200 },
          github_issues: { repo: plain.repo },
        },
      ],
      belt: [{ name: "ship", source: "gh", label: "hf-ship", workspace_name: "s/{{work_id}}", steps: [{ type: "work" }] }],
    }),
  },
  async (w) => {
    const bodies = () => plain.comments(CONTROL).map((c) => c.body);

    await w.waitFor(() => w.db.run(String(CONTROL)) !== undefined, { label: "the control item is claimed", timeoutMs: 120_000 });
    const run = w.db.run(String(CONTROL))!;
    // The exact string the factory wrote before `source_comments` existed — the default brand, and
    // the machine's own hostname, with no alias in sight.
    await w.waitFor(() => bodies().includes(`[herdr-factory claim id=${run.id} host=${RAW_HOST}]`), {
      label: "the default config writes the pre-brand claim line",
      timeoutMs: 60_000,
    });
    await w.waitForEnd(String(CONTROL), undefined, { label: "the control runs to the end", timeoutMs: 180_000 });
    await w.waitFor(() => bodies().includes(`[herdr-factory release id=${run.id} host=${RAW_HOST}]`), {
      label: "…and the pre-brand release line",
      timeoutMs: 60_000,
    });
  },
);

// ────────────────────────────────────────────────────────────────────────────────────────────────
// 3. the human loop across the switch
// ────────────────────────────────────────────────────────────────────────────────────────────────

const asked = new GithubFake({ repo: "acme/app" });
const ASK = 701;

/** The world's factory repo name (ScenarioSpec.repoName defaults to "app") — it is the first
 *  segment of a question marker, so the seeded legacy question has to spell it. */
const REPO = "app";
/** The run and question a fresh world allocates for its FIRST claim and its FIRST question. The
 *  seeded legacy marker has to name them exactly, and the body asserts both before relying on them. */
const FIRST_RUN = 1;
const FIRST_QUESTION = 1;

scenario(
  {
    name: "comment-brand-legacy-question",
    timeoutMs: 300_000,
    beforeStart: async (p) => {
      await asked.listen();
      asked.seed({ number: ASK, title: "A question was already asked here", labels: ["hf-ask"] });
      // A question this ticket already carries, posted by a factory that had not been re-branded yet.
      // askHuman is re-invoked until an externalId is persisted, so if the scan were blind to the old
      // marker the human would simply be asked the same thing twice.
      asked.addComment(
        ASK,
        [
          `[herdr-factory question: ${REPO}/${FIRST_RUN}/${FIRST_QUESTION}]`,
          `Work item: #${ASK}`,
          "Step: ask",
          "",
          "Should this apply to logged-out users too?",
        ].join("\n"),
        "herdr-factory",
      );
      mkdirSync(p.configDir, { recursive: true });
      writeFileSync(join(p.configDir, "machine.yml"), `host_alias: ${ALIAS}\n`);
    },
    afterStop: () => asked.close(),
    env: () => ({ GITHUB_TOKEN: "ghp_e2e", GITHUB_API_URL: asked.url }),
    config: () => ({
      source_comments: { brand: BRAND },
      work_sources: [
        {
          type: "github_issues",
          name: "gh",
          poll_interval_seconds: 1,
          claim_guard: { enabled: true, settle_ms: 200 },
          github_issues: { repo: asked.repo },
        },
      ],
      // The step is NAMED, so the agent script can address it without touching any other scenario's
      // `work` behaviour.
      belt: [{ name: "ask", source: "gh", label: "hf-ask", workspace_name: "a/{{work_id}}", steps: [{ type: "work", name: "ask" }] }],
    }),
    agent: { steps: { ask: { signal: "ask-human", text: "Should this apply to logged-out users too?" } } },
  },
  async (w) => {
    const key = String(ASK);
    const questionComments = () => asked.comments(ASK).filter((c) => c.body.includes("question:"));

    await w.waitFor(() => w.db.run(key)?.phase === "waiting_for_human", { label: "the agent asks and the run parks", timeoutMs: 240_000 });
    const run = w.db.run(key)!;
    // The seeded marker names run 1 / question 1 — a fresh world's first claim and first question.
    // Asserted rather than assumed, so a future change to id allocation fails here saying why.
    expect(run.id, "the seeded legacy question is addressed to this world's first run").toBe(FIRST_RUN);

    // ── 1. the legacy question is OURS: no second question is posted ─────────────────────────────
    const question = w.db.humanQuestions(run.id)[0] as { id: number; external_id: string };
    expect(question.id, "…and to its first question").toBe(FIRST_QUESTION);
    expect(questionComments().length, "the human is asked once, not once per brand").toBe(1);
    expect(questionComments()[0]!.body, "the one question on the ticket is the LEGACY one").toContain(
      `[herdr-factory question: ${REPO}/${FIRST_RUN}/${FIRST_QUESTION}]`,
    );
    expect(question.external_id, "…and the engine adopted it as the thread to watch").toBe(questionComments()[0]!.id);

    // ── 2. a LEGACY-marked artifact is still not a human reply (INV-6, bilingual) ────────────────
    asked.addComment(ASK, "[herdr-factory] ⚠ a note left by a host that has not been re-branded yet", "herdr-factory");
    w.db.dueNow("human_reply_poll", run.id);
    await w.waitFor(() => asked.requests(`GET /repos/${asked.repo}/issues/${ASK}/comments`).length > 1, {
      label: "the engine polls for a reply",
      timeoutMs: 90_000,
    });
    expect(w.db.run(key)!.phase, "an old-brand artifact of ours is not an answer").toBe("waiting_for_human");

    // ── 3. a real human reply resumes it, and the NEXT question is written in the new brand ──────
    w.setAgentScript({ steps: { ask: { signal: "ask-human", text: "And for anonymous API callers?" } } });
    asked.addComment(ASK, "Yes — logged-out too.", "a.human");
    w.db.dueNow("human_reply_poll", run.id);
    await w.waitFor(() => w.db.humanQuestions(run.id).length === 2, { label: "the reply lands and the agent asks again", timeoutMs: 180_000 });
    expect(w.db.eventTypes(key)).toContain("human_reply");
    await w.waitFor(() => questionComments().length === 2, { label: "the second question is posted", timeoutMs: 120_000 });
    expect(questionComments()[1]!.body, "a question the FACTORY writes now carries the configured brand").toContain(
      `[${BRAND} question: ${REPO}/${FIRST_RUN}/2]`,
    );
    expect(questionComments()[1]!.body, "…and nothing it writes says the old one").not.toContain("[herdr-factory");

    // Let it finish, so the release line is written too.
    w.setAgentScript({ steps: { ask: { signal: "step-done" } } });
    asked.addComment(ASK, "Anonymous callers too.", "a.human");
    w.db.dueNow("human_reply_poll", w.db.run(key)!.id);
    await w.waitForEnd(key, undefined, { label: "the run finishes once both questions are answered", timeoutMs: 240_000 });
    expect(asked.comments(ASK).map((c) => c.body)).toContain(`[${BRAND} release id=${run.id} host=${ALIAS}]`);
  },
);
