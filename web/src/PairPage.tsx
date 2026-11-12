import { useState } from "react";
import { APP_DISPLAY_NAME } from "../../src/core/constants.js";
import { clearHash, defaultDeviceName, pairDevice } from "./remote";

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
    <main className="remote-screen">
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
        <button type="submit" className="primary-button remote-big" disabled={busy || error !== null}>
          {busy ? "Pairing…" : "Pair"}
        </button>
      </form>
    </main>
  );
}

export function NotPaired() {
  return (
    <main className="remote-screen">
      <div className="remote-card">
        <h1>{APP_DISPLAY_NAME}</h1>
        <p>This phone isn't paired. Pair it from the dashboard on your PC.</p>
        <p className="remote-hint">
          On your PC open {APP_DISPLAY_NAME}, go to Phone (remote access), press "Pair a phone" and scan the
          code with this phone's camera.
        </p>
      </div>
    </main>
  );
}
