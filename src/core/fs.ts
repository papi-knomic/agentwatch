import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Returns null when the file does not exist; other errors (permissions, etc.) are thrown.
 * Strips a UTF-8 BOM: Windows PowerShell 5.1 and older editors add one, and JSON.parse rejects it.
 */
export async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return (await readFile(path, "utf8")).replace(/^﻿/, "");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Write to a temp file and rename, so a crash never leaves a half-written config behind. */
export async function writeFileAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, contents, "utf8");
  await rename(tmp, path);
}
