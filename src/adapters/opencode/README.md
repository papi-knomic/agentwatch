# OpenCode adapter

Supports **OpenCode 1.x** (npm `opencode-ai`, checked against 1.19.3) and **OpenCode 2.x** (npm `@opencode/cli`,
checked against 2.2.6) with one plugin file.

Official plugin docs: https://opencode.ai/docs/plugins/ (checked 2026-11-09; still describes the 1.x API). The 2.x
API is documented in the source at tag `v2.2.6` of https://github.com/anomalyco/opencode: `packages/plugin/src/README.md`
and `packages/plugin/src/promise/plugin.ts` (plugin shape), `packages/core/src/plugin/module.ts` (what a module must
export), and `packages/schema/src/` (`event.ts`, `session-event.ts`, `session-status-event.ts`, `permission.ts`,
`form.ts`: event shapes). 1.x event shapes: `packages/sdk/js/src/v2/gen/types.gen.ts` at tag `v1.19.3`.

## How it hooks in

OpenCode has no shell hooks. Its extension point is a JS/TS **plugin** that it loads from
`{plugin,plugins}/*.{js,ts}` in its config folder (both majors) and runs inside its own Bun process.

`agentwatch install --tool opencode` writes **its own file**, `~/.config/opencode/plugins/agentwatch.js`
(`$XDG_CONFIG_HOME/opencode/...` when that is set; OpenCode uses the same folder on Windows). No file belonging to
the user is edited, so no backup is needed, and `uninstall` deletes the file. The file starts with a marker line:
install refuses to overwrite a file at that path without it, and uninstall leaves such a file alone. OpenCode 1.x
loads plugins only at startup, so it has to be restarted after installing. 2.x watches its plugin folders
(`packages/core/src/config/plugin/source.ts`), so it should pick the file up on its own; not verified, so the
install step still says to restart.

### One file for both majors

The two plugin APIs are incompatible, and people run both against the same config folder, so the plugin exports a
single default definition that each major reads its own part of:

```js
export default {
  id: "agentwatch",
  server: async (input) => ({ event: async ({ event }) => { /* 1.x */ } }),
  setup: (ctx) => { /* 2.x: for await (const event of ctx.event.subscribe({ types })) ... */ },
};
```

- **1.x** (`packages/opencode/src/plugin/index.ts`): a default export with an `id` is a plugin module; it calls
  `server(input)` and hands every event to the returned `event` hook as `{ type, properties }`. `setup` is ignored.
