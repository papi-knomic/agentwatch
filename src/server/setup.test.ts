import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adapters, toolDefaults } from "../adapters/index.js";
import { createSetupService } from "./setup.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "aw-setup-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function service(afterConnect?: (dryRun: boolean) => Promise<void>) {
  return createSetupService({
    adapters,
    config: { port: 1, token: "x".repeat(32), notifications: true, tools: toolDefaults() },
    homeDir: home,
    env: {},
    hookCommandFor: (id) => `node "/opt/aw/cli.js" hook --tool ${id}`,
    autostartInstalled: async () => true,
    ...(afterConnect ? { afterConnect } : {}),
  });
}

describe("setup service", () => {
  it("reports every tool as not connected in a fresh home, with copyable commands", async () => {
    const state = await service().status();
    expect(state.cli).toBe("agentwatch");
    expect(state.autostart).toEqual({ supported: true, installed: true });
    expect(state.tools.map((t) => t.id)).toEqual(adapters.map((a) => a.meta.id));
    for (const tool of state.tools) {
      expect(tool.connected).toBe(false);
      expect(tool.configPath.startsWith(home)).toBe(true);
      expect(tool.command).toBe(`agentwatch install --tool ${tool.id}`);
    }
    expect(state.tools.find((t) => t.id === "codex")?.afterInstall[0]).toMatch(/\/hooks/);
  });

  it("previews without writing, then connects", async () => {
    const calls: boolean[] = [];
    const setup = service(async (dryRun) => {
      calls.push(dryRun);
    });

    const preview = await setup.connect("claude-code", true);
    expect(preview.results[0]).toMatchObject({ id: "claude-code", changed: true });
    expect(preview.results[0]?.summary).toContain("add Stop hook");
    expect(preview.setup.tools.find((t) => t.id === "claude-code")?.connected).toBe(false);

    const done = await setup.connect("claude-code", false);
    expect(done.setup.tools.find((t) => t.id === "claude-code")?.connected).toBe(true);
    expect(done.setup.tools.find((t) => t.id === "codex")?.connected).toBe(false);
    expect(calls).toEqual([true, false]);
  });

  it("connects all tools at once", async () => {
    const { setup } = await service().connect("all", false);
    expect(setup.tools.every((t) => t.connected)).toBe(true);
  });

  it("reports a broken config instead of failing the whole status", async () => {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", "settings.json"), "{ broken");
    const claude = (await service().status()).tools.find((t) => t.id === "claude-code");
    expect(claude?.connected).toBe(false);
    expect(claude?.error).toMatch(/not valid JSON/);
  });

  it("rejects unknown tools", async () => {
    await expect(service().connect("nope", false)).rejects.toThrow(/Unknown tool/);
  });

  describe("remote actions", () => {
    function remoteService() {
      const saved: boolean[] = [];
      const config = { port: 1, token: "x".repeat(32), notifications: true, tools: toolDefaults() };
      const setup = createSetupService({
        adapters,
        config,
        homeDir: home,
        env: {},
        hookCommandFor: (id) => `node "/opt/aw/cli.js" hook --tool ${id}`,
        decideCommandFor: (id) => `node "/opt/aw/cli.js" decide --tool ${id}`,
        saveRemoteActions: async (enabled) => {
          saved.push(enabled);
        },
      });
      return { setup, saved, config };
    }

    it("writes the flag even when the in-memory config already agrees (the file may differ)", async () => {
      const { setup, saved, config } = remoteService();
      Object.assign(config, { remoteActions: true });
      await setup.setRemoteActions(true, false);
      expect(saved).toEqual([true]);
    });

    it("is unsupported without a way to save the config", async () => {
      expect((await service().status()).remoteActions.supported).toBe(false);
      await expect(service().setRemoteActions(true, false)).rejects.toThrow(/aren't available/);
    });

    it("previews, turns on, and turns off, saving the flag only for real runs", async () => {
      const { setup, saved, config } = remoteService();
      const initial = (await setup.status()).remoteActions;
      expect(initial).toEqual({ supported: true, enabled: false, installed: false, tools: ["Claude Code"] });

      const preview = await setup.setRemoteActions(true, true);
      expect(preview.results[0]?.summary).toContain("add PermissionRequest hook (*)");
      expect(preview.results[0]?.summary).toContain("add PreToolUse hook (AskUserQuestion)");
      expect(saved).toEqual([]);
      expect(config.remoteActions).toBeUndefined();

      const on = await setup.setRemoteActions(true, false);
      expect(on.setup.remoteActions).toMatchObject({ enabled: true, installed: true });
      expect(saved).toEqual([true]);

      const off = await setup.setRemoteActions(false, false);
      expect(off.setup.remoteActions).toMatchObject({ enabled: false, installed: false });
      expect(saved).toEqual([true, false]);
    });
  });
});
