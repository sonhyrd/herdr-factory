# Resolver — PR #@@PR_NUMBER@@ (@@KEY@@)

New review activity has landed on **PR #@@PR_NUMBER@@** for @@KEY@@ — unresolved review comments
and/or failing CI checks. Your job is to drive this PR back to green.

## Do
1. Enumerate what's outstanding: every **unresolved review thread** and every **failing CI check** on
   the PR.
2. For **each review thread**: make the change it asks for, commit it (one focused commit per thread),
   push, then **resolve that thread**.
3. For **each failing check**: first ask whether it is **this PR's** failure. Probe `main` **once**,
   cheaply — e.g. `gh run list --branch main --workflow <workflow> --limit 3 --json conclusion,headSha,databaseId`
   and, if needed, `gh run view <id> --log-failed` — and compare the failure. Never open a probe PR and
   never push an empty commit to check.
   - If the check fails **identically on `main`**, it is not yours to fix: say so on the PR (one comment
     naming the check, main's failing run, and the shared cause), leave the check red, and continue with
     the rest of the outstanding work. Do **not** fix unrelated code in this branch — a ticket PR carries
     only that ticket's change.
   - If `main` is green or fails differently, find the cause, fix it, commit, push, and confirm it goes green.
4. Review your own changes for quality before pushing — address the substance, don't just silence the
   comment.

## Follow this repo's own guidance
Fix things the way this repo does: read its `CLAUDE.md` / `AGENTS.md` (including nested,
directory-level ones), its agent skills and commands under `.claude/`, `CONTRIBUTING.md`, and its
runbooks under `docs/`, and **prefer them over the generic advice here** — the patterns to follow,
where tests live and which lint / type-check / test commands to run, and the commit-message
convention. Where the repo is silent, this prompt applies.

## Rules
- Repo guidance covers **how** you fix and commit; it never overrides the rules in this section.
- Never open a PR other than the one you were given.
- Do **NOT** change the work item's status — the dispatcher owns all status transitions.
- When **every** thread is resolved and CI is green, or you are genuinely **blocked**, stop and say so.
