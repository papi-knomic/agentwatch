import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeOpenCode } from "./normalize.js";

interface BusEvent {
  type: string;
  properties: Record<string, unknown>;
}

const fixture = (name: string): BusEvent =>
  JSON.parse(readFileSync(new URL(`./fixtures/v1/${name}`, import.meta.url), "utf8"));

const SESSION = "ses_ea930fb5affekKS0B120gDMDYx";
const CWD = "C:\\Users\\dev\\projects\\web";
const AT = "2026-10-20T00:56:21.031Z";

/** What plugin.ts sends for a bus event (plugin.test.ts checks the plugin really builds this). */
const envelope = (name: string, extra: Record<string, unknown> = {}) => {
  const { type, properties } = fixture(name);
  return { event: { type, properties }, directory: CWD, pid: 4242, at: AT, ...extra };
};

const ctx = { env: { WT_SESSION: "x" }, now: new Date("2026-10-20T12:00:00.000Z") };

describe("normalizeOpenCode", () => {
  it.each([
    ["session-status-busy.json", "working"],
    ["session-status-retry.json", "working"],
    ["session-idle.json", "done"],
    ["session-error.json", "error"],
    ["session-deleted.json", "ended"],
    ["permission-asked-edit.json", "needs_input"],
    ["permission-asked-bash.json", "needs_input"],
    ["permission-updated.json", "needs_input"],
    ["permission-replied-once.json", "working"],
    ["permission-replied-reject.json", "working"],
    ["question-asked.json", "needs_input"],
    ["question-replied.json", "working"],
    ["question-rejected.json", "working"],
  ])("%s → %s", (file, status) => {
    expect(normalizeOpenCode(envelope(file), ctx)).toMatchObject({
      tool: "opencode",
      sessionId: SESSION,
      cwd: CWD,
      status,
      pid: 4242,
      host: "Windows Terminal",
      timestamp: AT,
    });
  });

  it.each([
    "session-status-idle.json",
    "session-created.json",
    "session-updated-title.json",
    "session-error-aborted.json",
  ])("ignores %s", (file) => {
    expect(normalizeOpenCode(envelope(file), ctx)).toBeNull();
  });

  it("names the permission without passing on the command or the diff", () => {
    const bash = normalizeOpenCode(envelope("permission-asked-bash.json"), ctx);
    expect(bash?.message).toBe("Permission needed: bash");
    expect(JSON.stringify(bash)).not.toContain("cmd /c");
    const edit = normalizeOpenCode(envelope("permission-asked-edit.json"), ctx);
    expect(edit?.message).toBe("Permission needed: edit");
    expect(JSON.stringify(edit)).not.toContain("world");
  });

  it("keeps question text out of the message", () => {
    const event = normalizeOpenCode(envelope("question-asked.json"), ctx);
    expect(event?.message).toBe("Has a question for you");
    expect(JSON.stringify(event)).not.toContain("colour");
  });

  it("reports the API error's message", () => {
    expect(normalizeOpenCode(envelope("session-error.json"), ctx)?.message).toBe(
      "You exceeded your current quota",
    );
  });

  it("says why it's retrying", () => {
    expect(normalizeOpenCode(envelope("session-status-retry.json"), ctx)?.message).toBe(
      "Retrying: Rate limited, retrying",
    );
  });

  it("keeps an error when OpenCode follows it with session.idle", () => {
    expect(normalizeOpenCode(envelope("session-idle.json", { afterError: "APIError" }), ctx)).toBeNull();
  });

  it("shows Esc as interrupted, not done", () => {
    expect(
      normalizeOpenCode(envelope("session-idle.json", { afterError: "MessageAbortedError" }), ctx),
    ).toMatchObject({ status: "idle", message: "Interrupted" });
  });

  it("uses OpenCode's own session title, but not its placeholder", () => {
    const named = normalizeOpenCode(
      envelope("session-status-busy.json", { title: 'Adding "world" to hello.txt' }),
      ctx,
    );
    expect(named).toMatchObject({ title: 'Adding "world" to hello.txt', titleSource: "tool" });
    const placeholder = normalizeOpenCode(
      envelope("session-status-busy.json", { title: "New session - 2026-10-20T00:56:10.149Z" }),
      ctx,
    );
    expect(placeholder?.title).toBeUndefined();
    expect(placeholder?.titleSource).toBeUndefined();
  });

  it("puts a subagent's prompts on the parent session and ignores its own busy/idle", () => {
    const root = { rootSessionID: "ses_parent" };
    expect(normalizeOpenCode(envelope("permission-asked-bash.json", root), ctx)).toMatchObject({
      sessionId: "ses_parent",
      status: "needs_input",
    });
    expect(normalizeOpenCode(envelope("question-replied.json", root), ctx)?.sessionId).toBe("ses_parent");
    expect(normalizeOpenCode(envelope("session-status-busy.json", root), ctx)).toBeNull();
    expect(normalizeOpenCode(envelope("session-idle.json", root), ctx)).toBeNull();
    expect(normalizeOpenCode(envelope("session-deleted.json", root), ctx)).toBeNull();
  });

  it("falls back to the hook's clock and OPENCODE_PID", () => {
    const { at: _at, pid: _pid, ...bare } = envelope("session-idle.json");
    const event = normalizeOpenCode(bare, { env: { OPENCODE_PID: "777" }, now: ctx.now });
    expect(event).toMatchObject({ timestamp: ctx.now.toISOString(), pid: 777 });
    expect(event?.host).toBeUndefined();
  });

  it("needs a session id and a directory", () => {
    const { directory: _directory, ...noDir } = envelope("session-idle.json");
    expect(normalizeOpenCode(noDir, ctx)).toBeNull();
    expect(
      normalizeOpenCode({ ...envelope("session-idle.json"), event: { type: "session.idle" } }, ctx),
    ).toBeNull();
    expect(normalizeOpenCode(fixture("session-idle.json"), ctx)).toBeNull();
  });
});

