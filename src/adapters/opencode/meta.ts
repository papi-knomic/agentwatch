import type { AdapterMeta } from "../types.js";

export const openCodeMeta: AdapterMeta = {
  id: "opencode",
  displayName: "OpenCode",
  color: "#0ea5e9",
  sound: "mail",
  docsUrl: "https://opencode.ai/docs/plugins/",
  afterInstall: ["Restart OpenCode so it loads the plugin (OpenCode 1.x loads plugins only when it starts)."],
};
