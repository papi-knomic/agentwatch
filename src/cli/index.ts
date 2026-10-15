#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { adapters, getAdapter, toolDefaults } from "../adapters/index.js";
import { ensureConfig } from "../core/config.js";
import { APP_DISPLAY_NAME, APP_NAME } from "../core/constants.js";
import { NOTIFIABLE_STATUSES, type NotifiableStatus, type Session } from "../core/types.js";
import { createNotifier } from "../notify/index.js";
import { buildNotification } from "../server/notifications.js";
import { runHook } from "./hook.js";
import { installCommand } from "./install.js";
import { start } from "./start.js";

const cliPath = fileURLToPath(import.meta.url);
const staticDir = fileURLToPath(new URL("../web", import.meta.url));

function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const HELP = `${APP_DISPLAY_NAME}: one dashboard and desktop notifications for your AI coding agents.

Usage:
  ${APP_NAME} start [--open]                 Start the local dashboard server
  ${APP_NAME} install --tool <id|all>        Add hooks to the tool's config (backs it up first)
        [--dry-run] [--home <dir>]
  ${APP_NAME} uninstall --tool <id|all>      Remove exactly the hooks that install added
        [--dry-run] [--home <dir>]
  ${APP_NAME} notify-test [--tool <id>] [--status needs_input|done|error]
                                             Show a sample notification
  ${APP_NAME} hook --tool <id> [payload]     Called by agents; not for direct use

Tools: ${adapters.map((a) => a.meta.id).join(", ")}`;

async function notifyTest(toolId: string, status: NotifiableStatus): Promise<void> {
  const config = await ensureConfig(toolDefaults());
  const settings = config.tools[toolId];
  if (!settings) throw new Error(`Unknown tool "${toolId}".`);
  const now = new Date().toISOString();
  const session: Session = {
    key: `${toolId}:test`,
    tool: toolId,
    sessionId: "test",
    cwd: process.cwd(),
    status,
    message: status === "needs_input" ? "Wants permission to run a command (test)" : "rate_limit (test)",
    host: "VS Code",
    startedAt: now,
    updatedAt: now,
  };
  const notification = buildNotification(session, status, settings, `http://127.0.0.1:${config.port}`);
  await createNotifier()(notification);
  console.log(`Sent: "${notification.title}": ${notification.body}`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  // Handled first and separately: the hook must never print or throw, whatever its arguments are.
  if (command === "hook") {
    const toolIndex = rest.indexOf("--tool");
    if (toolIndex >= 0) {
      const payload = rest.filter((_, i) => i !== toolIndex && i !== toolIndex + 1)[0];
      await runHook(rest[toolIndex + 1], payload);
    }
    process.exit(0);
  }

  const { values } = parseArgs({
    args: rest,
    options: {
      tool: { type: "string" },
      status: { type: "string" },
      home: { type: "string" },
      "dry-run": { type: "boolean", default: false },
      open: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  switch (command) {
    case "start":
      return start({ open: values.open ?? false, staticDir, version: version() });
    case "install":
    case "uninstall":
      return installCommand({
        tool: values.tool,
        uninstall: command === "uninstall",
        dryRun: values["dry-run"] ?? false,
        home: values.home,
        cliPath,
      });
    case "notify-test": {
      const tool = values.tool ?? "claude-code";
      if (!getAdapter(tool)) throw new Error(`Unknown tool "${tool}".`);
      const status = (values.status ?? "needs_input") as NotifiableStatus;
      if (!NOTIFIABLE_STATUSES.includes(status))
        throw new Error(`--status must be one of ${NOTIFIABLE_STATUSES}`);
      return notifyTest(tool, status);
    }
    case "--version":
    case "-v":
      console.log(version());
      return;
    default:
      console.log(HELP);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
