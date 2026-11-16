import { useEffect, useState } from "react";
import { APP_DISPLAY_NAME, APP_NAME } from "../../src/core/constants.js";
import type { BackgroundHold } from "../../src/core/decision-types.js";
import { PhoneNotifications } from "./PhoneSettings";
import { PhoneWizard } from "./PhoneWizard";
import { RemoteAccess } from "./RemoteAccess";
import { SETTINGS_TABS, type SettingsTab, settingsHref } from "./route";
import { AgentsSection, CopyCommand, RemoteActionsRow } from "./SetupPanel";
import { getPhone, type PhoneSettings, type Setup, setBackgroundHold } from "./setup";
import type { Permission } from "./WaitingPanel";

function partlySetUp(setup: Setup): boolean {
  return setup.remoteActions.supported && setup.remoteActions.enabled !== setup.remoteActions.installed;
}

/** What in setup needs a second look; drives the dot on the gear. */
export function setupNeedsAttention(setup: Setup | null): boolean {
  if (!setup) return false;
  return partlySetUp(setup) || setup.tools.some((tool) => tool.error !== undefined);
}

interface SettingsProps {
  tab: SettingsTab;
  setup: Setup | null;
  onSetup: (setup: Setup) => void;
  permission: Permission;
  onEnableAlerts: () => void;
}

