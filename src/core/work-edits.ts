import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger, SourceRuntime } from "./deps.ts";
import type { WorkContent } from "../types.ts";

// Edit detection (issue #97): a work item edited after the claim must not ship against the copy the
// run snapshotted. The claim records the item's content next to the work doc; before a read-only or
// PR-opening step starts, reconcile re-reads it and parks the run when a content field changed.

/** The content the run last built against (claim time, then each acknowledged edit). */
export const CLAIMED_CONTENT_FILE = "work-content.json";
/** The before/after of every edited field, for the operator and a rework pass. */
export const WORK_EDITS_FILE = "work-item-edits.md";

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Record the item's content at claim. Idempotent (claiming ticks repeat) and best-effort: a run
 *  without a record takes its baseline at the first check instead. */
export async function recordClaimedContent(src: SourceRuntime, key: string, mem: string, log: Logger): Promise<void> {
  if (!src.client.workContent || existsSync(join(mem, CLAIMED_CONTENT_FILE))) return;
  try {
    writeFileSync(join(mem, CLAIMED_CONTENT_FILE), JSON.stringify(await src.client.workContent(key), null, 2));
  } catch (e) {
    log("warn", `${key}: could not record the claimed content for edit detection: ${errText(e)}`);
  }
}

/** Re-read the item and compare its content with the recorded copy. On an edit: refresh the work doc
 *  (the claim-time one kept as `<doc>.claimed<ext>`), write the before/after to WORK_EDITS_FILE, move
 *  the baseline to the new content (so a `resume` ships as is), and return the edited field names.
 *  [] when nothing changed, the source can't tell, or the read failed (never blocks an advance). */
export async function detectWorkItemEdits(src: SourceRuntime, key: string, mem: string, log: Logger): Promise<string[]> {
  if (!src.client.workContent) return [];
  const basePath = join(mem, CLAIMED_CONTENT_FILE);
  let now: WorkContent;
  try {
    now = await src.client.workContent(key);
  } catch (e) {
    log("warn", `${key}: edit check skipped — could not re-read the work item: ${errText(e)}`);
    return [];
  }
  let before: WorkContent;
  try {
    before = JSON.parse(readFileSync(basePath, "utf8")) as WorkContent;
  } catch {
    writeFileSync(basePath, JSON.stringify(now, null, 2)); // claimed before this shipped: baseline from here
    return [];
  }
  const changed = [...new Set([...Object.keys(before.fields), ...Object.keys(now.fields)])].filter(
    (f) => (before.fields[f] ?? "") !== (now.fields[f] ?? ""),
  );
  if (!changed.length) return [];

  const doc = (await src.client.workDoc(mem)).path;
  const claimed = doc.replace(/(\.[^./]+)?$/, ".claimed$1");
  const prev = join(mem, `${doc}.prev`);
  // materialize is skip-if-exists, so the current doc moves aside first; a failed refresh puts it back.
  if (existsSync(join(mem, doc))) renameSync(join(mem, doc), prev);
  await src.client.materialize(key, mem, log).catch((e) => log("warn", `${key}: work doc refresh failed: ${errText(e)}`));
  if (existsSync(prev)) {
    if (!existsSync(join(mem, doc))) renameSync(prev, join(mem, doc));
    else if (!existsSync(join(mem, claimed))) renameSync(prev, join(mem, claimed));
    else rmSync(prev, { recursive: true, force: true });
  }

  const sections = changed.flatMap((f) => [`## ${f}`, "", "### Before", "", before.fields[f] || "_(empty)_", "", "### Now", "", now.fields[f] || "_(empty)_", ""]);
  writeFileSync(
    join(mem, WORK_EDITS_FILE),
    [
      `# ${key} was edited after the run claimed it`,
      "",
      `Source last-updated: ${before.updated ?? "?"} → ${now.updated ?? "?"}. ${doc} holds the current copy; the claim-time one is ${claimed}.`,
      "",
      ...sections,
    ].join("\n"),
  );
  writeFileSync(basePath, JSON.stringify(now, null, 2));
  return changed;
}
