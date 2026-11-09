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
 * its own process and see its events. This one hands the few that matter to our `hook` command, so tokens,
 * `taskTitles` and the server address are handled in one place for every tool.
 *
 * One file serves both plugin APIs, so a user can run either OpenCode major against the same config folder:
 * - 1.x calls `default.server(input)` once an exported default has an `id`, and passes each event to the
 *   returned `event` hook as `{ type, properties }`.
 * - 2.x requires `default` to be `{ id, setup }`, calls `setup(ctx)`, and streams `{ type, data }` events from
 *   `ctx.event.subscribe()`. 2.x ignores `server`; 1.x ignores `setup`.
 * Each envelope says which API it came from (`v`), and normalize.ts maps each with its own fixtures.
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

const V1_FORWARDED = new Set([
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

const V2_FORWARDED = [
  "session.status",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.deleted",
  "permission.asked",
  "permission.replied",
  "form.created",
  "form.replied",
  "form.cancelled",
];
// Remembered for titles, subagents and folders, never sent on their own.
const V2_TRACKED = ["session.created", "session.renamed"];

function text(value) {
  return typeof value === "string" ? value.slice(0, MAX_TEXT) : undefined;
}

function pickStatus(status) {
  return status && { type: status.type, attempt: status.attempt, message: text(status.message) };
}

function pickV1(type, p) {
  switch (type) {
    case "session.deleted":
      return { info: { id: p.info && p.info.id } };
    case "session.status":
      return { sessionID: p.sessionID, status: pickStatus(p.status) };
    case "session.error":
      return {
        sessionID: p.sessionID,
        error: p.error ? { name: text(p.error.name), data: { message: text(p.error.data && p.error.data.message) } } : undefined,
      };
    case "permission.asked":
      return { sessionID: p.sessionID, permission: text(p.permission) };
    case "permission.updated":
      return { sessionID: p.sessionID, type: text(p.type) };
    case "permission.replied":
      return { sessionID: p.sessionID, reply: p.reply !== undefined ? p.reply : p.response };
    default:
      return { sessionID: p.sessionID };
  }
}

function pickV2(type, d) {
  switch (type) {
    case "session.status":
      return { sessionID: d.sessionID, status: pickStatus(d.status) };
    case "session.execution.failed":
      return { sessionID: d.sessionID, error: d.error ? { type: text(d.error.type), message: text(d.error.message) } : undefined };
    case "session.execution.interrupted":
      return { sessionID: d.sessionID, reason: text(d.reason) };
    case "permission.asked":
      return { sessionID: d.sessionID, action: text(d.action) };
    case "permission.replied":
      return { sessionID: d.sessionID, reply: text(d.reply) };
    case "form.created":
      return { form: { sessionID: d.form && d.form.sessionID } };
    default:
      return { sessionID: d.sessionID };
  }
}

// Detached, no shell, payload as the last argument. \`opencode run\` exits right after its final event; under
// Bun on Windows only this combination still delivers it (an attached child or a stdin pipe dies with
// OpenCode, and a detached child with a stdin pipe never runs).
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

function createReporter(defaultDirectory) {
  // What session.created/updated/renamed told us; status events carry only the session id.
  const sessions = new Map();
  // Per session: the last event sent, so the many repeated "busy" statuses of one turn cost one process.
  const lastSent = new Map();
  // 1.x per session: the error that ended the current turn. OpenCode 1.x follows it with session.idle.
  const lastError = new Map();

  function remember(id, info) {
    if (typeof id !== "string") return;
    const known = sessions.get(id) || {};
    for (const [key, value] of Object.entries(info)) if (typeof value === "string") known[key] = value;
    sessions.set(id, known);
  }

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

  function forward(v, type, sessionID, picked, statusOf, extra) {
    if (typeof sessionID !== "string") return;
    const status = statusOf || {};
    const payload = {
      v,
      event: v === 2 ? { type, data: picked } : { type, properties: picked },
      directory: defaultDirectory,
      pid: process.pid,
      at: new Date().toISOString(),
      ...extra,
    };
    const root = rootOf(sessionID);
    if (root !== sessionID) payload.rootSessionID = root;
    const rootInfo = sessions.get(root);
    if (rootInfo && rootInfo.directory) payload.directory = rootInfo.directory;
    if (rootInfo && rootInfo.title) payload.title = text(rootInfo.title);
    if (typeof payload.directory !== "string") return;

    if (type === "session.deleted") {
      sessions.delete(sessionID);
      lastSent.delete(sessionID);
      lastError.delete(sessionID);
    } else {
      const key = [type, status.type, status.attempt, payload.title].join("|");
      if (lastSent.get(sessionID) === key) return;
      lastSent.set(sessionID, key);
    }
    send(payload);
  }

  function v1(event) {
    const type = event && event.type;
    const p = (event && event.properties) || {};
    if (type === "session.created" || type === "session.updated") {
      const info = p.info || {};
      remember(info.id, { parentID: info.parentID, directory: info.directory, title: info.title });
      return;
    }
    if (!V1_FORWARDED.has(type)) return;
    const sessionID = type === "session.deleted" ? p.info && p.info.id : p.sessionID;
    // session.idle says the same, and is the event documented for "finished".
    if (type === "session.status" && p.status && p.status.type === "idle") return;
    const extra = {};
    if (type === "session.error") lastError.set(sessionID, (p.error && p.error.name) || "UnknownError");
    if (type === "session.status" && p.status && p.status.type === "busy") lastError.delete(sessionID);
    if (type === "session.idle" && lastError.has(sessionID)) {
      extra.afterError = lastError.get(sessionID);
      lastError.delete(sessionID);
    }
    forward(1, type, sessionID, pickV1(type, p), type === "session.status" ? p.status : undefined, extra);
  }

  function v2(event) {
    const type = event && event.type;
    const d = (event && event.data) || {};
    if (type === "session.created") {
      remember(d.sessionID, { parentID: d.parentID, directory: d.location && d.location.directory, title: d.title });
      return;
    }
    if (type === "session.renamed") {
      remember(d.sessionID, { title: d.title });
      return;
    }
    if (!V2_FORWARDED.includes(type)) return;
    // session.execution.succeeded says when a turn is done; an idle status also follows errors and interrupts.
    if (type === "session.status" && d.status && d.status.type === "idle") return;
    const sessionID = type === "form.created" ? d.form && d.form.sessionID : d.sessionID;
    const extra = event.location && typeof event.location.directory === "string" ? { directory: event.location.directory } : {};
    forward(2, type, sessionID, pickV2(type, d), type === "session.status" ? d.status : undefined, extra);
  }

  return { v1, v2 };
}

export default {
  id: ${JSON.stringify(APP_NAME)},
  // OpenCode 1.x
  server: async (input) => {
    const reporter = createReporter(input && input.directory);
    return {
      event: async (arg) => {
        try {
          reporter.v1(arg && arg.event);
        } catch {}
      },
    };
  },
  // OpenCode 2.x. The subscription runs in the background: setup must return straight away.
  setup: (ctx) => {
    const controller = new AbortController();
    try {
      const reporter = createReporter(ctx && ctx.location && ctx.location.directory);
      const events = ctx.event.subscribe({ types: V2_FORWARDED.concat(V2_TRACKED), signal: controller.signal });
      (async () => {
        try {
          for await (const event of events) {
            try {
              reporter.v2(event);
            } catch {}
          }
        } catch {}
      })();
    } catch {}
    return () => controller.abort();
  },
};
`;
}
