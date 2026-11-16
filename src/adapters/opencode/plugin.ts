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

export interface PluginOptions {
  /** Also answer permission prompts and questions from the dashboard (opt-in `remoteActions`). */
  decide?: boolean;
  /** `node "<cli>" decide --tool opencode`; derived from the hook command when left out. */
  decideCommand?: string;
}

/** `…hook --tool opencode` becomes `…decide --tool opencode` (same CLI, same quoting). */
export function decideCommandFor(hookCommand: string): string {
  return hookCommand.replace(/\bhook --tool /, "decide --tool ");
}

/** Present in a generated plugin exactly when it can answer from the dashboard; how an unflagged install keeps the choice. */
export const DECIDE_ENABLED_LINE = "const DECIDE = [";

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
export function pluginSource(hookCommand: string, options: PluginOptions = {}): string {
  const decideArgv = options.decide
    ? commandArgv(options.decideCommand ?? decideCommandFor(hookCommand))
    : null;
  return `${PLUGIN_MARKER}
// Installed by \`${APP_NAME} install --tool opencode\`; \`${APP_NAME} uninstall --tool opencode\` removes it.
// Reports OpenCode session status to the local ${APP_NAME} dashboard. Edits here are overwritten on reinstall.
import { spawn } from "node:child_process";

const HOOK = ${JSON.stringify(commandArgv(hookCommand))};
// \`${APP_NAME} decide --tool opencode\`, or null when answering from the dashboard is not installed.
const DECIDE = ${decideArgv ? JSON.stringify(decideArgv) : "null"};
// At most this many decide processes at once per OpenCode process (each waits, off OpenCode's critical path).
const MAX_DECIDES = 5;
// The regular hook creates the session on the server; decide registers a little later so it finds it.
const DECIDE_START_DELAY_MS = 300;
// Longer than decide's own deadline (560 s): only a safety net so a stuck child can't outlive its prompt.
const DECIDE_LIFETIME_MS = 600000;
const MAX_DECIDE_PREVIEW = 400;
const MAX_DECIDE_OUTPUT = 65536;
const MAX_TEXT = 500;
// The task title is at most the first line of the first prompt, cut to 80 characters (AGENTS.md hard rule 4).
const MAX_PROMPT_TITLE = 80;

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
const V2_TRACKED = ["session.created", "session.renamed", "session.inbox.enqueued"];

function text(value) {
  return typeof value === "string" ? value.slice(0, MAX_TEXT) : undefined;
}

// Only the first non-empty line, and only as much as a title can hold: prompts never travel further.
function firstLine(value) {
  if (typeof value !== "string") return undefined;
  const line = value.split(/\\r?\\n/).map((part) => part.trim()).find((part) => part.length > 0);
  return line ? line.slice(0, MAX_PROMPT_TITLE) : undefined;
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

// Answering from the dashboard. Everything here runs beside OpenCode, never in its way: the wait is a separate
// process, no event handler awaits it, and every failure ends silently with OpenCode's own prompt still on screen.
// Shared through globalThis so a plugin that is loaded twice still adds only one exit listener.
const RUNNING_KEY = Symbol.for("agentwatch.opencode.decide");
const running = globalThis[RUNNING_KEY] || (globalThis[RUNNING_KEY] = new Set());
if (!running.listening) {
  running.listening = true;
  try {
    // Children must not outlive OpenCode: nothing is left to deliver their answer to.
    process.on("exit", () => {
      for (const child of running) {
        try {
          child.kill();
        } catch {}
      }
    });
  } catch {}
}

function permissionPreview(kind, patterns, metadata) {
  const m = metadata && typeof metadata === "object" ? metadata : {};
  const listed = Array.isArray(patterns) ? patterns.filter((item) => typeof item === "string").join(" ") : "";
  const detail = typeof m.command === "string" && m.command ? m.command : typeof m.filepath === "string" && m.filepath ? m.filepath : listed;
  return (detail || (typeof kind === "string" ? kind : "")).slice(0, MAX_DECIDE_PREVIEW);
}

// Question text and labels are the answer keys, so they are passed whole (decide refuses what is too long).
function cutQuestions(questions) {
  if (!Array.isArray(questions)) return undefined;
  return questions.map((q) => ({
    question: q && q.question,
    header: q && q.header,
    multiple: q && q.multiple === true,
    options: Array.isArray(q && q.options) ? q.options.map((o) => ({ label: o && o.label, description: o && o.description })) : [],
  }));
}

// What decide printed: one JSON line, checked again here because it is only trusted as far as its shape goes.
function parseAnswer(kind, line) {
  let out;
  try {
    out = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!out || typeof out !== "object") return undefined;
  if (kind === "permission") return out.reply === "once" || out.reply === "reject" ? { reply: out.reply } : undefined;
  const ok = Array.isArray(out.answers) && out.answers.every((a) => Array.isArray(a) && a.every((label) => typeof label === "string"));
  return ok ? { answers: out.answers } : undefined;
}

function createReporter(defaultDirectory, replier) {
  // What session.created/updated/renamed told us; status events carry only the session id.
  const sessions = new Map();
  // Per session: the last event sent, so the many repeated "busy" statuses of one turn cost one process.
  const lastSent = new Map();
  // 1.x per session: the error that ended the current turn. OpenCode 1.x follows it with session.idle.
  const lastError = new Map();
  // 1.x: user message ids and the text of text parts, by message id. Parts can arrive before their message, and
  // the role is only on the message, so both are kept (bounded) until they meet.
  const userMessages = new Map();
  const partTexts = new Map();

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

  // Requests with a decide process (or one about to start), by request id.
  const decides = new Map();

  function cancelDecide(requestID) {
    const entry = typeof requestID === "string" ? decides.get(requestID) : undefined;
    if (!entry) return;
    decides.delete(requestID);
    entry.cancelled = true;
    clearTimeout(entry.timer);
    clearTimeout(entry.limit);
    if (entry.child) {
      running.delete(entry.child);
      try {
        entry.child.kill();
      } catch {}
    }
  }

  function stop() {
    for (const id of Array.from(decides.keys())) cancelDecide(id);
  }

  // kind: "permission" | "question". sessionID is the session that asked (a subagent's own id), which is the one
  // OpenCode wants back in the reply; the dashboard knows the root session, with the child as the asking agent.
  function startDecide(kind, sessionID, requestID, toolName, preview, questions) {
    if (!DECIDE || !replier) return;
    if (typeof sessionID !== "string" || typeof requestID !== "string") return;
    if (decides.has(requestID) || decides.size >= MAX_DECIDES) return;
    const root = rootOf(sessionID);
    const payload = JSON.stringify({
      kind,
      sessionId: root,
      agentSessionId: root !== sessionID ? sessionID : undefined,
      requestId: requestID,
      toolName: text(toolName) || kind,
      preview,
      questions,
    });
    const entry = { cancelled: false, child: undefined, timer: undefined, limit: undefined };
    decides.set(requestID, entry);
    entry.timer = setTimeout(() => {
      try {
        if (entry.cancelled) return;
        const child = spawn(DECIDE[0], DECIDE.slice(1), { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
        entry.child = child;
        running.add(child);
        let output = "";
        const finish = () => {
          running.delete(child);
          if (decides.get(requestID) === entry) decides.delete(requestID);
          clearTimeout(entry.limit);
          // The user answered in OpenCode first (cancelDecide): nothing left to send.
          if (entry.cancelled) return;
          entry.cancelled = true;
          const answer = parseAnswer(kind, output.split("\\n")[0]);
          if (!answer) return;
          Promise.resolve()
            .then(() => replier(kind, sessionID, requestID, answer))
            .catch(() => {});
        };
        child.on("error", finish);
        child.on("close", finish);
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk) => {
          if (output.length < MAX_DECIDE_OUTPUT) output += chunk;
        });
        child.stdout.on("error", () => {});
        child.stdin.on("error", () => {});
        child.stdin.end(payload);
        try {
          child.unref();
          child.stdout.unref();
        } catch {}
        entry.limit = setTimeout(() => cancelDecide(requestID), DECIDE_LIFETIME_MS);
        if (entry.limit.unref) entry.limit.unref();
      } catch {
        cancelDecide(requestID);
      }
    }, DECIDE_START_DELAY_MS);
    if (entry.timer.unref) entry.timer.unref();
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
    if (rootInfo && rootInfo.prompt) payload.prompt = rootInfo.prompt;
    if (typeof payload.directory !== "string") return;

    if (type === "session.deleted") {
      sessions.delete(sessionID);
      lastSent.delete(sessionID);
      lastError.delete(sessionID);
    } else {
      const key = [type, status.type, status.attempt, payload.title, payload.prompt].join("|");
      if (lastSent.get(sessionID) === key) return;
      lastSent.set(sessionID, key);
    }
    send(payload);
  }

  function bounded(map, key, value) {
    map.set(key, value);
    if (map.size > 200) map.delete(map.keys().next().value);
  }

  // The first user prompt names a session until OpenCode generates a title (it can fail, or never run for
  // sessions driven over the HTTP API). Child sessions are skipped later: a root's title comes from its own prompt.
  function trackV1Prompt(type, p) {
    const info = type === "message.updated" ? p.info : undefined;
    const part = type === "message.part.updated" ? p.part : undefined;
    if (info && info.role === "user" && typeof info.id === "string") bounded(userMessages, info.id, p.sessionID || info.sessionID);
    if (part && part.type === "text" && !part.synthetic && !part.ignored && typeof part.messageID === "string") {
      if (!partTexts.has(part.messageID)) bounded(partTexts, part.messageID, part.text);
      else if (typeof part.text === "string" && part.text) partTexts.set(part.messageID, part.text);
    }
    const id = info ? info.id : part && part.messageID;
    const sessionID = userMessages.get(id);
    const line = firstLine(partTexts.get(id));
    if (typeof sessionID !== "string" || !line) return;
    const known = sessions.get(sessionID);
    if (!known || !known.prompt) remember(sessionID, { prompt: line });
  }

  function v1(event) {
    const type = event && event.type;
    const p = (event && event.properties) || {};
    if (type === "session.created" || type === "session.updated") {
      const info = p.info || {};
      remember(info.id, { parentID: info.parentID, directory: info.directory, title: info.title });
      return;
    }
    if (type === "message.updated" || type === "message.part.updated") {
      trackV1Prompt(type, p);
      return;
    }
    if (!V1_FORWARDED.has(type)) return;
    if (type === "permission.asked") startDecide("permission", p.sessionID, p.id, p.permission, permissionPreview(p.permission, p.patterns, p.metadata));
    else if (type === "question.asked") startDecide("question", p.sessionID, p.id, "question", undefined, cutQuestions(p.questions));
    else if (type === "permission.replied" || type === "question.replied" || type === "question.rejected") cancelDecide(p.requestID);
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
    if (type === "session.inbox.enqueued") {
      const item = d.item || {};
      const known = sessions.get(d.sessionID);
      if (item.type === "user" && (!known || !known.prompt)) remember(d.sessionID, { prompt: firstLine(item.payload && item.payload.text) });
      return;
    }
    if (!V2_FORWARDED.includes(type)) return;
    // 2.x: permissions only. Forms (the question tool) have no reply route verified in the source.
    if (type === "permission.asked") startDecide("permission", d.sessionID, d.id, d.action, permissionPreview(d.action, d.resources, d.metadata));
    else if (type === "permission.replied") cancelDecide(d.requestID);
    // session.execution.succeeded says when a turn is done; an idle status also follows errors and interrupts.
    if (type === "session.status" && d.status && d.status.type === "idle") return;
    const sessionID = type === "form.created" ? d.form && d.form.sessionID : d.sessionID;
    const extra = event.location && typeof event.location.directory === "string" ? { directory: event.location.directory } : {};
    forward(2, type, sessionID, pickV2(type, d), type === "session.status" ? d.status : undefined, extra);
  }

  return { v1, v2, stop };
}

// 1.x: the plugin's own SDK client already knows the server's address, auth and project directory (and may talk to
// the app in-process). It has no method for these routes, so its underlying HTTP client posts to them.
// Source (v1.19.3): packages/opencode/src/server/routes/instance/httpapi/groups/{permission,question}.ts
async function replyV1(input, kind, requestID, answer) {
  const url = (kind === "question" ? "/question/" : "/permission/") + encodeURIComponent(requestID) + "/reply";
  const body = kind === "question" ? { answers: answer.answers } : { reply: answer.reply };
  const raw = input && input.client && input.client._client;
  if (raw && typeof raw.post === "function") {
    await raw.post({ url, body, headers: { "Content-Type": "application/json" } });
    return;
  }
  if (input && input.serverUrl && typeof fetch === "function") {
    await fetch(new URL(url, input.serverUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-opencode-directory": encodeURIComponent(input.directory || "") },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  }
}

export default {
  id: ${JSON.stringify(APP_NAME)},
  // OpenCode 1.x
  server: async (input) => {
    const reporter = createReporter(input && input.directory, (kind, sessionID, requestID, answer) =>
      replyV1(input, kind, requestID, answer),
    );
    return {
      event: async (arg) => {
        try {
          reporter.v1(arg && arg.event);
        } catch {}
      },
      dispose: async () => {
        try {
          reporter.stop();
        } catch {}
      },
    };
  },
  // OpenCode 2.x. The subscription runs in the background: setup must return straight away.
  setup: (ctx) => {
    const controller = new AbortController();
    let reporter;
    try {
      // 2.x: ctx.permission.reply, as OpenCode's own ACP server calls it (packages/cli/src/acp/permission.ts, v2.2.6).
      reporter = createReporter(ctx && ctx.location && ctx.location.directory, async (kind, sessionID, requestID, answer) => {
        if (kind === "permission") await ctx.permission.reply({ sessionID, requestID, decision: answer.reply });
      });
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
    return () => {
      controller.abort();
      try {
        if (reporter) reporter.stop();
      } catch {}
    };
  },
};
`;
}
