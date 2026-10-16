import { getAdapter, toolDefaults } from "../adapters/index.js";
import { ensureConfig } from "../core/config.js";
import { APP_DISPLAY_NAME, APP_NAME } from "../core/constants.js";
import { configPath, migrateLegacyHome, sessionsPath } from "../core/paths.js";
import { SessionStore } from "../core/store.js";
import { createNotifier } from "../notify/index.js";
import { createApprovalWatcher } from "../server/approval-watch.js";
import { createNotificationDispatcher } from "../server/notifications.js";
import { createSessionOpener } from "../server/open-session.js";
import { defaultListChildren } from "../server/process-list.js";
import { createAppServer } from "../server/server.js";
import { openUrl } from "./open.js";
import { isRunning, setupService, startInBackground } from "./service.js";

const SAVE_DEBOUNCE_MS = 500;
const PRUNE_INTERVAL_MS = 10 * 60 * 1000;

export async function start(options: {
  open: boolean;
  background: boolean;
  staticDir: string;
  version: string;
  cliPath: string;
}): Promise<void> {
  if (options.background) {
    const { url, alreadyRunning } = await startInBackground(options.cliPath);
    console.log(`${APP_DISPLAY_NAME} ${alreadyRunning ? "is already running" : "started"} at ${url}`);
    if (options.open) openUrl(url);
    return;
  }

  migrateLegacyHome();
  const config = await ensureConfig(toolDefaults());
  const url = `http://127.0.0.1:${config.port}`;

  if (await isRunning(url)) {
    console.log(`${APP_DISPLAY_NAME} is already running at ${url}`);
    if (options.open) openUrl(url);
    return;
  }

  const store = new SessionStore();
  const statePath = sessionsPath();
  await store.load(statePath);

  let saveTimer: NodeJS.Timeout | undefined;
  const save = () =>
    store.save(statePath).catch((e: unknown) => console.error(`Could not save sessions: ${e}`));
  store.subscribe(() => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS);
  });
  store.subscribe(
    createNotificationDispatcher({
      config,
      notifier: createNotifier(),
      dashboardUrl: url,
      log: (message) => console.error(message),
    }),
  );
  setInterval(() => store.pruneStale(), PRUNE_INTERVAL_MS).unref();
  createApprovalWatcher({
    store,
    listChildren: defaultListChildren(),
    log: (message) => console.error(message),
  }).start();

  const tools = Object.entries(config.tools).map(([id, settings]) => ({
    id,
    label: settings.label,
    color: settings.color,
  }));
  const server = createAppServer({
    config,
    store,
    tools,
    staticDir: options.staticDir,
    version: options.version,
    openSession: createSessionOpener({
      linkFor: (session) => getAdapter(session.tool)?.sessionLink?.(session),
      openUrl,
    }),
    setup: setupService(config, options.cliPath),
    onShutdown: () => void shutdown(),
  });

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(`Port ${config.port} is in use. Change "port" in ${configPath()} and try again.`);
    } else {
      console.error(error.message);
    }
    process.exit(1);
  });

  server.listen(config.port, "127.0.0.1", () => {
    console.log(`${APP_DISPLAY_NAME} running at ${url}`);
    console.log(`Config: ${configPath()} (restart after editing)`);
    console.log(`Connect your agents on the dashboard, or run: ${APP_NAME} setup`);
    if (options.open) openUrl(url);
  });

  async function shutdown(): Promise<void> {
    clearTimeout(saveTimer);
    await save();
    process.exit(0);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
