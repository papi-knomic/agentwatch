import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectClaudeHost, normalizeClaudeCode } from "./normalize.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const ctx = { env: { CLAUDE_CODE_ENTRYPOINT: "claude-vscode" }, now: new Date("2026-10-16T12:00:00.000Z") };

describe("normalizeClaudeCode", () => {
  it.each([
    ["session-start.json", "idle"],
    ["user-prompt-submit.json", "working"],
    ["post-tool-use.json", "working"],
    ["notification-permission.json", "needs_input"],
    ["notification-legacy.json", "needs_input"],
    ["stop.json", "done"],
    ["stop-failure.json", "error"],
    ["session-end.json", "ended"],
  ])("%s → %s", (file, status) => {
    const event = normalizeClaudeCode(fixture(file), ctx);
    expect(event).toMatchObject({
      tool: "claude-code",
      sessionId: "sess-demo-1",
      cwd: "C:\\Users\\dev\\projects\\demo",
      status,
      host: "VS Code",
      timestamp: "2026-10-16T12:00:00.000Z",
    });
  });

  it("ignores idle reminders, which arrive after Stop and need no action", () => {
    expect(normalizeClaudeCode(fixture("notification-idle.json"), ctx)).toBeNull();
  });

  it("keeps the permission message", () => {
    expect(normalizeClaudeCode(fixture("notification-permission.json"), ctx)?.message).toBe(
      "Claude needs your permission to use Bash",
    );
  });

  it("reports the error type on StopFailure", () => {
    expect(normalizeClaudeCode(fixture("stop-failure.json"), ctx)?.message).toBe(
      "rate_limit: 429 Too Many Requests",
    );
  });

  it("never carries prompts, assistant text or file contents", () => {
    for (const file of ["user-prompt-submit.json", "stop.json", "post-tool-use.json"]) {
      const serialized = JSON.stringify(normalizeClaudeCode(fixture(file), ctx));
      expect(serialized).not.toMatch(/factorial|refactoring|secret file content/);
    }
  });

  it("rejects payloads without a session id or cwd", () => {
    expect(normalizeClaudeCode({ hook_event_name: "Stop", cwd: "C:\\x" }, ctx)).toBeNull();
    expect(normalizeClaudeCode({ hook_event_name: "Stop", session_id: "a" }, ctx)).toBeNull();
    expect(normalizeClaudeCode("not an object", ctx)).toBeNull();
    expect(normalizeClaudeCode(null, ctx)).toBeNull();
  });

  it("ignores calls made by Grok, which also runs Claude Code's hooks", () => {
    const grokCtx = { ...ctx, env: { ...ctx.env, GROK_HOOK_EVENT: "Stop", GROK_SESSION_ID: "g1" } };
    expect(normalizeClaudeCode(fixture("stop.json"), grokCtx)).toBeNull();
  });

  it("ignores events it does not map", () => {
    expect(
      normalizeClaudeCode({ hook_event_name: "PreCompact", session_id: "a", cwd: "/x" }, ctx),
    ).toBeNull();
  });
});

describe("detectClaudeHost", () => {
  it("maps known entrypoints and terminals", () => {
    expect(detectClaudeHost({ CLAUDE_CODE_ENTRYPOINT: "claude-vscode" })).toBe("VS Code");
    expect(detectClaudeHost({ CLAUDE_CODE_ENTRYPOINT: "cli", WT_SESSION: "abc" })).toBe("Windows Terminal");
    expect(detectClaudeHost({ CLAUDE_CODE_ENTRYPOINT: "cli", TERM_PROGRAM: "vscode" })).toBe(
      "VS Code terminal",
    );
    expect(detectClaudeHost({ CLAUDE_CODE_ENTRYPOINT: "cli" })).toBe("Terminal");
    expect(detectClaudeHost({})).toBeUndefined();
  });
});
