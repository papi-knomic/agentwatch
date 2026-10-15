import type { Adapter } from "../types.js";
import { installCodex, uninstallCodex } from "./install.js";
import { codexMeta } from "./meta.js";
import { normalizeCodex } from "./normalize.js";

export const codexAdapter: Adapter = {
  meta: codexMeta,
  normalize: normalizeCodex,
  install: installCodex,
  uninstall: uninstallCodex,
};
