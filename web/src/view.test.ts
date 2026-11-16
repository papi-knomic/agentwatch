import { describe, expect, it } from "vitest";
import type { PendingDecision, Session } from "./useAgentStream";
import {
  anyBlocking,
  compareSessions,
  DEFAULT_SORT,
  effectiveStatus,
  matchesQuery,
  matchesStatus,
  nextSort,
  openTargetFor,
  parseStatusFilter,
  parseView,
  shortenPath,
  sortSessions,
  statusCounts,
  withDecisions,
} from "./view";

const session = (key: string, patch: Partial<Session> = {}): Session => ({
  key,
  tool: "claude-code",
  sessionId: key,
  cwd: "/projects/Web-App",
  status: "working",
  startedAt: "2026-10-20T10:00:00.000Z",
  updatedAt: "2026-10-20T10:00:00.000Z",
  statusSince: "2026-10-20T10:00:00.000Z",
  ...patch,
});

describe("parseView", () => {
  it("accepts the two views and defaults to the list", () => {
    expect(parseView("table")).toBe("table");
    expect(parseView("list")).toBe("list");
    expect(parseView(null)).toBe("list");
    expect(parseView(undefined)).toBe("list");
    expect(parseView("board")).toBe("list");
  });
});

describe("parseStatusFilter", () => {
  it("ignores unknown values", () => {
    expect(parseStatusFilter("needs")).toBe("needs");
    expect(parseStatusFilter("bogus")).toBe("all");
    expect(parseStatusFilter(null)).toBe("all");
  });
});

describe("matchesQuery", () => {
  const s = session("a", { title: "Fix Login Bug", host: "VS Code", tool: "codex" });
  it("matches everything for an empty query", () => {
    expect(matchesQuery(s, "", undefined)).toBe(true);
    expect(matchesQuery(s, "   ", undefined)).toBe(true);
  });
  it("matches title, project folder, host and agent name, ignoring case", () => {
    expect(matchesQuery(s, "login", undefined)).toBe(true);
    expect(matchesQuery(s, "WEB-app", undefined)).toBe(true);
    expect(matchesQuery(s, "vs code", undefined)).toBe(true);
    expect(matchesQuery(s, "codex", undefined)).toBe(true);
    expect(matchesQuery(s, "claude", "Codex")).toBe(false);
    expect(matchesQuery(session("b"), "claude", "Claude Code")).toBe(true);
  });
  it("needs every word to match", () => {
    expect(matchesQuery(s, "login web", undefined)).toBe(true);
    expect(matchesQuery(s, "login nope", undefined)).toBe(false);
  });
  it("does not search the full path or the message", () => {
    expect(matchesQuery(session("c", { message: "secret" }), "secret", undefined)).toBe(false);
    expect(matchesQuery(s, "projects", undefined)).toBe(false);
  });
});

describe("matchesStatus and statusCounts", () => {
  const list = [
    session("a", { status: "needs_input" }),
    session("b", { status: "error" }),
    session("c", { status: "working" }),
    session("d", { status: "done" }),
    session("e", { status: "idle" }),
  ];
  it("treats errors as needing you", () => {
    expect(list.filter((x) => matchesStatus(x, "needs")).map((x) => x.key)).toEqual(["a", "b"]);
    expect(list.filter((x) => matchesStatus(x, "all"))).toHaveLength(5);
  });
  it("counts each tab", () => {
    expect(statusCounts(list)).toEqual({ all: 5, needs: 2, working: 1, done: 1 });
  });
});

describe("sorting", () => {
  const label = (s: Session) => s.tool;
  const list = [
    session("w", {
      status: "working",
      title: "b task",
      tool: "opencode",
      statusSince: "2026-10-20T10:05:00.000Z",
    }),
    session("n", { status: "needs_input", title: "a task", tool: "codex", host: "Zed" }),
    session("d", { status: "done", title: "C task", tool: "claude-code", host: "VS Code" }),
  ];
  const keys = (sorted: Session[]) => sorted.map((s) => s.key).join("");

  it("defaults to urgency: needs you first, done last", () => {
    expect(keys(sortSessions(list, DEFAULT_SORT, label))).toBe("nwd");
  });
  it("sorts text columns case-insensitively and can reverse", () => {
    expect(keys(sortSessions(list, { key: "task", dir: "asc" }, label))).toBe("nwd");
    expect(keys(sortSessions(list, { key: "task", dir: "desc" }, label))).toBe("dwn");
    expect(keys(sortSessions(list, { key: "agent", dir: "asc" }, label))).toBe("dnw");
  });
  it("sorts by time, newest first on the first click", () => {
    expect(nextSort(DEFAULT_SORT, "time")).toEqual({ key: "time", dir: "desc" });
    expect(keys(sortSessions(list, { key: "time", dir: "desc" }, label))[0]).toBe("w");
  });
  it("sorts missing hosts together", () => {
    expect(keys(sortSessions(list, { key: "host", dir: "asc" }, label))[0]).toBe("w");
  });
  it("flips the direction when the same column is clicked again", () => {
    expect(nextSort({ key: "project", dir: "asc" }, "project")).toEqual({ key: "project", dir: "desc" });
    expect(nextSort({ key: "project", dir: "desc" }, "host")).toEqual({ key: "host", dir: "asc" });
  });
  it("is stable for equal rows", () => {
    const a = session("a");
    const b = session("b");
    expect(compareSessions(a, b, DEFAULT_SORT, label)).toBeLessThan(0);
    expect(compareSessions(b, a, DEFAULT_SORT, label)).toBeGreaterThan(0);
  });
  it("does not change the input", () => {
    const copy = [...list];
    sortSessions(list, { key: "task", dir: "desc" }, label);
    expect(list).toEqual(copy);
  });
});

