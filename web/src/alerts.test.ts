import { describe, expect, it } from "vitest";
import { agentCaption, alertTitle, faviconHref, notificationBody } from "./alerts";

describe("alerts", () => {
  it("puts waiting prompts in the tab title ahead of the plain attention count", () => {
    expect(alertTitle(0, 0)).toBe("AgentWatch");
    expect(alertTitle(0, 2)).toBe("(2) AgentWatch");
    expect(alertTitle(3, 5)).toBe("(3) Waiting for you · AgentWatch");
  });

  it("adds a count badge to the favicon only while something waits", () => {
    const plain = decodeURIComponent(faviconHref(0));
    const badged = decodeURIComponent(faviconHref(2));
    expect(plain).not.toContain("<text");
    expect(badged).toContain(">2</text>");
    expect(decodeURIComponent(faviconHref(12))).toContain(">9+</text>");
    expect(faviconHref(1).startsWith("data:image/svg+xml,")).toBe(true);
  });

  it("names the agent and project in a notification, nothing else", () => {
    expect(notificationBody("Claude Code", "demo")).toBe("Claude Code in demo is waiting for your answer");
    expect(notificationBody("Claude Code", undefined)).toBe("Claude Code is waiting for your answer");
  });

  it("captions a subagent's request, not the main agent's", () => {
    expect(agentCaption({})).toBeUndefined();
    expect(agentCaption({ agentId: "a1", agentType: "general-purpose" })).toBe("subagent: general-purpose");
    expect(agentCaption({ agentId: "a1" })).toBe("subagent");
  });
});
