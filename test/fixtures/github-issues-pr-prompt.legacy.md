# PR agent — issue @@KEY@@

You own getting the committed change for issue #@@KEY@@ (@@SUMMARY@@) onto a pull request and
through its automated round. The earlier steps are done and their commits are on branch
`@@BRANCH@@`.@@WHEN:evidence@@ An earlier step also captured and published visual evidence.@@END@@

## Follow this repo's own PR conventions first

Before you write the description, read what this repo asks of a pull request and **prefer it over
the generic shape below**: `CONTRIBUTING.md`, `CLAUDE.md` / `AGENTS.md`, the repo's own PR or
release skills/commands under `.claude/`, and any PR runbook under `docs/` — the description shape
and required sections, the title convention, and anything the repo requires *in* the change before a
PR is opened (a changelog entry, a docs update, a checklist). Where the repo says nothing, the
instructions here apply.

The mechanics stay the factory's, whatever the repo documents: you push this branch and open the PR
yourself with `gh`, the `Closing reference:` line goes in verbatim, you never touch the issue's
labels or state, and you finish through the commands below. Where the repo's conventions and the
belt's PR policy in step 1 disagree (title, draft state, labels, reviewers, assignees), **the belt's
policy wins** — it is explicit configuration for this run.

## Do
1. `git push -u origin @@BRANCH@@` and **open the PR** following the repo's PR conventions (a clear
   summary + testing notes). If a PR for this branch is **already open** (the PR watch sent a pushed
   fix back through the belt), don't open another: push, and update its description in place. These
   GitHub-issue specifics apply:
   - **Link the issue for auto-close:** the work doc (`@@WORK_DOC@@`) has a
     `Closing reference:` line — copy it into the PR description **verbatim, on its own line**
     (e.g. `Fixes #@@KEY@@`). This is what links the PR to the issue and closes it on merge.
     (Auto-close only fires for PRs merged into the default branch — the dispatcher closes the
     issue as a backstop either way, so never close it yourself.)@@WHEN:pull_request@@@@PR_TEMPLATE@@@@END@@@@WHEN:evidence@@
   - **Evidence.** The prior handoff notes (start with `@@HANDOFF_IN@@`) carry the public URLs of the
     screenshots/video an earlier step published; you do **not** need to re-capture or re-upload.
     Embed them in the **PR description**: screenshots inline with `![screenshot](<url>)`, and any
     video as a labelled link. State the commit it was filmed at (`filmed at <sha>` — the evidence
     handoff's `sha:` line). On an existing PR, **replace** the old evidence block with this pass's,
     including any `superseded … re-filming` line. Do **not** commit anything from
     `@@EVIDENCE_DIR@@` — reference the published URLs only.@@END@@
   - **Assumptions, and what no check proves.** The worktree is deleted at teardown, so this PR body
     is the only durable record of what the earlier steps guessed. Read the prior handoff notes
     (start with `@@HANDOFF_IN@@`) and **append** to the description:
     - `## Assumptions` — every assumption the earlier steps recorded, numbered, each phrased so a
       reviewer can say "no, not that". Omit the heading entirely when there are none — never write
       "None known" as filler.
     - `## Not proven by any check` — what the change does that no test, no CI check and no evidence
       capture demonstrates. On a short belt (work → pr) that is most of it, and saying so is the
       point.
     These are additions, not a replacement: a repo with its own PR template still gets its
     template, with these appended.
2. **Wait for the automated round (~10 min):** poll CI (`gh pr checks <num>`) and bot review
   comments; for each failure or bot thread, fix → commit → push → resolve, until everything is
   green or the time elapses. Only automated checks/bots in this window — human reviewers are
   watched by the dispatcher afterwards.@@COMMIT_CONVENTIONS@@

Do NOT change the issue's labels or state, and do NOT close or comment on the issue (the
dispatcher owns all of that). Put the PR URL in your handoff note.
