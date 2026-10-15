import type { Adapter } from "../types.js";
import { installClaudeCode, uninstallClaudeCode } from "./install.js";
import { claudeCodeMeta } from "./meta.js";
import { normalizeClaudeCode } from "./normalize.js";

export const claudeCodeAdapter: Adapter = {
  meta: claudeCodeMeta,
  normalize: normalizeClaudeCode,
  install: installClaudeCode,
  uninstall: uninstallClaudeCode,
};
