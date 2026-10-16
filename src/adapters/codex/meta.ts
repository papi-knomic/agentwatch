import type { AdapterMeta } from "../types.js";

export const codexMeta: AdapterMeta = {
  id: "codex",
  displayName: "Codex",
  color: "#10a37f",
  sound: "im",
  docsUrl: "https://learn.chatgpt.com/docs/hooks",
  afterInstall: [
    "Run /hooks in the Codex CLI and approve the new hooks. Codex skips hooks you haven't trusted.",
    "If existing desktop-app chats are missing, fully quit and reopen Codex, then resume the chat. Sending another prompt in an already loaded chat may not reload its hooks.",
  ],
};
