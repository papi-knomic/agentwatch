# AGENTS.md

Rules for any AI coding agent (Claude Code, Codex, Grok, Gemini, Cursor, …) working in this repo.
`CLAUDE.md` imports this file, so this is the only rules file to maintain.

## What this project is

A local, open-source dashboard and notifier for AI coding agents. When you run several agents at once
(in VS Code, in a terminal, or in a desktop app), it shows every session in one browser page. It also sends a
desktop notification when one needs your input or has finished. You can set notifications up differently for each tool.

- **Status:** 0.1. Server, dashboard, Windows notifications, start at login and the Claude Code, Codex and Grok adapters work.
- **Name:** `agentwatch` (npm package and command; display name "AgentWatch"). Don't hard-code it: use `APP_NAME` /
  `APP_DISPLAY_NAME` from `src/core/constants.ts`, kept in sync with `package.json`.
- **Distribution:** `npm install -g @kn0mic/agentwatch && agentwatch setup`. The package is scoped because npm
  rejected unscoped `agentwatch` as too similar to `agent-watch`; the command is still `agentwatch` (`PACKAGE_NAME`
  vs `APP_NAME` in constants.ts). Hooks and start at login store the installed
  CLI's absolute path, so installing from npx's cache is refused (`assertStableInstall`).
- **License:** MIT.

## How it works

```
agent hook ──▶ `agentwatch hook --tool <id>` ───HTTP POST──▶ local server (127.0.0.1)
                                                                ├─ session store (in memory + JSON file)
                                                                ├─ SSE stream ──▶ browser dashboard
                                                                └─ notifier ──▶ OS notification (per-tool settings)
```

Each AI tool fires its own hooks (Claude Code `Notification`/`Stop`, Codex `notify`, Grok `Stop`/`Notification`).
The hook runs our small CLI, which turns the raw event into one shared format and sends it to the server.

### Layout

```
src/
  core/        shared event format (types.ts), session store, config, constants (knows nothing about any one tool)
  adapters/    one folder per AI tool: meta.ts, normalize.ts, install.ts, fixtures/, README.md
    shared/    helpers that several adapters use (JSON config editing, Claude-style hooks, terminal detection)
  server/      HTTP + SSE endpoints, auth, notification decisions
  notify/      windows.ts, macos.ts, linux.ts (one module per OS)
  cli/         start | hook | install | uninstall | notify-test
web/           Vite + React dashboard (built into dist/web and served by the server)
```

