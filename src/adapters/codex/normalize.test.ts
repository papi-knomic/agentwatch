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

  it("never carries prompts, tool output or assistant text", () => {
    for (const file of ["user-prompt-submit.json", "post-tool-use.json", "stop.json"]) {
      expect(JSON.stringify(normalizeCodex(fixture(file), ctx))).not.toMatch(/pagination|secret output/i);
    }
  });

  it("reports a terminal host when run from one", () => {
    const event = normalizeCodex(fixture("stop.json"), { ...ctx, env: { WT_SESSION: "x" } });
    expect(event?.host).toBe("Windows Terminal");
  });

  it("ignores unmapped events", () => {
    expect(normalizeCodex({ hook_event_name: "PreCompact", session_id: "a", cwd: "/x" }, ctx)).toBeNull();
  });
});
