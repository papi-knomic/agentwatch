import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { ensureStatusIcon, renderStatusIcon } from "./icon.js";

let dir: string | undefined;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

/** Minimal PNG reader for the files we write: RGBA, filter type 0 on every row. */
function decode(png: Buffer): { size: number; pixel: (x: number, y: number) => number[] } {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const size = png.readUInt32BE(16);
  const idatLength = png.readUInt32BE(33);
  expect(png.toString("ascii", 37, 41)).toBe("IDAT");
  const rows = inflateSync(png.subarray(41, 41 + idatLength));
  const pixel = (x: number, y: number) => {
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    return [...rows.subarray(offset, offset + 4)];
  };
  return { size, pixel };
}

describe("renderStatusIcon", () => {
  it("draws a circle in the tool's colour with a white glyph and transparent corners", () => {
    const { size, pixel } = decode(renderStatusIcon("#d97757", "done"));
    expect(size).toBe(96);
    expect(pixel(0, 0)).toEqual([0, 0, 0, 0]);
    expect(pixel(48, 15)).toEqual([0xd9, 0x77, 0x57, 255]); // inside the circle, above the check
    expect(pixel(42, 63)).toEqual([255, 255, 255, 255]); // on the check's stroke
  });

  it("accepts short hex colours", () => {
    const { pixel } = decode(renderStatusIcon("#f80", "error"));
    expect(pixel(48, 15)).toEqual([0xff, 0x88, 0x00, 255]);
  });
});

describe("ensureStatusIcon", () => {
  it("writes the icon once and reuses it", async () => {
    dir = await mkdtemp(join(tmpdir(), "icons-"));
    const path = await ensureStatusIcon(join(dir, "icons"), "#D97757", "needs_input");
    expect(path).toBe(join(dir, "icons", "d97757-needs_input.png"));
    const first = await stat(path);
    expect(await ensureStatusIcon(join(dir, "icons"), "#D97757", "needs_input")).toBe(path);
    expect((await stat(path)).mtimeMs).toBe(first.mtimeMs);
    expect((await readFile(path)).length).toBeGreaterThan(100);
  });
});
