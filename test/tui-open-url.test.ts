// The dashboard's `o` / `O`: which URL a row resolves to, and how this host is meant to open it.
// Both are pure — the spawn itself is one line behind them (src/tui/open-url.ts).
import { describe, expect, it } from "vitest";
import { chooseOpener, linkRefs, rowUrl } from "../src/tui/open-url.ts";
import { githubIssuesDescriptor } from "../src/sources/github-issues/descriptor.ts";
import { jiraDescriptor } from "../src/sources/jira/descriptor.ts";
import { sentryDescriptor } from "../src/sources/sentry/descriptor.ts";
import { localMarkdownDescriptor } from "../src/sources/local-markdown/descriptor.ts";

describe("rowUrl", () => {
  const item = "https://github.com/o/n/issues/75";
  const pr = "https://github.com/o/n/pull/80";

  it("`o` opens the PR when there is one", () => {
    expect(rowUrl({ prUrl: pr, itemUrl: item }, "pr")).toBe(pr);
  });

  it("`o` falls back to the work item before there is a PR", () => {
    expect(rowUrl({ prUrl: null, itemUrl: item }, "pr")).toBe(item);
  });

  it("`O` opens the work item even when a PR exists", () => {
    expect(rowUrl({ prUrl: pr, itemUrl: item }, "item")).toBe(item);
  });

  it("has nothing to open for a source with no web item and no PR", () => {
    expect(rowUrl({ prUrl: null, itemUrl: null }, "pr")).toBeNull();
    expect(rowUrl({}, "item")).toBeNull();
  });
});

describe("descriptor itemUrl", () => {
  it("jira browses the key on the configured site", () => {
    expect(jiraDescriptor.itemUrl?.({ baseUrl: "https://org.atlassian.net" } as never, "MAMAS-12", "")).toBe(
      "https://org.atlassian.net/browse/MAMAS-12",
    );
  });

  it("github_issues points at the polled repo, defaulting to the PR repo", () => {
    expect(githubIssuesDescriptor.itemUrl?.({ kind: "issues" } as never, "75", "o/n")).toBe("https://github.com/o/n/issues/75");
    expect(githubIssuesDescriptor.itemUrl?.({ repo: "a/b", kind: "pull_requests" } as never, "9", "o/n")).toBe("https://github.com/a/b/pull/9");
    expect(githubIssuesDescriptor.itemUrl?.({ kind: "issues" } as never, "75", "")).toBeNull();
  });

  it("sentry points at the org's issue", () => {
    expect(sentryDescriptor.itemUrl?.({ baseUrl: "https://sentry.io", organization: "acme" } as never, "42", "")).toBe(
      "https://sentry.io/organizations/acme/issues/42/",
    );
  });

  it("local_markdown declares none — its items have no web page", () => {
    expect(localMarkdownDescriptor.itemUrl).toBeUndefined();
  });
});

describe("chooseOpener", () => {
  it("uses `open` on macOS and `xdg-open` elsewhere", () => {
    expect(chooseOpener({}, "darwin")).toEqual({ kind: "spawn", command: "open", args: [] });
    expect(chooseOpener({}, "linux")).toEqual({ kind: "spawn", command: "xdg-open", args: [] });
  });

  it("prefers $BROWSER wherever it is set — including over SSH, where it is the user saying so", () => {
    expect(chooseOpener({ BROWSER: "firefox" }, "linux")).toEqual({ kind: "spawn", command: "firefox", args: [] });
    expect(chooseOpener({ BROWSER: "firefox", SSH_CONNECTION: "1 2 3 4" }, "linux")).toEqual({ kind: "spawn", command: "firefox", args: [] });
    expect(chooseOpener({ BROWSER: "  " }, "linux")).toEqual({ kind: "spawn", command: "xdg-open", args: [] });
  });

  it("prints the URL over SSH with no display, rather than failing where nobody can see it", () => {
    expect(chooseOpener({ SSH_CONNECTION: "1 2 3 4" }, "linux")).toEqual({ kind: "print" });
    expect(chooseOpener({ SSH_CONNECTION: "1 2 3 4" }, "darwin")).toEqual({ kind: "print" });
  });

  it("still opens locally over SSH when there IS a display to draw into", () => {
    expect(chooseOpener({ SSH_CONNECTION: "1 2 3 4", DISPLAY: ":0" }, "linux")).toEqual({ kind: "spawn", command: "xdg-open", args: [] });
    expect(chooseOpener({ SSH_CONNECTION: "1 2 3 4", WAYLAND_DISPLAY: "wayland-0" }, "linux")).toEqual({
      kind: "spawn",
      command: "xdg-open",
      args: [],
    });
  });
});

describe("linkRefs — what the OSC 8 hyperlinks are hung on", () => {
  it("carves out every `#NN` ref and leaves the rest of the line plain", () => {
    expect(linkRefs("✓ 75  PR #69 is green — ready to merge  (app)")).toEqual([
      { text: "✓ 75  PR ", ref: false },
      { text: "#69", ref: true },
      { text: " is green — ready to merge  (app)", ref: false },
    ]);
  });

  it("links each ref of a line that carries several", () => {
    expect(linkRefs("#1 and #23").filter((s) => s.ref).map((s) => s.text)).toEqual(["#1", "#23"]);
  });

  it("answers one plain segment when there is no ref — the caller's cue to skip styling entirely", () => {
    expect(linkRefs("  app  @local  active 1/2")).toEqual([{ text: "  app  @local  active 1/2", ref: false }]);
    expect(linkRefs("issue #")).toEqual([{ text: "issue #", ref: false }]);
  });

  it("handles a ref at either end without emitting empty segments", () => {
    expect(linkRefs("#7 opened")).toEqual([{ text: "#7", ref: true }, { text: " opened", ref: false }]);
    expect(linkRefs("merged #7")).toEqual([{ text: "merged ", ref: false }, { text: "#7", ref: true }]);
  });
});
