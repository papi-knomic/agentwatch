import type { AdapterMeta } from "../types.js";

export const codexMeta: AdapterMeta = {
  id: "codex",
  displayName: "Codex",
  color: "#10a37f",
  sound: "im",
  docsUrl: "https://learn.chatgpt.com/docs/hooks",
  afterInstall: [
    "In Codex (CLI or VS Code extension), run /hooks and approve the new hooks. Codex skips hooks you haven't trusted.",
  ],
};
