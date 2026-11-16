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

  it("parses AskUserQuestion from PreToolUse in the terminal, blocking", () => {
    const request = claudeCodeDecide.parse(fixture("pre-tool-use-ask-user-question.json"), {
      CLAUDE_CODE_ENTRYPOINT: "cli",
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

describe("AskUserQuestion by host", () => {
  const vscode = { CLAUDE_CODE_ENTRYPOINT: "claude-vscode" };
  const cli = { CLAUDE_CODE_ENTRYPOINT: "cli" };
  const preTool = fixture("pre-tool-use-ask-user-question.json");
  const permissionQuestion = fixture("permission-request-ask-user-question.json");

  it("VS Code and Desktop: PreToolUse returns null at once, PermissionRequest is a concurrent question", () => {
    for (const env of [vscode, { CLAUDE_CODE_ENTRYPOINT: "claude-desktop" }]) {
      expect(claudeCodeDecide.parse(preTool, env)).toBeNull();
      expect(claudeCodeDecide.skipped?.(preTool, env)).toMatchObject({
        reason: "question-handled-by-permission-request",
        concurrent: true,
      });
      const request = claudeCodeDecide.parse(permissionQuestion, env);
      expect(request).toMatchObject({ kind: "question", toolName: "AskUserQuestion", concurrent: true });
      expect(request?.questions).toHaveLength(2);
    }
  });

  it("terminal: PreToolUse stays a blocking question, PermissionRequest is skipped", () => {
    for (const env of [cli, {}]) {
      const request = claudeCodeDecide.parse(preTool, env);
      expect(request?.kind).toBe("question");
      expect(request?.concurrent).toBeUndefined();
      expect(claudeCodeDecide.parse(permissionQuestion, env)).toBeNull();
      expect(claudeCodeDecide.skipped?.(permissionQuestion, env)).toMatchObject({
        reason: "cli-permission-request-question",
        concurrent: false,
      });
    }
  });

  it("answers through PermissionRequest allow with updatedInput; multi-select is joined with a comma", () => {
    const request = claudeCodeDecide.parse(permissionQuestion, vscode);
    if (!request) throw new Error("fixture must parse");
    const answers = {
      "Which database should the app use?": "SQLite",
      "Which extras do you want?": "Linting, CI",
    };
    const output = JSON.parse(claudeCodeDecide.buildOutput(request, { answers }) ?? "");
    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
          updatedInput: {
            questions: (permissionQuestion as { tool_input: { questions: unknown } }).tool_input.questions,
            answers,
          },
        },
      },
    });
    expect(claudeCodeDecide.buildOutput(request, { behavior: "deny" })).toBeNull();
  });
});
