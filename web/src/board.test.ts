import { describe, expect, it } from "vitest";
import { agentsInUse, groupByProject, matchesAgent } from "./board";
import type { Session, ToolInfo } from "./useAgentStream";

const session = (key: string, tool: string): Session => ({
  key,
  tool,
  sessionId: key,
  cwd: "C:\\projects\\web",
  status: "working",
  startedAt: "2026-10-20T10:00:00.000Z",
  updatedAt: "2026-10-20T10:00:00.000Z",
  statusSince: "2026-10-20T10:00:00.000Z",
});

const tools: ToolInfo[] = [
  { id: "claude-code", label: "Claude Code", color: "#d97757" },
  { id: "codex", label: "Codex", color: "#10a37f" },
  { id: "opencode", label: "OpenCode", color: "#0ea5e9" },
];

describe("agentsInUse", () => {
  it("lists only agents with sessions, in the server's order, with counts", () => {
    const sessions = [session("a", "opencode"), session("b", "claude-code"), session("c", "opencode")];
    expect(agentsInUse(sessions, tools)).toEqual([
      { id: "claude-code", label: "Claude Code", color: "#d97757", count: 1 },
      { id: "opencode", label: "OpenCode", color: "#0ea5e9", count: 2 },
    ]);
  });

  it("still lists a tool the server didn't describe, last and without a colour", () => {
    expect(agentsInUse([session("a", "zed"), session("b", "codex")], tools)).toEqual([
      { id: "codex", label: "Codex", color: "#10a37f", count: 1 },
      { id: "zed", label: "zed", count: 1 },
    ]);
  });
});

describe("matchesAgent", () => {
  it("keeps everything without a filter, and only that agent with one", () => {
    expect(matchesAgent(session("a", "codex"), null)).toBe(true);
    expect(matchesAgent(session("a", "codex"), "codex")).toBe(true);
    expect(matchesAgent(session("a", "codex"), "opencode")).toBe(false);
  });
});

describe("groupByProject with a custom order", () => {
  const at = (key: string, cwd: string, status: Session["status"], since: string): Session => ({
    ...session(key, "claude-code"),
    cwd,
    status,
    statusSince: since,
    updatedAt: since,
  });
  it("orders rows inside a project by the given comparison but keeps projects by urgency", () => {
    const list = [
      at("a", "/p/one", "done", "2026-10-20T10:00:00.000Z"),
      at("b", "/p/one", "working", "2026-10-20T10:01:00.000Z"),
      at("c", "/p/two", "needs_input", "2026-10-20T10:02:00.000Z"),
    ];
    const byKeyDesc = (x: Session, y: Session) => y.key.localeCompare(x.key);
    const groups = groupByProject(list, byKeyDesc);
    expect(groups.map((g) => g.name)).toEqual(["two", "one"]);
    expect(groups[1]?.sessions.map((s) => s.key)).toEqual(["b", "a"]);
  });
});
