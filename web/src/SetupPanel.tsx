import { type CSSProperties, useState } from "react";
import { type ConnectResult, connectTool, type Setup, type SetupTool } from "./setup";

const OPEN_KEY = "setup-panel-open";

function readOpen(): boolean | null {
  try {
    const value = localStorage.getItem(OPEN_KEY);
    return value === null ? null : value === "true";
  } catch {
    return null;
  }
}

function writeOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, String(open));
  } catch {
    // Only a convenience; the panel works without it.
  }
}

/**
 * How to connect each agent. Prominent when nothing is running yet (it's the first thing a new user
 * needs), a one-line summary that expands otherwise.
 */
export function SetupPanel(props: { setup: Setup; onSetup: (setup: Setup) => void; prominent: boolean }) {
  const { setup, onSetup, prominent } = props;
  const connected = setup.tools.filter((tool) => tool.connected).length;
  const [open, setOpen] = useState(() => readOpen() ?? connected < setup.tools.length);
  const expanded = prominent || open;

  const toggle = () => {
    setOpen(!expanded);
    writeOpen(!expanded);
  };

  return (
    <section className={`setup${prominent ? " setup-prominent" : ""}`} aria-labelledby="setup-title">
      <header className="setup-head">
        <div>
          <h2 id="setup-title">{prominent ? "Connect your agents" : "Agents"}</h2>
          <p className="setup-sub">
            {connected} of {setup.tools.length} connected
            {prominent && " · sessions show up here as soon as a connected agent starts or finishes a turn"}
          </p>
        </div>
        {!prominent && (
          <button type="button" className="text-button" aria-expanded={expanded} onClick={toggle}>
            {expanded ? "Hide" : "Manage"}
          </button>
        )}
      </header>

      {expanded && (
        <>
          <ul className="setup-list">
            {setup.tools.map((tool) => (
              <ToolRow key={tool.id} tool={tool} onSetup={onSetup} />
            ))}
          </ul>
          {setup.notes.length > 0 && (
            <ul className="setup-notes">
              {setup.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          )}
          <p className="setup-foot">
            Prefer the terminal? <CopyCommand command={`${setup.cli} install --tool all`} />
          </p>
        </>
      )}
    </section>
  );
}

type Step =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "preview"; result: ConnectResult }
  | { kind: "done"; result: ConnectResult }
  | { kind: "error"; message: string };

function ToolRow({ tool, onSetup }: { tool: SetupTool; onSetup: (setup: Setup) => void }) {
  const [step, setStep] = useState<Step>({ kind: "idle" });

  // Two calls on purpose: a dry run shows exactly what will change before anything is written.
  const run = async (dryRun: boolean) => {
    setStep({ kind: "busy" });
    try {
      const { results, setup } = await connectTool(tool.id, dryRun);
      const result = results.find((r) => r.id === tool.id);
      if (!result) throw new Error("No result for this tool");
      onSetup(setup);
      setStep(dryRun && result.changed ? { kind: "preview", result } : { kind: "done", result });
    } catch (error) {
      setStep({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  return (
    <li className="setup-row" style={{ "--tool": tool.color } as CSSProperties}>
      <div className="setup-row-main">
        <span className="setup-name">
          <span className="tool-dot" />
          {tool.label}
        </span>
        <span className="setup-path" title={tool.configPath}>
          {tool.configPath}
        </span>
      </div>

      <div className="setup-row-action">
        {tool.error ? (
          <span className="setup-problem">Can't read config</span>
        ) : tool.connected && step.kind !== "preview" ? (
          <span className="connected-badge">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 8.5l2.5 2.5 5.5-6" />
            </svg>
            Connected
          </span>
        ) : (
          step.kind !== "preview" && (
            <button
              type="button"
              className="open-button"
              disabled={step.kind === "busy"}
              onClick={() => void run(true)}
            >
              {step.kind === "busy" ? "Checking…" : "Connect"}
            </button>
          )
        )}
      </div>

      {step.kind === "preview" && (
        <div className="setup-detail">
          <p>
            This adds to <code>{step.result.configPath}</code>. A backup is saved first, and{" "}
            <code>uninstall</code> removes exactly these entries.
          </p>
          <ul className="setup-changes">
            {step.result.summary.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <div className="setup-buttons">
            <button type="button" className="primary-button" onClick={() => void run(false)}>
              Connect {tool.label}
            </button>
            <button type="button" className="text-button" onClick={() => setStep({ kind: "idle" })}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {step.kind === "done" && (
        <div className="setup-detail">
          <p>
            {step.result.changed ? "Connected." : "Already up to date, nothing changed."}
            {step.result.backupPath && (
              <>
                {" "}
                Backup: <code>{step.result.backupPath}</code>
              </>
            )}
          </p>
          <NextSteps steps={step.result.afterInstall} />
        </div>
      )}

      {tool.error && (
        <div className="setup-detail setup-error">
          <p>
            {tool.error} Fix or move <code>{tool.configPath}</code>, then reload this page.
          </p>
        </div>
      )}

      {step.kind === "error" && (
        <div className="setup-detail setup-error">
          <p>{step.message}</p>
        </div>
      )}

      {/* Steps in the tool itself stay visible until done; the server can't see whether they were. */}
      {step.kind === "idle" && tool.connected && tool.afterInstall.length > 0 && (
        <div className="setup-detail">
          <NextSteps steps={tool.afterInstall} reminder />
        </div>
      )}

      {!tool.connected && !tool.error && step.kind === "idle" && (
        <div className="setup-terminal">
          <CopyCommand command={tool.command} />
        </div>
      )}
    </li>
  );
}

function NextSteps({ steps, reminder = false }: { steps: string[]; reminder?: boolean }) {
  if (steps.length === 0) return null;
  return (
    <div className={reminder ? "next-steps reminder" : "next-steps"}>
      <strong>{reminder ? "If you haven't yet, in the tool:" : "Next, in the tool:"}</strong>
      <ol>
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    </div>
  );
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied; the command is still there to select by hand.
    }
  };
  return (
    <span className="copy-command">
      <code>{command}</code>
      <button type="button" className="text-button" onClick={() => void copy()}>
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}
