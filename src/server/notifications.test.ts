import { describe, expect, it, vi } from "vitest";
import { type Config, defaultToolSettings } from "../core/config.js";
import { SessionStore } from "../core/store.js";
import type { AgentEvent } from "../core/types.js";
import { createNotificationDispatcher, projectName, vscodeUrl } from "./notifications.js";

function setup(overrides: Partial<Config> = {}) {
  const config: Config = {
    port: 7878,
    token: "x".repeat(32),
    notifications: true,
    tools: { "claude-code": defaultToolSettings("Claude", "#d97757", "im") },
    ...overrides,
  };
  const notifier = vi.fn(async () => {});
  let clock = 0;
  const store = new SessionStore();
  store.subscribe(
    createNotificationDispatcher({
      config,
      notifier,
      dashboardUrl: "http://127.0.0.1:7878",
      log: () => {},
      now: () => clock,
    }),
  );
  let second = 0;
  const apply = (partial: Partial<AgentEvent>) =>
    store.apply({
      tool: "claude-code",
      sessionId: "s1",
      cwd: "C:\\projects\\demo",
      status: "working",
      host: "VS Code",
      timestamp: new Date(Date.UTC(2026, 9, 16, 12, 0, second++)).toISOString(),
      ...partial,
    });
  return { config, notifier, apply, advance: (ms: number) => (clock += ms) };
}

describe("notification dispatcher", () => {
  it("notifies on needs_input with the tool's label, sound and a VS Code link", () => {
    const { notifier, apply } = setup();
    apply({ status: "working" });
    apply({ status: "needs_input", message: "Claude needs your permission to use Bash" });
    expect(notifier).toHaveBeenCalledTimes(1);
    expect(notifier).toHaveBeenCalledWith({
      title: "demo needs you",
      body: "Claude needs your permission to use Bash",
      attribution: "Claude · VS Code",
      sound: "im",
      status: "needs_input",
      color: "#d97757",
      clickUrl: "vscode://file/C:/projects/demo",
      actions: [{ label: "Open dashboard", url: "http://127.0.0.1:7878" }],
    });
  });

  it("does not notify for working or idle, or when the status did not change", () => {
    const { notifier, apply, advance } = setup();
    apply({ status: "idle" });
    apply({ status: "working" });
    apply({ status: "done" });
    advance(10_000);
    apply({ status: "done" });
    expect(notifier).toHaveBeenCalledTimes(1);
  });

  it("deduplicates rapid repeats of the same status", () => {
    const { notifier, apply, advance } = setup();
    apply({ status: "done" });
    apply({ status: "working" });
    advance(1000);
    apply({ status: "done" });
    expect(notifier).toHaveBeenCalledTimes(1);
    apply({ status: "working" });
    advance(5000);
    apply({ status: "done" });
    expect(notifier).toHaveBeenCalledTimes(2);
  });

  it("respects the master switch and per-tool settings", () => {
    const off = setup({ notifications: false });
    off.apply({ status: "done" });
    expect(off.notifier).not.toHaveBeenCalled();

    const muted = setup();
    const settings = muted.config.tools["claude-code"];
    if (!settings) throw new Error("missing settings");
    settings.notifyOn.done = false;
    muted.apply({ status: "done" });
    expect(muted.notifier).not.toHaveBeenCalled();
    muted.apply({ status: "needs_input" });
    expect(muted.notifier).toHaveBeenCalledTimes(1);
  });

  it("leads the body with the task title when there is one", () => {
    const { notifier, apply, advance } = setup();
    apply({ status: "needs_input", title: "Fix the login bug", message: "Claude needs your permission" });
    advance(10_000);
    apply({ status: "done", title: "Fix the login bug" });
    expect(notifier.mock.calls.map((call) => call[0]?.body)).toEqual([
      "Fix the login bug — Claude needs your permission",
      "Fix the login bug",
    ]);
  });

  it("links to the dashboard for sessions outside VS Code", () => {
    const { notifier, apply } = setup();
    apply({ status: "done", host: "Windows Terminal" });
    const notification = notifier.mock.calls[0]?.[0];
    expect(notification).toMatchObject({
      title: "demo is done",
      attribution: "Claude · Windows Terminal",
      clickUrl: "http://127.0.0.1:7878",
    });
    expect(notification).not.toHaveProperty("actions");
  });
});

describe("helpers", () => {
  it("projectName handles both path styles", () => {
    expect(projectName("C:\\Users\\dev\\my-app")).toBe("my-app");
    expect(projectName("/home/dev/my-app/")).toBe("my-app");
  });

  it("vscodeUrl builds file URLs for Windows and POSIX paths", () => {
    expect(vscodeUrl("C:\\Users\\dev\\my app")).toBe("vscode://file/C:/Users/dev/my%20app");
    expect(vscodeUrl("/home/dev/app")).toBe("vscode://file/home/dev/app");
  });
});
