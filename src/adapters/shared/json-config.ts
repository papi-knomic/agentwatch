import { copyFile } from "node:fs/promises";
import { APP_NAME } from "../../core/constants.js";
import { readTextIfExists, writeFileAtomic } from "../../core/fs.js";

export type JsonObject = Record<string, unknown>;

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface JsonUpdateResult {
  changed: boolean;
  backupPath?: string;
}

/**
 * Applies `transform` to a JSON config file. Refuses to touch a file it cannot parse, backs up the
 * original before writing, and writes nothing when the content is unchanged or on a dry run.
 */
export async function updateJsonFile(
  path: string,
  transform: (data: JsonObject) => JsonObject,
  dryRun: boolean,
  now: Date = new Date(),
): Promise<JsonUpdateResult> {
  const text = await readTextIfExists(path);
  let data: JsonObject = {};
  if (text !== null && text.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${path} is not valid JSON. It was left untouched; fix it and try again.`);
    }
    if (!isJsonObject(parsed)) {
      throw new Error(`${path} does not contain a JSON object. It was left untouched.`);
    }
    data = parsed;
  }

  const next = transform(structuredClone(data));
  const changed = JSON.stringify(next) !== JSON.stringify(data);
  if (!changed || dryRun) return { changed };

  let backupPath: string | undefined;
  if (text !== null) {
    backupPath = `${path}.${APP_NAME}-backup-${now.toISOString().replace(/[:.]/g, "-")}`;
    await copyFile(path, backupPath);
  }
  await writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
  return backupPath ? { changed, backupPath } : { changed };
}
