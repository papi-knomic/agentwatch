import { describe, expect, it } from "vitest";
import { answeringNeedsAttention } from "./answering";
import type { RemoteToolState, Setup } from "./setup";

const tool = (id: string, answering: "on" | "off", connected = true): RemoteToolState => ({
  id,
  name: id,
  connected,
  answering,
});

function setup(enabled: boolean, perTool: RemoteToolState[], supported = true): Setup {
  return {
    cli: "agentwatch",
    autostart: { supported: false, installed: false },
    notes: [],
    tools: [],
    remoteActions: { supported, enabled, installed: false, tools: [], perTool, backgroundHold: "full" },
  };
}

describe("answeringNeedsAttention", () => {
  it("is quiet while loading or unsupported", () => {
    expect(answeringNeedsAttention(null)).toBe(false);
    expect(answeringNeedsAttention(setup(true, [], false))).toBe(false);
  });

  it("does not flag a tool deliberately left off", () => {
    expect(answeringNeedsAttention(setup(true, [tool("claude-code", "on"), tool("codex", "off")]))).toBe(
      false,
    );
  });

  it("is quiet when everything is off, master included", () => {
    expect(answeringNeedsAttention(setup(false, [tool("claude-code", "off")]))).toBe(false);
  });

  it("flags the master on with no tool answering", () => {
    expect(answeringNeedsAttention(setup(true, [tool("claude-code", "off")]))).toBe(true);
  });

  it("flags a tool answering while the master is off", () => {
    expect(answeringNeedsAttention(setup(false, [tool("claude-code", "on")]))).toBe(true);
  });
});
