import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { grokHooksPath, installGrok, uninstallGrok } from "./install.js";

let home: string;
const hookCommand = 'node "/opt/x/cli.js" hook --tool grok';

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "aw-grok-legacy-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function writeLegacy(extra: object = {}): Promise<string> {
  const path = join(home, ".grok", "hooks", "orchestrator.json");
  await mkdir(join(home, ".grok", "hooks"), { recursive: true });
  const ours = { hooks: [{ type: "command", command: 'node "/old/cli.js" hook --tool grok' }] };
  await writeFile(path, JSON.stringify({ hooks: { Stop: [ours] }, ...extra }));
  return path;
}

describe("grok hook file from the old project name", () => {
  it("install moves our hooks to the new file and deletes the old one", async () => {
    const legacy = await writeLegacy();
    const options = { homeDir: home, env: {}, dryRun: false, hookCommand };
    const result = await installGrok(options);
    expect(result.summary).toContain(`remove old ${legacy}`);
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(grokHooksPath(options))).toBe(true);
    expect((await installGrok(options)).changed).toBe(false);
  });

  it("keeps the old file if someone else's hooks are in it", async () => {
    const legacy = await writeLegacy({ other: true });
    await installGrok({ homeDir: home, env: {}, dryRun: false, hookCommand });
    expect(JSON.parse(await readFile(legacy, "utf8"))).toEqual({ other: true });
  });

  it("uninstall removes the old file too", async () => {
    const legacy = await writeLegacy();
    const result = await uninstallGrok({ homeDir: home, env: {}, dryRun: false, hookCommand });
    expect(result.changed).toBe(true);
    expect(existsSync(legacy)).toBe(false);
  });
});
