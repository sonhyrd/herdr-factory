// Opening a dashboard row's PR / work item in a browser, and deciding when NOT to.
//
// A LEAF module: pure decisions (`chooseOpener`, `rowUrl`) plus one thin spawn, so the dashboard's
// `o`/`O` keys are unit-testable without a terminal or a browser. The spawn is detached and fully
// ignored — an opener that writes to stdout would otherwise paint over the TUI's own screen.
import { spawn } from "node:child_process";

/** What a row can be opened at. Both are resolved server-side (fleet/shapes.ts) and travel with the
 *  run, so a REMOTE machine's row opens in THIS machine's browser. */
export interface OpenableRow {
  prUrl?: string | null;
  itemUrl?: string | null;
}

/** `o` = the PR, falling back to the work item while there is no PR yet; `O` = always the work item. */
export function rowUrl(row: OpenableRow, which: "pr" | "item"): string | null {
  if (which === "item") return row.itemUrl ?? null;
  return row.prUrl ?? row.itemUrl ?? null;
}

/** Split a line at its `#NN` refs, so a renderer can hang an OSC 8 link on the refs alone and leave
 *  the rest of the line plain. Returns ONE non-ref segment when the line carries no ref, which is
 *  the caller's signal that there is nothing to link and the cheap plain-string path will do. */
export function linkRefs(content: string): { text: string; ref: boolean }[] {
  const out: { text: string; ref: boolean }[] = [];
  let last = 0;
  for (const m of content.matchAll(/#\d+/g)) {
    if (m.index > last) out.push({ text: content.slice(last, m.index), ref: false });
    out.push({ text: m[0], ref: true });
    last = m.index + m[0].length;
  }
  if (out.length === 0) return [{ text: content, ref: false }];
  if (last < content.length) out.push({ text: content.slice(last), ref: false });
  return out;
}

export type Opener =
  /** Hand the URL to this command. */
  | { kind: "spawn"; command: string; args: string[] }
  /** No display to open into — show the URL instead of failing where nobody can see it. */
  | { kind: "print" };

/**
 * How to open a URL here. `$BROWSER` wins when set — it is the user saying so explicitly, including
 * over SSH. Otherwise a session with no display to draw into (SSH with neither X nor Wayland) gets
 * the URL printed: `open`/`xdg-open` there either fail silently or open a browser on the far side of
 * the connection, and both are worse than a line you can Cmd-click.
 */
export function chooseOpener(env: Record<string, string | undefined>, platform: string): Opener {
  const browser = env.BROWSER?.trim();
  if (browser) return { kind: "spawn", command: browser, args: [] };
  if (env.SSH_CONNECTION && !env.DISPLAY && !env.WAYLAND_DISPLAY) return { kind: "print" };
  return platform === "darwin" ? { kind: "spawn", command: "open", args: [] } : { kind: "spawn", command: "xdg-open", args: [] };
}

/** Open `url`, or report that it could not be opened here. The message is what the caller shows on
 *  the status line — it carries the URL itself when there is no browser to hand it to. A missing
 *  opener binary surfaces asynchronously (spawn's `error` event), so `onFail` gets that one late:
 *  it must never be an unhandled error event, which would take the TUI's process down. */
export function openUrl(
  url: string,
  onFail: (message: string) => void,
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): { opened: boolean; message: string } {
  const opener = chooseOpener(env, platform);
  if (opener.kind === "print") return { opened: false, message: url };
  const child = spawn(opener.command, [...opener.args, url], { stdio: "ignore", detached: true });
  child.on("error", (e) => onFail(`✗ ${opener.command} could not open ${url} (${e.message})`));
  child.unref();
  return { opened: true, message: `opened ${url}` };
}
