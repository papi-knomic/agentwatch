import { useId, useState } from "react";
import { type DecisionQuestion, PLAN_FEEDBACK_MAX } from "../../src/core/decision-types.js";
import { type PendingDecision, type ResolveOutcome, resolveDecision } from "./useAgentStream";

type Phase = "idle" | "sending" | ResolveOutcome;

const OUTCOME_NOTE: Partial<Record<Phase, string>> = {
  answered: "Already answered.",
  gone: "This request is over: it timed out, no dashboard tab was visible, or it was answered elsewhere.",
  failed: "Couldn't send that. Try again, or answer in the terminal.",
};

/**
 * A pending permission prompt or question for one session (opt-in "remote actions"). The answer goes to the local
 * server, which hands it to the waiting hook. While a visible tab is open, Claude Code waits for this panel (its own
 * prompt is not shown in the terminal meanwhile) for up to about 100 s, or until the tab is hidden or closed.
 */
export function DecisionPanel({
  decision,
  canAnswer = true,
}: {
  decision: PendingDecision;
  /** false on a paired phone that isn't allowed to approve: it sees the request but can't answer it. */
  canAnswer?: boolean;
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
          <p className="decision-title">Approve this plan?</p>
          {/* Plain text in a <pre>: the plan is untrusted Markdown and is never rendered as HTML. */}
          {decision.preview && <pre className="decision-preview decision-plan">{decision.preview}</pre>}
          {canAnswer && (
            <>
              <label className="decision-feedback" htmlFor={feedbackId}>
                If you keep planning, tell Claude what to change (optional)
                <textarea
                  id={feedbackId}
                  value={feedback}
                  maxLength={PLAN_FEEDBACK_MAX}
                  rows={2}
                  disabled={sending || over}
                  onChange={(e) => setFeedback(e.target.value)}
                />
              </label>
              <div className="decision-buttons">
                <button
                  type="button"
                  className="primary-button"
                  disabled={sending || over}
                  onClick={() => void send({ behavior: "allow" })}
                >
                  Approve plan
                </button>
                <button
                  type="button"
                  className="deny-button"
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
          <p className="decision-title">
            Allow <strong>{decision.toolName}</strong>?
          </p>
          {decision.preview && <pre className="decision-preview">{decision.preview}</pre>}
          {canAnswer && (
            <div className="decision-buttons">
              <button
                type="button"
                className="primary-button"
                disabled={sending || over}
                onClick={() => void send({ behavior: "allow" })}
              >
                Approve
              </button>
              <button
                type="button"
                className="deny-button"
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
      {phase === "ok" && <p className="decision-note">Sent. Claude Code continues in a moment.</p>}
      {OUTCOME_NOTE[phase] && <p className="decision-note decision-warn">{OUTCOME_NOTE[phase]}</p>}
      {!canAnswer && (
        <p className="decision-note decision-warn">
          Answer this at your PC. To answer from this phone, turn on "Allow approvals" for it in the dashboard
          on your PC.
        </p>
      )}
      {canAnswer && !over && (
        <p className="decision-note">
          Claude Code is waiting for this answer and is not showing it in the terminal meanwhile. If you hide
          or close this tab, or wait about 100 seconds, the normal prompt appears there instead.
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
        <fieldset className="decision-question" key={q.question} disabled={disabled}>
          <legend>
            {q.header && <span className="decision-header">{q.header}</span>}
            {q.question}
          </legend>
          <ul className="decision-options">
            {q.options.map((option) => {
              const checked = picked[q.question]?.includes(option.label) ?? false;
              return (
                <li key={option.label}>
                  <label className={checked ? "decision-option on" : "decision-option"}>
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
        </fieldset>
      ))}
      {!hideSubmit && (
        <div className="decision-buttons">
          <button type="button" className="primary-button" disabled={disabled || !complete} onClick={submit}>
            Submit
          </button>
        </div>
      )}
    </>
  );
}
