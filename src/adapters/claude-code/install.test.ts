import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InstallOptions } from "../types.js";
import {
  CLAUDE_DECIDE_HOOKS,
  CLAUDE_HOOK_EVENTS,
  claudeSettingsPath,
  installClaudeCode,
  uninstallClaudeCode,
} from "./install.js";

const HOOK = 'node "C:/tools/agentwatch/dist/cli/index.js" hook --tool claude-code';

const DECIDE = 'node "C:/tools/agentwatch/dist/cli/index.js" decide --tool claude-code';

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

describe("subagent attribution hooks", () => {
  it("installs PermissionRequest and SubagentStop as plain async hooks, next to the existing ones", async () => {
    await writeSettings({
      hooks: { PermissionRequest: [{ matcher: "Bash", hooks: [{ type: "command", command: "./mine.sh" }] }] },
    });
    const result = await installClaudeCode(options);
    expect(result.summary).toContain("add PermissionRequest hook");
    expect(result.summary).toContain("add SubagentStop hook");
    const settings = await readSettings();
    expect(settings.hooks.PermissionRequest).toEqual([
      { matcher: "Bash", hooks: [{ type: "command", command: "./mine.sh" }] },
      { hooks: [{ type: "command", command: HOOK, async: true, timeout: 10 }] },
    ]);
    expect(settings.hooks.SubagentStop).toEqual([
      { hooks: [{ type: "command", command: HOOK, async: true, timeout: 10 }] },
    ]);
  });

  it("is idempotent, upgrades an older install by adding only the two new events, and uninstalls cleanly", async () => {
    await installClaudeCode(options);
    const before = await readFile(settingsPath, "utf8");
    expect((await installClaudeCode(options)).changed).toBe(false);
    expect(await readFile(settingsPath, "utf8")).toBe(before);
    const older = JSON.parse(before);
    delete older.hooks.PermissionRequest;
    delete older.hooks.SubagentStop;
    await writeSettings(older);
    const upgraded = await installClaudeCode(options);
    expect([...upgraded.summary].sort()).toEqual(["add PermissionRequest hook", "add SubagentStop hook"]);
    await uninstallClaudeCode(options);
    expect((await readSettings()).hooks).toBeUndefined();
  });
});

