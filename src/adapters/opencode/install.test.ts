import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InstallOptions } from "../types.js";
import { installOpenCode, openCodePluginPath, uninstallOpenCode } from "./install.js";
import { PLUGIN_MARKER } from "./plugin.js";

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

  it("adds answering from the dashboard only with remoteActions, and an unflagged install keeps it", async () => {
    const withDecide = {
      ...options,
      remoteActions: true,
      decideCommand: 'node "/opt/a/cli.js" decide --tool opencode',
    };
    await installOpenCode(options);
    expect(await readFile(openCodePluginPath(options), "utf8")).toContain("const DECIDE = null;");

    const added = await installOpenCode(withDecide);
    expect(added.changed).toBe(true);
    expect(added.summary[0]).toMatch(/answering from the dashboard/);
    const text = await readFile(openCodePluginPath(options), "utf8");
    expect(text).toContain('const DECIDE = ["node","/opt/a/cli.js","decide","--tool","opencode"];');

    // Twice changes nothing; a plain install (flag left out) and a moved CLI keep the choice.
    expect((await installOpenCode(withDecide)).changed).toBe(false);
    expect((await installOpenCode(options)).changed).toBe(false);
    const moved = { ...options, hookCommand: 'node "/opt/b/cli.js" hook --tool opencode' };
    await installOpenCode(moved);
    expect(await readFile(openCodePluginPath(options), "utf8")).toContain('"/opt/b/cli.js","decide"');

    const removed = await installOpenCode({ ...options, remoteActions: false });
    expect(removed.changed).toBe(true);
    expect(await readFile(openCodePluginPath(options), "utf8")).toContain("const DECIDE = null;");
  });

  it("finds the plugin in the real Windows-style layout and tells an older copy from a missing one", async () => {
    // %USERPROFILE%\.config\opencode\plugins\agentwatch.js with unrelated env vars, as on the real machine.
    const env = { APPDATA: join(home, "AppData", "Roaming"), USERPROFILE: home };
    const real = { ...options, env };
    const path = join(home, ".config", "opencode", "plugins", "agentwatch.js");
    expect(openCodePluginPath(real)).toBe(path);

    // A copy written by an older template: ours (marker), but not byte-equal to what this version generates.
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      `${PLUGIN_MARKER}
// older template
const HOOK = [];
`,
    );
    const dry = { ...real, dryRun: true };
    expect((await installOpenCode(dry)).changed).toBe(true);
    expect((await uninstallOpenCode(dry)).changed).toBe(true);

    await installOpenCode(real);
    expect((await installOpenCode(dry)).changed).toBe(false);
  });

  it("a dry run writes nothing", async () => {
    const result = await installOpenCode({ ...options, dryRun: true, remoteActions: true });
    expect(result.changed).toBe(true);
    await expect(readFile(openCodePluginPath(options), "utf8")).rejects.toThrow();
  });
});
