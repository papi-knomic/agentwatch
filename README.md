# AgentWatch

One local dashboard and desktop notifications for all your AI coding agents. If you run several Claude Code,
Codex or Grok sessions at once (in VS Code windows, terminals or desktop apps), you can see in one place which
ones are working, which are done, and which are **waiting on you**. You also get a notification you can customize for each tool.

- **Local only.** The server listens on `127.0.0.1`. No telemetry, no accounts, no internet requests.
- **Doesn't get in your agents' way.** Hooks run in the background, finish in about 150 ms, and quietly do nothing if the dashboard isn't running.
- **Safe with your config.** Connecting a tool adds to its config and backs it up first, and `uninstall` removes exactly what was added.
- **Private.** Code and prompts are never stored. Each session's name is the exception: Claude Code's own session title,
  or the first line of the first prompt, cut to 80 characters. Turn it off with `"taskTitles": false`.

Status: **early (0.1)**. Claude Code, Codex and Grok are supported, and their event formats were checked against real captured payloads.

## Get started

Requires Node.js 22 or newer.

```sh
npm install -g agentwatch
agentwatch setup
```

`setup` does everything in one go:
1. Connects Claude Code, Codex and Grok by adding hooks to their configs. Every edited file is backed up first.
2. Makes the dashboard start when you log in.
3. Starts the dashboard in the background and opens it at http://127.0.0.1:7878.

Then start a **new** agent session, in VS Code, a terminal or a desktop app. It shows up on the dashboard right away.
Sessions that were already open don't pick up the new hooks.

**Codex only:** open `/hooks` in Codex once and approve the new hooks. Codex skips hooks you haven't trusted.

Prefer to connect tools one at a time? Open the dashboard. The **Connect your agents** panel shows each tool's status
and lets you preview and connect it with a click. It also has the terminal command for each tool.

> Use `npm install -g`, not `npx`. Hooks store the path to the installed program, and npx runs from a temporary
> cache that npm may clear. `setup` refuses to run from there.

### Everyday commands

| Command | What it does |
|---|---|
| `agentwatch status` | What's running, whether it starts at login, which agents are connected |
| `agentwatch start --background` | Start the dashboard without a window (it also starts at login after `setup`) |
| `agentwatch stop` | Stop it |
| `agentwatch notify-test --status needs_input` | Show a sample notification |
| `agentwatch install --tool <claude-code\|codex\|grok\|all> [--dry-run]` | Connect one tool |
| `agentwatch uninstall --tool all` | Remove all hooks, start at login and the notification registration |

## Supported tools

| Tool | Installs into | Needs input | Done | Error | Notes |
|---|---|---|---|---|---|
| Claude Code | `~/.claude/settings.json` | ✅ | ✅ | ✅ | [adapter docs](src/adapters/claude-code/README.md) |
| Codex | `~/.codex/hooks.json` | ✅ (permission requests) | ✅ | ❌ no such event | Trust the hooks once via `/hooks`. [adapter docs](src/adapters/codex/README.md) |
| Grok | `~/.grok/hooks/agentwatch.json` (its own file) | ⚠️ only messages asking for a decision | ✅ | ✅ | [adapter docs](src/adapters/grok/README.md) |

Hooks are set per user, not per app, so sessions are picked up from the CLI in any terminal and from the VS Code
extensions too.

