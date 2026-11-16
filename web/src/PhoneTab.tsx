import { type ReactNode, useState } from "react";
import { CopyButton, FeatureHead, NtfySteps, Pill, Switch } from "./PhoneParts";
import { StatusIcon } from "./parts";
import {
  lastSeen,
  ntfyServerLabel,
  ntfySubscribeUrl,
  pairedSummary,
  type RemoteView,
  remoteView,
  type StepState,
  stepStates,
} from "./phoneView";
import { QrCode } from "./QrCode";
import {
  type PairedDevice,
  revokeDevice,
  type ServeOutcome,
  TAILSCALE_DOWNLOAD_URL,
  updateDevice,
} from "./remote";
import { type PhoneSettings, testPhone } from "./setup";
import { messageOf, type PhoneModel, usePhone } from "./usePhone";

/**
 * The whole Phone tab on this PC's dashboard: a setup wizard on top, then one card per feature. All of it reads one
 * shared model (usePhone), so a change made anywhere shows up everywhere.
 */
export function PhoneTab() {
  const model = usePhone();
  if (!model.remote && !model.phone) return null;
  const view = remoteView(model.remote, model.serve, model.devices);
  return (
    <>
      <Wizard model={model} view={view} />
      {model.phone && <PushCard model={model} phone={model.phone} />}
      {model.remote && <RemoteCard model={model} view={view} />}
    </>
  );
}

/* ---------------------------------------------------------------- wizard */

function Wizard({ model, view }: { model: PhoneModel; view: RemoteView }) {
  const { serve, busy, message, pair, justPaired, phone } = model;
  const [withPush, setWithPush] = useState(true);
  const [s1, s2, s3] = stepStates(view);
  const pushOn = phone?.enabled === true;
  const pairUrl = pair?.from === "wizard" && view.address ? `${view.address}/#pair=${pair.code}` : null;

  return (
    <section className="settings-card phone-wizard" aria-labelledby="wizard-title">
      <h2 id="wizard-title">Set up phone</h2>
      <p className="settings-text">
        Watch your agents and get notifications on your phone. It stays inside your own Tailscale network;
        nothing is put on the public internet.
      </p>
      <ol className="stepper">
        <WizardStep n={1} title="On this PC" state={s1}>
          {view.on ? (
            <p>
              Phone access is on at <code>{view.address}</code>.{" "}
              {view.mappingMissing && (
                <span className="inline-warn">Tailscale isn't forwarding it right now. </span>
              )}
              <button
                type="button"
                className="btn sm"
                disabled={busy}
                onClick={() => void model.setAccess(true)}
              >
                Re-apply
              </button>
            </p>
          ) : (
            <PcStep
              serve={serve}
              busy={busy}
              onTurnOn={() => void model.setAccess(true)}
              onRecheck={() => void model.reload()}
            />
          )}
          {message && (
            <p className="note err" role="alert">
              {message}
            </p>
          )}
        </WizardStep>

        <WizardStep n={2} title="On your phone" state={s2}>
          <p>
            Install <strong>Tailscale</strong> and sign in with the same account as this PC (
            <a href={TAILSCALE_DOWNLOAD_URL} target="_blank" rel="noreferrer">
              download
            </a>
            ). For push notifications also install <strong>ntfy</strong>; the Push notifications card below
            has the links.
          </p>
        </WizardStep>

        <WizardStep n={3} title="Pair" state={s3}>
          {!view.on ? (
            <p className="hint">Finish step 1 first.</p>
          ) : (
            <>
              {view.paired && (
                <p className="note ok" role="status">
                  Paired: {pairedSummary(view.pairedNames)}
                </p>
              )}
              {!pushOn && (
                <label className="opt-row">
                  <input
                    type="checkbox"
                    checked={withPush}
                    disabled={busy}
                    onChange={(e) => setWithPush(e.target.checked)}
                  />
                  <span className="opt-text">
                    <span className="opt-title">Also turn on push notifications</span>
                    <span className="opt-desc">Uses the free ntfy app. You can change this below.</span>
                  </span>
                </label>
              )}
              <div className="actions">
                <button
                  type="button"
                  className={`btn${view.paired ? "" : " pri"}`}
                  disabled={busy || !view.host}
                  onClick={() => void model.startPairing("wizard", withPush && !pushOn)}
                >
                  {view.paired ? "Pair another phone" : "Show pairing code"}
                </button>
              </div>
              {pair?.from === "wizard" && pairUrl && <PairBox url={pairUrl} />}
              {justPaired && !view.paired && (
                <p className="note ok" role="status">
                  Paired: {justPaired}
                </p>
              )}
              {view.paired && pushOn && (
                <p className="hint">On the phone, tap Get notifications to subscribe to push.</p>
              )}
            </>
          )}
        </WizardStep>
      </ol>
    </section>
  );
}

