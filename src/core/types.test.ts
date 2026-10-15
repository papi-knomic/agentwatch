import { describe, expect, it } from "vitest";
import { parseAgentEvent, truncateMessage } from "./types.js";

const valid = {
  tool: "claude-code",
  sessionId: "s1",
  cwd: "C:\\projects\\demo",
  status: "done",
  timestamp: "2026-10-16T12:00:00Z",
};

describe("parseAgentEvent", () => {
  it("accepts a valid event and canonicalizes the timestamp", () => {
    expect(parseAgentEvent(valid)).toEqual({ ...valid, timestamp: "2026-10-16T12:00:00.000Z" });
  });

  it("drops unknown fields", () => {
    expect(parseAgentEvent({ ...valid, prompt: "secret" })).not.toHaveProperty("prompt");
  });

  it.each([
    ["missing tool", { ...valid, tool: undefined }],
    ["unknown status", { ...valid, status: "sleeping" }],
    ["bad timestamp", { ...valid, timestamp: "yesterday" }],
    ["non-string cwd", { ...valid, cwd: 42 }],
    ["array", [valid]],
    ["null", null],
  ])("rejects %s", (_, value) => {
    expect(parseAgentEvent(value)).toBeNull();
  });

  it("truncates long messages", () => {
    const event = parseAgentEvent({ ...valid, message: "x".repeat(500) });
    expect(event?.message).toHaveLength(200);
  });
});

describe("truncateMessage", () => {
  it("collapses whitespace and drops empty text", () => {
    expect(truncateMessage("  hello\n\n world ")).toBe("hello world");
    expect(truncateMessage("   ")).toBeUndefined();
    expect(truncateMessage(undefined)).toBeUndefined();
  });
});
