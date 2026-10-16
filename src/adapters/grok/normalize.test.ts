import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeGrok } from "./normalize.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const ctx = { env: { WT_SESSION: "x" }, now: new Date("2026-10-16T12:00:00.000Z") };

describe("normalizeGrok", () => {
  it.each([
    ["session-start.json", "idle"],
    ["user-prompt-submit.json", "working"],
    ["post-tool-use.json", "working"],
    ["notification.json", "needs_input"],
    ["stop.json", "done"],
    ["stop-failure.json", "error"],
    ["session-end.json", "ended"],
  ])("%s → %s", (file, status) => {
    expect(normalizeGrok(fixture(file), ctx)).toMatchObject({
      tool: "grok",
      sessionId: "grok-sess-1",
      cwd: "C:\\Users\\dev\\projects\\web",
      status,
      host: "Windows Terminal",
    });
  });

  it("accepts Claude-style snake_case payloads too", () => {
    const event = normalizeGrok({ hook_event_name: "Stop", session_id: "s", cwd: "/w" }, ctx);
    expect(event).toMatchObject({ sessionId: "s", cwd: "/w", status: "done" });
  });

  it("falls back to GROK_* env vars for the event and session", () => {
    const env = { GROK_HOOK_EVENT: "stop", GROK_SESSION_ID: "from-env" };
    expect(normalizeGrok({ cwd: "/w" }, { env, now: ctx.now })).toMatchObject({
      sessionId: "from-env",
      status: "done",
    });
  });

  it("uses workspaceRoot when cwd is missing", () => {
    const event = normalizeGrok({ hookEventName: "Stop", sessionId: "s", workspaceRoot: "/root" }, ctx);
    expect(event?.cwd).toBe("/root");
  });

  it("does not carry tool input or output", () => {
    expect(JSON.stringify(normalizeGrok(fixture("post-tool-use.json"), ctx))).not.toContain("echo hello");
  });

  it("takes the task title from the prompt", () => {
    expect(normalizeGrok(fixture("user-prompt-submit.json"), ctx)?.title).toBe(
      "Reply with just the word OK.",
    );
  });

  it("ignores the idle ping Grok sends after a turn ends (seen live)", () => {
    expect(normalizeGrok(fixture("notification-idle.json"), ctx)).toBeNull();
  });

  it("maps the captured permission prompt by its notificationType", () => {
    expect(normalizeGrok(fixture("notification.json"), ctx)).toMatchObject({
      status: "needs_input",
      message: "Tool permission requested",
    });
    const idleTyped = {
      hookEventName: "notification",
      sessionId: "s",
      cwd: "/w",
      notificationType: "idle_prompt",
    };
    expect(
      normalizeGrok({ ...idleTyped, message: "Please approve? (wording doesn't matter)" }, ctx),
    ).toBeNull();
  });

  it("without a notificationType, only text that asks for a decision means needs you", () => {
    const base = { hookEventName: "notification", sessionId: "s", cwd: "/w" };
    expect(normalizeGrok({ ...base, message: "Grok wants to run a command. Allow?" }, ctx)?.status).toBe(
      "needs_input",
    );
    expect(normalizeGrok({ ...base, message: "Indexing finished" }, ctx)).toBeNull();
    expect(normalizeGrok(base, ctx)).toBeNull();
  });

  it("ignores the extra Stop Grok sends after the session shuts down", () => {
    expect(normalizeGrok(fixture("stop-shutdown.json"), ctx)).toBeNull();
  });

  it("understands snake_case event names on their own", () => {
    const raw = { hookEventName: "user_prompt_submit", sessionId: "s", cwd: "/w" };
    expect(normalizeGrok(raw, ctx)?.status).toBe("working");
    const fromEnv = { sessionId: "s", cwd: "/w" };
    expect(
      normalizeGrok(fromEnv, { ...ctx, env: { GROK_HOOK_EVENT: "post_tool_use_failure" } })?.status,
    ).toBe("working");
  });
});
