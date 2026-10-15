# Grok adapter

Official hook docs: https://docs.x.ai/build/features/hooks (checked 2026-10-16, against Grok Build 1.0.34)

## Installed hooks

`orchestrator install --tool grok` writes **its own file**, `~/.grok/hooks/orchestrator.json`. Grok loads every
`*.json` in that folder, so no file belonging to the user or another tool is edited. No backup is needed, and
`uninstall` deletes the file.

| Grok event | Status | Notes |
|---|---|---|
| `SessionStart` | `idle` | |
| `UserPromptSubmit` | `working` | |
| `PostToolUse`, `PostToolUseFailure` | `working` | |
| `Notification` | `needs_input` | **Unverified**, see below. |
| `Stop` | `done` | |
| `StopFailure` | `error` | |
| `SessionEnd` | `ended` | |

Each hook has `"timeout": 5` (Grok's default). Grok documents no async option, so it waits for the hook, which takes
about 150 ms.

## Payload format

Grok documents camelCase fields: `hookEventName`, `sessionId`, `cwd`, `workspaceRoot` (and `toolName`/`toolInput`
on tool events). It also sets `GROK_HOOK_EVENT`, `GROK_SESSION_ID`, `GROK_WORKSPACE_ROOT` and `GROK_HOOK_NAME` in
the environment. The adapter reads both the camelCase and Claude-style snake_case field names, and falls back to the environment variables.

Grok also runs hooks from Claude Code's `.claude/settings.json`. So the Claude Code adapter ignores any call that has
`GROK_*` environment variables, which stops Grok sessions from showing up twice (or as Claude Code).

## Unverified (help wanted)

The docs don't show per-event payloads. In particular:
- **`Notification`**: we assume it means "needs you" (like Claude Code's permission prompts) and use its `message`
  field if there is one. If Grok also sends notifications for other things, such as idle reminders, this mapping needs
  narrowing.
- **`StopFailure`**: we read an `error` field if there is one.

The files in `fixtures/` are made up from the documented fields, not captured. Replace them with real payloads when you can.

## Known gaps

- Project-level hooks need `/hooks-trust`. It isn't documented whether personal hooks (`~/.grok/hooks`) need trust too.
