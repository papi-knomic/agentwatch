import { useEffect, useState } from "react";
import { QrCode } from "./QrCode";
import { getPhone, type PhoneSettings, type PhoneUpdate, savePhone, testPhone } from "./setup";

/**
 * Opt-in push notifications to a phone through ntfy. Only shown on this computer's dashboard: the topic is the
 * secret on the public ntfy.sh server, and the access token is write-only (the server never sends it back).
 */
export function PhoneNotifications() {
  const [phone, setPhone] = useState<PhoneSettings | null>(null);
  const [server, setServer] = useState("");
  const [token, setToken] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    getPhone()
      .then((value) => {
        setPhone(value);
        setServer(value.server);
      })
      .catch(() => setPhone(null));
  }, []);

  if (!phone) return null;

  const save = async (update: PhoneUpdate) => {
    setBusy(true);
    setMessage(null);
    try {
      const next = await savePhone(update);
      setPhone(next);
      setServer(next.server);
      if (update.token !== undefined) setToken("");
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await testPhone();
      setMessage(
        result.ok
          ? { ok: true, text: "Sent. It should arrive on your phone in a few seconds." }
          : { ok: false, text: result.error ?? "Could not send." },
      );
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  const subscribeUrl = phone.topic ? `${phone.server.replace(/\/+$/, "")}/${phone.topic}` : "";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(phone.topic);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be denied; the topic is shown to select by hand.
    }
  };

  return (
    <div className="setup-remote phone-settings">
      <div className="setup-row-main">
        <span className="setup-name">Phone notifications (ntfy)</span>
        <span className="setup-path">
          Get a push on your phone when an agent needs you or finishes. Off by default.
        </span>
      </div>
      <div className="setup-row-action">
        <button
          type="button"
          className="open-button"
          disabled={busy}
          onClick={() => void save({ enabled: !phone.enabled })}
        >
          {phone.enabled ? "Turn off" : "Turn on"}
        </button>
      </div>

      {phone.enabled && (
        <div className="setup-detail">
          <p>
            1. Install the <strong>ntfy</strong> app on your phone. 2. Subscribe to the topic below
            {phone.server === "https://ntfy.sh" ? "" : " on your server"}. 3. Press "Send test".
          </p>
          <p>
            Topic: <code>{phone.topic}</code>{" "}
            <button type="button" className="text-button" onClick={() => void copy()}>
              {copied ? "Copied" : "Copy"}
            </button>{" "}
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() => void save({ regenerateTopic: true })}
            >
              New topic
            </button>
          </p>
          {subscribeUrl && (
            <div className="pair-box">
              <QrCode text={subscribeUrl} label="QR code to subscribe to the ntfy topic" />
              <p>Scan with your phone's camera to open the topic in the ntfy app.</p>
            </div>
          )}
          <p>
            Or open <a href={subscribeUrl}>{subscribeUrl}</a> on your phone. On the public ntfy.sh server
            anyone who knows the topic can read your notifications, so keep it private.
          </p>

          <label className="phone-field">
            Server{" "}
            <input
              type="url"
              value={server}
              onChange={(e) => setServer(e.target.value)}
              onBlur={() => server !== phone.server && void save({ server })}
            />
          </label>
          <label className="phone-field">
            Access token ({phone.tokenSet ? "set" : "not set"}){" "}
            <input
              type="password"
              autoComplete="off"
              placeholder={
                phone.tokenSet ? "enter a new token to replace it" : "optional, for protected servers"
              }
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
          <div className="setup-buttons">
            <button
              type="button"
              className="text-button"
              disabled={busy || token.trim() === ""}
              onClick={() => void save({ token })}
            >
              Save token
            </button>
            {phone.tokenSet && (
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => void save({ token: "" })}
              >
                Remove token
              </button>
            )}
          </div>

          <label className="phone-field">
            <input
              type="checkbox"
              checked={phone.includeDetails}
              disabled={busy}
              onChange={(e) => void save({ includeDetails: e.target.checked })}
            />{" "}
            Include project and task names
          </label>
          <p className="setup-path">
            Off: pushes say only "Needs your input" or "Finished". On: they also include the project folder
            name, the task title and the agent's short message, which then pass through the ntfy server and
            your phone vendor's push service. Full paths, prompts and transcripts are never sent.
          </p>

          <div className="setup-buttons">
            <button type="button" className="primary-button" disabled={busy} onClick={() => void test()}>
              Send test
            </button>
          </div>
        </div>
      )}
      {message && (
        <div className={`setup-detail${message.ok ? "" : " setup-error"}`}>
          <p>{message.text}</p>
        </div>
      )}
    </div>
  );
}
