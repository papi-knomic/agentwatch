import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeCodex } from "./normalize.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const ctx = { env: { VSCODE_PID: "1234" }, now: new Date("2026-10-16T12:00:00.000Z") };

describe("normalizeCodex", () => {
  it.each([
    ["session-start.json", "idle"],
    ["user-prompt-submit.json", "working"],
    ["post-tool-use.json", "working"],
    ["permission-request.json", "needs_input"],
    ["stop.json", "done"],
    ["interrupt.json", "idle"],
    ["session-end.json", "ended"],
  ])("%s → %s", (file, status) => {
    expect(normalizeCodex(fixture(file), ctx)).toMatchObject({
      tool: "codex",
      sessionId: "codex-sess-1",
      cwd: "C:\\Users\\dev\\projects\\api",
      status,
      host: "VS Code",
      timestamp: "2026-10-16T12:00:00.000Z",
    });
  });

  it("names the tool on permission requests, without the command itself", () => {
    const event = normalizeCodex(fixture("permission-request.json"), ctx);
    expect(event?.message).toBe("Needs permission to use shell");
    expect(JSON.stringify(event)).not.toContain("rm -rf");
  });

  it("marks an async question as pending, without carrying its questions or answers", () => {
    expect(normalizeCodex(fixture("question-async.json"), ctx)).toMatchObject({
      status: "needs_input",
      inputPending: true,
      message: "Waiting for your answer",
    });
    expect(normalizeCodex(fixture("user-prompt-submit.json"), ctx)?.inputPending).toBe(false);
  });

  it.each(["", "**", "  "])("hides the desktop suggestion helper (prefix %j)", (prefix) => {
    const event = normalizeCodex(
      {
        session_id: "helper",
        cwd: "/project",
        hook_event_name: "UserPromptSubmit",
        prompt: `${prefix}This is an app-generated request for a suggested next user message.\nPrivate context`,
      },
      ctx,
    );
    expect(event).toMatchObject({ hidden: true });
    expect(event).not.toHaveProperty("title");
    expect(JSON.stringify(event)).not.toContain("Private context");
  });

  it("keeps real user tasks about suggestions visible", () => {
    const event = normalizeCodex(
      {
        session_id: "real",
        cwd: "/project",
        hook_event_name: "UserPromptSubmit",
        prompt: "Fix suggested next user messages in the app",
      },
      ctx,
    );
    expect(event?.status).toBe("working");
    expect(event?.hidden).toBeUndefined();
  });

  it("never carries tool input, tool output or assistant text", () => {
    for (const file of ["post-tool-use.json", "stop.json"]) {
      expect(JSON.stringify(normalizeCodex(fixture(file), ctx))).not.toMatch(/echo hello|DONE/);
    }
  });

  it("takes the task title from the prompt", () => {
    expect(normalizeCodex(fixture("user-prompt-submit.json"), ctx)?.title).toBe(
      "Run the shell command: echo hello. Then reply DONE.",
    );
  });

  it("reports a terminal host when run from one", () => {
    const event = normalizeCodex(fixture("stop.json"), { ...ctx, env: { WT_SESSION: "x" } });
    expect(event?.host).toBe("Windows Terminal");
  });

  it("identifies desktop sessions ahead of inherited VS Code or terminal variables", () => {
    expect(
      normalizeCodex(fixture("stop.json"), {
        ...ctx,
        env: {
          CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "Codex Desktop",
          TERM_PROGRAM: "vscode",
          VSCODE_PID: "1234",
        },
      })?.host,
    ).toBe("Codex Desktop");
  });

  it("ignores unmapped events", () => {
    expect(normalizeCodex({ hook_event_name: "PreCompact", session_id: "a", cwd: "/x" }, ctx)).toBeNull();
  });
});
