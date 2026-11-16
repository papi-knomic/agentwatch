import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { claudeCodeDecide } from "./decide.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

// The end-to-end behaviour is covered by src/cli/decide.test.ts; this pins the adapter's own contract.
describe("claudeCodeDecide", () => {
  it("parses a permission request, with the preview and the host class", () => {
    const payload = fixture("permission-request.json");
    expect(claudeCodeDecide.parse(payload, {})).toMatchObject({
      kind: "permission",
      toolName: expect.any(String),
    });
    expect(claudeCodeDecide.parse(payload, {})?.concurrent).toBeUndefined();
    expect(claudeCodeDecide.parse(payload, { CLAUDE_CODE_ENTRYPOINT: "claude-vscode" })?.concurrent).toBe(
      true,
    );
    expect(claudeCodeDecide.parse(payload, { CLAUDE_CODE_ENTRYPOINT: "claude-desktop" })?.concurrent).toBe(
      true,
    );
  });

  it("parses AskUserQuestion from PreToolUse only, always blocking", () => {
    const request = claudeCodeDecide.parse(fixture("pre-tool-use-ask-user-question.json"), {
      CLAUDE_CODE_ENTRYPOINT: "claude-vscode",
    });
    expect(request?.kind).toBe("question");
    expect(request?.questions?.length).toBeGreaterThan(0);
    expect(request?.concurrent).toBeUndefined();
  });

  it("echoes the input on allow, and answers questions through PreToolUse", () => {
    const permission = claudeCodeDecide.parse(fixture("permission-request.json"), {});
    if (!permission) throw new Error("fixture must parse");
    const allow = JSON.parse(claudeCodeDecide.buildOutput(permission, { behavior: "allow" }) ?? "");
    expect(allow.hookSpecificOutput.decision).toEqual({
      behavior: "allow",
      updatedInput: permission.toolInput,
    });
    const deny = JSON.parse(claudeCodeDecide.buildOutput(permission, { behavior: "deny" }) ?? "");
    expect(deny.hookSpecificOutput.decision).toEqual({
      behavior: "deny",
      message: "Denied from the AgentWatch dashboard.",
    });
    expect(claudeCodeDecide.buildOutput(permission, { answers: { q: "a" } })).toBeNull();

    const question = claudeCodeDecide.parse(fixture("pre-tool-use-ask-user-question.json"), {});
    if (!question) throw new Error("fixture must parse");
    const answered = JSON.parse(claudeCodeDecide.buildOutput(question, { answers: { q: "a" } }) ?? "");
    expect(answered.hookSpecificOutput).toMatchObject({
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput: { answers: { q: "a" } },
    });
    expect(claudeCodeDecide.buildOutput(question, { behavior: "allow" })).toBeNull();
  });
});