function PairBox({ url }: { url: string }) {
  return (
    <div className="pair-box">
      <QrCode text={url} label="QR code to pair a phone" />
      <div className="pair-text">
        <p>
          <strong>Scan with the phone's camera.</strong> Tailscale must be on. The code works once and expires
          in 2 minutes.
        </p>
        <p className="pair-url">
          <code>{url}</code>
        </p>
      </div>
    </div>
  );
}

function WizardStep({
  n,
  title,
  state,
  children,
}: {
  n: number;
  title: string;
  state: StepState;
  children: ReactNode;
}) {
  const label = { done: "Done", current: "Next", blocked: "Waiting", todo: "" }[state];
  return (
    <li className={`step ${state}`}>
      <span className="step-mark">
        <StatusIcon
          status={state === "done" ? "done" : state === "current" ? "needs_input" : "idle"}
          decorative
        />
      </span>
      <div className="step-body">
        <h3>
          <span className="step-n">Step {n}</span>
          {title}
          {label && <span className="step-state">{label}</span>}
        </h3>
        {children}
      </div>
    </li>
  );
}

function PcStep({
  serve,
  busy,
  onTurnOn,
  onRecheck,
}: {
  serve: ServeOutcome | null;
  busy: boolean;
  onTurnOn: () => void;
  onRecheck: () => void;
}) {
  const recheck = (
    <button type="button" className="btn sm" disabled={busy} onClick={onRecheck}>
      Check again
    </button>
  );
  const turnOn = (
    <button type="button" className="btn pri" disabled={busy} onClick={onTurnOn}>
      {busy ? "Turning on…" : "Turn on phone access"}
    </button>
  );
  switch (serve?.state) {
    case "not_installed":
      return (
        <p>
          Tailscale isn't installed on this PC.{" "}
          <a href={TAILSCALE_DOWNLOAD_URL} target="_blank" rel="noreferrer">
            Download Tailscale
          </a>
          , sign in, then {recheck}
        </p>
      );
    case "logged_out":
      return <p>Open the Tailscale app on this PC and sign in, then {recheck}</p>;
    case "needs_consent":
      return (
        <p>
          Tailscale needs HTTPS turned on for your network (once).{" "}
          {serve.consentUrl && (
            <a href={serve.consentUrl} target="_blank" rel="noreferrer">
              Enable HTTPS in Tailscale
            </a>
          )}
          , then {turnOn}
        </p>
      );
    case "port_in_use":
    case "error":
      return (
        <p className="note err">
          {serve.message ?? "Something went wrong."} {recheck}
        </p>
      );
    default:
      return turnOn;
  }
}

/* ------------------------------------------------------ push notifications */

