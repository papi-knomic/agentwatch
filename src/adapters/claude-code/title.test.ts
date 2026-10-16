import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readAiTitle } from "./title.js";

const transcript = fileURLToPath(new URL("./fixtures/transcript.jsonl", import.meta.url));

let dir: string | undefined;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("readAiTitle", () => {
  it("returns the newest complete generated title, skipping a half-written last line", () => {
    expect(readAiTitle(transcript)).toBe("Factorial function with memoization");
  });

  it("only looks at the end of the file", async () => {
    dir = await mkdtemp(join(tmpdir(), "title-"));
    const path = join(dir, "s.jsonl");
    const early = '{"type":"ai-title","aiTitle":"Early title","sessionId":"s"}\n';
    const filler = `${'{"type":"assistant","message":"x"}\n'.repeat(200)}`;
    await writeFile(path, early + filler);
    expect(readAiTitle(path)).toBe("Early title");
    expect(readAiTitle(path, 1024)).toBeUndefined();
  });

  it("returns nothing for missing, relative or non-transcript paths", () => {
    expect(readAiTitle(undefined)).toBeUndefined();
    expect(readAiTitle(join(tmpdir(), "does-not-exist.jsonl"))).toBeUndefined();
    expect(readAiTitle("fixtures/transcript.jsonl")).toBeUndefined();
    expect(readAiTitle(transcript.replace(/\.jsonl$/, ".json"))).toBeUndefined();
  });
});
