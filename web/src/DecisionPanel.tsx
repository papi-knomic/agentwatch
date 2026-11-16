import { useId, useState } from "react";
import {
  type BackgroundHold,
  type DecisionQuestion,
  PLAN_FEEDBACK_MAX,
} from "../../src/core/decision-types.js";
import { renderMarkdown } from "./markdown";
import { settingsHref } from "./route";
import { type PendingDecision, type ResolveOutcome, resolveDecision } from "./useAgentStream";

type Phase = "idle" | "sending" | ResolveOutcome;

/** Where a concurrent prompt is also shown, from the session's host ("VS Code*", "Claude Desktop", ...). */
export function concurrentPlace(host: string | undefined, sessionKey?: string): string {
  if (sessionKey?.startsWith("opencode:")) return "OpenCode";
  if (host === "Claude Desktop") return "the Claude app";
  if (host?.startsWith("VS Code")) return "VS Code";
  return "its own window";
}

/** What the "terminal prompts while in the background" setting means for a card. */
const HOLD_TEXT: Record<BackgroundHold, string> = {
  full: "It waits up to about 100 seconds, even while this tab is in the background.",
  short:
    "While this tab is visible it waits up to about 100 seconds; if the tab is hidden it waits about 15 seconds.",
  off: "It waits up to about 100 seconds while this tab is visible; if the tab is hidden, the terminal prompt appears within a couple of seconds.",
};

/** The long explanation of a held-back terminal prompt, behind a small "?" so cards stay one line. */
export function HoldInfo({ hold }: { hold: BackgroundHold }) {
  return (
    <details className="hold-info">
      <summary aria-label="Why isn't it in the terminal?" title="Why isn't it in the terminal?">
        ?
      </summary>
      <span className="hold-text">
        Claude Code is waiting for this answer and is not showing it in the terminal meanwhile.{" "}
        {HOLD_TEXT[hold]} Closing all dashboard tabs hands the prompt back to the terminal within about 5
        seconds. <a href={settingsHref("answering")}>Change in Settings</a>
      </span>
    </details>
  );
}

const OUTCOME_NOTE: Partial<Record<Phase, string>> = {
  answered: "Already answered.",
  gone: "This request is over: it timed out, the dashboard was disconnected, or it was answered elsewhere.",
  failed: "Couldn't send that. Try again, or answer in the terminal.",
};

/**
 * A pending permission prompt or question for one session (opt-in "remote actions"). The answer goes to the local
 * server, which hands it to the waiting hook. While a visible tab is open, Claude Code waits for this panel (its own
 * prompt is not shown in the terminal meanwhile) for up to about 100 s; with only hidden tabs it depends on the background-hold setting; with none, not
 * at all.
 */
