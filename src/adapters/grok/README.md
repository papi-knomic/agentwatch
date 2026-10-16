# Grok adapter

Official hook docs: https://docs.x.ai/build/features/hooks (checked 2026-10-16, against Grok Build 1.0.34)

## Installed hooks

`agentwatch install --tool grok` writes **its own file**, `~/.grok/hooks/agentwatch.json`. Grok loads every
`*.json` in that folder, so no file belonging to the user or another tool is edited. No backup is needed, and
`uninstall` deletes the file.

| Grok event | Status | Notes |
|---|---|---|
| `SessionStart` | `idle` | |
| `UserPromptSubmit` | `working` | The first prompt's first line becomes the task title (unless `taskTitles: false`). |
| `PostToolUse`, `PostToolUseFailure` | `working` | |
| `Notification` | `needs_input` | Only for `notificationType: "permission_prompt"` (verified) and the other "a human must act" types Claude Code uses; idle pings are ignored. |
| `Stop` | `done` | Ignored when `reason` is `shutdown` (see below). |
| `StopFailure` | `error` | |
| `SessionEnd` | `ended` | |

Each hook has `"timeout": 5` (Grok's default). Grok documents no async option, so it waits for the hook, which takes
about 150 ms.

## Payload format (verified by capture, Grok 1.0.34, 2026-10-16)

The docs show camelCase fields. Captured payloads contain **both** styles:
- camelCase: `hookEventName`, `sessionId`, `cwd`, `workspaceRoot`, `timestamp`, `permissionMode`, …
- Claude-style duplicates: `hook_event_name`, `session_id`, `permission_mode`, …

The two event-name fields differ: `hookEventName` is **snake_case** (`session_start`, `user_prompt_submit`,
`post_tool_use`, `stop`), while `hook_event_name` is PascalCase (`SessionStart`). `GROK_HOOK_EVENT` is snake_case too.
The adapter converts all of these to PascalCase.

Grok sets `GROK_HOOK_EVENT`, `GROK_SESSION_ID`, `GROK_WORKSPACE_ROOT` and `GROK_HOOK_NAME` in the environment.

**Extra `stop` after shutdown:** when a session ends, Grok sends `session_end` and then another `stop` with
`reason: "shutdown"` and no `lastAssistantMessage`. A real finished turn has `reason: "end_turn"`. The shutdown stop is
ignored, so it can't bring an ended session back as "done".

Grok also runs hooks from Claude Code's `.claude/settings.json`, and its payloads carry Claude-style fields. So the
Claude Code adapter ignores any call that has `GROK_*` environment variables, which stops Grok sessions from showing up
as Claude Code.

## Fixtures

`session-start`, `user-prompt-submit`, `stop`, `stop-shutdown` and `session-end` are real captured payloads, with paths
and ids replaced. `post-tool-use` was rebuilt from the captured field list. `notification` and `stop-failure` are still
constructed: those events never fired in our captures.

## Notifications and what's still unverified

- **`Notification`, verified by capture on 2026-10-16.** A permission prompt arrives with
  `notificationType: "permission_prompt"` (also `notification_type`), `message: "Tool permission requested"` and
  `level: "info"`; see fixture `notification.json`. That's the same type value Claude Code uses, so we map on the
  type. Grok also sends an idle ping about a minute after `Stop` ("Waiting for your next prompt", fixture
  `notification-idle.json`), which is ignored. A notification without a type only counts as `needs_input` if its text
  asks for a decision.
- **`StopFailure`**: we read an `error` field if there is one (not captured yet).
- No process id reaches Grok's hooks, so after you approve a command the session stays at "needs input" until the
  command finishes (Claude Code is tracked through `CLAUDE_PID`; Grok isn't).

## Known gaps

- Project-level hooks need `/hooks-trust`. It isn't documented whether personal hooks (`~/.grok/hooks`) need trust too.
