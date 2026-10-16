# Claude Code adapter

Official hook docs: https://code.claude.com/docs/en/hooks (checked 2026-10-16)

Covers Claude Code anywhere it runs locally: the CLI in any terminal, the VS Code extension, and other local
front ends that read `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`).

## Installed hooks

`agentwatch install --tool claude-code` adds one `command` hook per event below to the user's `settings.json`, with
`"async": true` so Claude Code runs it in the background and never waits on it.

| Claude Code event | Status | Notes |
|---|---|---|
| `SessionStart` | `idle` | |
| `UserPromptSubmit` | `working` | The prompt text is never read or stored. |
| `PostToolUse`, `PostToolUseFailure` | `working` | Moves a session back to working after a permission prompt is answered. |
| `Notification` | `needs_input` | Only for `notification_type` `permission_prompt`, `elicitation_dialog`, `elicitation_url_dialog`, `agent_needs_input`. Everything else (e.g. `idle_prompt`) is ignored. |
| `Stop` | `done` | `last_assistant_message` is never read or stored. |
| `StopFailure` | `error` | Message is the error type and details, e.g. `rate_limit: 429 Too Many Requests`. |
| `SessionEnd` | `ended` | Removes the session from the dashboard. |

Our entries are identified by the `hook --tool claude-code` part of the command, so `uninstall` removes exactly those
and leaves the rest of the file alone.

## Where the session runs (`host`)

From `CLAUDE_CODE_ENTRYPOINT`: `claude-vscode` → "VS Code" (verified), `cli` → the terminal detected from
`TERM_PROGRAM` / `WT_SESSION`. Other values are passed through as-is until we've verified what they mean.

## Task title

The dashboard shows the same session name as VS Code's tab and Claude Code's session list. These sources are
checked in order:

1. `session_title`, a name the user set with `/rename` or `--name`. The hook docs only include it on
   `SessionStart`.
2. The generated title. Claude Code writes it to the transcript as `{"type":"ai-title","aiTitle":"…","sessionId":"…"}`
   and appends it again as the session goes on. On every event except `SessionEnd`, the hook reads the last 256 KB of
   `transcript_path` (about 3 ms on a 4.7 MB transcript) and takes the newest `aiTitle`. Every other line is
   discarded without being parsed or stored.
3. Until a title has been generated: the first line of the prompt, with IDE context such as
   `<ide_opened_file>…</ide_opened_file>` removed.

Titles from 1 and 2 are sent with `titleSource: "tool"`. They replace a prompt title and follow later changes,
such as a new title after a plan is accepted.

Not verified by docs: the transcript format is internal. The [sessions docs](https://code.claude.com/docs/en/sessions)
say it "changes between versions", so this may stop working after a Claude Code update. It was checked against
real transcripts from VS Code extension 2.1.300 on 2026-10-16. If it breaks, the dashboard falls back to the prompt
title. Also not verified: how a `/rename` mid-session is stored in the transcript. Until the session is resumed, the
generated title may still show.

## Project folder (`cwd`)

The hook payload's `cwd` is the "current working directory when the hook is invoked", so it follows Claude's `cd`
into a subfolder. The adapter uses `CLAUDE_PROJECT_DIR` instead ("the project root where the session started",
exported to command hooks; [docs](https://code.claude.com/docs/en/hooks), checked 2026-10-16) and falls back to the
payload's `cwd`. Opening a subfolder via `vscode://file/...` replaces the focused window's workspace and kills the
running session.

## Opening a session

For "VS Code" sessions, the dashboard's **Open in VS Code** opens `vscode://file/<cwd>` to bring the project's window to
the front. After 0.7s it opens `vscode://anthropic.claude-code/open?session=<session_id>`, the extension's URI handler
([docs](https://code.claude.com/docs/en/vs-code#launch-a-vs-code-tab-from-other-tools), checked 2026-10-16). That link
focuses the session's tab if it is open and resumes the session otherwise.

The order matters. VS Code hands the link to whichever window has focus, and the docs say the session must belong to
that window's workspace, or a fresh conversation starts instead. Notifications can only launch one link, so a
notification click only does the first step.

CLI sessions (including the CLI in VS Code's terminal) get no session link. Opening it would resume the conversation a
second time in an extension tab.

## Fixtures

The files in `fixtures/` were written from the JSON examples in the official docs, with paths changed to Windows
style. `session-start.json` and `session-end.json` contain only the documented common fields plus `source` /
`reason`, because the docs page didn't show full examples for them. Replace these with real captured payloads when
you can (remove anything private first).

## Known gaps

- Older Claude Code versions don't send `notification_type`. As a fallback, a notification whose message mentions
  "permission" counts as `needs_input`.
- Not verified: whether the Claude desktop app's Code tab runs hooks from `~/.claude/settings.json`.
