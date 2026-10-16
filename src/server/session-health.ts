import type { SessionStore } from "../core/store.js";

/**
 * Keeps the board honest about sessions that went quiet:
 * - the agent's process is gone (crashed, tab closed without SessionEnd) → remove the session
 * - "working" with no event for a long time → mark it stalled
 * - "done"/"idle" untouched for a long time → remove it; it no longer needs attention
 */

export interface SessionHealthOptions {
  store: SessionStore;
  /** True if a process with this pid exists. */
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  stallAfterMs?: number;
  expireAfterMs?: number;
  intervalMs?: number;
}

export const STALL_AFTER_MS = 10 * 60 * 1000;
export const EXPIRE_AFTER_MS = 60 * 60 * 1000;

/** Signal 0 checks existence without touching the process. EPERM means it exists but isn't ours. */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function createSessionHealth(options: SessionHealthOptions): {
  tick: () => void;
  start: () => void;
  stop: () => void;
} {
  const {
    store,
    isAlive = processIsAlive,
    now = Date.now,
    stallAfterMs = STALL_AFTER_MS,
    expireAfterMs = EXPIRE_AFTER_MS,
    intervalMs = 60_000,
  } = options;
  let timer: NodeJS.Timeout | undefined;

  function tick(): void {
    const time = now();
    for (const session of store.list()) {
      const quietFor = time - Date.parse(session.updatedAt);
      if (session.pid !== undefined && !isAlive(session.pid)) {
        store.remove(session.key);
      } else if ((session.status === "done" || session.status === "idle") && quietFor > expireAfterMs) {
        store.remove(session.key);
      } else if (session.status === "working" && quietFor > stallAfterMs) {
        store.markStalled(session.key);
      }
    }
  }

  return {
    tick,
    start: () => {
      tick();
      timer ??= setInterval(tick, intervalMs);
      timer.unref();
    },
    stop: () => {
      clearInterval(timer);
      timer = undefined;
    },
  };
}
