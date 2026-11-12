import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { syncRemoteActionsFlag } from "./install.js";

let home: string;
let env: NodeJS.ProcessEnv;
let lines: string[];

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "aw-install-"));
  env = { AGENTWATCH_HOME: home };
  lines = [];
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({ port: 4567, token: "0123456789abcdef0123", remoteActions: false }),
  );
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const flag = async () => JSON.parse(await readFile(join(home, "config.json"), "utf8")).remoteActions;
const run = (over: Partial<Parameters<typeof syncRemoteActionsFlag>[0]>) =>
  syncRemoteActionsFlag({
    remoteActions: undefined,
    uninstall: false,
    dryRun: false,
    sandboxed: false,
    supported: true,
    targetNames: "Claude Code",
    log: (line) => lines.push(line),
    env,
    ...over,
  });

describe("syncRemoteActionsFlag", () => {
  it("turns the flag on only when a tool with the hooks is targeted", async () => {
    await run({ remoteActions: true, supported: false, targetNames: "Codex" });
    expect(await flag()).toBe(false);
    expect(lines.join("\n")).toMatch(/not available for Codex/);
    expect(lines.join("\n")).not.toMatch(/Remote actions: on/);

    lines = [];
    await run({ remoteActions: true });
    expect(await flag()).toBe(true);
    expect(lines).toEqual(["Remote actions: on (restart the dashboard to apply)"]);
  });

  it("clears the flag when Claude Code is uninstalled, and says so", async () => {
    await run({ remoteActions: true });
    lines = [];
    await run({ uninstall: true });
    expect(await flag()).toBe(false);
    expect(lines).toEqual(["Remote actions: off (restart the dashboard to apply)"]);
  });

  it("leaves the flag alone when uninstalling a tool without the hooks, in a dry run, or in a sandbox", async () => {
    await run({ remoteActions: true });
    lines = [];
    await run({ uninstall: true, supported: false, targetNames: "Codex" });
    expect(await flag()).toBe(true);
    expect(lines).toEqual([]);

    await run({ uninstall: true, dryRun: true });
    expect(await flag()).toBe(true);
    expect(lines).toEqual(["Remote actions: would turn off."]);

    lines = [];
    await run({ uninstall: true, sandboxed: true });
    expect(await flag()).toBe(true);
    expect(lines[0]).toMatch(/unchanged because --home/);
  });

  it("prints nothing when nothing was asked for", async () => {
    await run({});
    expect(lines).toEqual([]);
  });
});
