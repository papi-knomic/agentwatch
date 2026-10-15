import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../core/types.js";
import { createSessionOpener, sessionOpenUrls } from "./open-session.js";

const base: Session = {
  key: "demo:s1",
  tool: "demo",
  sessionId: "s1",
  cwd: "C:\\projects\\my app",
  status: "done",
  startedAt: "2026-10-16T12:00:00.000Z",
  updatedAt: "2026-10-16T12:00:00.000Z",
};
const link = "vscode://example.demo/open?session=s1";

afterEach(() => {
  vi.useRealTimers();
});

describe("sessionOpenUrls", () => {
  it("focuses the project window first, then opens the tool's session link", () => {
    expect(sessionOpenUrls({ ...base, host: "VS Code" }, link)).toEqual([
      "vscode://file/C:/projects/my%20app",
      link,
    ]);
  });

  it("only focuses the window when the tool has no session link", () => {
    expect(sessionOpenUrls({ ...base, host: "VS Code terminal" }, undefined)).toEqual([
      "vscode://file/C:/projects/my%20app",
    ]);
  });

  it("opens nothing for sessions outside VS Code", () => {
    expect(sessionOpenUrls({ ...base, host: "Windows Terminal" }, link)).toEqual([]);
    expect(sessionOpenUrls(base, link)).toEqual([]);
  });
});

describe("createSessionOpener", () => {
  it("waits before opening the session link so the right window has focus", () => {
    vi.useFakeTimers();
    const opened: string[] = [];
    const open = createSessionOpener({
      linkFor: () => link,
      openUrl: (url) => opened.push(url),
      delayMs: 500,
    });

    expect(open({ ...base, host: "VS Code" })).toBe(true);
    expect(opened).toEqual(["vscode://file/C:/projects/my%20app"]);
    vi.advanceTimersByTime(500);
    expect(opened).toEqual(["vscode://file/C:/projects/my%20app", link]);
  });

  it("reports when there is nothing to open", () => {
    const openUrl = vi.fn();
    const open = createSessionOpener({ linkFor: () => link, openUrl });
    expect(open({ ...base, host: "Windows Terminal" })).toBe(false);
    expect(openUrl).not.toHaveBeenCalled();
  });
});
