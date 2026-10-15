import type { Adapter } from "../types.js";
import { installGrok, uninstallGrok } from "./install.js";
import { grokMeta } from "./meta.js";
import { normalizeGrok } from "./normalize.js";

export const grokAdapter: Adapter = {
  meta: grokMeta,
  normalize: normalizeGrok,
  install: installGrok,
  uninstall: uninstallGrok,
};