Want another tool supported? See [Adding a tool](#adding-a-tool).

## Notifications

A notification is sent when a session **moves into** one of these statuses:

| Status | When |
|---|---|
| Needs input | The agent is asking for permission or an answer. |
| Done | The agent finished its turn and is ready for a follow-up. |
| Error | The turn ended because of an API error (rate limit, billing, …). |

Clicking a notification opens the project in VS Code if the session runs there; otherwise it opens the dashboard.

On the dashboard, **Open in VS Code** brings the project's window to the front. For a session in the Claude Code
extension it then switches to that session's tab, even when several Claude tabs are open. Sessions in a standalone
terminal have no button, because a terminal tab can't be focused from outside.

On Windows, after `install`, notifications show under the app's own name and icon. Until then they show under Windows
PowerShell. If none appear, check *Settings → System → Notifications*: allow notifications for AgentWatch (or Windows
PowerShell before install) and turn off Do Not Disturb.

### Settings

Edit `~/.agentwatch/config.json` (created on first start), then restart the dashboard (`agentwatch stop`, then
`agentwatch start --background`):

```jsonc
{
  "port": 7878,
  "token": "…",                 // generated; hooks use it to authenticate
  "notifications": true,        // master switch
  "taskTitles": true,           // show each session's name
  "tools": {
    "claude-code": {
      "enabled": true,
      "label": "Claude",        // shown in notifications and on the dashboard
      "color": "#d97757",
      "sound": "im",            // default | im | mail | reminder | sms | alarm | silent
      "notifyOn": { "needs_input": true, "done": false, "error": true },
      "clickAction": "auto"     // auto | vscode | dashboard | none
    }
  }
}
```

## How it works

```
agent hook ──▶ agentwatch hook --tool <id> ──HTTP──▶ local server ──▶ dashboard (live updates over SSE)
                                                                └──▶ desktop notification
```

Each tool's hooks run a small CLI command. It converts the tool's event into one shared format and sends it to the local
server. The server tracks sessions, streams changes to the dashboard and sends notifications.

**After you approve a command.** No tool fires a hook when you approve a permission prompt. The next event arrives
only when the command *finishes*, so a long command would sit at "needs input". For Claude Code, the server watches
the agent's process while a session waits for you. When an approved command starts (as a new shell under Claude),
the session switches to "working · Running approved command", usually within a few seconds.

**Start at login** is per user and needs no admin rights:
- **Windows:** a value in `HKCU\…\Run`, launched through `conhost --headless` so no window appears.
- **macOS:** a LaunchAgent.
- **Linux:** an XDG autostart entry.

## Limitations

- Cloud sessions (Claude Code on the web, Codex cloud) run on remote machines and can't reach your local dashboard.
- Plain chat apps (claude.ai, ChatGPT, Grok chat) have no hooks.
- Notification clicks can open a VS Code window, but not a specific Claude tab or terminal tab. A notification can
  open only one link, so use the dashboard's **Open in VS Code** to get to the exact Claude tab.
- macOS and Linux notifications and start at login are implemented but not yet tested on those systems. macOS notifications can't be clicked.
- Codex and Grok don't expose their process id to hooks, so after you approve a command there, the session stays at
  "needs input" until the command finishes. The same goes for Claude Code permission prompts that don't run a shell (e.g.
  file edits), but those finish almost instantly.

## Upgrading from "orchestrator"

This project was briefly called `orchestrator`. Run `agentwatch setup` (or `agentwatch install --tool all`) once. It:
- moves `~/.orchestrator` to `~/.agentwatch`, keeping your token;
- replaces the old Grok hook file;
- re-registers Windows notifications under the new name.

## Development

```sh
git clone <this repo> agentwatch && cd agentwatch
npm install
npm run build       # server (tsc) + dashboard (vite) into dist/
npm test            # vitest
npm run typecheck
npm run lint        # biome
npm link            # optional: makes `agentwatch` run your checkout
```

Set `AGENTWATCH_HOME` to a temporary folder while developing, so your real config and sessions aren't touched.
Use `install --home <temp dir>` to test installers against a fake home directory.

## Adding a tool

Each tool is one folder in `src/adapters/`. See [AGENTS.md](AGENTS.md#adding-support-for-a-new-ai-tool) for the
checklist. In short: verify the tool's hook docs, convert its events into the shared format, add an
installer that's safe to run twice and fully reversible, and add fixtures and tests.

## License

[MIT](LICENSE)
