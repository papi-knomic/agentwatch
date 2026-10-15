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
    const env = { GROK_HOOK_EVENT: "Stop", GROK_SESSION_ID: "from-env" };
    expect(normalizeGrok({ cwd: "/w" }, { env, now: ctx.now })).toMatchObject({
      sessionId: "from-env",
      status: "done",
    });
  });

  it("uses workspaceRoot when cwd is missing", () => {
    const event = normalizeGrok({ hookEventName: "Stop", sessionId: "s", workspaceRoot: "/root" }, ctx);
    expect(event?.cwd).toBe("/root");
  });

  it("does not carry tool input", () => {
    expect(JSON.stringify(normalizeGrok(fixture("post-tool-use.json"), ctx))).not.toContain("npm run build");
  });
});
