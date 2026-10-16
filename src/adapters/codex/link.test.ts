import { describe, expect, it } from "vitest";
import type { Session } from "../../core/types.js";
import { codexSessionLink } from "./link.js";

const session: Session = {
  key: "codex:s1",
  tool: "codex",
  sessionId: "s1",
  cwd: "/project",
  status: "done",
  startedAt: "2026-10-16T12:00:00.000Z",
  updatedAt: "2026-10-16T12:00:00.000Z",
};

describe("codexSessionLink", () => {
  it("opens desktop chats using their thread id as an encoded path segment", () => {
    expect(codexSessionLink({ ...session, host: "Codex Desktop" })).toBe("codex://threads/s1");
    expect(
      codexSessionLink({ ...session, host: "Codex Desktop", sessionId: "new?prompt=bad/path#fragment" }),
    ).toBe("codex://threads/new%3Fprompt%3Dbad%2Fpath%23fragment");
  });

  it.each([undefined, "VS Code", "VS Code terminal", "Windows Terminal"])(
    "doesn't resume %s sessions in the desktop app",
    (host) => {
      expect(codexSessionLink({ ...session, ...(host ? { host } : {}) })).toBeUndefined();
    },
  );

  it.each(["", "new", ".", ".."])("rejects reserved navigation segments (%j)", (sessionId) => {
    expect(codexSessionLink({ ...session, host: "Codex Desktop", sessionId })).toBeUndefined();
  });
});
