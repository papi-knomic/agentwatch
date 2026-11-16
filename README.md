# AgentWatch

One local dashboard and desktop notifications for all your AI coding agents. If you run several Claude Code,
Codex, Grok or OpenCode sessions at once (in VS Code windows, terminals or desktop apps), you can see in one place which
ones are working, which are done, and which are **waiting on you**. You also get a notification you can customize for each tool.

- **Local only.** The server listens on `127.0.0.1`. No telemetry, no accounts, no internet requests.
- **Doesn't get in your agents' way.** Hooks run in the background, finish in about 150 ms, and quietly do nothing if the dashboard isn't running.
- **Safe with your config.** Connecting a tool adds to its config and backs it up first, and `uninstall` removes exactly what was added.
- **Private.** Code and prompts are never stored. Each session's name is the exception: Claude Code's own session title,
  or the first line of the first prompt, cut to 80 characters. Turn it off with `"taskTitles": false`.

Status: **early (0.1)**. Claude Code, Codex, Grok and OpenCode are supported, and their event formats were checked against real captured payloads.

## Get started

Requires Node.js 22 or newer.

```sh
npm install -g @kn0mic/agentwatch
agentwatch setup
```

`setup` does everything in one go:
1. Connects Claude Code, Codex, Grok and OpenCode by adding hooks (for OpenCode, a plugin file) to their configs.
   Every edited file is backed up first.
2. Makes the dashboard start when you log in.
3. Starts the dashboard in the background and opens it at http://127.0.0.1:7878.

Then start a **new** agent session, in VS Code, a terminal or a desktop app. It shows up on the dashboard right away.
Sessions that were already open don't pick up the new hooks.

What else each tool needs:
- **Claude Code:** nothing. Start a new session.
- **Grok:** nothing. Its personal hooks folder (`~/.grok/hooks`) needs no trust step.
- **OpenCode:** restart it. It loads plugins only when it starts.
- **Codex:** approve the new hooks once. Codex skips hooks you haven't trusted. Run `/hooks` in the Codex CLI and
  approve them. No `codex` command on your PATH? The VS Code extension ships the CLI at
  `~/.vscode/extensions/openai.chatgpt-<version>/bin/<platform>/codex` (`codex.exe` on Windows); start it in a
  terminal and run `/hooks` there. For desktop chats that were already open, fully quit and reopen Codex, then
  resume the chat and send a prompt; an already loaded chat may keep its old hook configuration. The dashboard's
  **Hooks installed** confirms the config file is in place, not that every open chat has loaded or trusted it.

### Check it works

```sh
agentwatch status                              # dashboard running? each tool "connected"?
agentwatch notify-test --status needs_input    # you should see a desktop notification
```

Then send a prompt in a new Claude Code, Codex, Grok or OpenCode session: its row appears on the dashboard within a second.
If it doesn't, see [Troubleshooting](#troubleshooting).

Prefer to connect tools one at a time? Open the dashboard and click the gear (**Settings** > **Agents**). It shows each tool's status
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
| `agentwatch notify-test --phone` | Send a test push to your phone (after turning on phone notifications) |
| `agentwatch install --tool <claude-code\|codex\|grok\|opencode\|all> [--dry-run]` | Connect one tool |
| `agentwatch install --tool claude-code --remote-actions` | Also let the dashboard answer Claude Code permission prompts and questions (opt-in, see below) |
| `agentwatch uninstall --tool all` | Remove all hooks, start at login and the notification registration |

### Updating

```sh
npm install -g @kn0mic/agentwatch@latest
agentwatch stop
agentwatch start --background
```

The hooks pick up the new version immediately. The running dashboard keeps the old code until you restart it.
If release notes mention new hooks, run `agentwatch install --tool all` again (and, for Codex, approve them in
`/hooks` again).

## Supported tools

