import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adapters, getAdapter, toolDefaults } from "./index.js";
import type { InstallOptions } from "./types.js";

// Contract every adapter must meet (AGENTS.md hard rule 5). New adapters are covered automatically.

const FOREIGN = {
  someSetting: true,
  hooks: { Stop: [{ hooks: [{ type: "command", command: "echo someone-else" }] }] },
};

async function readJsonIfExists(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

describe.each(adapters.map((a) => [a.meta.id, a] as const))("adapter %s", (id, adapter) => {
  let home: string;
  let options: InstallOptions;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), `orch-${id}-`));
    options = {
      homeDir: home,
      env: {},
      dryRun: false,
      hookCommand: `node "/opt/x/cli.js" hook --tool ${id}`,
    };
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const configPathFor = async () => (await adapter.install({ ...options, dryRun: true })).configPath;

  it("is registered under its own id with defaults", () => {
    expect(getAdapter(id)).toBe(adapter);
    expect(toolDefaults()[id]).toMatchObject({ label: adapter.meta.displayName, enabled: true });
  });

  it("only writes inside the given home directory", async () => {
    const result = await adapter.install(options);
    expect(result.configPath.startsWith(home)).toBe(true);
  });

  it("writes nothing on a dry run", async () => {
    const result = await adapter.install({ ...options, dryRun: true });
    expect(result.changed).toBe(true);
    expect(await readdir(home)).toEqual([]);
  });

  it("installs once: a second install changes nothing", async () => {
    expect((await adapter.install(options)).changed).toBe(true);
    const path = await configPathFor();
    const before = await readFile(path, "utf8");
    expect((await adapter.install(options)).changed).toBe(false);
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("uninstall restores a pre-existing file exactly", async () => {
    const path = await configPathFor();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(FOREIGN));
    await adapter.install(options);
    const installed = await readJsonIfExists(path);
    expect(installed).toMatchObject({ someSetting: true });
    expect(JSON.stringify(installed)).toContain("echo someone-else");

    expect((await adapter.uninstall(options)).changed).toBe(true);
    expect(await readJsonIfExists(path)).toEqual(FOREIGN);
  });

  it("uninstall after a fresh install leaves nothing of ours behind", async () => {
    await adapter.install(options);
    await adapter.uninstall(options);
    const left = await readJsonIfExists(await configPathFor());
    expect(left === undefined || JSON.stringify(left) === "{}").toBe(true);
  });

  it("uninstall is a no-op when nothing is installed", async () => {
    expect((await adapter.uninstall(options)).changed).toBe(false);
    expect(await readdir(home)).toEqual([]);
  });

  it("ignores garbage payloads", () => {
    const ctx = { env: {}, now: new Date() };
    for (const raw of [null, undefined, 42, "text", [], {}]) {
      expect(adapter.normalize(raw, ctx)).toBeNull();
    }
  });
});