const fixtureV2 = (name: string): { type: string; data: Record<string, unknown> } =>
  JSON.parse(readFileSync(new URL(`./fixtures/v2/${name}`, import.meta.url), "utf8"));

const SESSION_V2 = "ses_e40543cc2ffewW3gz0p0TD4jA8";

/** What plugin.ts sends for an OpenCode 2.x event. */
const envelopeV2 = (name: string, extra: Record<string, unknown> = {}) => {
  const { type, data } = fixtureV2(name);
  return { v: 2, event: { type, data }, directory: CWD, pid: 4242, at: AT, ...extra };
};

describe("normalizeOpenCode, OpenCode 2.x", () => {
  it.each([
    ["session-execution-started.json", "working"],
    ["session-status-busy.json", "working"],
    ["session-status-retry.json", "working"],
    ["session-execution-succeeded.json", "done"],
    ["session-execution-failed.json", "error"],
    ["session-execution-interrupted-user.json", "idle"],
    ["session-execution-interrupted-shutdown.json", "idle"],
    ["session-deleted.json", "ended"],
    ["permission-asked-edit.json", "needs_input"],
    ["permission-asked-shell.json", "needs_input"],
    ["permission-replied-once.json", "working"],
    ["permission-replied-reject.json", "working"],
    ["form-created.json", "needs_input"],
    ["form-replied.json", "working"],
    ["form-cancelled.json", "working"],
  ])("%s → %s", (file, status) => {
    expect(normalizeOpenCode(envelopeV2(file), ctx)).toMatchObject({
      tool: "opencode",
      sessionId: SESSION_V2,
      cwd: CWD,
      status,
      pid: 4242,
      timestamp: AT,
    });
  });

  it.each([
    "session-status-idle.json",
    "session-created.json",
    "session-renamed.json",
    "session-execution-interrupted-superseded.json",
    "form-created-global.json",
  ])("ignores %s", (file) => {
    expect(normalizeOpenCode(envelopeV2(file), ctx)).toBeNull();
  });

  it("names the permission's action without passing on the command or file", () => {
    const shell = normalizeOpenCode(envelopeV2("permission-asked-shell.json"), ctx);
    expect(shell?.message).toBe("Permission needed: shell");
    expect(JSON.stringify(shell)).not.toContain('"dir');
    const edit = normalizeOpenCode(envelopeV2("permission-asked-edit.json"), ctx);
    expect(edit?.message).toBe("Permission needed: edit");
    expect(JSON.stringify(edit)).not.toContain("hello.txt");
  });

  it("keeps the form's question out of the message", () => {
    const event = normalizeOpenCode(envelopeV2("form-created.json"), ctx);
    expect(event?.message).toBe("Has a question for you");
    expect(JSON.stringify(event)).not.toContain("What word");
  });

  it("reports the failure's message, Esc as interrupted, and a rejected permission as stopped", () => {
    expect(normalizeOpenCode(envelopeV2("session-execution-failed.json"), ctx)?.message).toBe(
      "You exceeded your current quota",
    );
    expect(normalizeOpenCode(envelopeV2("session-execution-interrupted-user.json"), ctx)?.message).toBe(
      "Interrupted",
    );
    // Captured: OpenCode 2.2.6 ends the turn with reason "shutdown" right after a rejected permission.
    expect(normalizeOpenCode(envelopeV2("session-execution-interrupted-shutdown.json"), ctx)?.message).toBe(
      "Stopped",
    );
  });

  it("puts a subagent's form on the parent session and ignores its own lifecycle", () => {
    const root = { rootSessionID: "ses_parent" };
    expect(normalizeOpenCode(envelopeV2("form-created.json", root), ctx)?.sessionId).toBe("ses_parent");
    expect(normalizeOpenCode(envelopeV2("session-execution-succeeded.json", root), ctx)).toBeNull();
  });

  it("does not read 2.x data as 1.x properties, or the other way round", () => {
    const { v: _v, ...asV1 } = envelopeV2("session-execution-succeeded.json");
    expect(normalizeOpenCode(asV1, ctx)).toBeNull();
    expect(normalizeOpenCode({ ...envelope("session-idle.json"), v: 2 }, ctx)).toBeNull();
  });
});
