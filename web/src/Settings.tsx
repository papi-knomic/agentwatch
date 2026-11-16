import { useEffect, useState } from "react";
import { APP_DISPLAY_NAME, APP_NAME } from "../../src/core/constants.js";
import type { BackgroundHold } from "../../src/core/decision-types.js";
import { answeringNeedsAttention } from "./answering";
import type { Permission } from "./decisionAlerts";
import { Pill, Switch } from "./PhoneParts";
import { PhoneTab } from "./PhoneTab";
import { SETTINGS_TABS, type SettingsTab, settingsHref } from "./route";
import { AgentsSection, CopyCommand } from "./SetupPanel";
import {
  getPhone,
  type PhoneSettings,
  type RemoteToolState,
  type Setup,
  type SetupTool,
  setBackgroundHold,
  setToolRemoteActions,
} from "./setup";

/** What in setup needs a second look; drives the dot on the gear. */
export function setupNeedsAttention(setup: Setup | null): boolean {
  if (!setup) return false;
  return answeringNeedsAttention(setup) || setup.tools.some((tool) => tool.error !== undefined);
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
              {t.id === "answering" && setup && answeringAttention(setup) && (
                <span className="attn-dot" title="Needs a look" />
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
            <button type="button" className="btn" onClick={onEnableAlerts}>
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
        <h2>Push notifications</h2>
        <p className="settings-text">
          {phone === null
            ? "Push notifications to your phone with the free ntfy app."
            : phone.enabled
              ? `On, through ${phone.server}.`
              : "Off. Push notifications to your phone with the free ntfy app."}{" "}
          <a href={settingsHref("phone")}>Manage on the Phone tab</a>
        </p>
      </section>
    </>
  );
}

/** The tab's dot: the same rule as the gear, plus a remote-capable tool whose config can't be read. */
function answeringAttention(setup: Setup): boolean {
  const capable = new Set(setup.remoteActions.perTool.map((tool) => tool.id));
  return (
    answeringNeedsAttention(setup) || setup.tools.some((t) => capable.has(t.id) && t.error !== undefined)
  );
}

/** What each tool can answer, and what to know before turning it on. */
const ANSWERING_INFO: Record<string, { what: string; warn?: string }> = {
  "claude-code": { what: "Permissions, questions and plans." },
  codex: {
    what: "Permissions only.",
    warn: "Leave off if you use Codex's auto reviewer: it would delay auto-approved requests.",
  },
  opencode: { what: "Permissions, and questions on 1.x. Restart OpenCode after changing." },
};

function AnsweringTab({ setup, onSetup }: { setup: Setup | null; onSetup: (setup: Setup) => void }) {
  return (
    <>
      <section className="settings-card">
        <h2>Answer prompts from the dashboard</h2>
        <p className="settings-text">
          Approve or deny permission requests and answer questions on this page instead of in the terminal.
          Off by default, and switched on per tool.
        </p>
        <ul className="settings-list">
          <li>
            While a dashboard tab is visible, the agent waits up to about 100 seconds for your answer here.
          </li>
          <li>With no dashboard tab open, it never waits: the terminal asks as usual.</li>
        </ul>
        {setup?.remoteActions.supported ? (
          <ul className="answer-list">
            {setup.remoteActions.perTool.map((state) => (
              <AnswerRow
                key={state.id}
                state={state}
                tool={setup.tools.find((t) => t.id === state.id)}
                onSetup={onSetup}
              />
            ))}
          </ul>
        ) : (
          <p className="settings-text settings-muted">Not available on this server.</p>
        )}
      </section>
      {setup?.remoteActions.supported && (
        <section className="settings-card">
          <h2>Terminal prompts</h2>
          <BackgroundHoldChoice current={setup.remoteActions.backgroundHold} onSetup={onSetup} />
        </section>
      )}
    </>
  );
}

type AnswerStep =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "preview"; to: boolean; configPath: string; summary: string[] }
  | { kind: "error"; message: string };

function AnswerRow({
  state,
  tool,
  onSetup,
}: {
  state: RemoteToolState;
  tool: SetupTool | undefined;
  onSetup: (setup: Setup) => void;
}) {
  const [step, setStep] = useState<AnswerStep>({ kind: "idle" });
  const on = state.answering === "on";
  const info = ANSWERING_INFO[state.id];
  const usable = state.connected || on;

  // A dry run first, so the exact change is on screen before any config is written.
  const run = async (to: boolean, dryRun: boolean) => {
    setStep({ kind: "busy" });
    try {
      const { results, setup } = await setToolRemoteActions(state.id, to, dryRun);
      const result = results[0];
      if (!result) throw new Error("No result");
      onSetup(setup);
      setStep(
        dryRun && result.changed
          ? { kind: "preview", to, configPath: result.configPath, summary: result.summary }
          : { kind: "idle" },
      );
    } catch (error) {
      setStep({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <li className="answer-row">
      <div className="answer-main">
        <div className="answer-title">
          <span className="answer-name">{state.name}</span>
          {usable ? (
            <Pill on={on}>{on ? "On" : "Off"}</Pill>
          ) : (
            <span className="pill pill-off">Not connected</span>
          )}
        </div>
        <p className="settings-text">{info?.what}</p>
        {info?.warn && <p className="answer-note">{info.warn}</p>}
        {state.note && !tool?.error && <p className="answer-note">{state.note}</p>}
        {tool?.error && <p className="answer-note answer-problem">{tool.error}</p>}
        {!usable && (
          <p className="answer-note">
            <a href={settingsHref("agents")}>Connect it first</a>
            {tool?.outdated ? " (an older copy is installed)" : ""}
          </p>
        )}
      </div>
      {usable && (
        <Switch
          checked={on}
          label={`Answer ${state.name} prompts from the dashboard`}
          disabled={step.kind === "busy" || step.kind === "preview"}
          onChange={(next) => void run(next, true)}
        />
      )}
      {step.kind === "preview" && (
        <div className="setup-detail answer-detail">
          <p>
            This {step.to ? "adds" : "removes"} the answering entry in <code>{step.configPath}</code>. A
            backup is saved first.
          </p>
          <ul className="setup-changes">
            {step.summary.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {step.to && (
            <p>
              Any program on this computer can approve commands through this page, so don't turn this on on a
              shared computer. The command shown here stays in memory only.
            </p>
          )}
          <div className="setup-buttons">
            <button type="button" className="btn pri" onClick={() => void run(step.to, false)}>
              {step.to ? "Turn on" : "Turn off"}
            </button>
            <button type="button" className="btn sm" onClick={() => setStep({ kind: "idle" })}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {step.kind === "error" && (
        <div className="setup-detail setup-error answer-detail">
          <p>{step.message}</p>
        </div>
      )}
    </li>
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
