import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configFileExists,
  parseConfig,
  setPhoneConfig,
  setRemoteActionsFlag,
  setRemoteConfig,
} from "./config.js";

const TOKEN = "0123456789abcdef0123";

describe("parseConfig remoteActions", () => {
  it("is off unless the file turns it on with a real boolean", () => {
    expect(parseConfig({ token: TOKEN }, {})?.remoteActions).toBe(false);
    expect(parseConfig({ token: TOKEN, remoteActions: "yes" }, {})?.remoteActions).toBe(false);
    expect(parseConfig({ token: TOKEN, remoteActions: 1 }, {})?.remoteActions).toBe(false);
    expect(parseConfig({ token: TOKEN, remoteActions: true }, {})?.remoteActions).toBe(true);
  });
});

describe("setRemoteActionsFlag", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "aw-config-"));
    env = { AGENTWATCH_HOME: home };
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("changes only the flag on disk, keeping every other key as the file has it", async () => {
    const file = join(home, "config.json");
    await writeFile(
      file,
      JSON.stringify({
        port: 4567,
        token: TOKEN,
        notifications: false,
        custom: { keep: 1 },
        remoteActions: false,
      }),
    );
    expect(await setRemoteActionsFlag(true, env)).toBe(true);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      port: 4567,
      token: TOKEN,
      notifications: false,
      custom: { keep: 1 },
      remoteActions: true,
    });
    expect(await setRemoteActionsFlag(true, env)).toBe(false);
  });

  it("does nothing without a config file, and refuses a broken one", async () => {
    expect(await setRemoteActionsFlag(false, env)).toBe(false);
    await writeFile(join(home, "config.json"), "{ nope");
    await expect(setRemoteActionsFlag(true, env)).rejects.toThrow(/Could not parse/);
  });
});

describe("serialized config saves", () => {
  let home: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "aw-config-queue-"));
    env = { AGENTWATCH_HOME: home };
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("keeps every change when saves overlap", async () => {
    const file = join(home, "config.json");
    await writeFile(file, JSON.stringify({ port: 4567, token: TOKEN, custom: "keep" }));
    const phone = { enabled: true, server: "https://ntfy.sh", topic: "a".repeat(32), includeDetails: true };
    const remote = { enabled: true, hosts: ["box.tail1234.ts.net"] };
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, i) => [
        setRemoteConfig(i === 3 ? remote : { enabled: false, hosts: [] }, env),
        setPhoneConfig(i === 3 ? phone : { ...phone, includeDetails: false }, env),
        setRemoteActionsFlag(i === 3, env),
      ]).flat(),
    );
    expect(results).toHaveLength(12);
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved).toMatchObject({ port: 4567, custom: "keep", remote, phone, remoteActions: true });
  });

  it("reports a missing config file instead of pretending to save", async () => {
    expect(await setRemoteConfig({ enabled: false, hosts: [] }, env)).toBe(false);
    expect(await configFileExists(env)).toBe(false);
    await writeFile(join(home, "config.json"), JSON.stringify({ token: TOKEN }));
    expect(await configFileExists(env)).toBe(true);
  });

  it("keeps working after a failed save", async () => {
    await writeFile(join(home, "config.json"), "{ not json");
    await expect(setRemoteConfig({ enabled: false, hosts: [] }, env)).rejects.toThrow(/Could not parse/);
    await writeFile(join(home, "config.json"), JSON.stringify({ token: TOKEN }));
    expect(await setRemoteConfig({ enabled: false, hosts: [] }, env)).toBe(true);
  });
});
