import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import { truncateTitle } from "../../core/types.js";

/**
 * Claude Code re-appends the session's generated title to the transcript as it works, so the newest one is
 * near the end. 256 KB covers many turns and stays cheap for a hook that must finish within ~1s.
 */
const TAIL_BYTES = 256 * 1024;
const AI_TITLE_PREFIX = '{"type":"ai-title"';

/**
 * The session name Claude Code shows in VS Code's tab and session list, read from the end of the
 * transcript. Hooks don't carry it, and the transcript format is internal to Claude Code (see README), so
 * any failure just means no title. Only the title is kept; every other line is discarded unparsed.
 */
export function readAiTitle(transcriptPath: string | undefined, tailBytes = TAIL_BYTES): string | undefined {
  if (!transcriptPath || !isAbsolute(transcriptPath) || !transcriptPath.endsWith(".jsonl")) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(transcriptPath, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, tailBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim();
      if (!line?.startsWith(AI_TITLE_PREFIX)) continue;
      try {
        const entry: unknown = JSON.parse(line);
        const title = (entry as { aiTitle?: unknown }).aiTitle;
        if (typeof title === "string") return truncateTitle(title);
      } catch {
        // A line still being written; an older one may do.
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
