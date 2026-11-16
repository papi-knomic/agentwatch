import { type ReactNode, useState } from "react";
import { ntfyServerLabel } from "./phoneView";
import { NTFY_APP_STORE_URL, NTFY_PLAY_URL } from "./remote";

/** One on/off control for every feature on the Phone tab. */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`switch${checked ? " on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-thumb" />
    </button>
  );
}

export function Pill({ on, children }: { on: boolean; children: ReactNode }) {
  return <span className={`pill ${on ? "pill-on" : "pill-off"}`}>{children}</span>;
}

/** Card header: title, one-line description, status pill and the switch. */
export function FeatureHead({
  id,
  title,
  description,
  on,
  onLabel = "On",
  offLabel = "Off",
  switchLabel,
  onToggle,
  disabled,
}: {
  id: string;
  title: string;
  description: ReactNode;
  on: boolean;
  onLabel?: string;
  offLabel?: string;
  switchLabel: string;
  onToggle: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <header className="feature-head">
      <div className="feature-text">
        <h2 id={id}>
          {title} <Pill on={on}>{on ? onLabel : offLabel}</Pill>
        </h2>
        <p className="settings-text">{description}</p>
      </div>
      <Switch checked={on} onChange={onToggle} label={switchLabel} disabled={disabled} />
    </header>
  );
}

export function CopyButton({
  text,
  label = "Copy",
  small = true,
}: {
  text: string;
  label?: string;
  small?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be denied; the text stays on screen to select by hand.
    }
  };
  return (
    <button type="button" className={`btn${small ? " sm" : ""}`} onClick={() => void copy()}>
      {copied ? "Copied" : label}
    </button>
  );
}

type Platform = "iphone" | "android";

/**
 * How to subscribe the ntfy app to a topic, per platform. iOS ignores ntfy:// links (observed) and its camera only acts
 * on https, so the supported route there is pasting the topic into the app. `after` is an extra last step (the
 * dashboard adds "Send test").
 */
export function NtfySteps({
  server,
  onPhone,
  after,
}: {
  server: string;
  onPhone?: boolean;
  after?: ReactNode;
}) {
  const [platform, setPlatform] = useState<Platform>(() =>
    onPhone && /Android/.test(navigator.userAgent) ? "android" : "iphone",
  );
  const label = ntfyServerLabel(server);
  return (
    <ol className="ntfy-steps">
      <li>
        Install the free <strong>ntfy</strong> app:{" "}
        <a href={NTFY_PLAY_URL} target="_blank" rel="noreferrer">
          Google Play
        </a>{" "}
        or{" "}
        <a href={NTFY_APP_STORE_URL} target="_blank" rel="noreferrer">
          App Store
        </a>
        .
      </li>
      <li>
        <div className="seg" role="tablist" aria-label="Your phone">
          {(["iphone", "android"] as const).map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={platform === p}
              className={platform === p ? "on" : ""}
              onClick={() => setPlatform(p)}
            >
              {p === "iphone" ? "iPhone" : "Android"}
            </button>
          ))}
        </div>
        {platform === "iphone" ? (
          <>
            Open ntfy, tap <strong>+</strong>, paste the topic, keep the server <code>{label}</code>, then tap{" "}
            <strong>Subscribe</strong>.
          </>
        ) : (
          <>
            {onPhone ? (
              <>
                Tap <strong>Open link</strong> below.
              </>
            ) : (
              "Scan the code with the camera."
            )}{" "}
            Or open ntfy, tap <strong>+</strong>, paste the topic and tap <strong>Subscribe</strong>.
          </>
        )}
      </li>
      {after && <li>{after}</li>}
    </ol>
  );
}