Endpoints: `GET /api/health`, `GET /api/state`, `GET /api/stream` (SSE: `snapshot`, `upsert`, `remove`),
`POST /api/events` (needs the token), `POST /api/sessions/dismiss` (dashboard's own origin or the token).

### Shared event format (the contract between adapters and core)

```ts
type AgentStatus = "idle" | "working" | "needs_input" | "done" | "error" | "ended";

interface AgentEvent {
  tool: string;        // adapter id, e.g. "claude-code", "codex", "grok"
  sessionId: string;   // from the tool if it gives one; otherwise derived from tool + cwd
  cwd: string;         // project folder (session root, not the shell's current dir); first one sticks
  status: AgentStatus; // "ended" removes the session
  message?: string;    // short, at most 200 chars, never a full prompt or transcript
  title?: string;      // task name: tool's session title, or first line of the first prompt (≤ 80 chars); first one sticks
  host?: string;       // where it runs: "VS Code", "Windows Terminal", ... ("VS Code*" enables VS Code click-through)
  inputPending?: boolean; // an unanswered async question; true survives background work, false clears it
  hidden?: boolean;    // internal helper session: suppress dashboard/notifications, including later events
  timestamp: string;   // ISO 8601, set when the hook fires; older events than a session's latest are dropped
}
```

Defined in `src/core/types.ts`. Change this format only on purpose: update every adapter and the dashboard in the
same change.

## Hard rules

1. **Never break or slow down the agent.** The `hook` command must:
   - always exit with code `0`. (In Claude Code, exit code `2` from a `Stop` hook makes Claude *keep going*.)
   - print nothing to stdout. Some tools read hook stdout as instructions.
   - finish within ~1s, even if the server is down (short request timeout, failures ignored).
   - be safe to run when the server isn't running at all.
2. **Local only.** The server listens on `127.0.0.1` only. No telemetry, no analytics, no requests to the internet,
   no auto-update calls.
3. **Treat localhost as unsafe.** Any website open in the user's browser can send requests to localhost. Require the token stored in
   the user config on every write request, check the `Host` header (blocks DNS rebinding), and check `Origin`
   on browser requests.
4. **Privacy.** Store only what the shared event format holds. Never save prompts, transcripts, file contents or
   environment variables. The one exception is `title`: at most the first line of a prompt, cut to 80 characters,
   so users can tell sessions apart. The hook drops it when the user sets `taskTitles: false`.
5. **Don't damage the user's config.** Installers that edit `~/.claude/settings.json`, `~/.codex/config.toml`,
   `~/.grok/hooks/`, etc. must: add to what's there and never overwrite it, back it up first, be safe to run twice, support `--dry-run`,
   and have an `uninstall` that removes exactly what was added.
6. **Never touch the real home directory in tests or while developing.** Point config paths at a temp folder
   (`AGENTWATCH_HOME` / a fake home directory). Don't run `install` against the developer's own agent configs unless the
   user asks in that conversation.
7. **Windows is fully supported.** Use `node:path`, never hard-coded `/`. Don't assume bash. Quote paths with spaces.
   Every feature must work on Windows, macOS and Linux, or say clearly where it doesn't.
8. **No native modules, no `postinstall` scripts.** Prefer Node built-ins. Every new runtime dependency needs a
   one-line reason in the PR.
9. **Verify each tool's hook format; don't guess.** Before writing or changing an adapter, link the tool's official
   hook docs in the adapter's `README.md` and save real payloads under `fixtures/`. If you can't verify something, say so;
   don't make it up.

## Adding support for a new AI tool

1. Create `src/adapters/<tool-id>/` with:
   - `meta.ts`: id, display name, default icon/colour/sound
   - `normalize.ts`: converts the tool's raw hook event into `AgentEvent`
   - `install.ts`: installs/uninstalls the hook (following hard rule 5)
   - `fixtures/`: real captured hook payloads and sample config files
   - `README.md`: link to the official docs, which events are supported, known gaps
2. Register it in `src/adapters/index.ts`. Core code must not import anything tool-specific.
3. Add tests: normalizing each fixture, and install/uninstall against the sample config files (installing twice must change nothing the second time).
4. Add a row to the supported-tools table in `README.md`.

## Code conventions

- TypeScript `strict`, ES modules, Node >= 22. No `any`; use `unknown` and narrow it.
- Small modules, named exports, no default exports.
- Treat external input (hook stdin, HTTP bodies, config files) as untrusted and check it.
- Tests: Vitest. Lint and format: Biome. Package manager: npm.
- Comments explain *why*, not *what*.

## Commands

```sh
npm run build       # tsc → dist/, vite → dist/web
npm test            # vitest (src/**/*.test.ts)
npm run typecheck   # server and web
npm run lint        # biome check; `npm run format` applies safe fixes
```

Before saying work is done, run all four. For a manual end-to-end check, set `AGENTWATCH_HOME` to a temp folder (and a free `port` in its config.json), run
`node dist/cli/index.js start`, and pipe a fixture into `node dist/cli/index.js hook --tool <id>`.

## Workflow

- Keep changes small and focused. Use Conventional Commit messages (`feat:`, `fix:`, `docs:`, …).
- Run tests and lint before saying work is done. If something couldn't be run, say so.
- Never commit tokens, personal paths, usernames or real captured payloads that contain private data
  (remove them from fixtures first).
- When you change behaviour, update `README.md` and the relevant adapter `README.md`.

## Known limitations (keep up to date)

- Codex: uses lifecycle hooks (not `notify`). New hooks must be trusted in Codex via `/hooks` before they run. There is no
  event for API-error stops. Desktop hooks are verified; chats loaded before installation may need an app restart.
  Async questions stay needs_input until the next user prompt; blocking questions and individual simultaneous
  questions aren't mapped. Suggested-reply helper sessions are hidden using their observed prompt prefix.
  Desktop sessions use the observed internal `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` env var for host detection;
  the dashboard and auto notification clicks open their exact chat via the documented `codex://threads/<id>` URI.
- Grok: payloads verified by capture (Grok 1.0.34): `hookEventName` is snake_case, with Claude-style duplicates, and an
  extra `stop` (reason `shutdown`) arrives after `session_end`. Permission prompts arrive as `Notification` with
  `notificationType: "permission_prompt"` (captured); idle pings ("Waiting for your next prompt") are ignored.
- No tool fires a hook on approval; the next event is `PostToolUse`, after the command finishes. For Claude Code,
  `src/server/approval-watch.ts` works around this: while a session is `needs_input`, it polls for a new child shell
  of `CLAUDE_PID` and switches the session to `working`. Codex and Grok expose no pid, so they wait for `PostToolUse`.
- Grok also runs hooks from Claude Code's settings.json. The Claude Code adapter ignores calls that have `GROK_*` env vars.
- Cloud sessions (Claude Code on the web, Codex cloud) run on remote machines and can't reach the local server.
- Plain chat apps (claude.ai, ChatGPT, Grok chat) have no hooks and are out of scope.
- Clicking a notification focuses the right VS Code window (`vscode://file/<cwd>`), but not the exact Claude tab: a toast
  can launch only one link. The dashboard's "Open in VS Code" goes to the exact Claude Code extension tab (via the
  server, see the claude-code adapter README). Focusing the exact terminal tab is not supported.
