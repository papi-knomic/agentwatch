import { describe, expect, it } from "vitest";
import type { Session } from "../../core/types.js";
import { claudeCodeSessionLink } from "./link.js";

const base: Session = {
  key: "claude-code:5f0c3b1e-8a2d-4c6f-9b7e-1d2a3c4b5e6f",
  tool: "claude-code",
  sessionId: "5f0c3b1e-8a2d-4c6f-9b7e-1d2a3c4b5e6f",
  cwd: "C:\\projects\\demo",
  status: "done",
  startedAt: "2026-10-16T12:00:00.000Z",
  updatedAt: "2026-10-16T12:00:00.000Z",
};

describe("claudeCodeSessionLink", () => {
  it("links extension sessions to their tab", () => {
    expect(claudeCodeSessionLink({ ...base, host: "VS Code" })).toBe(
      "vscode://anthropic.claude-code/open?session=5f0c3b1e-8a2d-4c6f-9b7e-1d2a3c4b5e6f",
    );
  });

  it("has no link for CLI sessions, which would be resumed in a second process", () => {
    expect(claudeCodeSessionLink({ ...base, host: "VS Code terminal" })).toBeUndefined();
    expect(claudeCodeSessionLink({ ...base, host: "Windows Terminal" })).toBeUndefined();
    expect(claudeCodeSessionLink(base)).toBeUndefined();
  });
});

describe("claudeCodeSessionLink for Claude Desktop", () => {
  const desktop = { ...base, host: "Claude Desktop" };
  it("links to the app's own session id", () => {
    expect(claudeCodeSessionLink(desktop, () => "local_abc-123")).toBe(
      "claude://code/continue?session=local_abc-123&source=agentwatch",
    );
  });
  it("has no link when the app's id can't be found, rather than guessing with session=last", () => {
    expect(claudeCodeSessionLink(desktop, () => undefined)).toBeUndefined();
  });
});
