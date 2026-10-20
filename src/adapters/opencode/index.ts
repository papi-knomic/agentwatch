import type { Adapter } from "../types.js";
import { installOpenCode, uninstallOpenCode } from "./install.js";
import { openCodeMeta } from "./meta.js";
import { normalizeOpenCode } from "./normalize.js";

export const openCodeAdapter: Adapter = {
  meta: openCodeMeta,
  normalize: normalizeOpenCode,
  install: installOpenCode,
  uninstall: uninstallOpenCode,
};
