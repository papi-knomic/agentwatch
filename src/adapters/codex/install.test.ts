import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InstallOptions } from "../types.js";
import { CODEX_HOOK_EVENTS, codexHooksPath, installCodex, uninstallCodex } from "./install.js";

const HOOK = 'node "C:/tools/agentwatch/dist/cli/index.js" hook --tool codex';
const DECIDE = 'node "C:/tools/agentwatch/dist/cli/index.js" decide --tool codex';

let home: string;
let options: InstallOptions;
let path: string;

beforeEach(async () => {
  // A temp folder stands in for the home directory: the real ~/.codex is never touched.
  home = await mkdtemp(join(tmpdir(), "orch-codex-"));
  options = { homeDir: home, hookCommand: HOOK, dryRun: false, env: {} };
  path = codexHooksPath(options);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const read = async () => JSON.parse(await readFile(path, "utf8"));
const notify = { type: "command", command: HOOK, async: true, timeout: 10 };
const decide = { type: "command", command: DECIDE, timeout: 600 };

describe("installCodex", () => {
  it("installs async notify hooks for every event, including the subagent ones", async () => {
    expect(CODEX_HOOK_EVENTS).toContain("SubagentStart");
    expect(CODEX_HOOK_EVENTS).toContain("SubagentStop");
    await installCodex(options);
    const settings = await read();
    for (const event of CODEX_HOOK_EVENTS) {
      expect(settings.hooks[event]).toHaveLength(1);
      expect(settings.hooks[event][0].hooks[0]).toMatchObject({ command: HOOK, async: true });
    }
  });

  it("adds a separate synchronous PermissionRequest decide hook only when asked, and leaves notify hooks alone", async () => {
    await installCodex(options);
    const before = await read();

    const result = await installCodex({ ...options, remoteActions: true, decideCommand: DECIDE });
    expect(result.changed).toBe(true);
    const after = await read();
    expect(after.hooks.PermissionRequest).toEqual([...before.hooks.PermissionRequest, { hooks: [decide] }]);
    expect(after.hooks.PermissionRequest[0].hooks[0]).toEqual(notify);
    expect(JSON.stringify(after.hooks.PermissionRequest[1])).not.toContain("async");
    // Nothing else changed.
    const { PermissionRequest: _a, ...restAfter } = after.hooks;
    const { PermissionRequest: _b, ...restBefore } = before.hooks;
    expect(restAfter).toEqual(restBefore);
  });

  it("is idempotent, with or without remote actions", async () => {
    const on = { ...options, remoteActions: true, decideCommand: DECIDE };
    await installCodex(on);
    const once = await readFile(path, "utf8");
    expect((await installCodex(on)).changed).toBe(false);
    expect((await installCodex(options)).changed).toBe(false); // flag left out: decide hook untouched
    expect(await readFile(path, "utf8")).toBe(once);
  });

  it("removes only the decide hook with remoteActions: false", async () => {
    await installCodex({ ...options, remoteActions: true, decideCommand: DECIDE });
    const off = await installCodex({ ...options, remoteActions: false });
    expect(off.changed).toBe(true);
    const settings = await read();
    expect(settings.hooks.PermissionRequest).toEqual([{ hooks: [notify] }]);
    expect((await installCodex({ ...options, remoteActions: false })).changed).toBe(false);
  });

  it("requires a decide command for remote actions", async () => {
    await expect(installCodex({ ...options, remoteActions: true })).rejects.toThrow(/decideCommand/);
  });

  it("dry run reports the decide hook without writing", async () => {
    const result = await installCodex({
      ...options,
      dryRun: true,
      remoteActions: true,
      decideCommand: DECIDE,
    });
    expect(result.changed).toBe(true);
    expect(result.summary.join("\n")).toMatch(/PermissionRequest/);
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });

  it("keeps other people's hooks, and uninstall removes exactly ours (notify and decide)", async () => {
    const foreign = { hooks: { PermissionRequest: [{ hooks: [{ type: "command", command: "audit.sh" }] }] } };
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(path, JSON.stringify(foreign, null, 2));
    await installCodex({ ...options, remoteActions: true, decideCommand: DECIDE });
    expect((await read()).hooks.PermissionRequest[0].hooks[0].command).toBe("audit.sh");

    await uninstallCodex(options);
    expect(await read()).toEqual(foreign);
  });
});
