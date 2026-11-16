import type { SessionStore } from "../core/store.js";
import type { ChildProcessInfo, ListChildren } from "./process-list.js";

/**
 * No tool fires a hook when the user approves a permission prompt; the next event is PostToolUse, after the
 * command finishes. A long foreground command would sit at "needs input" the whole time. So while a session
 * waits, watch its agent process: an approved command starts as a new child shell.
 */

export const APPROVED_MESSAGE = "Running approved command";
/** The same failure is logged at most this often: a broken lister fails every poll, and flaps in and out. */
const ERROR_LOG_INTERVAL_MS = 10 * 60_000;

const SHELLS = new Set(["cmd", "powershell", "pwsh", "bash", "sh", "zsh", "fish", "dash"]);

/**
 * Our own hooks (`hook` and `decide`, run through a shell Claude Code spawns for the hook command) also appear as
 * short-lived children while a prompt is up; they are not an approved command. Matches the subcommand with its
 * `--tool` flag, so a user's command that merely mentions "decide" is still taken.
 */
const OWN_HOOK = /\b(?:hook|decide)\s+--tool\b/;

export function isApprovedCommand(child: ChildProcessInfo): boolean {
  const name = child.name.toLowerCase().replace(/\.exe$/, "");
  return SHELLS.has(name) && !OWN_HOOK.test(child.command);
}

export interface ApprovalWatcherOptions {
  store: SessionStore;
  listChildren: ListChildren;
  /** A blocking prompt of this session is on the dashboard: Claude Code is stopped, so it can't have started a command. */
  isHeld?: (sessionKey: string) => boolean;
  intervalMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

export function createApprovalWatcher(options: ApprovalWatcherOptions): {
  tick: () => Promise<void>;
  start: () => void;
  stop: () => void;
} {
  const { store, listChildren, isHeld, intervalMs = 2000, now = Date.now, log } = options;
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  // Candidate shells seen on the previous tick, per session. A command must be seen twice in a row, so a
  // short-lived hook from some other tool firing with the prompt doesn't count as an approval.
  let seen = new Map<string, Set<number>>();
  // A failing lister would otherwise log every interval (and every flap). Say a given failure once in a while,
  // and "recovered" only for a failure that was actually announced.
  let lastLogged: { message: string; loggedAt: number } | undefined;
  let failing = false;
  let announced = false;

  function reportFailure(error: unknown): void {
    const message = (error instanceof Error ? error.message : String(error)).split(/\r?\n/)[0] ?? "";
    failing = true;
    if (lastLogged?.message === message && now() - lastLogged.loggedAt < ERROR_LOG_INTERVAL_MS) return;
    log?.(`Approval watch failed (retrying every ${intervalMs / 1000}s): ${message}`);
    lastLogged = { message, loggedAt: now() };
    announced = true;
  }

  async function tick(): Promise<void> {
    if (running) return;
    // Several agents in one session (subagents) can't be told apart by their shells: a command that started may
    // be another agent's, so the session stays as it is until that agent's own event arrives.
    const waiting = store
      .list()
      .filter(
        (s) =>
          s.status === "needs_input" &&
          s.pid !== undefined &&
          store.activeSubagents(s.key, now()) === 0 &&
          !isHeld?.(s.key),
      );
    if (waiting.length === 0) {
      seen = new Map();
      return;
    }
    running = true;
    try {
      const pids = [...new Set(waiting.map((s) => s.pid as number))];
      const children = (await listChildren(pids)).filter(isApprovedCommand);
      if (failing) {
        if (announced) log?.("Approval watch recovered.");
        failing = false;
        announced = false;
      }
      const nextSeen = new Map<string, Set<number>>();
      for (const session of waiting) {
        // Measured from the last activity *before* the prompt, not the prompt event itself: our "needs input"
        // hook can land after a fast approval, and the approved shell then starts before it.
        const since = Date.parse(session.previousActivityAt ?? session.statusSince);
        const candidates = children
          .filter((c) => c.parentPid === session.pid && c.startedAt > since)
          .map((c) => c.pid);
        nextSeen.set(session.key, new Set(candidates));
        const before = seen.get(session.key);
        if (!candidates.some((pid) => before?.has(pid))) continue;
        // Re-check: an event may have arrived while we were listing processes.
        const current = store.get(session.key);
        if (isHeld?.(session.key)) continue; // a prompt may have been registered while we were listing
        if (current?.status !== "needs_input" || current.updatedAt !== session.updatedAt) continue;
        store.apply({
          tool: session.tool,
          sessionId: session.sessionId,
          cwd: session.cwd,
          status: "working",
          message: APPROVED_MESSAGE,
          timestamp: new Date(now()).toISOString(),
        });
      }
      seen = nextSeen;
    } catch (error) {
      reportFailure(error);
    } finally {
      running = false;
    }
  }

  return {
    tick,
    start: () => {
      timer ??= setInterval(() => void tick(), intervalMs);
      timer.unref();
    },
    stop: () => {
      clearInterval(timer);
      timer = undefined;
    },
  };
}