export function SettingsPage({ tab, setup, onSetup, permission, onEnableAlerts }: SettingsProps) {
  return (
    <div className="settings">
      <div className="settings-top">
        <a className="back-link" href="#/">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M10 3.5L5.5 8l4.5 4.5" />
          </svg>
          Dashboard
        </a>
        <h1>Settings</h1>
      </div>

      <nav className="settings-tabs" aria-label="Settings sections">
        <div className="tab-strip" role="tablist">
          {SETTINGS_TABS.map((t) => (
            <a
              key={t.id}
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={t.id === tab}
              aria-controls="settings-panel"
              className={t.id === tab ? "tab on" : "tab"}
              href={settingsHref(t.id)}
            >
              {t.label}
              {t.id === "answering" && setup && partlySetUp(setup) && (
                <span className="attn-dot" title="Partly set up" />
              )}
            </a>
          ))}
        </div>
        <select
          className="tab-select"
          aria-label="Settings section"
          value={tab}
          onChange={(event) => {
            window.location.hash = settingsHref(event.target.value as SettingsTab);
          }}
        >
          {SETTINGS_TABS.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </nav>

      <div id="settings-panel" role="tabpanel" aria-labelledby={`tab-${tab}`} className="settings-body">
        <TabBody
          tab={tab}
          setup={setup}
          onSetup={onSetup}
          permission={permission}
          onEnableAlerts={onEnableAlerts}
        />
      </div>
    </div>
  );
}

function TabBody({ tab, setup, onSetup, permission, onEnableAlerts }: SettingsProps) {
  switch (tab) {
    case "agents":
      return setup ? <AgentsSection setup={setup} onSetup={onSetup} /> : <Unavailable />;
    case "notifications":
      return <NotificationsTab permission={permission} onEnableAlerts={onEnableAlerts} />;
    case "phone":
      return <PhoneTab />;
    case "answering":
      return <AnsweringTab setup={setup} onSetup={onSetup} />;
    case "general":
      return <GeneralTab setup={setup} />;
  }
}

function Unavailable() {
  return (
    <section className="settings-card">
      <p className="settings-text">
        This server doesn't offer setup from the browser. Use the terminal: <code>{APP_NAME} setup</code>.
      </p>
    </section>
  );
}

function NotificationsTab({
  permission,
  onEnableAlerts,
}: {
  permission: Permission;
  onEnableAlerts: () => void;
}) {
  const [phone, setPhone] = useState<PhoneSettings | null>(null);
  useEffect(() => {
    getPhone()
      .then(setPhone)
      .catch(() => setPhone(null));
  }, []);

  return (
    <>
      <section className="settings-card">
        <h2>Desktop notifications</h2>
        <p className="settings-text">
          {APP_DISPLAY_NAME} sends an operating system notification when an agent needs your input, finishes
          or fails. Which statuses notify, and the sound, are set per agent in <code>config.json</code> under{" "}
          <code>tools</code> (see the README); this page can't change them yet. To check that they appear:
        </p>
        <p className="settings-text">
          <CopyCommand command={`${APP_NAME} notify-test`} />
        </p>
      </section>

      <section className="settings-card">
        <h2>Browser alerts</h2>
        <p className="settings-text">
          While this page is open in the background, a browser notification names the agent and project when a
          prompt is waiting for you here. It never shows the command.
        </p>
        <div className="settings-line">
          {permission === "granted" && <span className="connected-badge">On</span>}
          {permission === "default" && (
            <button type="button" className="open-button" onClick={onEnableAlerts}>
              Enable browser alerts
            </button>
          )}
          {permission === "denied" && (
            <span className="settings-muted">
              Blocked in this browser. Allow notifications for this site in its settings.
            </span>
          )}
          {permission === "unsupported" && (
            <span className="settings-muted">This browser doesn't support notifications.</span>
          )}
        </div>
      </section>

      <section className="settings-card">
        <h2>Phone push (ntfy)</h2>
        <p className="settings-text">
          {phone === null
            ? "Push notifications to your phone through ntfy."
            : phone.enabled
              ? `On, through ${phone.server}.`
              : "Off. Push notifications to your phone through ntfy."}{" "}
          <a href={settingsHref("phone")}>Manage on the Phone tab</a>
        </p>
      </section>
    </>
  );
}

function PhoneTab() {
  return (
    <>
      <PhoneWizard />
      <details className="phone-advanced settings-card settings-advanced">
        <summary>Advanced: hosts, ntfy server, paired devices</summary>
        <PhoneNotifications />
        <RemoteAccess />
      </details>
    </>
  );
}

function AnsweringTab({ setup, onSetup }: { setup: Setup | null; onSetup: (setup: Setup) => void }) {
  return (
    <section className="settings-card">
      <h2>Answer prompts from the dashboard</h2>
      <p className="settings-text">
        Approve or deny permission requests and answer questions on this page instead of in the terminal. It
        works for Claude Code (permissions, questions and plans), Codex (permissions only, not with Codex's
        auto reviewer: the hook would delay auto-approved requests, so leave Codex answering off if you use
        it) and OpenCode (permissions, and questions on 1.x), and is off by default.
      </p>
      <ul className="settings-list">
        <li>
          While a dashboard tab is visible, the agent waits up to about 100 seconds for your answer here.
        </li>
        <li>
          If the tab is hidden or covered, what happens is your choice below (browser alerts, if enabled,
          still tell you a prompt is waiting).
        </li>
        <li>With no dashboard tab open, it never waits: the terminal asks as usual.</li>
      </ul>
      {setup?.remoteActions.supported ? (
        <>
          <RemoteActionsRow remote={setup.remoteActions} onSetup={onSetup} />
          <BackgroundHoldChoice current={setup.remoteActions.backgroundHold} onSetup={onSetup} />
        </>
      ) : (
        <p className="settings-text settings-muted">Not available on this server.</p>
      )}
    </section>
  );
}

const BACKGROUND_HOLD_OPTIONS: { value: BackgroundHold; label: string }[] = [
  { value: "full", label: "Wait for the dashboard (up to ~100s; the terminal shows nothing until then)" },
  { value: "short", label: "Wait briefly (~15s), then the terminal" },
  { value: "off", label: "Go straight to the terminal" },
];

function BackgroundHoldChoice({
  current,
  onSetup,
}: {
  current: BackgroundHold;
  onSetup: (setup: Setup) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const choose = async (mode: BackgroundHold) => {
    setBusy(true);
    setError(null);
    try {
      onSetup(await setBackgroundHold(mode));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <fieldset className="settings-choice" disabled={busy}>
      <legend>When the dashboard is open in the background, terminal prompts:</legend>
      {BACKGROUND_HOLD_OPTIONS.map((option) => (
        <label key={option.value}>
          <input
            type="radio"
            name="background-hold"
            value={option.value}
            checked={current === option.value}
            onChange={() => void choose(option.value)}
          />{" "}
          {option.label}
        </label>
      ))}
      <p className="settings-text settings-muted">
        VS Code and the Claude app always show their own prompt too, so their cards stay up regardless of this
        setting.
      </p>
      {error && <p className="settings-text">{error}</p>}
    </fieldset>
  );
}

function GeneralTab({ setup }: { setup: Setup | null }) {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/health")
      .then((res) => res.json() as Promise<{ version?: unknown }>)
      .then((body) => setVersion(typeof body.version === "string" ? body.version : null))
      .catch(() => setVersion(null));
  }, []);

  const startAtLogin = !setup
    ? "Unknown"
    : !setup.autostart.supported
      ? "Not supported on this system"
      : setup.autostart.installed
        ? "On"
        : "Off";

  return (
    <section className="settings-card">
      <h2>General</h2>
      <dl className="settings-facts">
        <dt>Start at login</dt>
        <dd>
          {startAtLogin}
          <span className="settings-muted">
            {" "}
            · change with <code>{APP_NAME} setup</code> or <code>{APP_NAME} uninstall --tool all</code>
          </span>
        </dd>
        <dt>Config file</dt>
        <dd>
          <code>~/.agentwatch/config.json</code>
          <span className="settings-muted">
            {" "}
            (or in $AGENTWATCH_HOME). Task titles, the port and per-agent notifications live here.
          </span>
        </dd>
        <dt>Version</dt>
        <dd>{version ?? "Unknown"}</dd>
        <dt>Stop the server</dt>
        <dd>
          <CopyCommand command={`${APP_NAME} stop`} />
          <span className="settings-muted"> A web page can't stop it, by design.</span>
        </dd>
      </dl>
    </section>
  );
}