| Tool | Installs into | Needs input | Done | Error | Notes |
|---|---|---|---|---|---|
| Claude Code | `~/.claude/settings.json` | ✅ | ✅ | ✅ | Subagents tracked separately. Can answer from the dashboard (opt-in). [adapter docs](src/adapters/claude-code/README.md) |
| Codex | `~/.codex/hooks.json` | ✅ (permissions and async questions) | ✅ | ❌ no such event | Trust the hooks once via `/hooks`. Subagents tracked separately. Can answer permissions from the dashboard (opt-in). [adapter docs](src/adapters/codex/README.md) |
| Grok | `~/.grok/hooks/agentwatch.json` (its own file) | ⚠️ only messages asking for a decision | ✅ | ✅ | Subagent events are ignored so they can't finish the parent session. Cannot answer from the dashboard (hooks can't approve a prompt). [adapter docs](src/adapters/grok/README.md) |
| OpenCode | `~/.config/opencode/plugins/agentwatch.js` (its own plugin) | ✅ (permissions and questions) | ✅ | ✅ | OpenCode 1.x and 2.x, one plugin for both. Restart OpenCode after installing. Works with any model provider. Two subagents asking at once are tracked separately. [adapter docs](src/adapters/opencode/README.md) |

Hooks are set per user, not per app, so sessions are picked up from the CLI in any terminal and from the VS Code
extensions too.

Codex desktop's suggested-reply helper sessions are hidden after their app-generated prompt is identified.
Async questions stay under **needs you** while the agent does other work, until your next reply.
Desktop sessions also get **Open in Codex**, which opens the exact local chat. With `clickAction: "auto"`,
their notifications open that chat too; an **Open dashboard** action remains available.

