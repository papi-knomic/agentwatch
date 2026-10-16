import { getAdapter, toolDefaults } from "../adapters/index.js";
import { readConfig } from "../core/config.js";
import { HOOK_REQUEST_TIMEOUT_MS, HOOK_STDIN_MAX_BYTES, HOOK_STDIN_TIMEOUT_MS } from "../core/constants.js";

/**
 * Entry point for every agent hook. Hard rule: this must never print to stdout, never fail, and never
 * take long — agents may treat stdout or exit codes as instructions. Every error is swallowed.
 */
export async function runHook(toolId: string | undefined, argPayload: string | undefined): Promise<void> {
  try {
    if (!toolId) return;
    const adapter = getAdapter(toolId);
    if (!adapter) return;

    // Some tools (e.g. Codex `notify`) pass the payload as an argument instead of stdin.
    // Windows PowerShell prepends a BOM when piping text to a native process.
    const text = (argPayload ?? (await readStdin())).replace(/^﻿/, "");
    if (!text.trim()) return;
    const event = adapter.normalize(JSON.parse(text), { env: process.env, now: new Date() });
    if (!event) return;

    const config = await readConfig(toolDefaults());
    if (!config || config.tools[toolId]?.enabled === false) return;
    // Dropped here, before it leaves the hook, so with titles off no prompt text reaches the server.
    if (config.taskTitles === false) {
      delete event.title;
      delete event.titleSource;
    }

    await fetch(`http://127.0.0.1:${config.port}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${config.token}` },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(HOOK_REQUEST_TIMEOUT_MS),
    });
  } catch {
    // Server not running, bad payload, timeout: none of it is the agent's problem.
  }
}

function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    let data = "";
    const finish = () => {
      clearTimeout(timer);
      process.stdin.removeAllListeners();
      process.stdin.destroy();
      resolve(data);
    };
    const timer = setTimeout(finish, HOOK_STDIN_TIMEOUT_MS);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
      if (data.length > HOOK_STDIN_MAX_BYTES) {
        data = "";
        finish();
      }
    });
    process.stdin.on("end", finish);
    process.stdin.on("error", finish);
  });
}
