import { describe, expect, it } from "vitest";
import { parseAgentEvent, titleFromPrompt, truncateMessage } from "./types.js";

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

describe("titleFromPrompt", () => {
  it("uses the first non-empty line, trimmed to 80 characters", () => {
    expect(titleFromPrompt("\n  Fix the   login bug\nDetails: the token expires")).toBe("Fix the login bug");
    const long = titleFromPrompt("a".repeat(200));
    expect(long).toHaveLength(80);
    expect(long?.endsWith("…")).toBe(true);
  });

  it("skips slash commands and empty prompts", () => {
    expect(titleFromPrompt("/clear")).toBeUndefined();
    expect(titleFromPrompt("  /compact keep the plan")).toBeUndefined();
    expect(titleFromPrompt("   ")).toBeUndefined();
    expect(titleFromPrompt(undefined)).toBeUndefined();
  });

  it("skips the IDE context the VS Code extension puts before the prompt", () => {
    const opened =
      "<ide_opened_file>The user opened the file c:\\app\\README.md in the IDE. This may or may not be related.</ide_opened_file>";
    const selection = "<ide_selection>The user selected lines 1-3:\nconst a = 1;\n</ide_selection>";
    expect(titleFromPrompt(`${opened}Fix the login bug\nmore`)).toBe("Fix the login bug");
    expect(titleFromPrompt(`${opened}\n${selection}\n  Rename the helper`)).toBe("Rename the helper");
    expect(titleFromPrompt(`${opened}/clear`)).toBeUndefined();
    expect(titleFromPrompt(opened)).toBeUndefined();
  });

  it("keeps ordinary HTML at the start of a prompt", () => {
    expect(titleFromPrompt("<b>bold</b> text renders wrong")).toBe("<b>bold</b> text renders wrong");
  });

  it("is carried through HTTP validation, truncated", () => {
    expect(parseAgentEvent({ ...valid, title: "Fix login" })?.title).toBe("Fix login");
    expect(parseAgentEvent({ ...valid, title: "x".repeat(300) })?.title).toHaveLength(80);
  });
});

describe("truncateMessage", () => {
  it("collapses whitespace and drops empty text", () => {
    expect(truncateMessage("  hello\n\n world ")).toBe("hello world");
    expect(truncateMessage("   ")).toBeUndefined();
    expect(truncateMessage(undefined)).toBeUndefined();
  });
});