describe("openTargetFor", () => {
  it("names the app a host opens in", () => {
    expect(openTargetFor("VS Code")).toBe("VS Code");
    expect(openTargetFor("VS Code Insiders")).toBe("VS Code");
    expect(openTargetFor("Claude Desktop")).toBe("Claude");
    expect(openTargetFor("Codex Desktop")).toBe("Codex");
    expect(openTargetFor("Windows Terminal")).toBeUndefined();
    expect(openTargetFor(undefined)).toBeUndefined();
  });
});

const decision = (sessionKey: string, patch: Partial<PendingDecision> = {}): PendingDecision => ({
  id: `d-${sessionKey}`,
  sessionKey,
  kind: "permission",
  toolName: "Bash",
  createdAt: "2026-10-20T10:30:00.000Z",
  expiresAt: "2026-10-20T10:31:40.000Z",
  ...patch,
});

describe("effectiveStatus", () => {
  it("treats a working session with a pending decision as needing you", () => {
    expect(effectiveStatus(session("a"), [decision("a")])).toBe("needs_input");
    expect(effectiveStatus(session("a", { status: "idle" }), [decision("a")])).toBe("needs_input");
  });

  it("leaves other sessions and errors alone", () => {
    expect(effectiveStatus(session("a"), [decision("b")])).toBe("working");
    expect(effectiveStatus(session("a", { status: "error" }), [decision("a")])).toBe("error");
    expect(effectiveStatus(session("a"), [])).toBe("working");
  });
});

describe("withDecisions", () => {
  it("makes counts, filters and sorting see the pending decision", () => {
    const sessions = withDecisions(
      [session("a"), session("b"), session("c", { status: "needs_input" })],
      [decision("a")],
    );
    expect(statusCounts(sessions).needs).toBe(2);
    expect(statusCounts(sessions).working).toBe(1);
    expect(matchesStatus(sessions[0] as Session, "needs")).toBe(true);
    const sorted = sortSessions(sessions, DEFAULT_SORT, (s) => s.tool);
    expect(sorted.at(-1)?.key).toBe("b");
  });

  it("dates the wait from the prompt and keeps untouched sessions as they are", () => {
    const original = [session("a"), session("b")];
    const out = withDecisions(original, [decision("a")]);
    expect(out[0]?.statusSince).toBe("2026-10-20T10:30:00.000Z");
    expect(out[1]).toBe(original[1]);
    expect(withDecisions(original, [])).toBe(original);
  });
});

describe("anyBlocking", () => {
  it("is true only when a prompt is held back from its host", () => {
    expect(anyBlocking([])).toBe(false);
    expect(anyBlocking([decision("a", { concurrent: true })])).toBe(false);
    expect(anyBlocking([decision("a", { concurrent: true }), decision("b")])).toBe(true);
  });
});

describe("shortenPath", () => {
  const scratch =
    "C:\\Users\\someone\\AppData\\Local\\Claude-Data\\claude_xxx\\scratch-workspaces\\6a45d61a-1111-2222-3333-444444444444\\78aa963c-aaaa-bbbb-cccc-dddddddddddd";

  it("leaves a short path alone", () => {
    expect(shortenPath("/projects/Web-App")).toBe("/projects/Web-App");
    expect(shortenPath("C:workapp")).toBe("C:workapp");
  });

  it("replaces a Windows user home with ~ and keeps the rest", () => {
    expect(shortenPath("C:\\Users\\someone\\code\\app")).toBe("~\\code\\app");
  });

  it("replaces a macOS or Linux home with ~", () => {
    expect(shortenPath("/Users/someone/code/app")).toBe("~/code/app");
    expect(shortenPath("/home/someone/code/app")).toBe("~/code/app");
  });

  it("does not treat a path that only starts with Users as a home", () => {
    expect(shortenPath("C:\\Users")).toBe("C:\\Users");
  });

  it("middle-ellipsizes a long scratch path to first segment, ellipsis, and last two segments", () => {
    const short = shortenPath(scratch);
    expect(short).toBe("~\\…\\6a45d61a-1111-2222-3333-444444444444\\78aa96…");
    expect(short.length).toBeLessThanOrEqual(48);
  });

  it("keeps a long path within the limit when the tail is short", () => {
    const deep = `/home/someone/${"a-very-long-folder-name/".repeat(4)}end`;
    const short = shortenPath(deep);
    expect(short.length).toBeLessThanOrEqual(48);
    expect(short.startsWith("~/…/")).toBe(true);
    expect(short.endsWith("end")).toBe(true);
  });

  it("uses the same limit when asked", () => {
    expect(shortenPath("C:\\Users\\someone\\alpha\\beta\\gamma\\delta", 20)).toBe("~\\…\\gamma\\delta");
  });
});
