import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import type { NotifiableStatus } from "../core/types.js";

type Point = readonly [number, number];
type Segment = readonly [Point, Point];

/** Status glyphs in a unit square, drawn as round-capped strokes; a zero-length segment is a dot. */
const GLYPHS: Record<NotifiableStatus, readonly Segment[]> = {
  needs_input: [
    [
      [0.5, 0.27],
      [0.5, 0.55],
    ],
    [
      [0.5, 0.72],
      [0.5, 0.72],
    ],
  ],
  done: [
    [
      [0.3, 0.52],
      [0.44, 0.66],
    ],
    [
      [0.44, 0.66],
      [0.71, 0.37],
    ],
  ],
  error: [
    [
      [0.36, 0.36],
      [0.64, 0.64],
    ],
    [
      [0.64, 0.36],
      [0.36, 0.64],
    ],
  ],
};

const STROKE = 0.068;
const SIZE = 96;
const SAMPLES = 4;

function distanceToSegment(x: number, y: number, [[ax, ay], [bx, by]]: Segment): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSquared));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

function parseHexColor(color: string): [number, number, number] {
  let hex = color.replace(/^#/, "");
  if (hex.length === 3 || hex.length === 4) hex = [...hex.slice(0, 3)].map((c) => c + c).join("");
  const value = Number.parseInt(hex.slice(0, 6), 16);
  if (hex.length < 6 || Number.isNaN(value)) return [128, 128, 128];
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 255] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size: number, rgba: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, no interlace
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A circle in the tool's colour with a white status glyph, as a PNG. Supersampled for smooth edges. */
export function renderStatusIcon(color: string, status: NotifiableStatus, size = SIZE): Buffer {
  const [r, g, b] = parseHexColor(color);
  const glyph = GLYPHS[status];
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let inCircle = 0;
      let inGlyph = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (px + (sx + 0.5) / SAMPLES) / size;
          const y = (py + (sy + 0.5) / SAMPLES) / size;
          if ((x - 0.5) ** 2 + (y - 0.5) ** 2 > 0.24) continue;
          inCircle++;
          if (glyph.some((segment) => distanceToSegment(x, y, segment) < STROKE)) inGlyph++;
        }
      }
      if (inCircle === 0) continue;
      const white = inGlyph / inCircle;
      const offset = (py * size + px) * 4;
      rgba[offset] = Math.round(r + (255 - r) * white);
      rgba[offset + 1] = Math.round(g + (255 - g) * white);
      rgba[offset + 2] = Math.round(b + (255 - b) * white);
      rgba[offset + 3] = Math.round((255 * inCircle) / SAMPLES ** 2);
    }
  }
  return encodePng(size, rgba);
}

/** Writes the icon once per colour and status, then reuses the file. */
export async function ensureStatusIcon(
  dir: string,
  color: string,
  status: NotifiableStatus,
): Promise<string> {
  const path = join(dir, `${color.replace(/[^0-9a-fA-F]/g, "").toLowerCase()}-${status}.png`);
  try {
    await access(path);
  } catch {
    await mkdir(dir, { recursive: true });
    await writeFile(path, renderStatusIcon(color, status));
  }
  return path;
}
