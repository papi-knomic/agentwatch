import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** What the desktop app's `claude://code/continue?session=` accepts (checked in its URL handler, app 5.1231). */
const LOCAL_ID = /^local_[A-Za-z0-9-]{1,64}$/;
const MAX_DEPTH = 3;
const MAX_FILES = 500;
const MAX_FILE_BYTES = 2_000_000;
/** The scan is synchronous, so a miss is remembered this long instead of rescanning on every click or toast. */
const MISS_TTL_MS = 15_000;
const MAX_MISSES = 200;

/**
 * Where the Claude desktop app keeps one JSON record per Code-tab session. Verified only for the Windows
 * MSIX install (`%LOCALAPPDATA%\Claude-Data\claude_<package family hash>\claude-code-sessions`). The macOS
 * path is a guess and unverified; the Linux/other-Windows layouts are unknown.
 */
export function defaultDesktopSessionRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  if (process.platform === "win32") {
    const base = join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Claude-Data");
    return listDirs(base)
      .filter((name) => name.startsWith("claude_"))
      .map((name) => join(base, name, "claude-code-sessions"));
  }
  if (process.platform === "darwin") {
    // Unverified guess.
    return [join(homedir(), "Library", "Application Support", "Claude-Data", "claude-code-sessions")];
  }
  return [];
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function findRecordFiles(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) walk(path, depth + 1);
      } else if (entry.isFile() && /^local_.+\.json$/.test(entry.name)) {
        files.push(path);
      }
    }
  };
  walk(root, 0);
  return files;
}

interface Candidate {
  id: string;
  archived: boolean;
  mtimeMs: number;
}

function readCandidate(path: string, cliSessionId: string): Candidate | undefined {
  try {
    const stat = statSync(path);
    if (stat.size > MAX_FILE_BYTES) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    if (record.cliSessionId !== cliSessionId && record.lastAssistantCliSessionId !== cliSessionId)
      return undefined;
    const id = record.sessionId;
    // Only the id leaves this function: the record also holds titles, prompts and paths (AGENTS.md rule 4).
    if (typeof id !== "string" || !LOCAL_ID.test(id)) return undefined;
    return { id, archived: record.isArchived === true, mtimeMs: stat.mtimeMs };
  } catch {
    return undefined;
  }
}

/**
 * Maps a Claude Code session id (from the hooks) to the desktop app's own `local_...` id. Read-only; keeps
 * only the id and caches hits. Misses are cached only briefly (MISS_TTL_MS) because the app writes its record
 * around session start, so a session that is not found yet may be found a moment later.
 */
export function createDesktopSessionResolver(
  roots: () => string[] = defaultDesktopSessionRoots,
  now: () => number = Date.now,
): (cliSessionId: string) => string | undefined {
  const cache = new Map<string, string>();
  const misses = new Map<string, number>();
  return (cliSessionId) => {
    const cached = cache.get(cliSessionId);
    if (cached) return cached;
    const missedAt = misses.get(cliSessionId);
    if (missedAt !== undefined && now() - missedAt < MISS_TTL_MS) return undefined;
    try {
      let best: Candidate | undefined;
      for (const root of roots()) {
        for (const file of findRecordFiles(root)) {
          const candidate = readCandidate(file, cliSessionId);
          if (!candidate) continue;
          if (
            !best ||
            (best.archived && !candidate.archived) ||
            (best.archived === candidate.archived && candidate.mtimeMs > best.mtimeMs)
          ) {
            best = candidate;
          }
        }
      }
      if (best) {
        misses.delete(cliSessionId);
        cache.set(cliSessionId, best.id);
      } else {
        if (misses.size >= MAX_MISSES) misses.clear();
        misses.set(cliSessionId, now());
      }
      return best?.id;
    } catch {
      return undefined;
    }
  };
}
