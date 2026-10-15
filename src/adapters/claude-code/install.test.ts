import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InstallOptions } from "../types.js";
import { CLAUDE_HOOK_EVENTS, claudeSettingsPath, installClaudeCode, uninstallClaudeCode } from "./install.js";

const HOOK = 'node "C:/tools/orchestrator/dist/cli/index.js" hook --tool claude-code';

const EXISTING = {
  model: "opus",
  permissions: { allow: ["Bash(npm test)"] },
  hooks: {
    Stop: [{ hooks: [{ type: "command", command: "say done" }] }],
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./guard.sh" }] }],
  },
};

let home: string;
let options: InstallOptions;
let settingsPath: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "orch-claude-"));
  options = { homeDir: home, hookCommand: HOOK, dryRun: false, env: {} };
  settingsPath = claudeSettingsPath(options);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function writeSettings(value: unknown): Promise<void> {
  await mkdir(join(home, ".claude"), { recursive: true });
  await writeFile(settingsPath, typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

const readSettings = async () => JSON.parse(await readFile(settingsPath, "utf8"));

describe("installClaudeCode", () => {
  it("creates settings.json when none exists", async () => {
    const result = await installClaudeCode(options);
    expect(result.changed).toBe(true);
    expect(result.backupPath).toBeUndefined();
    const settings = await readSettings();
    for (const event of CLAUDE_HOOK_EVENTS) {
      expect(settings.hooks[event]).toEqual([
        { hooks: [{ type: "command", command: HOOK, async: true, timeout: 10 }] },
      ]);
    }
  });

  it("keeps existing settings and hooks, and backs up the original", async () => {
    await writeSettings(EXISTING);
    const result = await installClaudeCode(options);
    const settings = await readSettings();
    expect(settings.model).toBe("opus");
    expect(settings.permissions).toEqual(EXISTING.permissions);
    expect(settings.hooks.PreToolUse).toEqual(EXISTING.hooks.PreToolUse);
    expect(settings.hooks.Stop[0]).toEqual(EXISTING.hooks.Stop[0]);
    expect(settings.hooks.Stop).toHaveLength(2);
    expect(result.backupPath).toBeDefined();
    expect(JSON.parse(await readFile(result.backupPath as string, "utf8"))).toEqual(EXISTING);
  });

  it("is idempotent: a second install changes nothing and writes no backup", async () => {
    await writeSettings(EXISTING);
    await installClaudeCode(options);
    const before = await readFile(settingsPath, "utf8");
    const filesBefore = await readdir(join(home, ".claude"));
    const second = await installClaudeCode(options);
    expect(second.changed).toBe(false);
    expect(await readFile(settingsPath, "utf8")).toBe(before);
    expect(await readdir(join(home, ".claude"))).toEqual(filesBefore);
  });

  it("updates the command in place when the CLI has moved", async () => {
    await installClaudeCode(options);
    const moved = 'node "D:/elsewhere/dist/cli/index.js" hook --tool claude-code';
    const result = await installClaudeCode({ ...options, hookCommand: moved });
    expect(result.changed).toBe(true);
    const settings = await readSettings();
    expect(settings.hooks.Stop).toHaveLength(1);
    expect(settings.hooks.Stop[0].hooks[0].command).toBe(moved);
  });

  it("writes nothing on a dry run", async () => {
    await writeSettings(EXISTING);
    const result = await installClaudeCode({ ...options, dryRun: true });
    expect(result.changed).toBe(true);
    expect(result.summary).toContain("add Stop hook");
    expect(await readSettings()).toEqual(EXISTING);
    expect(await readdir(join(home, ".claude"))).toEqual(["settings.json"]);
  });

  it("refuses to touch a file it cannot parse", async () => {
    await writeSettings("{ not json");
    await expect(installClaudeCode(options)).rejects.toThrow(/not valid JSON/);
    expect(await readFile(settingsPath, "utf8")).toBe("{ not json");
  });

  it("refuses to touch a hooks section with an unexpected shape", async () => {
    await writeSettings({ hooks: { Stop: "oops" } });
    await expect(installClaudeCode(options)).rejects.toThrow(/not an array/);
  });

  it("respects CLAUDE_CONFIG_DIR", () => {
    const custom = join(home, "custom");
    expect(claudeSettingsPath({ homeDir: home, env: { CLAUDE_CONFIG_DIR: custom } })).toBe(
      join(custom, "settings.json"),
    );
  });
});

describe("uninstallClaudeCode", () => {
  it("removes exactly what install added", async () => {
    await writeSettings(EXISTING);
    await installClaudeCode(options);
    const result = await uninstallClaudeCode(options);
    expect(result.changed).toBe(true);
    expect(await readSettings()).toEqual(EXISTING);
  });

  it("drops the hooks key if install created it", async () => {
    await writeSettings({ model: "opus" });
    await installClaudeCode(options);
    await uninstallClaudeCode(options);
    expect(await readSettings()).toEqual({ model: "opus" });
  });

  it("does nothing when not installed", async () => {
    await writeSettings(EXISTING);
    const result = await uninstallClaudeCode(options);
    expect(result.changed).toBe(false);
    expect(await readdir(join(home, ".claude"))).toEqual(["settings.json"]);
  });

  it("does nothing when settings.json does not exist", async () => {
    const result = await uninstallClaudeCode(options);
    expect(result.changed).toBe(false);
  });
});
