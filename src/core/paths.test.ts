import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appHome, migrateLegacyHome } from "./paths.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "aw-paths-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("app home", () => {
  it("uses the override, then ~/.agentwatch", () => {
    expect(appHome({ AGENTWATCH_HOME: "/custom" }, home)).toBe("/custom");
    expect(appHome({}, home)).toBe(join(home, ".agentwatch"));
  });

  it("keeps using a folder from the old name until it is migrated", async () => {
    await mkdir(join(home, ".orchestrator"));
    await writeFile(join(home, ".orchestrator", "config.json"), '{"token":"old"}');
    expect(appHome({}, home)).toBe(join(home, ".orchestrator"));

    expect(migrateLegacyHome({}, home)).toBe(join(home, ".orchestrator"));
    expect(existsSync(join(home, ".orchestrator"))).toBe(false);
    expect(appHome({}, home)).toBe(join(home, ".agentwatch"));
    expect(await readFile(join(home, ".agentwatch", "config.json"), "utf8")).toBe('{"token":"old"}');
  });

  it("never migrates over an existing folder or with an override", async () => {
    await mkdir(join(home, ".orchestrator"));
    await mkdir(join(home, ".agentwatch"));
    expect(migrateLegacyHome({}, home)).toBeNull();
    expect(existsSync(join(home, ".orchestrator"))).toBe(true);
    expect(migrateLegacyHome({ AGENTWATCH_HOME: "/x" }, home)).toBeNull();
  });
});
