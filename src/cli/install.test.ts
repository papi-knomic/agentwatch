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
    await run({ remoteActions: true, supported: false, targetNames: "Grok" });
    expect(await flag()).toBe(false);
    expect(lines.join("\n")).toMatch(/not available for Grok/);
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
    await run({ uninstall: true, supported: false, targetNames: "Grok" });
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

  it("says it is already on in a dry run when the flag is already set", async () => {
    await run({ remoteActions: true });
    lines = [];
    await run({ remoteActions: true, dryRun: true });
    expect(lines).toEqual(["Remote actions: already on, nothing to change."]);

    lines = [];
    await run({ uninstall: true, dryRun: true });
    expect(lines).toEqual(["Remote actions: would turn off."]);
    expect(await flag()).toBe(true);
  });

  it("says it would turn the flag on in a dry run when it is off", async () => {
    await run({ remoteActions: true, dryRun: true });
    expect(lines).toEqual(["Remote actions: would turn on."]);
    expect(await flag()).toBe(false);
  });

  it("prints nothing when nothing was asked for", async () => {
    await run({});
    expect(lines).toEqual([]);
  });

  it("keeps the master switch on while another tool still has answering", async () => {
    await run({ remoteActions: true });
    lines = [];
    await run({ remoteActions: false, targetNames: "Codex", stillOn: ["Claude Code"] });
    expect(await flag()).toBe(true);
    expect(lines).toEqual(["Remote actions: still on for Claude Code (only Codex was turned off)."]);

    lines = [];
    await run({ uninstall: true, targetNames: "Codex", stillOn: ["Claude Code", "OpenCode"] });
    expect(await flag()).toBe(true);
    expect(lines[0]).toMatch(/still on for Claude Code, OpenCode/);
  });

  it("turns it off when the last tool with answering is turned off", async () => {
    await run({ remoteActions: true });
    lines = [];
    await run({ remoteActions: false, targetNames: "Codex", stillOn: [] });
    expect(await flag()).toBe(false);
    expect(lines).toEqual(["Remote actions: off (restart the dashboard to apply)"]);
  });

  it("dry run says it would stay on, and enabling one tool still turns it on", async () => {
    await run({ remoteActions: true });
    lines = [];
    await run({ remoteActions: false, dryRun: true, targetNames: "Codex", stillOn: ["Claude Code"] });
    expect(lines).toEqual(["Remote actions: would stay on for Claude Code (only Codex was turned off)."]);
    expect(await flag()).toBe(true);

    await run({ remoteActions: true, stillOn: ["Claude Code"] });
    expect(await flag()).toBe(true);
  });
});