export function DecisionPanel({
  decision,
  canAnswer = true,
  host,
  caption,
}: {
  decision: PendingDecision;
  /** false on a paired phone that isn't allowed to approve: it sees the request but can't answer it. */
  canAnswer?: boolean;
  /** The session's host, to name where a concurrent prompt is also shown. */
  host?: string;
  /** "subagent · name" when a subagent is the one asking. */
  caption?: string | null;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [feedback, setFeedback] = useState("");
  const feedbackId = useId();
  const sending = phase === "sending";
  const over = phase === "ok" || phase === "answered" || phase === "gone";

  const send = async (body: unknown) => {
    setPhase("sending");
    setPhase(await resolveDecision(decision.id, body));
  };

  return (
    <fieldset className="decision" aria-label={`${decision.toolName} request`}>
      {decision.kind === "plan" ? (
        <>
          <p className="dc-q">Approve this plan?</p>
          {/* Untrusted plan text: the renderer only builds React elements, never HTML. */}
          {decision.preview && <div className="pv plan">{renderMarkdown(decision.preview)}</div>}
          {canAnswer && (
            <>
              <label className="fb" htmlFor={feedbackId}>
                What should change? (optional)
                <textarea
                  id={feedbackId}
                  value={feedback}
                  maxLength={PLAN_FEEDBACK_MAX}
                  rows={2}
                  disabled={sending || over}
                  onChange={(e) => setFeedback(e.target.value)}
                />
              </label>
              <div className="acts-row">
                <button
                  type="button"
                  className="btn pri"
                  disabled={sending || over}
                  onClick={() => void send({ behavior: "allow" })}
                >
                  Approve plan
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={sending || over}
                  onClick={() =>
                    void send(
                      feedback.trim() ? { behavior: "deny", message: feedback.trim() } : { behavior: "deny" },
                    )
                  }
                >
                  Keep planning
                </button>
              </div>
            </>
          )}
        </>
      ) : decision.kind === "permission" ? (
        <>
          <p className="dc-q">
            {decision.toolName === "Bash" ? "Run this Bash command?" : `Allow ${decision.toolName}?`}
            {caption && (
              <span className="badge sub" title="Asked by a subagent">
                {caption}
              </span>
            )}
          </p>
          {decision.preview && (
            <pre className="pv">
              {decision.toolName === "Bash" ? `$ ${decision.preview}` : decision.preview}
            </pre>
          )}
          {canAnswer && (
            <div className="acts-row">
              <button
                type="button"
                className="btn pri"
                disabled={sending || over}
                onClick={() => void send({ behavior: "allow" })}
              >
                Approve
              </button>
              <button
                type="button"
                className="btn dng"
                disabled={sending || over}
                onClick={() => void send({ behavior: "deny" })}
              >
                Deny
              </button>
            </div>
          )}
        </>
      ) : (
        <QuestionForm
          questions={decision.questions ?? []}
          disabled={sending || over || !canAnswer}
          hideSubmit={!canAnswer}
          onSubmit={(answers) => void send({ answers })}
        />
      )}
      {phase === "ok" && <p className="note ok">Sent. Claude Code continues in a moment.</p>}
      {OUTCOME_NOTE[phase] && <p className="note warn">{OUTCOME_NOTE[phase]}</p>}
      {!canAnswer && (
        <p className="note warn">
          Answer this at your PC. To answer from this phone, turn on "Allow approvals" for it in the dashboard
          on your PC.
        </p>
      )}
      {canAnswer && !over && decision.concurrent === true && (
        <p className="note">
          Also showing in {concurrentPlace(host, decision.sessionKey)}. Answer here or there.
        </p>
      )}
      {canAnswer && !over && decision.concurrent !== true && (
        <p className="note">
          Not in the terminal until you answer.
          <HoldInfo hold={decision.backgroundHold ?? "full"} />
        </p>
      )}
    </fieldset>
  );
}

function QuestionForm({
  questions,
  disabled,
  hideSubmit,
  onSubmit,
}: {
  questions: DecisionQuestion[];
  disabled: boolean;
  hideSubmit: boolean;
  onSubmit: (answers: Record<string, string | string[]>) => void;
}) {
  const uid = useId();
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const complete = questions.every((q) => (picked[q.question]?.length ?? 0) > 0);

  const toggle = (q: DecisionQuestion, label: string) => {
    setPicked((prev) => {
      const current = prev[q.question] ?? [];
      if (!q.multiSelect) return { ...prev, [q.question]: [label] };
      return {
        ...prev,
        [q.question]: current.includes(label) ? current.filter((l) => l !== label) : [...current, label],
      };
    });
  };

  const submit = () => {
    const answers: Record<string, string | string[]> = {};
    for (const q of questions) {
      const labels = picked[q.question] ?? [];
      answers[q.question] = q.multiSelect ? labels : (labels[0] ?? "");
    }
    onSubmit(answers);
  };

  return (
    <>
      {questions.map((q, index) => (
        <fieldset className="qset" key={q.question} disabled={disabled}>
          <p className="dc-q">
            {q.header && <span className="badge">{q.header}</span>}
            {q.question}
          </p>
          <ul className="opts">
            {q.options.map((option) => {
              const checked = picked[q.question]?.includes(option.label) ?? false;
              return (
                <li key={option.label}>
                  <label className={checked ? "opt on" : "opt"}>
                    <input
                      type={q.multiSelect ? "checkbox" : "radio"}
                      name={`${uid}-${index}`}
                      checked={checked}
                      onChange={() => toggle(q, option.label)}
                    />
                    <span>
                      {option.label}
                      {option.description && <small>{option.description}</small>}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
          <p className="note">{q.multiSelect ? "Pick one or more." : "Pick one."}</p>
        </fieldset>
      ))}
      {!hideSubmit && (
        <div className="acts-row">
          <button type="button" className="btn pri" disabled={disabled || !complete} onClick={submit}>
            Send answer
          </button>
        </div>
      )}
    </>
  );
}
