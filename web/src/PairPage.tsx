import { useEffect, useState } from "react";
import { APP_DISPLAY_NAME } from "../../src/core/constants.js";
import { CopyButton, NtfySteps } from "./PhoneParts";
import { clearHash, defaultDeviceName, getNtfyLink, type NtfyLink, pairDevice } from "./remote";

/** What a phone shows after scanning the QR code from the dashboard on the PC. */
export function PairPage({ code, onPaired }: { code: string; onPaired: () => void }) {
  const [name, setName] = useState(defaultDeviceName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: { preventDefault: () => void }) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const result = await pairDevice(code, name.trim() || defaultDeviceName());
    // The code is single-use whatever happened, so it has no business staying in the address bar.
    clearHash();
    setBusy(false);
    if (result.ok) onPaired();
    else setError(result.message);
  };

  return (
    <main className="remote-screen aw">
      <form className="remote-card" onSubmit={(e) => void submit(e)}>
        <h1>Pair this phone</h1>
        <p>
          Give it a name so you can tell your devices apart on your PC. After pairing you can watch your
          agents from here.
        </p>
        <label className="remote-field">
          Device name
          <input
            type="text"
            value={name}
            maxLength={40}
            autoComplete="off"
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {error && (
          <p className="remote-error" role="alert">
            {error === "Too many attempts — make a new code on your PC"
              ? `${error}.`
              : `${error}. Make a new code from the dashboard on your PC.`}
          </p>
        )}
        <button type="submit" className="btn pri remote-big" disabled={busy || error !== null}>
          {busy ? "Pairing…" : "Pair"}
        </button>
      </form>
    </main>
  );
}

export function NotPaired() {
  return (
    <main className="remote-screen aw">
      <div className="remote-card">
        <h1>{APP_DISPLAY_NAME}</h1>
        <p>This phone isn't paired. Pair it from the dashboard on your PC.</p>
        <p className="remote-hint">
          On your PC open {APP_DISPLAY_NAME}, go to Settings, Phone, press "Pair a phone" and scan the code
          with this phone's camera.
        </p>
      </div>
    </main>
  );
}

const HIDE_KEY = "agentwatch.hideNtfyBanner";

/**
 * "Get notifications": a banner that opens short steps for subscribing the ntfy app to this PC's topic. The main link
 * is https (iOS ignores ntfy:// links, observed); the ntfy:// deep link is only an extra on Android. Renders nothing
 * when push notifications are off.
 */
export function GetNotifications() {
  const [ntfy, setNtfy] = useState<NtfyLink | null>(null);
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(() => {
    try {
      return window.localStorage.getItem(HIDE_KEY) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    getNtfyLink()
      .then(setNtfy)
      .catch(() => setNtfy(null));
  }, []);
  if (!ntfy?.enabled || hidden) return null;
  const hide = () => {
    setHidden(true);
    try {
      window.localStorage.setItem(HIDE_KEY, "1");
    } catch {
      // Private mode: the banner just comes back next time.
    }
  };
  const android = /Android/.test(navigator.userAgent);
  return (
    <>
      <div className="banner">
        <svg
          viewBox="0 0 16 16"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M4 11.5V7a4 4 0 0 1 8 0v4.5l1 1H3zM6.5 14h3" />
        </svg>
        <p>
          <b>Get notifications</b> on this phone
          <span className="sub">Free push alerts through the ntfy app</span>
        </p>
        <button
          type="button"
          className="btn sm pri"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "Close" : "Set up"}
        </button>
        <button type="button" className="btn sm ico ghost" aria-label="Hide this banner" onClick={hide}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
          </svg>
        </button>
      </div>
      {open && (
        <section className="notify-panel" aria-label="Get notifications">
          <NtfySteps server={ntfy.server} onPhone />
          <div className="field">
            <span className="field-label">Topic</span>
            <div className="field-row">
              <code className="host-text">{ntfy.topic}</code>
              <CopyButton text={ntfy.topic} label="Copy topic" />
            </div>
          </div>
          <div className="actions">
            <a className="btn sm" href={ntfy.web} target="_blank" rel="noreferrer">
              Open link
            </a>
            {android && (
              <a className="btn sm" href={ntfy.link}>
                Open in ntfy app
              </a>
            )}
          </div>
        </section>
      )}
    </>
  );
}
