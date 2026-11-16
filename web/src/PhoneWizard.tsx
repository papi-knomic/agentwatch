import { type ReactNode, useCallback, useEffect, useState } from "react";
import { StatusIcon } from "./parts";
import { QrCode } from "./QrCode";
import { DeviceRow } from "./RemoteAccess";
import {
  createPairCode,
  getServeStatus,
  listDevices,
  NTFY_APP_STORE_URL,
  NTFY_PLAY_URL,
  type PairedDevice,
  type ServeOutcome,
  setServe,
  TAILSCALE_DOWNLOAD_URL,
} from "./remote";
import { getPhone, type PhoneSettings, savePhone } from "./setup";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * One flow for phone access: turn on Tailscale Serve (we run it, on click), install the apps, pair and subscribe to
 * notifications. Only on this PC's dashboard; the server refuses every endpoint used here for remote requests.
 * Advanced settings (host list, ntfy server, token) stay in the panels below it.
 */
export function PhoneWizard() {
  const [serve, setServeState] = useState<ServeOutcome | null>(null);
  const [phone, setPhone] = useState<PhoneSettings | null>(null);
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [pair, setPair] = useState<{ code: string; expiresAt: number; baseline: number } | null>(null);
  const [withNtfy, setWithNtfy] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [justPaired, setJustPaired] = useState<string | null>(null);

  const refresh = useCallback(() => {
    getServeStatus()
      .then(setServeState)
      .catch((error) => setServeState({ state: "error", message: messageOf(error) }));
    getPhone()
      .then(setPhone)
      .catch(() => {});
  }, []);
  const refreshDevices = useCallback(() => {
    listDevices()
      .then(setDevices)
      .catch(() => {});
  }, []);

  useEffect(refresh, [refresh]);

  const on = serve?.state === "on";
  useEffect(() => {
    if (!on) return;
    refreshDevices();
    const id = window.setInterval(refreshDevices, pair ? 2000 : 15_000);
    return () => window.clearInterval(id);
  }, [on, pair, refreshDevices]);

  useEffect(() => {
    if (!pair) return;
    const id = window.setTimeout(() => setPair(null), Math.max(pair.expiresAt - Date.now(), 0));
    return () => window.clearTimeout(id);
  }, [pair]);

  useEffect(() => {
    if (pair && devices.length > pair.baseline) {
      const newest = [...devices].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      setJustPaired(newest?.name ?? "Phone");
      setPair(null);
    }
  }, [pair, devices]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
    } catch (error) {
      setMessage(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  const turnOn = () =>
    run(async () => {
      const outcome = await setServe("on");
      setServeState(outcome);
      if (outcome.message) setMessage(outcome.message);
    });

  const turnOff = () =>
    run(async () => {
      const outcome = await setServe("off");
      setPair(null);
      setJustPaired(null);
      setMessage(outcome.message ?? "Phone access is off.");
      refresh();
    });

  const startPairing = () =>
    run(async () => {
      let current = phone;
      if (withNtfy && current && !current.enabled) {
        // A fresh random topic on the public ntfy.sh server; generic text only (includeDetails stays off).
        current = await savePhone({ enabled: true });
        setPhone(current);
      }
      const { code, expiresAt } = await createPairCode();
      setJustPaired(null);
      setPair({ code, expiresAt: Date.parse(expiresAt), baseline: devices.length });
    });

  if (!serve) return null;
  const host = serve.host;
  const pairUrl = pair && host ? `https://${host}/#pair=${pair.code}` : null;

  const step3 = !on ? "blocked" : justPaired || devices.length > 0 ? "done" : "current";
  return (
    <section className="settings-card phone-wizard" aria-labelledby="wizard-title">
      <h2 id="wizard-title">Set up phone</h2>
      <p className="settings-text">
        Watch your agents and get notifications on your phone. It stays inside your own Tailscale network;
        nothing is put on the public internet.
      </p>
      <ol className="stepper">
        <WizardStep n={1} title="On this PC" state={on ? "done" : "current"}>
          <PcStep serve={serve} busy={busy} onTurnOn={() => void turnOn()} onRecheck={refresh} />
          {message && (
            <p className="note err" role="alert">
              {message}
            </p>
          )}
        </WizardStep>

        <WizardStep n={2} title="On your phone" state="todo">
          <p>
            Install <strong>Tailscale</strong> and sign in with the same account as this PC (
            <a href={TAILSCALE_DOWNLOAD_URL} target="_blank" rel="noreferrer">
              download
            </a>
            ). For notifications, also install <strong>ntfy</strong>:{" "}
            <a href={NTFY_PLAY_URL} target="_blank" rel="noreferrer">
              Google Play
            </a>{" "}
            or{" "}
            <a href={NTFY_APP_STORE_URL} target="_blank" rel="noreferrer">
              App Store
            </a>
            .
          </p>
        </WizardStep>

        <WizardStep n={3} title="Pair" state={step3}>
          {!on ? (
            <p className="hint">Finish step 1 first.</p>
          ) : (
            <>
              <label className="check">
                <input
                  type="checkbox"
                  checked={withNtfy || phone?.enabled === true}
                  disabled={busy || phone?.enabled === true}
                  onChange={(e) => setWithNtfy(e.target.checked)}
                />
                Send notifications to this phone
                {phone?.enabled ? " (already on)" : ""}
              </label>
              <div className="actions">
                <button
                  type="button"
                  className="btn pri"
                  disabled={busy || !host}
                  onClick={() => void startPairing()}
                >
                  Show pairing code
                </button>
              </div>
              {pair && pairUrl && (
                <div className="pair-box">
                  <QrCode text={pairUrl} label="QR code to pair a phone" />
                  <p>
                    Scan with the phone's camera (Tailscale must be on). The code works once and expires in 2
                    minutes. After pairing, tap <strong>Get notifications</strong> on the phone.
                  </p>
                </div>
              )}
              {justPaired && (
                <p className="note ok" role="status">
                  Paired: {justPaired}
                </p>
              )}
              {devices.length > 0 && (
                <ul className="device-list">
                  {devices.map((device) => (
                    <DeviceRow
                      key={device.id}
                      device={device}
                      onChange={refreshDevices}
                      onError={(text) => setMessage(text)}
                    />
                  ))}
                </ul>
              )}
              <div className="actions">
                <button type="button" className="btn sm dng" disabled={busy} onClick={() => void turnOff()}>
                  Turn off phone access
                </button>
              </div>
            </>
          )}
        </WizardStep>
      </ol>
    </section>
  );
}

type StepState = "done" | "current" | "blocked" | "todo";

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
  serve: ServeOutcome;
  busy: boolean;
  onTurnOn: () => void;
  onRecheck: () => void;
}) {
  const recheck = (
    <button type="button" className="btn sm" disabled={busy} onClick={onRecheck}>
      Check again
    </button>
  );
  switch (serve.state) {
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
          , then{" "}
          <button type="button" className="btn pri" disabled={busy} onClick={onTurnOn}>
            Turn on phone access
          </button>{" "}
          again.
        </p>
      );
    case "port_in_use":
    case "error":
      return (
        <p className="note err">
          {serve.message ?? "Something went wrong."} {recheck}
        </p>
      );
    case "on":
      return (
        <p>
          Phone access is on{serve.host ? ` at https://${serve.host}` : ""}.{" "}
          <button type="button" className="btn sm" disabled={busy} onClick={onTurnOn}>
            Re-apply
          </button>
        </p>
      );
    case "off":
      return (
        <button type="button" className="btn pri" disabled={busy} onClick={onTurnOn}>
          {busy ? "Turning on…" : "Turn on phone access"}
        </button>
      );
  }
}