describe("remote actions (decide hooks)", () => {
  function options0(): InstallOptions {
    return { homeDir: home, hookCommand: HOOK, decideCommand: DECIDE, dryRun: false, env: {} };
  }

  it("does not add them unless asked", async () => {
    await installClaudeCode({ ...options0() });
    const settings = await readSettings();
    expect(JSON.stringify(settings)).not.toContain("decide --tool");
    expect(settings.hooks.PreToolUse).toBeUndefined();
  });

  it("adds PermissionRequest and PreToolUse entries next to the user's own, with a timeout", async () => {
    await writeSettings(EXISTING);
    const result = await installClaudeCode({ ...options0(), remoteActions: true });
    expect(result.summary).toContain("add PermissionRequest hook (*)");
    expect(result.summary).toContain("add PreToolUse hook (AskUserQuestion)");
    const settings = await readSettings();
    expect(Object.keys(CLAUDE_DECIDE_HOOKS)).toEqual(["PermissionRequest", "PreToolUse"]);
    // The regular (async) hook that says which agent is asking sits next to the decide hook.
    expect(settings.hooks.PermissionRequest).toEqual([
      { hooks: [{ type: "command", command: HOOK, async: true, timeout: 10 }] },
      { matcher: "*", hooks: [{ type: "command", command: DECIDE, timeout: 600 }] },
    ]);
    expect(settings.hooks.PreToolUse[0]).toEqual(EXISTING.hooks.PreToolUse[0]);
    expect(settings.hooks.PreToolUse[1]).toEqual({
      matcher: "AskUserQuestion",
      hooks: [{ type: "command", command: DECIDE, timeout: 120 }],
    });
    // The decide hook waits for an answer, so it must not be async.
    expect(JSON.stringify(settings.hooks.PermissionRequest[1])).not.toContain("async");
  });

  it("upgrades an older 120 s PermissionRequest entry of ours in place, leaving everything else alone", async () => {
    await writeSettings(EXISTING);
    await installClaudeCode({ ...options0(), remoteActions: true });
    const old = await readSettings();
    old.hooks.PermissionRequest[1].hooks[0].timeout = 120;
    // A foreign PermissionRequest entry with its own timeout must not be touched.
    old.hooks.PermissionRequest.push({
      matcher: "Bash",
      hooks: [{ type: "command", command: "mine", timeout: 7 }],
    });
    await writeSettings(old);

    const upgraded = await installClaudeCode({ ...options0(), remoteActions: true });
    expect(upgraded.changed).toBe(true);
    expect(upgraded.summary).toEqual(["update PermissionRequest hook (*)"]);
    expect(upgraded.backupPath).toBeDefined();
    const settings = await readSettings();
    expect(settings.hooks.PermissionRequest[1].hooks[0].timeout).toBe(600);
    expect(settings.hooks.PermissionRequest[2]).toEqual(old.hooks.PermissionRequest[2]);
    expect(settings.hooks.PreToolUse[1].hooks[0].timeout).toBe(120);
    expect((await installClaudeCode({ ...options0(), remoteActions: true })).changed).toBe(false);

    // Uninstall removes exactly ours: only the foreign entry is left behind in that event.
    await uninstallClaudeCode(options0());
    expect((await readSettings()).hooks.PermissionRequest).toEqual([old.hooks.PermissionRequest[2]]);
  });

  it("is idempotent, and a dry run writes nothing", async () => {
    await writeSettings(EXISTING);
    const dry = await installClaudeCode({ ...options0(), remoteActions: true, dryRun: true });
    expect(dry.changed).toBe(true);
    expect(await readSettings()).toEqual(EXISTING);

    await installClaudeCode({ ...options0(), remoteActions: true });
    const before = await readFile(settingsPath, "utf8");
    const filesBefore = await readdir(join(home, ".claude"));
    const second = await installClaudeCode({ ...options0(), remoteActions: true });
    expect(second.changed).toBe(false);
    expect(await readFile(settingsPath, "utf8")).toBe(before);
    expect(await readdir(join(home, ".claude"))).toEqual(filesBefore);
  });

  it("a plain install afterwards leaves them alone; remoteActions: false removes only them", async () => {
    await writeSettings(EXISTING);
    await installClaudeCode({ ...options0(), remoteActions: true });
    const withBoth = await readFile(settingsPath, "utf8");
    expect((await installClaudeCode(options0())).changed).toBe(false);
    expect(await readFile(settingsPath, "utf8")).toBe(withBoth);

    const off = await installClaudeCode({ ...options0(), remoteActions: false });
    expect(off.changed).toBe(true);
    const settings = await readSettings();
    expect(settings.hooks.PermissionRequest).toEqual([
      { hooks: [{ type: "command", command: HOOK, async: true, timeout: 10 }] },
    ]);
    expect(settings.hooks.PreToolUse).toEqual(EXISTING.hooks.PreToolUse);
    expect(settings.hooks.Stop).toHaveLength(2);
    expect(JSON.stringify(settings)).not.toContain("decide --tool");
  });

  it("uninstall removes exactly what install added, decide hooks included", async () => {
    await writeSettings(EXISTING);
    await installClaudeCode({ ...options0(), remoteActions: true });
    const result = await uninstallClaudeCode(options0());
    expect(result.changed).toBe(true);
    expect(await readSettings()).toEqual(EXISTING);
  });

  it("refuses to enable without a command to run", async () => {
    await expect(
      installClaudeCode({ homeDir: home, hookCommand: HOOK, dryRun: false, env: {}, remoteActions: true }),
    ).rejects.toThrow(/decideCommand/);
  });
});
