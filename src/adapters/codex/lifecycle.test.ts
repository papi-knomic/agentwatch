import { describe, expect, it } from "vitest";
import { defaultToolSettings } from "../../core/config.js";
import { SessionStore } from "../../core/store.js";
import type { AgentEvent } from "../../core/types.js";
import type { DesktopNotification } from "../../notify/index.js";
import { createNotificationDispatcher } from "../../server/notifications.js";
import { normalizeCodex } from "./normalize.js";

function harness() {
  const store = new SessionStore();
  const notifications: DesktopNotification[] = [];
  let now = Date.parse("2026-10-16T12:00:00Z");
  store.subscribe(
    createNotificationDispatcher({
      config: {
        port: 1,
        token: "test-token",
        notifications: true,
        tools: { codex: defaultToolSettings("Codex", "#10a37f", "im") },
      },
      notifier: async (notification) => {
        notifications.push(notification);
      },
      dashboardUrl: "http://127.0.0.1:1",
      log: () => {},
      now: () => now,
    }),
  );
  const apply = (name: string, extra: Record<string, unknown> = {}) => {
    now += 4000;
    const event = normalizeCodex(
      { session_id: "s1", cwd: "/project", hook_event_name: name, ...extra },
      { env: {}, now: new Date(now) },
    );
    if (event) store.apply(event);
  };
  return { store, notifications, apply };
}

describe("Codex desktop lifecycle", () => {
  it("notifies once for an async question, survives background work, and completes after a reply", () => {
    const { store, notifications, apply } = harness();
    apply("UserPromptSubmit", { prompt: "Fix login" });
    apply("PostToolUse", { tool_name: "request_user_input_async" });
    apply("PostToolUse", { tool_name: "Bash" });
    apply("Stop");
    expect(store.list()[0]?.status).toBe("needs_input");
    expect(notifications.map((n) => n.status)).toEqual(["needs_input"]);
    apply("UserPromptSubmit", { prompt: "Use the first option" });
    apply("Stop");
    expect(notifications.map((n) => n.status)).toEqual(["needs_input", "done"]);
  });

  it("never notifies for a suggestion helper, including after its session ends", () => {
    const { store, notifications, apply } = harness();
    apply("SessionStart");
    apply("UserPromptSubmit", {
      prompt: "This is an app-generated request for a suggested next user message.",
    });
    apply("PostToolUse", { tool_name: "Bash" });
    apply("SessionEnd");
    apply("Stop");
    expect(store.list()).toEqual([]);
    expect(notifications).toEqual([]);
  });

  it("preserves the flags through the HTTP event contract", async () => {
    const { parseAgentEvent } = await import("../../core/types.js");
    for (const flags of [{ hidden: true }, { inputPending: true }, { inputPending: false }]) {
      const event: AgentEvent = {
        tool: "codex",
        sessionId: "s1",
        cwd: "/project",
        status: "working",
        timestamp: "2026-10-16T12:00:00.000Z",
        ...flags,
      };
      expect(parseAgentEvent(JSON.parse(JSON.stringify(event)))).toEqual(event);
    }
  });
});
