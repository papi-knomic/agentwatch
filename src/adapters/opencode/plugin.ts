import { APP_NAME } from "../../core/constants.js";

/** First line of the file we install; how install and uninstall recognise the plugin as ours. */
export const PLUGIN_MARKER = `// ${APP_NAME}:opencode-plugin`;

/**
 * Splits a hook command (`node "<cli>" hook --tool opencode`, see buildHookCommand) into program and arguments,
 * so the plugin can run it without a shell. Double quotes group; paths can't contain them on Windows.
 */
export function commandArgv(command: string): string[] {
  return [...command.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2] ?? "");
}

/**
 * Source of the plugin OpenCode loads from its plugins folder. OpenCode has no shell hooks: plugins run inside
 * its own (Bun) process and receive every bus event. This one hands the few that matter to our `hook` command,
 * so tokens, `taskTitles` and the server address are handled in one place for every tool.
 *
 * Hard rule 1 applies here too, more strictly than for a hook: a throw or a slow `await` would land in
 * OpenCode itself. So every send is a detached background process, and every failure is swallowed.
 *
 * It sends only the fields normalize.ts reads. Raw events carry file diffs, shell commands and question
 * text (see fixtures/), which must not leave OpenCode, and the payload travels on a command line.
 */
export function pluginSource(hookCommand: string): string {
  return `${PLUGIN_MARKER}
// Installed by \`${APP_NAME} install --tool opencode\`; \`${APP_NAME} uninstall --tool opencode\` removes it.
// Reports OpenCode session status to the local ${APP_NAME} dashboard. Edits here are overwritten on reinstall.
import { spawn } from "node:child_process";

const HOOK = ${JSON.stringify(commandArgv(hookCommand))};
const MAX_TEXT = 500;

const FORWARDED = new Set([
  "session.status",
  "session.idle",
  "session.error",
  "session.deleted",
  "permission.asked",
  "permission.updated",
  "permission.replied",
  "question.asked",
  "question.replied",
  "question.rejected",
]);

function text(value) {
  return typeof value === "string" ? value.slice(0, MAX_TEXT) : undefined;
}

function pick(type, p) {
  switch (type) {
    case "session.deleted":
      return { info: { id: p.info && p.info.id } };
    case "session.status":
      return {
        sessionID: p.sessionID,
        status: p.status && { type: p.status.type, attempt: p.status.attempt, message: text(p.status.message) },
      };
    case "session.error":
      return {
        sessionID: p.sessionID,
        error: p.error ? { name: text(p.error.name), data: { message: text(p.error.data && p.error.data.message) } } : undefined,
      };
    case "permission.asked":
      return { sessionID: p.sessionID, permission: p.permission };
    case "permission.updated":
      return { sessionID: p.sessionID, type: p.type };
    case "permission.replied":
      return { sessionID: p.sessionID, reply: p.reply !== undefined ? p.reply : p.response };
    default:
      return { sessionID: p.sessionID };
  }
}

// Detached, no shell, payload as the last argument. \`opencode run\` exits right after its final session.idle;
// under Bun on Windows only this combination still delivers that event (an attached child or a stdin pipe dies
// with OpenCode, and a detached child with a stdin pipe never runs).
function send(payload) {
  try {
    const child = spawn(HOOK[0], HOOK.slice(1).concat(JSON.stringify(payload)), {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

export const AgentWatchPlugin = async ({ directory }) => {
  // What session.created/updated told us; status events carry only the session id.
  const sessions = new Map();
  // Per session: the last event sent, so the many repeated "busy" statuses of one turn cost one process.
  const lastSent = new Map();
  // Per session: the error that ended the current turn, if any. OpenCode follows it with session.idle.
  const lastError = new Map();

  // Subagents run in child sessions; their prompts belong to the session the user is looking at.
  function rootOf(id) {
    let current = id;
    for (let depth = 0; depth < 16; depth++) {
      const parent = sessions.get(current) && sessions.get(current).parentID;
      if (!parent) break;
      current = parent;
    }
    return current;
  }

  function handle(event) {
    const type = event && event.type;
    const p = (event && event.properties) || {};
    if (type === "session.created" || type === "session.updated") {
      const info = p.info;
      if (info && typeof info.id === "string") {
        sessions.set(info.id, { parentID: info.parentID, directory: info.directory, title: info.title });
      }
      return;
    }
    if (!FORWARDED.has(type)) return;
    const sessionID = type === "session.deleted" ? p.info && p.info.id : p.sessionID;
    if (typeof sessionID !== "string") return;

    const status = type === "session.status" && p.status ? p.status : {};
    // session.idle says the same, and is the event documented for "finished".
    if (type === "session.status" && status.type === "idle") return;
    const payload = {
      event: { type, properties: pick(type, p) },
      directory,
      pid: process.pid,
      at: new Date().toISOString(),
    };
    const root = rootOf(sessionID);
    if (root !== sessionID) payload.rootSessionID = root;
    const rootInfo = sessions.get(root);
    if (rootInfo && typeof rootInfo.directory === "string") payload.directory = rootInfo.directory;
    if (rootInfo && typeof rootInfo.title === "string") payload.title = text(rootInfo.title);

    if (type === "session.error") lastError.set(sessionID, (p.error && p.error.name) || "UnknownError");
    if (type === "session.status" && status.type === "busy") lastError.delete(sessionID);
    if (type === "session.idle" && lastError.has(sessionID)) {
      payload.afterError = lastError.get(sessionID);
      lastError.delete(sessionID);
    }
    if (type === "session.deleted") {
      sessions.delete(sessionID);
      lastSent.delete(sessionID);
      lastError.delete(sessionID);
    }

    const key = [type, status.type, status.attempt, payload.title].join("|");
    if (lastSent.get(sessionID) === key) return;
    if (type !== "session.deleted") lastSent.set(sessionID, key);
    send(payload);
  }

  return {
    event: async (input) => {
      try {
        handle(input && input.event);
      } catch {}
    },
  };
};
`;
}
