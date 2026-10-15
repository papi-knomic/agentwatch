# Codex adapter

Official hook docs: https://learn.chatgpt.com/docs/hooks (moved from developers.openai.com/codex/hooks; checked 2026-10-16)

Uses Codex's lifecycle hooks (stable and on by default). The older `notify` setting is not used: it only reported
turn-complete, and hooks cover that and more.

## Installed hooks

`orchestrator install --tool codex` adds one `command` hook per event below to `~/.codex/hooks.json`
(or `$CODEX_HOME/hooks.json`), adding to anything already there. Hooks run with `"async": true`, so Codex doesn't wait for them.
`SessionEnd` always runs synchronously in Codex, so it and `Interrupt` get the documented 3-second maximum timeout.

| Codex event | Status | Notes |
|---|---|---|
| `SessionStart` | `idle` | |
| `UserPromptSubmit` | `working` | The prompt is never read or stored. |
| `PostToolUse` | `working` | Moves a session back to working after an approval. |
| `PermissionRequest` | `needs_input` | Message names the tool (e.g. "Needs permission to use shell"); the command itself is not stored. Codex has no `Notification` event. |
| `Stop` | `done` | `last_assistant_message` is never read or stored. |
| `Interrupt` | `idle` | Message "Interrupted". |
| `SessionEnd` | `ended` | |

## Trust

Codex skips hooks it hasn't been told to trust. After installing, open `/hooks` in Codex and approve the new entries.
Trust is tied to each hook's content, so if the CLI path changes (e.g. after moving the repo), `install` updates the
command and you need to approve the hooks again.

## Where the session runs (`host`)

Codex's docs list no environment variables that say which front end is running. We use the terminal env vars
(`TERM_PROGRAM`, `WT_SESSION`), then `VSCODE_PID` → "VS Code" for sessions started by the VS Code extension.
This is a guess that hasn't been checked against real sessions yet.

## Fixtures

Written from the field lists in the official docs (common fields + per-event fields). Replace them with real captured
payloads when you can, removing anything private first.

## Known gaps

- Not verified: whether the Codex desktop app runs hooks from `~/.codex/hooks.json`.
- No error status: Codex has no event for a turn that fails with an API error.
