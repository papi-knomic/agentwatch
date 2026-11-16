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
| `PermissionRequest` | `needs_input` | Says which agent is asking (`agent_id`, present only inside subagents). Only the tool's name is read, never the input. A `Notification` for the same prompt within 5 s is then ignored. |
| `SubagentStop` | `done` + `agentId` | Clears only that subagent; the session itself doesn't change. |
| `Notification` | `needs_input` | Only for `notification_type` `permission_prompt`, `elicitation_dialog`, `elicitation_url_dialog`, `agent_needs_input`. Everything else (e.g. `idle_prompt`) is ignored. |
| `Stop` | `done` | `last_assistant_message` is never read or stored. |
| `StopFailure` | `error` | Message is the error type and details, e.g. `rate_limit: 429 Too Many Requests`. |
| `SessionEnd` | `ended` | Removes the session from the dashboard. |

Our entries are identified by the `hook --tool claude-code` part of the command, so `uninstall` removes exactly those
and leaves the rest of the file alone. `PermissionRequest` and `SubagentStop` were added after 0.1.4: re-run
`agentwatch install --tool claude-code` once to get them (it only adds what is missing). Without them everything still
works, but a permission wait can't be told apart per agent.

### Subagents

All agents of one task share `session_id`. Payloads of events fired inside a subagent carry `agent_id` (e.g.
`a0dcb4961017438ab`) and `agent_type` (e.g. `general-purpose`); the main agent's carry neither (hooks docs "Common input
fields"; verified by capture with Claude Code 2.1.301 in VS Code, fixtures `subagent-permission-request.json`,
`subagent-post-tool-use.json`, `subagent-stop.json`, derived from it). `PermissionRequest` has no `tool_use_id`. We keep
pending input per agent: the session stays `needs_input` while any agent waits, one agent's activity clears only that
agent, `SubagentStop`, a main-agent `Stop` or a new prompt clear as described in AGENTS.md. Not verified: whether
`Notification` carries `agent_id` (if not, it is treated as "unattributed" and any activity clears it), `AskUserQuestion`
asked from a subagent, and `PermissionRequest` from subagents in the interactive terminal UI.

## Answering from the dashboard (opt-in `decide` hooks)

