import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readTextIfExists } from "./fs.js";

let dir: string | undefined;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("readTextIfExists", () => {
  it("returns null for a missing file", async () => {
    dir = await mkdtemp(join(tmpdir(), "fs-"));
    expect(await readTextIfExists(join(dir, "missing.json"))).toBeNull();
  });

  it("strips the BOM that Windows PowerShell writes, so the JSON parses", async () => {
    dir = await mkdtemp(join(tmpdir(), "fs-"));
    const path = join(dir, "config.json");
    await writeFile(path, '﻿{"port": 7879}', "utf8");
    const text = await readTextIfExists(path);
    expect(JSON.parse(text ?? "")).toEqual({ port: 7879 });
  });
});
