@AGENTS.md

## Claude Code specifics

- `AGENTS.md` (imported above) is the source of truth. Put rules that apply to every agent there, not here.
- This repo will install hooks into Claude Code itself. While developing, never edit `~/.claude/settings.json`; test
  against a temporary config folder (see hard rule 6).
