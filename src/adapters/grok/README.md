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
| any of the above with `subagentType` | dropped, except a permission `Notification` | See "Subagents". |
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

## Subagents (unverified)

Grok's embedded docs say hooks that fire inside a subagent carry `subagentType`; the public docs page lists
`SubagentStart`/`SubagentStop` events but not that field, and we have no capture of one. We install neither
subagent event. No stable subagent id is documented (session records have a `parentSessionId`, but the hook payloads
are not known to carry it), so a subagent's events can't be attributed to one agent. The adapter therefore **drops**
every payload with `subagentType` / `subagent_type` so a subagent's `Stop` can't mark the whole session done, with one
exception: a `Notification` that needs the user stays as an unattributed wait (`agentId: "unattributed"`), cleared by
the next activity from any agent. If Grok adds an agent id to its payloads, map it to `agentId` like Claude Code.

## Answering from the dashboard

Not supported. Grok has no `PermissionRequest` event. A `PreToolUse` hook can answer `allow`, `deny`, `ask` or `defer`,
but `allow` only means "this hook does not block it": it never approves a pending permission prompt (verified against
the docs and Grok 1.0.62's embedded docs). An earlier note here said Grok hooks "can only deny"; that was out of date,
but the conclusion is the same.

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
- **`task_complete` / `idle_prompt` notification types**: other types exist (`idle_prompt`, `task_complete`), but
  `task_complete` is not documented as "turn finished" (and `Stop` already covers that), so only the types listed above
  map to `needs_input` and the rest are ignored. Revisit if a capture shows `task_complete` fires without `Stop`.
- **`StopFailure`**: we read an `error` field if there is one (not captured yet).
- No process id reaches Grok's hooks, so after you approve a command the session stays at "needs input" until the
  command finishes (Claude Code is tracked through `CLAUDE_PID`; Grok isn't).

## Known gaps

- Project-level hooks need `/hooks-trust`. It isn't documented whether personal hooks (`~/.grok/hooks`) need trust too.