function PushCard({ model, phone }: { model: PhoneModel; phone: PhoneSettings }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [server, setServer] = useState(phone.server);
  const [token, setToken] = useState("");
  const topicUrl = phone.topic ? ntfySubscribeUrl(phone.server, phone.topic) : "";

  const apply = async (update: Parameters<PhoneModel["updatePhone"]>[0]) => {
    setBusy(true);
    setResult(null);
    try {
      const next = await model.updatePhone(update);
      setServer(next.server);
      if (update.token !== undefined) setToken("");
    } catch (error) {
      setResult({ ok: false, text: messageOf(error) });
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await testPhone();
      setResult(
        r.ok
          ? { ok: true, text: "Sent. It should arrive on your phone in a few seconds." }
          : { ok: false, text: r.error ?? "Could not send." },
      );
    } catch (error) {
      setResult({ ok: false, text: messageOf(error) });
    } finally {
      setBusy(false);
    }
  };

  const serverChanged = server.trim() !== phone.server;
  const dirty = serverChanged || token.trim() !== "";

  return (
    <section className="settings-card feature-card" aria-labelledby="push-title">
      <FeatureHead
        id="push-title"
        title="Push notifications"
        description="Get a push on your phone when an agent needs you or finishes. Uses the free ntfy app; your topic is a private channel name, and anyone who knows it can read the pushes."
        on={phone.enabled}
        switchLabel="Push notifications"
        onToggle={(next) => void apply({ enabled: next })}
        disabled={busy}
      />

      {phone.enabled && (
        <>
          <div className="push-grid">
            {topicUrl && (
              <figure className="push-qr">
                <QrCode text={topicUrl} label="QR code with the link to your ntfy topic" />
                <figcaption>Scan with the phone's camera</figcaption>
              </figure>
            )}
            <NtfySteps
              server={phone.server}
              after={
                <>
                  Press <strong>Send test</strong> below.
                </>
              }
            />
          </div>

          <div className="field">
            <label htmlFor="push-topic">Topic</label>
            <div className="field-row">
              <input id="push-topic" type="text" readOnly value={phone.topic} className="mono" />
              <CopyButton text={phone.topic} label="Copy topic" />
              <button
                type="button"
                className="btn sm"
                disabled={busy}
                onClick={() => void apply({ regenerateTopic: true })}
              >
                New topic
              </button>
            </div>
            <p className="field-hint">
              Server: {ntfyServerLabel(phone.server)}. A new topic stops the old one; subscribe again.
            </p>
          </div>

          <div className="action-line">
            <button type="button" className="btn pri" disabled={busy} onClick={() => void test()}>
              Send test
            </button>
            {result && (
              <span className={`result ${result.ok ? "ok" : "err"}`} role="status">
                {result.text}
              </span>
            )}
          </div>

          <label className="opt-row">
            <input
              type="checkbox"
              checked={phone.includeDetails}
              disabled={busy}
              onChange={(e) => void apply({ includeDetails: e.target.checked })}
            />
            <span className="opt-text">
              <span className="opt-title">Include project and task names</span>
              <span className="opt-desc">
                Off: pushes only say "Needs your input" or "Finished". On: they also show the project folder
                name, the task title and the agent's short message, which then pass through the ntfy server
                and your phone vendor's push service. Full paths, prompts and transcripts are never sent.
              </span>
            </span>
          </label>

          <details className="mini-disclosure">
            <summary>Use your own ntfy server</summary>
            <div className="field">
              <label htmlFor="push-server">Server</label>
              <input id="push-server" type="url" value={server} onChange={(e) => setServer(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="push-token">
                Access token <Pill on={phone.tokenSet}>{phone.tokenSet ? "Token set" : "Not set"}</Pill>
              </label>
              <input
                id="push-token"
                type="password"
                autoComplete="off"
                placeholder={
                  phone.tokenSet ? "Enter a new token to replace it" : "Optional, for protected servers"
                }
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </div>
            <div className="actions">
              <button
                type="button"
                className="btn sm pri"
                disabled={busy || !dirty}
                onClick={() =>
                  void apply({
                    ...(serverChanged ? { server: server.trim() } : {}),
                    ...(token.trim() !== "" ? { token } : {}),
                  })
                }
              >
                Save
              </button>
              {phone.tokenSet && (
                <button
                  type="button"
                  className="btn sm"
                  disabled={busy}
                  onClick={() => void apply({ token: "" })}
                >
                  Remove token
                </button>
              )}
            </div>
          </details>
        </>
      )}
    </section>
  );
}

/* ----------------------------------------------------------- phone access */

function RemoteCard({ model, view }: { model: PhoneModel; view: RemoteView }) {
  const { busy, pair, devices, serve, message } = model;
  const [editing, setEditing] = useState(false);
  const [hostInput, setHostInput] = useState("");
  const [localMessage, setLocalMessage] = useState<string | null>(null);
  const pairUrl = pair?.from === "card" && view.address ? `${view.address}/#pair=${pair.code}` : null;
  const command = `tailscale serve --bg --yes --https=443 http://127.0.0.1:${model.remote?.port ?? 7878}`;
  const blocked = !view.on && serve !== null && serve.state !== "off" && serve.state !== "on";

  const startEdit = () => {
    setHostInput((model.remote?.hosts ?? []).join(", "));
    setLocalMessage(null);
    setEditing(true);
  };
  const detect = async () => {
    setLocalMessage(null);
    try {
      const host = await model.detectHost();
      if (host) setHostInput(host);
      else
        setLocalMessage(
          "Couldn't read the name from Tailscale. Is it installed and running? Type the host instead.",
        );
    } catch (error) {
      setLocalMessage(messageOf(error));
    }
  };
  const saveHost = async () => {
    await model.saveHost(
      hostInput
        .split(/[\s,]+/)
        .map((h) => h.trim())
        .filter(Boolean),
    );
    setEditing(false);
  };

  return (
    <section className="settings-card feature-card" aria-labelledby="remote-title">
      <FeatureHead
        id="remote-title"
        title="Phone access"
        description="Watch your agents from your phone through Tailscale. Nothing is exposed to the internet."
        on={view.on}
        switchLabel="Phone access"
        onToggle={(next) => void model.setAccess(next)}
        disabled={busy}
      />

      {!view.on && (
        <p className="hint">
          {blocked
            ? "Phone access needs a step in Set up phone above before it can be turned on."
            : "Turn it on to get a pairing code for your phone."}
        </p>
      )}

      {view.on && (
        <>
          <div className="field">
            <span className="field-label">Address</span>
            {editing ? (
              <>
                <div className="field-row">
                  <input
                    type="text"
                    aria-label="Your Tailscale host"
                    value={hostInput}
                    placeholder="mybox.tail1234.ts.net"
                    spellCheck={false}
                    autoCapitalize="none"
                    onChange={(e) => setHostInput(e.target.value)}
                  />
                  <button type="button" className="btn sm" disabled={busy} onClick={() => void detect()}>
                    Detect
                  </button>
                </div>
                <div className="actions">
                  <button
                    type="button"
                    className="btn sm pri"
                    disabled={busy || hostInput.trim() === "" || hostInput.trim() === view.host}
                    onClick={() => void saveHost()}
                  >
                    Save host
                  </button>
                  <button type="button" className="btn sm" onClick={() => setEditing(false)}>
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <div className="field-row">
                <code className="host-text">{view.address ?? "No host yet"}</code>
                <button type="button" className="btn sm" onClick={startEdit}>
                  Edit
                </button>
              </div>
            )}
            {(localMessage || message) && (
              <p className="note err" role="alert">
                {localMessage ?? message}
              </p>
            )}
            {view.mappingMissing && (
              <p className="note err" role="alert">
                Tailscale isn't forwarding this address right now.{" "}
                <button
                  type="button"
                  className="btn sm"
                  disabled={busy}
                  onClick={() => void model.setAccess(true)}
                >
                  Re-apply
                </button>
              </p>
            )}
          </div>

          <div className="action-line">
            <button
              type="button"
              className="btn pri"
              disabled={busy || !view.host}
              onClick={() => void model.startPairing("card", false)}
            >
              Pair a phone
            </button>
          </div>
          {pair?.from === "card" && pairUrl && <PairBox url={pairUrl} />}

          <h3 className="sub-head">Paired phones</h3>
          {devices.length === 0 ? (
            <p className="hint">None yet.</p>
          ) : (
            <ul className="device-list">
              {devices.map((device) => (
                <DeviceRow
                  key={device.id}
                  device={device}
                  onChange={model.reloadDevices}
                  onError={model.setMessage}
                />
              ))}
            </ul>
          )}

          <p className="funnel-note">
            Never use <strong>Tailscale Funnel</strong> for this: it puts the dashboard on the public
            internet. AgentWatch only supports Serve, which stays inside your own tailnet.
          </p>
          <details className="mini-disclosure">
            <summary>Run Tailscale Serve yourself</summary>
            <p className="hint">The wizard does this for you. To do it by hand, run once on this PC:</p>
            <div className="field-row">
              <code className="host-text">{command}</code>
              <CopyButton text={command} />
            </div>
          </details>
        </>
      )}
    </section>
  );
}

export function DeviceRow({
  device,
  onChange,
  onError,
}: {
  device: PairedDevice;
  onChange: () => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState(device.name);
  const act = async (action: () => Promise<unknown>) => {
    try {
      await action();
      onChange();
    } catch (error) {
      onError(messageOf(error));
    }
  };
  return (
    <li className="device-row">
      <div className="device-id">
        <input
          type="text"
          className="device-name"
          aria-label="Device name"
          value={name}
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
          onBlur={() =>
            name.trim() !== "" && name !== device.name && void act(() => updateDevice(device.id, { name }))
          }
        />
        <span className="device-seen">Last seen {lastSeen(device.lastSeenAt)}</span>
      </div>
      <div className="device-approve">
        <span>Allow approvals</span>
        <Switch
          checked={device.allowApprovals}
          label={`Allow approvals from ${device.name}`}
          onChange={(next) => void act(() => updateDevice(device.id, { allowApprovals: next }))}
        />
      </div>
      <button type="button" className="btn sm dng" onClick={() => void act(() => revokeDevice(device.id))}>
        Revoke
      </button>
    </li>
  );
}
