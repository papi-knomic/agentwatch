# Codex adapter

Official hook docs: https://learn.chatgpt.com/docs/hooks (moved from developers.openai.com/codex/hooks; checked 2026-10-16)

Uses Codex's lifecycle hooks (stable and on by default). The older `notify` setting is not used: it only reported
turn-complete, and hooks cover that and more.

## Installed hooks

`agentwatch install --tool codex` adds one `command` hook per event below to `~/.codex/hooks.json`
(or `$CODEX_HOME/hooks.json`), adding to anything already there. Hooks run with `"async": true`, so Codex doesn't wait for them.
`SessionEnd` always runs synchronously in Codex, so it and `Interrupt` get the documented 3-second maximum timeout.

| Codex event | Status | Notes |
|---|---|---|
| `SessionStart` | `idle` | |
| `UserPromptSubmit` | `working` | Clears a pending async question. Only the first prompt line can become a title; full prompts are never stored. |
| `PostToolUse` | `working` / `needs_input` | `request_user_input_async` marks a question as pending. Other tools return to working after an approval, but don't clear an outstanding question. |
| `PermissionRequest` | `needs_input` | Message names the tool (e.g. "Needs permission to use shell"); the command itself is not stored. Codex has no `Notification` event. |
| `Stop` | `done` | `last_assistant_message` is never read or stored. |
| `Interrupt` | `idle` | Message "Interrupted". |
| `SessionEnd` | `ended` | |

## Trust

Codex skips hooks it hasn't been told to trust. After installing, run `/hooks` in the Codex CLI and approve the new entries.
Trust is tied to each hook's content, so if the CLI path changes (e.g. after moving the repo), `install` updates the
command and you need to approve the hooks again.

For a desktop chat that was already loaded before installation, fully quit and reopen Codex, then resume it.
Another prompt in an already loaded chat may still use its original hook configuration. The setup panel's
**Hooks installed** checks the hook file, not the per-chat runtime or trust state.

## Desktop helper sessions and questions

The desktop app starts separate sessions for suggested replies. A `UserPromptSubmit` whose prompt begins
with `This is an app-generated request for a suggested next user message` (optionally bold) marks that
session as hidden. This exact marker was reported by the user; it isn't a documented hook field. We don't
infer internal activity from arbitrary mentions of suggestions. The marker prompt isn't used as a title.
An idle card may briefly appear before that prompt arrives; subsequent tool/stop events remain hidden,
including across server restarts, and never produce completion notifications. Hidden records expire with
the normal stale-session cleanup. Established tasks with an existing title aren't hidden if a user quotes
the marker. With task titles disabled, or if the marker is the very first user prompt, that distinction
isn't available; the prefix remains a best-effort filter.

`request_user_input_async` was captured as a desktop `PostToolUse` event on 2026-10-16. It maps to
`needs_input` with `inputPending: true`. Background tools and `Stop` preserve that state; the next
`UserPromptSubmit` clears it. Only status flags and the fixed message "Waiting for your answer" are kept,
not the question or its choices. This currently covers async questions; blocking question tools have not
been captured or mapped yet.

## Where the session runs (`host`)

The desktop app sets `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=Codex Desktop` in observed local sessions. We use
that exact value first, ahead of terminal variables inherited when launching the app. This variable is
internal, not a documented API. Otherwise we use terminal env vars (`TERM_PROGRAM`, `WT_SESSION`), then
`VSCODE_PID` → "VS Code"; this fallback is a heuristic.

## Opening a desktop chat

Official deep-link reference: https://learn.chatgpt.com/docs/reference/commands#deep-links (checked 2026-10-16).

For sessions identified as **Codex Desktop**, the dashboard's **Open in Codex** button launches the documented
`codex://threads/<thread-id>` link through the OS protocol handler. The id comes from the hook's `session_id`
and is encoded as one path segment. Windows, macOS and Linux use the same URI; the desktop app must be
installed and registered as its handler. Native opening hasn't been manually verified on macOS or Linux.

Notifications with `clickAction: "auto"` also open that exact chat and offer an **Open dashboard** action.
Explicit `dashboard`, `vscode` and `none` settings keep their behavior. CLI and VS Code sessions aren't
opened in the desktop app; sessions whose front end can't be identified retain the dashboard fallback.

## Fixtures

Verified by capture with `codex-cli 0.162.0-alpha` (bundled with the VS Code extension) on 2026-10-16. Payloads match
the docs exactly: snake_case fields, PascalCase `hook_event_name`. `session-start`, `user-prompt-submit`,
`post-tool-use`, `stop` and `session-end` are real captured payloads, with paths and ids replaced.
`permission-request` and `interrupt` are still built from the docs: `codex exec` doesn't ask for approval, and we
didn't interrupt.
`question-async` is a sanitized extract captured from the desktop app's `PostToolUse` event
(`codex-cli 0.162.0-alpha.17.2`); tool inputs and responses were omitted.

The user's first prompt becomes the session's task title (unless `taskTitles: false`).

## Known gaps

- Desktop lifecycle hooks verified by live capture. Chats already loaded before hookup may need an app restart.
- A pending question clears on the next user prompt; multiple simultaneous questions aren't tracked individually.
- No error status: Codex has no event for a turn that fails with an API error.
