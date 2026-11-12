import { getAdapter, toolDefaults } from "../adapters/index.js";
import { ensureConfig, setPhoneConfig, setRemoteConfig } from "../core/config.js";
import { APP_DISPLAY_NAME, APP_NAME } from "../core/constants.js";
import { configPath, devicesPath, sessionsPath } from "../core/paths.js";
import { defaultPhoneConfig } from "../core/phone.js";
import { SessionStore } from "../core/store.js";
import { createNotifier } from "../notify/index.js";
import { createPhoneNotifier } from "../notify/ntfy.js";
import { createApprovalWatcher } from "../server/approval-watch.js";
import { DeviceStore } from "../server/devices.js";
import { createNotificationDispatcher } from "../server/notifications.js";
import { createSessionOpener } from "../server/open-session.js";
import { defaultListChildren } from "../server/process-list.js";
import { createAppServer } from "../server/server.js";
import { createSessionHealth } from "../server/session-health.js";
import { detectTailscaleHost } from "../server/tailscale.js";
import { openUrl } from "./open.js";
import { isRunning, setupService, startInBackground } from "./service.js";

// Without a file the change would only live in memory and silently vanish on restart.
const NO_CONFIG_FILE =
  "The config file is missing, so the setting could not be saved. Restart AgentWatch and try again.";
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
  const phone = createPhoneNotifier({
    getPhone: () => config.phone,
    getRemote: () => config.remote,
    log: (message) => console.error(message),
  });
  store.subscribe(
    createNotificationDispatcher({
      config,
      notifier: createNotifier(),
      phone,
      dashboardUrl: url,
      linkFor: (session) => getAdapter(session.tool)?.sessionLink?.(session),
      log: (message) => console.error(message),
    }),
  );
  setInterval(() => store.pruneStale(), PRUNE_INTERVAL_MS).unref();
  createSessionHealth({ store }).start();
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
  const devices = new DeviceStore(devicesPath());
  await devices.load();
  const server = createAppServer({
    devices,
    detectHost: detectTailscaleHost,
    // Only `remote` is written, from the file's current content, so other keys edited meanwhile survive.
    saveRemote: async (remote) => {
      if (!(await setRemoteConfig(remote))) throw new Error(NO_CONFIG_FILE);
    },
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
    phone: {
      get: () => config.phone ?? defaultPhoneConfig(),
      set: async (next) => {
        // Only `phone` is written, from the file's current content, so other keys edited meanwhile survive.
        if (!(await setPhoneConfig(next))) throw new Error(NO_CONFIG_FILE);
        config.phone = next;
      },
      sendTest: () => phone.sendTest(),
    },
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
