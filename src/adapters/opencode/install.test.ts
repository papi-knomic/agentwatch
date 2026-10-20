import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InstallOptions } from "../types.js";
import { installOpenCode, openCodePluginPath, uninstallOpenCode } from "./install.js";

let home: string;
let options: InstallOptions;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "orch-opencode-install-"));
  options = {
    homeDir: home,
    env: {},
    dryRun: false,
    hookCommand: 'node "/opt/a/cli.js" hook --tool opencode',
  };
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("OpenCode install", () => {
  it("goes in ~/.config/opencode/plugins, or under XDG_CONFIG_HOME when set", () => {
    expect(openCodePluginPath(options)).toBe(join(home, ".config", "opencode", "plugins", "agentwatch.js"));
    const xdg = join(home, "xdg");
    expect(openCodePluginPath({ ...options, env: { XDG_CONFIG_HOME: xdg } })).toBe(
      join(xdg, "opencode", "plugins", "agentwatch.js"),
    );
  });

  it("rewrites its own plugin when the CLI moves", async () => {
    await installOpenCode(options);
    const moved = { ...options, hookCommand: 'node "/opt/b/cli.js" hook --tool opencode' };
    const result = await installOpenCode(moved);
    expect(result.changed).toBe(true);
    expect(result.summary[0]).toMatch(/^Update/);
    expect(await readFile(openCodePluginPath(options), "utf8")).toContain("/opt/b/cli.js");
  });

  it("refuses to replace a plugin the user wrote, and uninstall leaves it alone", async () => {
    const path = openCodePluginPath(options);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "export const Mine = async () => ({})\n");
    await expect(installOpenCode(options)).rejects.toThrow(/left untouched/);
    expect((await uninstallOpenCode(options)).changed).toBe(false);
    expect(await readFile(path, "utf8")).toBe("export const Mine = async () => ({})\n");
  });

  it("tells the user to restart OpenCode", async () => {
    expect((await installOpenCode(options)).notes?.[0]).toMatch(/Restart OpenCode/);
  });
});