`agentwatch install --tool claude-code --remote-actions` (or the dashboard's **Answer prompts from here** switch) adds
two more hooks. They run `agentwatch decide --tool claude-code`, are not async, and have `"timeout": 600` (`PermissionRequest`, the documented default) or `120` (`PreToolUse`) seconds. Reinstalling updates our own older 120 s entry in place and touches nothing else:

| Event | Matcher | Used for |
|---|---|---|
| `PermissionRequest` | `*` | Approve or deny a permission prompt. `AskUserQuestion` is answered here only in VS Code / Claude Desktop (concurrent), and skipped in the terminal. |
| `PreToolUse` | `AskUserQuestion` | Answer Claude's multiple-choice questions in the terminal. In VS Code / Claude Desktop it returns at once (no card, no wait) so the host's own question UI shows immediately. |

Our entries are identified by `decide --tool claude-code`; `uninstall` removes them with the others, and
`--no-remote-actions` removes only them. They do nothing unless `remoteActions` is `true` in the config.

Output (stdout, exit 0), from the [hooks docs](https://code.claude.com/docs/en/hooks):

- Allow: `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedInput":<the original tool_input>}}}`.
  `updatedInput` replaces the whole input and `ExitPlanMode` needs it, so the original is always echoed back.
- Deny: `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"deny","message":"…"}}}`.
- Plan (`ExitPlanMode`, same `PermissionRequest` hook; verified working by the maintainer's own use): registered as its own
  `plan` kind with `tool_input.plan` (first 4000 chars, memory only). Approve = the allow output above (original
  `tool_input` echoed). "Keep planning" = the deny output, with `message` set to the user's feedback (≤1000 chars) or
  "The user wants to keep planning.". The docs say `message` "tells Claude why the permission was denied"; what
  Claude does after it (stay in plan mode) was not captured. `-p` runs don't offer ExitPlanMode without a permission
  host, so a headless capture of the payload was not possible.
- Question: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","updatedInput":{"questions":<original>,"answers":{"<question text>":"<option label>"}}}}`.
  Multi-select labels are joined with ", " (docs: "joined with commas"). A label that itself contains a comma would be
  ambiguous, so such multi-select questions are not offered (no remote answer; Claude asks as usual).
- Question in VS Code / Claude Desktop (via `PermissionRequest`; the docs require `updatedInput` on allow for AskUserQuestion): `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow","updatedInput":{"questions":<original>,"answers":{...}}}}}`, same `answers` shape. **Unverified until confirmed live**; fixture `permission-request-ask-user-question.json` is derived from the documented schema, not captured. The terminal is unchanged.
- Anything else (no dashboard open, server down, setting off, timeout, answered in the terminal): no output, exit 0,
  so Claude Code carries on normally.

**Waiting replaces the terminal prompt.** `PreToolUse` runs before the tool, so Claude Code's own question UI does not
appear until `decide` returns: while a visible dashboard tab is open, the question waits for the dashboard (it is NOT
shown in the terminal meanwhile) for up to about 100 s. If the dashboard is open but only in the background (Chrome
reports a covered or minimized window as hidden too), the config key `remoteActionsBackgroundHold` (Settings,
Answering tab) decides: `full` (default) keeps the full 100 s, `short` holds 15 s and then Claude Code asks in the
terminal (a tab becoming visible extends the hold), `off` only holds while a tab is visible and hands the prompt
back about 2 s after the last visible tab hides. The dashboard's "Waiting for you" area, tab title, favicon badge and
optional browser notification are there to pull you over. With no dashboard connected, no wait at all, in every mode. `PermissionRequest` may behave the same; that is not verified (third-party reports say the dialog stays, but
don't rely on it). The dashboard reports `document.visibilityState` to `POST /api/presence`; an open event stream is
what counts as connected. Not supported through hooks: sending new prompts or starting plans (only Claude Code Channels,
a research preview, can do that). Free-text "Other" answers aren't offered. Codex's `PermissionRequest` uses the same
format (future work); Grok hooks can only deny, so Grok is unsupported.

Cancel rules. A blocking decision (terminal CLI, every question) is never cancelled by session events: while `decide`
waits, Claude Code shows no prompt of its own, so nothing else can have answered it, and events from other agents,
the main agent, Notification hooks or the approval watcher are about something else. It ends only by an answer, its
`decide` wait detaching (Esc or an interrupt in Claude Code kills the hook; the card is withdrawn after about 3 s),
session end, expiry, or the viewer rules above. `src/server/approval-watch.ts` also skips sessions with a pending
blocking decision and ignores shells whose command line is our own `hook --tool` / `decide --tool`. Concurrent
decisions (VS Code, Claude app) keep the event rule: a newer non-`needs_input` event from the same agent (more than
1.5 s after the request, by event time), or the main agent's turn ending, withdraws the card, since the user may have
answered in the host; that is fail-safe and can withdraw a card for unrelated activity of that agent. If the regular
hook hasn't told the server about the session yet, `decide` retries registration once after 300 ms. The terminal prompt
is unaffected; only the dashboard card is lost. `agentwatch debug decisions` records which rule ended each decision
(`resolved_allow`, `orphan`, `session_end`, `expired_full`, `no_viewer_cancel`, `hidden_cancel`,
`cancelled_by_agent_event`, ...).

**Concurrent hosts (VS Code extension, Claude desktop app).** Docs (https://code.claude.com/docs/en/hooks, PermissionRequest):
"For a call that reaches a `--permission-prompt-tool` or the Agent SDK's `canUseTool` callback, the hooks run alongside
your host, and whichever decides first applies." That these two hosts use that path is **inferred, not verified**; the
trigger is the same `CLAUDE_CODE_ENTRYPOINT` detection as `host` (`claude-vscode`, `claude-desktop`,
`claude-desktop-3p`). For their `PermissionRequest` calls (kinds permission and plan) `decide` sends `concurrent: true`:
the server registers the decision even with no dashboard open, holds it up to 540 s (`CONCURRENT_TTL_MS`) regardless of tab
visibility (no short hold, no no-viewer cancel), and `decide` waits up to 560 s. It still ends on the cancel rules above and
when `decide`'s wait connection drops (the host may kill the hook when you answer in its own UI; an orphan timer then clears
the card within about 3 s). In those hosts an `AskUserQuestion` is a concurrent `question` decision from `PermissionRequest` (the host routes it through its permission UI; inferred, not verified), with the same hold, cancel and orphan rules; `PreToolUse` `AskUserQuestion` returns nothing there. In the terminal, `PreToolUse` `AskUserQuestion` stays blocking and `PermissionRequest` for it is skipped.

**Diagnostics.** The server keeps the last 50 decision attempts in memory (`GET /api/debug/decisions`, this computer only;
`agentwatch debug decisions`): time, tool, hashed session, kind, tool name, subagent yes/no, concurrent or blocking,
outcome (`registered`, `no_viewer`, `unknown_session`, `cap`, `invalid`, `skipped` with a fixed reason such as `question-handled-by-permission-request` or `cli-permission-request-question`) and end reason. Skips are reported by `decide` with one awaited POST capped at 300 ms (a refused connection returns at once), only when remote actions are on. No previews, commands, questions or plans.

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

## Claude desktop app

Code-tab sessions in the Claude desktop app run the CLI with `CLAUDE_CODE_ENTRYPOINT=claude-desktop`
(`claude-desktop-3p` in third-party-provider builds), and load user-level hooks, so ours fire. The host is shown as
"Claude Desktop". Observed in the installed Windows app (5.1231.0.0) by reading its bundle; not documented by Anthropic.

The dashboard's **Open in Claude** (and `clickAction: "auto"` notifications) open
`claude://code/continue?session=<local id>&source=agentwatch`, a deep link of the app's protocol handler. These routes
are undocumented and may change between app versions; the app ignores them when you are logged out or deep links are
disabled by policy. The link needs the app's own `local_...` id, which is not the hook's `session_id`. The server finds
it by reading (read-only) the app's per-session records, `%LOCALAPPDATA%\Claude-Data\claude_*\claude-code-sessions\**\local_*.json`
(at most 3 levels deep and 500 files), matching `cliSessionId` or `lastAssistantCliSessionId` to the hook's session id.
It keeps only the id (checked against `^local_[A-Za-z0-9-]{1,64}$`); titles, prompts and paths in those files are
never stored or logged. If no record matches there is no link (we do not fall back to `session=last`, which could open a
different chat): the dashboard says it can't open the session and notifications open the dashboard.

Unverified: the record location for non-MSIX Windows installs, macOS (a `~/Library/Application Support/Claude-Data`
guess is probed) and Linux; whether `cliSessionId` changes on resume.

## Fixtures

The files in `fixtures/` were written from the JSON examples in the official docs, with paths changed to Windows
style. `permission-request.json`, `permission-request-ask-user-question.json` and `pre-tool-use-ask-user-question.json` are likewise built from the documented
input fields, **not captured** from a real session. `session-start.json` and `session-end.json` contain only the documented common fields plus `source` /
`reason`, because the docs page didn't show full examples for them. Replace these with real captured payloads when
you can (remove anything private first).

## Known gaps

- Older Claude Code versions don't send `notification_type`. As a fallback, a notification whose message mentions
  "permission" counts as `needs_input`.
- Not verified: whether the Claude desktop app's Code tab runs hooks from `~/.claude/settings.json`.