Want another tool supported? See [Adding a tool](#adding-a-tool).

## Notifications

A notification is sent when a session **moves into** one of these statuses:

| Status | When |
|---|---|
| Needs input | The agent is asking for permission or an answer. |
| Done | The agent finished its turn and is ready for a follow-up. |
| Error | The turn ended because of an API error (rate limit, billing, …). |

Clicking a notification opens the project in VS Code if the session runs there; otherwise it opens the dashboard.

When sessions from more than one agent are on the dashboard, each row shows its agent with a square swatch in that
agent's colour, and buttons at the top filter the board to one agent. The filter is remembered in your browser.
The top bar and the tab title still count every agent, and a note says when another agent's session needs you.

On the dashboard, **Open in VS Code** brings the project's window to the front. For a session in the Claude Code
extension it then switches to that session's tab, even when several Claude tabs are open. Sessions in a standalone
terminal have no button, because a terminal tab can't be focused from outside.

On Windows, after `install`, notifications show under the app's own name and icon. Until then they show under Windows
PowerShell. If none appear, check *Settings → System → Notifications*: allow notifications for AgentWatch (or Windows
PowerShell before install) and turn off Do Not Disturb.

### Answer prompts from the dashboard (Claude Code, Codex and OpenCode, opt-in)

Off by default. When on, a Claude Code or Codex permission request (for example "allow this Bash command?") or a
question from Claude Code shows up on its session card with **Approve** / **Deny** buttons or the question's options,
so you can answer without switching windows. Codex has no hook for questions or plans, so for Codex only permission
requests can be answered. Turning it on adds, per connected tool, a hook that waits for your answer: for Codex one
extra synchronous `PermissionRequest` entry (timeout 600 s) next to the existing async one, which you have to approve
once via `/hooks` in Codex like the others. Re-run `agentwatch install --remote-actions` to add it to Codex.

For OpenCode (permissions and, on 1.x, questions with listed options), run `agentwatch install --tool opencode --remote-actions`
and restart OpenCode: the plugin then starts a small waiting process for each prompt. OpenCode keeps showing its own prompt,
and whichever answer comes first wins. Approve means "once" (never "always"). Details and what is unverified: the
[OpenCode adapter docs](src/adapters/opencode/README.md).

Turn it on from the dashboard (**Settings** > **Answering** > **Turn on**, which shows exactly what it will
add first) or from a terminal:

```sh
agentwatch install --tool claude-code --remote-actions     # or: agentwatch setup --remote-actions
agentwatch install --tool claude-code --no-remote-actions  # turn it off again (uninstall turns it off too)
```

This adds two hooks to `~/.claude/settings.json` (backed up first, removed by `uninstall`; besides the status hooks that
every install adds): `PermissionRequest` (matcher `*`) and `PreToolUse` (matcher `AskUserQuestion`), both running `agentwatch decide --tool claude-code` (timeout 600 seconds for `PermissionRequest`, 120 for `PreToolUse`; re-run `agentwatch install --tool claude-code --remote-actions` once to upgrade an older 120 second entry in place), and sets `"remoteActions": true` in `~/.agentwatch/config.json`. Start a new Claude Code session
afterwards.

How it behaves:

- It only waits while a dashboard tab is open. With no tab open, the server down or the setting off, the hook exits
  silently at once and Claude Code asks you as usual.
- **While a visible tab is open, Claude Code's question waits for the dashboard: it is not shown in the terminal
  meanwhile.** (The hook runs before Claude Code's own question UI.) That lasts until you answer, for up to about
  100 seconds. A tab that is open but hidden (behind another window, minimized, or in a background tab; Chrome treats
  all of those as hidden) is handled by a setting in Settings, Answering tab, "When the dashboard is open in the
  background, terminal prompts": **wait for the dashboard** (the default: the full 100 seconds, the terminal shows
  nothing until then), **wait briefly** (about 15 seconds, then the terminal; bringing the tab forward restores the
  full wait) or **go straight to the terminal** (only a visible tab holds a prompt; hide the last visible tab and
  the terminal prompt appears after about 2 seconds). It is the `remoteActionsBackgroundHold` key in
  `config.json` (`full`, `short`, `off`) and applies without a restart. With no dashboard tab open at all
  the terminal asks as usual, in every mode.
  Permission prompts in the terminal may behave the same way; that is not verified.
- **VS Code extension and Claude desktop app:** these show their own Approve/Deny UI. The docs say hooks for such a
  call "run alongside your host, and whichever decides first applies" (that these hosts take that path is inferred,
  not verified), so a permission or plan prompt from them shows in both places and the first answer wins. Nothing is
  held back there: the card is registered even with no dashboard tab open (it appears when you open one) and stays
  for up to about 9 minutes, whether or not the tab is visible. The terminal CLI and every question keep the rules above.
- Not seeing a card? `agentwatch debug decisions` prints the last 50 attempts (time, tool, hashed session, kind, tool
  name, main or subagent, concurrent or blocking, outcome such as `registered` / `no_viewer` / `unknown_session`, and how
  it ended). It never includes commands, questions or plans. Same data at `GET /api/debug/decisions` (this computer only).
- A pinned **Waiting for you** area at the top of the dashboard shows every pending prompt, whatever the agent filter or
  collapsed folders. The tab title and icon show how many are waiting. Click **Enable browser alerts** there (once; it
  asks the browser for permission) to also get a browser notification when one arrives while the tab is hidden; it
  names only the agent and project, never the command.
- With subagents, the card says which one is asking. While the hook waits for a terminal prompt, nothing else can
  answer it, so no activity from any agent clears the card; it ends when you answer, when the hook goes away (for
  example you press Esc in Claude Code), when the session ends or when time runs out. `agentwatch debug decisions`
  shows which of these ended each one.
  For that, run `agentwatch install --tool claude-code` once more: it adds the `PermissionRequest` and `SubagentStop`
  status hooks (nothing else changes).
- VS Code and the Claude app show their own prompt too, so their cards stay up regardless of the background setting
  and clear when that agent carries on after you answered there.
- If nobody answers within about 100 seconds, the hook gives up and Claude Code's own prompt appears.
- Only a short gap is tolerated: if the waiting hook disappears, the card is withdrawn after a few seconds so you
  are never offered an answer nobody will receive.
- If a multi-select question has an option containing a comma, it is not offered here (several picks are returned
  joined with commas, which would be ambiguous), and Claude Code asks you as usual.
- Plans (`ExitPlanMode`) get their own card with the plan text (first 4000 characters, shown as plain text): "Approve plan"
  or "Keep planning" with optional feedback (up to 1000 characters) that Claude receives as the reason. You can't send
  new prompts or start plans from the dashboard (hooks can't do that). Which permission mode Claude continues in after
  an approved plan is not chosen by AgentWatch; it is whatever Claude Code does for a hook-approved plan (not verified).
- Not verified: whether Claude Code shows its own permission dialog while a `PermissionRequest` hook is waiting. Plan
  for it not to. Close or hide the dashboard tab, or turn the setting off, if you would rather answer in the terminal.

Security: the approve/deny endpoint checks that the request carries the dashboard's own `Origin`. That stops other web
pages (browsers can't forge `Origin`) but it is not authentication: any local process can send that header, so any
program on this computer that can reach `127.0.0.1` can approve a pending command or switch this setting. Programs
running as you can run commands anyway, but on a shared multi-user machine other users could too, so **do not turn
this on on a shared machine**. A dashboard login is planned together with phone access. The dashboard's state and
live stream also refuse requests from other web pages. The command or file path shown on
the card (up to 300 characters; plans up to 2000) is kept in memory only while the prompt is open and is never written
to disk. Grok isn't supported: its hooks have no permission-prompt event, and a `PreToolUse` "allow" only means
"not blocked", it never approves a pending prompt. OpenCode has an HTTP API for permissions and questions, possible
later.

### Phone notifications (ntfy, opt-in)

Get a push on your phone when an agent needs you or finishes, even away from your computer. It uses
[ntfy](https://ntfy.sh), a free push service, and is **off by default**.

The quickest way is *Settings → Phone* (see "Use AgentWatch from your phone"). Manually:

1. Install the ntfy app on your phone (Android, iOS).
2. On this computer's dashboard, open *Settings → Phone → Advanced → Phone notifications (ntfy)* and turn it on. A random topic is
   generated for you. (The same switch lives in `config.json` under `phone`.)
3. In the ntfy app, subscribe to that topic (use the same server if you changed it).
4. Press **Send test**, or run `agentwatch notify-test --phone`.

Phone pushes follow the same rules as desktop notifications: the master `notifications` switch, each tool's
`enabled` and `notifyOn`. Turning the master switch off mutes both. Pushes are rate limited (one per session per 10
seconds, 30 per minute overall).

```jsonc
"phone": {
  "enabled": false,
  "server": "https://ntfy.sh",   // https only (http is accepted for localhost)
  "topic": "…",                  // generated, 16-64 chars of A-Z a-z 0-9 _ -
  "token": "…",                  // optional access token for a protected server
  "includeDetails": false
}
```

**Privacy.** ntfy.sh is a third-party public service, and the topic is the only secret: anyone who knows it can read
(and send) notifications on it. Keep it private and use *New topic* if it leaks. By default a push says only the
agent's name and "Needs your input", "Finished" or "Error". *Include project and task names* adds the project folder
name (never the full path), the task title and the agent's short message; those then pass through the ntfy server and
your phone vendor's push service (Google or Apple). Prompts and transcripts are never sent. For more control, run your
own ntfy server (over https) and, if it is protected, set an access token; the token is stored in `config.json`
and is never shown again in the dashboard.

If you also set up phone access to the dashboard (below), tapping a push opens the dashboard at your Tailscale
address; otherwise pushes have no link, since `127.0.0.1` means nothing on a phone.

ntfy publish API: <https://docs.ntfy.sh/publish/> (headers `Title`, `Priority`, `Tags`, `Click`, `Actions`;
[access tokens](https://docs.ntfy.sh/publish/#authentication)). AgentWatch sends only a plain POST plus a `view`
action, never `http` actions.

### Settings

Edit `~/.agentwatch/config.json` (created on first start), then restart the dashboard (`agentwatch stop`, then
`agentwatch start --background`). Each tool has its own block under `tools`, keyed `claude-code`, `codex`, `grok`
and `opencode`. Any setting you leave out keeps its default, so you only need to write what you change:

```jsonc
{
  "port": 7878,
  "token": "…",                 // generated; hooks use it to authenticate
  "notifications": true,        // master switch
  "taskTitles": true,           // show each session's name
  "remoteActions": false,       // answer Claude Code prompts from the dashboard (see above)
  "remote": { "enabled": false, "hosts": [] },  // phone access through Tailscale Serve (see below)
  "phone": { "enabled": false },  // push notifications to your phone through ntfy (see above)
  "tools": {
    "claude-code": {
      "enabled": true,
      "label": "Claude",        // shown in notifications and on the dashboard
      "color": "#d97757",       // the agent's swatch on the dashboard
      "sound": "im",            // default | im | mail | reminder | sms | alarm | silent
      "notifyOn": { "needs_input": true, "done": false, "error": true },
      "clickAction": "auto"     // auto | vscode | dashboard | none
    },
    "codex": { "sound": "mail" },
    "grok": { "enabled": false }  // stop tracking Grok without uninstalling its hook
  }
}
```

## Use AgentWatch from your phone

Off by default. You can watch your sessions (and, per phone, answer prompts) from your phone through
[Tailscale Serve](https://tailscale.com/kb/1242/tailscale-serve), which shares the dashboard inside your own tailnet over
HTTPS. AgentWatch itself still listens on 127.0.0.1 only; Tailscale Serve is a proxy you run, and nothing is
exposed to the internet.

Open **Settings** > **Phone** on the PC's dashboard and follow the three steps:

1. **On this PC:** press **Turn on phone access**. AgentWatch checks Tailscale and runs
   `tailscale serve --bg --yes --https=443 http://127.0.0.1:<port>` for you, only when you press the button. If
   Tailscale isn't installed or signed in, the panel says so. If your tailnet hasn't enabled HTTPS yet, it shows a link to
   Tailscale's page for that; enable it and press the button again. If port 443 already serves something else, AgentWatch
   won't touch it.
2. **On your phone:** install Tailscale (same account as the PC) and, for notifications, the ntfy app (links in the panel).
3. **Pair:** keep **Send notifications to this phone** ticked (it turns on ntfy with a fresh random topic on ntfy.sh and
   generic text only), press **Show pairing code**, scan the QR code with the phone's camera and name the phone. On the phone
   tap **Get notifications** to open ntfy subscribed to your topic. The panel shows "Paired: <name>".

To let a phone approve Claude Code prompts, tick **Allow approvals** for it in the same panel. Without it the phone can
only watch and dismiss. **Revoke** removes a phone at once. **Turn off phone access** disables remote access and, only if
AgentWatch created the Serve mapping and it still points at AgentWatch, runs `tailscale serve --https=443 off`. Anything
else you set up in Tailscale is left alone. The old manual settings are under *Settings → Phone → Advanced*.

Never use **Tailscale Funnel** for this: it publishes the dashboard on the public internet. AgentWatch only supports Serve.
Remote requests need a device cookie from pairing (stored hashed in `~/.agentwatch/devices.json`); the token is never
accepted from them, and setup, device management and "Open in …" only work on the PC itself. Anyone who can read the
phone's browser cookies, or who you let into your tailnet and who gets a pairing code, can act as that phone, so keep
"Allow approvals" off unless you need it.

The device cookie is named `__Host-aw_device` (HttpOnly, Secure, SameSite=Strict, `Path=/`, no `Domain`), so browsers refuse
to let another site or service plant or overwrite it. Cookies are not scoped by port, though: any other web service you
serve on the same `<machine>.<tailnet>.ts.net` name (for example another `tailscale serve --https=8443` port) is sent
that cookie by the phone's browser and could read it. Serve only AgentWatch on that hostname, or give the other
service its own machine name. Turning remote access off, removing a host or revoking a phone closes that phone's open
connections immediately.

Not verified against a live tailnet: that Serve forwards the `Host` header as `<machine>.<tailnet>.ts.net` (AgentWatch
refuses the request otherwise), what the Tailscale CLI prints when HTTPS isn't enabled yet (we look for a
`https://login.tailscale.com/` link), and whether the `ntfy://` link opens the ntfy app on iOS (documented for Android
only; the store links stay on screen). The `serve status --json` shape follows Tailscale's `ipn.ServeConfig` source.

## Troubleshooting

**A session doesn't show up.** Check, in order:
1. `agentwatch status`: is the dashboard running? If not, run `agentwatch start --background`.
2. Is the tool **connected** in that list? If not, run `agentwatch install --tool <id>`.
3. Was the session started *after* connecting? Open a new one; existing sessions keep their old hooks.
4. Codex: did you approve the hooks in `/hooks`? Codex silently skips untrusted hooks.
5. Is the tool disabled with `"enabled": false` in `config.json`?

**No notifications.** Run `agentwatch notify-test`. On Windows, allow notifications for AgentWatch in
*Settings → System → Notifications* and turn off Do Not Disturb. Check that `"notifications"` and the tool's
`notifyOn` aren't turned off in `config.json`.

**"Port 7878 is in use".** Set another `"port"` in `~/.agentwatch/config.json` and start again. Hooks read the port
from the same file, so nothing else needs changing.

**Dashboard won't start in the background.** Its output goes to `~/.agentwatch/server.log`. To see errors directly,
run `agentwatch start` in a terminal (Ctrl+C to stop).

**A row is stuck.** Use the × on the row to dismiss it. Sessions whose agent process has exited (Claude Code)
disappear on their own, and finished ones clear after an hour.

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

- Phone access runs Tailscale Serve for you on a click, but has only been tested against a simulated proxy and a fake CLI (see above).
- Answering prompts from the dashboard is Claude Code (permissions, questions, plans), Codex (permissions only) and OpenCode (permissions, and questions on 1.x), and opt-in. Whether Claude Code's own dialog stays visible
  while the hook waits in the terminal is unverified; VS Code and Claude desktop prompts are treated as concurrent (inferred, see above).
- Cloud sessions (Claude Code on the web, Codex cloud) run on remote machines and can't reach your local dashboard.
- Plain chat apps (claude.ai, ChatGPT, Grok chat) have no hooks.
- Notification clicks can open a VS Code window, but not a specific Claude tab or terminal tab. A notification can
  open only one link, so use the dashboard's **Open in VS Code** to get to the exact Claude tab.
- Codex desktop chats open directly through `codex://threads/<thread-id>`. This requires Codex to be installed
  as the protocol handler and the session to be identified as running in the desktop app.
- Claude desktop app sessions (host "Claude Desktop") open through the app's undocumented `claude://code/continue` link,
  using the app's own session id found by reading its local session records (only the id is kept). If it can't be
  found there is no link. Verified on Windows only; see the [adapter docs](src/adapters/claude-code/README.md).
- macOS and Linux notifications and start at login are implemented but not yet tested on those systems. macOS notifications can't be clicked.
- Codex and Grok don't expose their process id to hooks, so after you approve a command there, the session stays at
  "needs input" until the command finishes. The same goes for Claude Code permission prompts that don't run a shell (e.g.
  file edits), but those finish almost instantly. OpenCode reports approvals itself, so it isn't affected.
- OpenCode sends no event when you quit it. OpenCode 1.x sessions disappear within a minute of the OpenCode process
  exiting. OpenCode 2.x keeps running in a background service after you quit, so its finished sessions stay until
  they expire, an hour after their last activity.

## Development

```sh
git clone https://github.com/papi-knomic/agentwatch.git && cd agentwatch
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
