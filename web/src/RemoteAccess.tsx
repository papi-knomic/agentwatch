import { useCallback, useEffect, useState } from "react";
import { QrCode } from "./QrCode";
import {
  createPairCode,
  detectRemoteHost,
  getRemoteSettings,
  listDevices,
  type PairedDevice,
  type RemoteSettings,
  revokeDevice,
  saveRemoteSettings,
  updateDevice,
} from "./remote";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Phone access through Tailscale Serve (opt-in). Only on this PC's dashboard: the server refuses all of these
 * endpoints for remote requests, and a phone never reaches this component.
 */
export function RemoteAccess() {
  const [settings, setSettings] = useState<RemoteSettings | null>(null);
  const [hostInput, setHostInput] = useState("");
  const [devices, setDevices] = useState<PairedDevice[]>([]);
  const [pair, setPair] = useState<{ code: string; expiresAt: number; baseline: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refreshDevices = useCallback(() => {
    listDevices()
      .then(setDevices)
      .catch(() => {});
  }, []);

  useEffect(() => {
    getRemoteSettings()
      .then((value) => {
        setSettings(value);
        setHostInput(value.hosts.join(", "));
      })
      .catch(() => setSettings(null));
  }, []);

  const enabled = settings?.enabled === true;
  useEffect(() => {
    if (!enabled) return;
    refreshDevices();
    // While a code is on screen, notice quickly that the phone used it.
    const id = window.setInterval(refreshDevices, pair ? 2000 : 15_000);
    return () => window.clearInterval(id);
  }, [enabled, pair, refreshDevices]);

  useEffect(() => {
    if (!pair) return;
    const left = pair.expiresAt - Date.now();
    const id = window.setTimeout(() => setPair(null), Math.max(left, 0));
    return () => window.clearTimeout(id);
  }, [pair]);

  useEffect(() => {
    // A new device while the QR code is up means it worked.
    if (pair && devices.length > pair.baseline) setPair(null);
  }, [pair, devices]);

  if (!settings) return null;

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

  const hostsFromInput = () =>
    hostInput
      .split(/[\s,]+/)
      .map((h) => h.trim())
      .filter(Boolean);

  const save = (next: boolean) =>
    run(async () => {
      // Turning off keeps the stored hosts: whatever is half-typed in the box isn't validated then.
      const value = await saveRemoteSettings(next, next ? hostsFromInput() : settings.hosts);
      setSettings(value);
      setHostInput(value.hosts.join(", "));
      if (!next) setPair(null);
    });

  const detect = () =>
    run(async () => {
      const { host } = await detectRemoteHost();
      if (host) setHostInput(host);
      else
        setMessage(
          "Couldn't read the name from Tailscale. Is it installed and running? Type the host instead.",
        );
    });

  const startPairing = () =>
    run(async () => {
      const { code, expiresAt } = await createPairCode();
      setPair({ code, expiresAt: Date.parse(expiresAt), baseline: devices.length });
    });

  const host = settings.hosts[0];
  const pairUrl = pair && host ? `https://${host}/#pair=${pair.code}` : null;
  const command = `tailscale serve --bg ${settings.port}`;

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be denied; the text is shown to select by hand.
    }
  };

  return (
    <div className="setup-remote remote-access">
      <div className="setup-row-main">
        <span className="setup-name">Phone (remote access)</span>
        <span className="setup-path">
          Watch your agents from your phone through Tailscale. Off by default; nothing is exposed to the
          internet.
        </span>
      </div>
      <div className="setup-row-action">
        <button type="button" className="open-button" disabled={busy} onClick={() => void save(!enabled)}>
          {enabled ? "Turn off" : "Turn on"}
        </button>
      </div>

      <div className="setup-detail">
        <label className="phone-field">
          Your Tailscale host{" "}
          <input
            type="text"
            value={hostInput}
            placeholder="mybox.tail1234.ts.net"
            spellCheck={false}
            autoCapitalize="none"
            onChange={(e) => setHostInput(e.target.value)}
          />
        </label>
        <div className="setup-buttons">
          <button type="button" className="text-button" disabled={busy} onClick={() => void detect()}>
            Detect
          </button>
          {enabled && (
            <button
              type="button"
              className="text-button"
              disabled={busy || hostInput.trim() === settings.hosts.join(", ")}
              onClick={() => void save(true)}
            >
              Save host
            </button>
          )}
        </div>
        {message && (
          <p className="setup-error" role="alert">
            {message}
          </p>
        )}

        {enabled && (
          <>
            <p>
              Run this once on this PC (check <code>tailscale serve --help</code> if your version differs):{" "}
              <code>{command}</code>{" "}
              <button type="button" className="text-button" onClick={() => void copy(command)}>
                {copied ? "Copied" : "Copy"}
              </button>
            </p>
            <p className="remote-warn">
              Never use <strong>Tailscale Funnel</strong> for this. Funnel puts the dashboard on the public
              internet. AgentWatch only supports Serve, which stays inside your own tailnet.
            </p>

            <div className="setup-buttons">
              <button
                type="button"
                className="primary-button"
                disabled={busy || !host}
                onClick={() => void startPairing()}
              >
                Pair a phone
              </button>
            </div>
            {pair && pairUrl && (
              <div className="pair-box">
                <QrCode text={pairUrl} label="QR code to pair a phone" />
                <p>
                  Scan with the phone's camera (Tailscale must be on). The code works once and expires in 2
                  minutes.
                </p>
                <p className="pair-url">
                  <code>{pairUrl}</code>
                </p>
              </div>
            )}

            <h3 className="remote-subhead">Paired phones</h3>
            {devices.length === 0 ? (
              <p className="remote-hint">None yet.</p>
            ) : (
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
          </>
        )}
      </div>
    </div>
  );
}

function DeviceRow({
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
      <span className="device-seen">Last seen {new Date(device.lastSeenAt).toLocaleString()}</span>
      <label className="device-approve">
        <input
          type="checkbox"
          checked={device.allowApprovals}
          onChange={(e) => void act(() => updateDevice(device.id, { allowApprovals: e.target.checked }))}
        />
        Allow approvals
      </label>
      <button type="button" className="deny-button" onClick={() => void act(() => revokeDevice(device.id))}>
        Revoke
      </button>
    </li>
  );
}
