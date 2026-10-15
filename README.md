# orchestrator

> Working name. It will be renamed before the first release.

One local dashboard and desktop notifications for all your AI coding agents. If you run several Claude Code,
Codex or Grok sessions at once (in VS Code windows, terminals or desktop apps), you can see in one place which
ones are working, which are done, and which are **waiting on you**. You also get a notification you can customize for each tool.

- **Local only.** The server listens on `127.0.0.1`. No telemetry, no accounts, no internet requests.
- **Doesn't get in your agents' way.** Hooks run in the background, finish in about 150 ms, and quietly do nothing if the dashboard isn't running.
- **Safe with your config.** `install` adds to your agent's config and backs it up first, and `uninstall` removes exactly what it added.
- **Private.** Prompts, transcripts and code are never read or stored, only the tool, status, project folder and a short message.

Status: **pre-alpha**. Claude Code works; Codex and Grok are next.

## Supported tools

| Tool | Works in | Needs input | Done | Error | Notes |
|---|---|---|---|---|---|
| Claude Code | CLI (any terminal), VS Code extension | ✅ | ✅ | ✅ | [adapter docs](src/adapters/claude-code/README.md) |
| Codex | | | | | Planned. The `notify` hook only reports turn-complete. |
| Grok | | | | | Planned (`~/.grok/hooks`). |

Want another tool supported? See [Adding a tool](#adding-a-tool).

## Quick start

Requires Node.js 22 or newer.

```sh
git clone <this repo> orchestrator
cd orchestrator
npm install
npm run build

node dist/cli/index.js start --open                    # dashboard at http://127.0.0.1:7878
node dist/cli/index.js install --tool claude-code --dry-run   # preview the change to ~/.claude/settings.json
node dist/cli/index.js install --tool claude-code             # apply it (a backup is written next to the file)
```

Then start a **new** Claude Code session anywhere. Sessions appear on the dashboard as soon as they start.

Optionally run `npm link` once so you can type `orchestrator` instead of `node dist/cli/index.js`.

To remove the hooks again: `node dist/cli/index.js uninstall --tool claude-code`.

## Notifications

A notification is sent when a session **moves into** one of these statuses:

| Status | When |
|---|---|
| Needs input | The agent is asking for permission or an answer. |
| Done | The agent finished its turn and is ready for a follow-up. |
| Error | The turn ended because of an API error (rate limit, billing, …). |

Clicking a notification opens the project in VS Code if the session runs there; otherwise it opens the dashboard.
Run `node dist/cli/index.js notify-test --status needs_input` to see one.

On Windows, notifications are shown under **Windows PowerShell** for now. If none appear, check
*Settings → System → Notifications* and make sure notifications from Windows PowerShell are allowed and Do Not Disturb is off.

### Per-tool settings

Edit `~/.orchestrator/config.json` (created on first start), then restart the server:

```jsonc
{
  "port": 7878,
  "token": "…",                 // generated; hooks use it to authenticate
  "notifications": true,        // master switch
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
agent hook ──▶ orchestrator hook --tool <id> ──HTTP──▶ local server ──▶ dashboard (live updates over SSE)
                                                                  └──▶ desktop notification
```

Each tool's hooks run a small CLI command. It converts the tool's event into one shared format and sends it to the local
server. The server tracks sessions, streams changes to the dashboard and sends notifications.

## Limitations

- Cloud sessions (Claude Code on the web, Codex cloud) run on remote machines and can't reach your local dashboard.
- Plain chat apps (claude.ai, ChatGPT, Grok chat) have no hooks.
- Notification clicks can open a VS Code window, but not a specific terminal tab.
- macOS and Linux notifications are implemented but not yet tested. macOS notifications can't be clicked.

## Development

```sh
npm run build       # server (tsc) + dashboard (vite) into dist/
npm test            # vitest
npm run typecheck
npm run lint        # biome
```

Set `ORCHESTRATOR_HOME` to a temporary folder while developing, so your real config and sessions aren't touched.
Use `install --home <temp dir>` to test installers against a fake home directory.

## Adding a tool

Each tool is one folder in `src/adapters/`. See [AGENTS.md](AGENTS.md#adding-support-for-a-new-ai-tool) for the
checklist. In short: verify the tool's hook docs, convert its events into the shared format, add an
installer that's safe to run twice and fully reversible, and add fixtures and tests.

## License

[MIT](LICENSE)
