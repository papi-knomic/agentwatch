# Changelog

All notable changes to AgentWatch are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-11-16

### Upgrading

1. `npm install -g @kn0mic/agentwatch@latest`
2. Re-run `agentwatch install --tool <id>` for each tool you use (or `agentwatch install --tool all`). Add
   `--remote-actions` if you want to answer prompts from the dashboard. For Codex, approve the hooks again in `/hooks`.
3. Restart the dashboard: `agentwatch stop`, then `agentwatch start --background`.
4. Start new agent sessions. Sessions that were already running keep the old hooks.

### Added

- Answer prompts from the dashboard (opt-in, switch it on per tool in Settings):
  - Claude Code: permission prompts, questions and plans, including sessions in VS Code and the Claude desktop app.
  - Codex: permission prompts. Not available when Codex's automatic reviewer is on.
  - OpenCode: permission prompts, and questions in OpenCode 1.x.
  - Grok: notifications only. Its hooks can't answer prompts.
- Choose how long a terminal prompt waits while the dashboard is in the background
  (hold it for the dashboard, or go straight to the terminal).
- Pending prompts stay on the dashboard as cards, also when the tab was hidden when they arrived.
- Subagents are tracked separately, so their prompts no longer get mixed up (Claude Code, Codex, Grok, OpenCode).
- "Open" links for Claude Desktop sessions.
- Phone access through Tailscale Serve (opt-in): a Set up phone wizard in the dashboard, pairing with a code or QR,
  and per-device permission to approve prompts.
- Phone push notifications through ntfy (opt-in), with a QR code that works on iPhone. Notifications are generic
  unless you choose to include details.
- A Settings page for notifications, dashboard answering, phone and per-tool options.
- `agentwatch debug decisions` lists the last 50 attempts to show a prompt on the dashboard, to help when a card
  doesn't appear.
- OpenCode and OpenChamber sessions are titled from your first prompt until OpenCode names them.

### Changed

- Redesigned dashboard with List and Table views and search.

### Fixed

- Prompts and questions from VS Code and the Claude app can now be answered from the dashboard.
- Codex's automatic reviewer is never held up by the dashboard.
- Turning dashboard answering on for one tool no longer turns it off for others.
- The setup check only flags real problems.

### Security

- The server still listens on `127.0.0.1` only. Nothing is exposed to the internet.
- Phone access is off by default. It works only through a proxy you run yourself (Tailscale Serve, never Funnel),
  and a phone must be paired before it can see or do anything.
- A phone never receives the local token and can approve prompts only if you allow it for that device.

## [0.1.4] - 2026-11-09

### Fixed

- OpenCode 2.x plugins are supported alongside 1.x.

## [0.1.3] - 2026-10-20

### Added

- OpenCode support.
- Filter the dashboard by agent. Each agent has its own colour.

## [0.1.2] - 2026-10-16

### Fixed

- "Open in VS Code" opens the project folder, never a subfolder.

## [0.1.1] - 2026-10-16

### Changed

- Removed leftover migration code for a pre-release name.

## [0.1.0] - 2026-10-16

First public release.

### Added

- Local dashboard and desktop notifications for Claude Code, Codex and Grok, with start at login and `agentwatch setup`.
- Codex desktop support, with "Open in Codex" links.
- Dashboard grouped by project, with a "Needs you" lane, task titles and honest statuses (stalled and finished sessions).
- Windows notifications with their own name and icon.
- Published as `@kn0mic/agentwatch` (the command is `agentwatch`).

[Unreleased]: https://github.com/papi-knomic/agentwatch/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/papi-knomic/agentwatch/compare/v0.1.4...v0.2.0
[0.1.4]: https://github.com/papi-knomic/agentwatch/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/papi-knomic/agentwatch/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/papi-knomic/agentwatch/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/papi-knomic/agentwatch/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/papi-knomic/agentwatch/releases/tag/v0.1.0