- **2.x** (`packages/core/src/plugin/module.ts`): the default export **must** be `{ id, setup }` or `{ id, effect }`;
  anything else fails with "Plugin must export a default definition with an id and an effect or setup function"
  (the error 0.1.3's named export hit). Events arrive as `{ id, type, data, location? }` from the async iterable
  `ctx.event.subscribe({ types, signal })`; the cleanup `setup` returns aborts it. `server` is ignored.

There are no other exports: 1.x would treat any other exported function as a plugin of its own.

### Sending

The plugin passes the events below to `agentwatch hook --tool opencode`, one detached background process per event,
with the payload as the last argument and no shell. Like the other tools' hooks, it never blocks or throws into
OpenCode. It sends only the fields `normalize.ts` reads, with text cut to 500 characters, because raw events carry
file diffs, shell commands and question text. It sends an event only when it differs from the session's last one
(1.x repeats `busy` several times per turn).

Why an argument, not stdin: `opencode run` exits right after its final event. Measured under OpenCode's own Bun
(1.3.14, Windows), an attached child, or one fed through a stdin pipe, dies with OpenCode and that last event is lost.
A detached child with a stdin pipe never runs at all. Detached, with the payload as an argument, every event arrived.

The envelope: `{ v, event, directory, pid, at, title?, rootSessionID?, afterError? }`, where `v` is `1` (`event` is
`{ type, properties }`) or `2` (`event` is `{ type, data }`). Plugins installed by 0.1.3 send no `v`; those are 1.x.

## OpenCode 1.x events

| Event | Status | Notes |
|---|---|---|
| `session.status` `busy` | `working` | |
| `session.status` `retry` | `working` | Message: `Retrying: <reason>`. |
| `session.status` `idle` | — | Not sent; `session.idle` says the same. |
| `session.idle` | `done` | After an error: ignored, so the error stays. After Esc (`MessageAbortedError`): `idle`, "Interrupted". |
| `session.error` | `error` | Message from `error.data.message`. `MessageAbortedError` (Esc) is ignored. |
| `session.deleted` | `ended` | |
| `permission.asked` | `needs_input` | Message: `Permission needed: <edit\|bash\|...>`. |
| `permission.updated` | `needs_input` | The older name in the v1 SDK types; 1.19.3 sends `permission.asked`. |
| `permission.replied` | `working` | On `reject`, `session.idle` follows within milliseconds. |
| `question.asked` | `needs_input` | Message: "Has a question for you" (the question text is not sent). |
| `question.replied`, `question.rejected` | `working` | |
| `session.created`, `session.updated` | — | Only remembered by the plugin: directory, title, `parentID`. |

## OpenCode 2.x events

| Event | Status | Notes |
|---|---|---|
| `session.execution.started` | `working` | One per turn. |
| `session.execution.succeeded` | `done` | |
| `session.execution.failed` | `error` | Message from `error.message`. |
| `session.execution.interrupted` | `idle` | `reason: "user"` (Esc): "Interrupted". `"shutdown"`: "Stopped"; 2.2.6 also uses it to end the turn after a rejected permission (captured). `"superseded"` is ignored: the new turn reports itself. |
| `session.status` `busy` / `retry` | `working` | Defined in the schema but never seen in the 2.2.6 capture; handled like 1.x. `idle` is not sent. |
| `session.deleted` | `ended` | |
| `permission.asked` | `needs_input` | Message: `Permission needed: <edit\|shell\|...>` from `action`; the `resources` (command, file) are not sent. |
| `permission.replied` | `working` | |
| `form.created` | `needs_input` | The question tool asks through a form (`metadata.kind: "question"`); the session is `form.sessionID`. Message: "Has a question for you". Forms owned by `"global"` (MCP elicitation) are ignored. |
| `form.replied`, `form.cancelled` | `working` | |
| `session.created`, `session.renamed` | — | Only remembered by the plugin: `location.directory`, `title`, `parentID`. |

`question.*` events and `session.error` no longer exist in 2.x, and `session.idle` is deprecated.

## Both majors

- **Session id and folder:** OpenCode's `sessionID` and the session's directory (1.x `info.directory`, 2.x
  `location.directory`), falling back to the plugin's own directory.
- **Title:** OpenCode names each session itself (e.g. `Add word to hello.txt`) and the plugin attaches the latest
  name to the next event it sends, with `titleSource: "tool"`. 1.x's placeholder `New session - <ISO time>` is
  ignored. A rename while idle shows with the next activity.
- **Subagents** run in child sessions (`parentID`). Their own lifecycle is ignored, because the parent is busy
  throughout. Their permission prompts and questions are shown on the top-level session (`rootSessionID`).
- **Host:** from the environment of the process running the plugin, e.g. `WT_SESSION` → "Windows Terminal".
- **pid:** the process running the plugin. OpenCode sends no event when you quit, so the server drops its sessions
  once that process is gone (within a minute).
- **Order:** `at` is when the plugin saw the event. Hooks are separate processes and can arrive out of order, so
  the server uses this time to drop late, stale ones.

## Fixtures

`fixtures/v1/`. Real captured payloads (OpenCode 1.19.3 TUI in Windows Terminal, OpenAI via a ChatGPT login,
2026-10-20), with paths replaced: `session-created`, `session-updated-title`, `session-status-busy`,
`session-status-idle`, `session-idle`, `permission-asked-edit`, `permission-asked-bash`, `permission-replied-once`,
`permission-replied-reject`, `question-asked`, `question-replied`. Constructed from the SDK types (didn't fire):
`session-status-retry`, `session-error`, `session-error-aborted`, `session-deleted`, `session-created-child`,
`question-rejected`, `permission-updated`.

`fixtures/v2/`. Real captured payloads (OpenCode 2.2.6 TUI in Windows Terminal with its background service, OpenAI
via a ChatGPT login, 2026-11-09), with paths replaced: `session-created`, `session-renamed`,
`session-execution-started`, `session-execution-succeeded`, `session-execution-interrupted-shutdown`,
`permission-asked-edit`, `permission-asked-shell`, `permission-replied-once`, `permission-replied-reject`,
`form-created`, `form-replied`. Constructed from the 2.2.6 schemas (didn't fire): `session-execution-failed`,
`session-execution-interrupted-user`, `session-execution-interrupted-superseded`, `session-status-busy`,
`session-status-idle`, `session-status-retry`, `session-deleted`, `session-created-child`, `form-cancelled`,
`form-created-global`.

## Known gaps

- **2.x background service:** by default OpenCode 2.x runs sessions, and plugins, in a shared background service
  (`opencode serve --service`) that keeps running after you quit the TUI (`--standalone` runs a private one). So
  for 2.x the pid is the service's: a finished session stays until it expires (an hour after its last event) rather
  than when you quit, and the host is whichever terminal started the service.
- **Not verified by capture:** errors, retries, Esc, subagent sessions and deleting a session (both majors), and the
  OpenCode desktop app and IDE extensions. The mappings above follow the SDK types and schemas for these.
- **No end event on quit (1.x):** a quit session is removed only when the server notices the OpenCode process has
  exited. Older sessions from the same process (after `/new`) stay until they expire.
- As with Claude Code's `CLAUDE_PID`, the pid also enables the approval watcher. OpenCode already reports approvals
  (`permission.replied`), so the watcher only matters if that event is late.
