/**
 * Types and limits for "answer from the dashboard" (opt-in `remoteActions`). Types only, no Node imports, so the
 * dashboard can share them. Everything here lives in memory for the length of one prompt: never saved to disk.
 */

export type DecisionKind = "permission" | "question" | "plan";

export interface DecisionOption {
  label: string;
  description?: string;
}

export interface DecisionQuestion {
  question: string;
  header?: string;
  options: DecisionOption[];
  multiSelect: boolean;
}

/** What the dashboard sees of a pending decision. */
export interface PendingDecision {
  id: string;
  /** The session it belongs to (`tool:sessionId`). */
  sessionKey: string;
  kind: DecisionKind;
  toolName: string;
  /** Command, file path, compact JSON, or (kind "plan") the plan in Markdown. Truncated; display only. */
  preview?: string;
  questions?: DecisionQuestion[];
  createdAt: string;
  expiresAt: string;
}

export type Resolution =
  | { behavior: "allow" }
  /** `message`: only for plans, the user's feedback when they keep planning. */
  | { behavior: "deny"; message?: string }
  | { answers: Record<string, string> };

export const PREVIEW_MAX = 300;
export const PLAN_PREVIEW_MAX = 4000;
/** Feedback sent to Claude when the user rejects a plan from the dashboard. */
export const PLAN_FEEDBACK_MAX = 1000;
export const DEFAULT_PLAN_FEEDBACK = "The user wants to keep planning.";
export const QUESTION_MAX = 500;
export const HEADER_MAX = 60;
export const LABEL_MAX = 200;
export const OPTION_DESCRIPTION_MAX = 300;
export const MAX_QUESTIONS = 6;
export const MAX_OPTIONS = 12;
/**
 * One prompt is answered within this long, or it is left to the local dialog. Must stay below the `decide` hook's
 * own deadline (110 s), so the dashboard never offers an answer to a hook that has already stopped listening.
 */
export const DECISION_TTL_MS = 100_000;

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A short, display-only description of what a tool call is about to do. */
export function previewFor(toolName: string, toolInput: unknown): string | undefined {
  const input =
    typeof toolInput === "object" && toolInput !== null ? (toolInput as Record<string, unknown>) : {};
  const text = (key: string): string | undefined =>
    typeof input[key] === "string" && input[key] !== "" ? (input[key] as string) : undefined;
  const direct = (key: string, max: number): string | undefined => {
    const value = text(key);
    return value === undefined ? undefined : truncate(value, max);
  };
  let shown: string | undefined;
  switch (toolName) {
    case "Bash":
    case "PowerShell":
      shown = direct("command", PREVIEW_MAX);
      break;
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "Read":
      shown = direct("file_path", PREVIEW_MAX);
      break;
    case "NotebookEdit":
      shown = direct("notebook_path", PREVIEW_MAX);
      break;
    case "ExitPlanMode":
      shown = direct("plan", PLAN_PREVIEW_MAX);
      break;
  }
  if (shown) return shown;
  try {
    const json = JSON.stringify(toolInput);
    return json === undefined || json === "{}" ? undefined : truncate(json, PREVIEW_MAX);
  } catch {
    return undefined;
  }
}

/**
 * Checks AskUserQuestion's `questions` (untrusted: it comes from a hook payload or an HTTP body). Returns null for
 * anything that can't be shown and answered exactly. Question text and labels are the answer keys and values, so
 * they are rejected when too long rather than shortened, which would make Claude receive a different string.
 * Multi-select questions whose labels contain a comma are rejected too (the answer format would be ambiguous).
 */
export function parseQuestions(value: unknown): DecisionQuestion[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_QUESTIONS) return null;
  const questions: DecisionQuestion[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "object" || item === null) return null;
    const raw = item as Record<string, unknown>;
    const question = raw.question;
    if (typeof question !== "string" || question === "" || question.length > QUESTION_MAX) return null;
    if (seen.has(question)) return null;
    seen.add(question);
    if (!Array.isArray(raw.options) || raw.options.length === 0 || raw.options.length > MAX_OPTIONS) {
      return null;
    }
    const labels = new Set<string>();
    const options: DecisionOption[] = [];
    for (const option of raw.options) {
      if (typeof option !== "object" || option === null) return null;
      const { label, description } = option as Record<string, unknown>;
      if (typeof label !== "string" || label === "" || label.length > LABEL_MAX || labels.has(label)) {
        return null;
      }
      // Claude receives several picks as one string, labels joined with commas, so a label containing a comma
      // could be read back as two. Such a question is left to the terminal instead.
      if (raw.multiSelect === true && label.includes(",")) return null;
      labels.add(label);
      options.push(
        typeof description === "string" && description !== ""
          ? { label, description: truncate(description, OPTION_DESCRIPTION_MAX) }
          : { label },
      );
    }
    const parsed: DecisionQuestion = { question, options, multiSelect: raw.multiSelect === true };
    if (typeof raw.header === "string" && raw.header !== "") parsed.header = truncate(raw.header, HEADER_MAX);
    questions.push(parsed);
  }
  return questions;
}

/**
 * Checks a dashboard's answers against the stored questions. Every question needs an answer, and each answer must
 * be one of its option labels (several, for a multi-select question). Returns Claude's `answers` map, with
 * multi-select labels joined by ", ", or null if anything doesn't match.
 */
export function validateAnswers(
  questions: readonly DecisionQuestion[],
  value: unknown,
): Record<string, string> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const given = value as Record<string, unknown>;
  if (Object.keys(given).length !== questions.length) return null;
  const answers: Record<string, string> = {};
  for (const q of questions) {
    const answer = Object.hasOwn(given, q.question) ? given[q.question] : undefined;
    const labels = new Set(q.options.map((o) => o.label));
    let picked: string[];
    if (typeof answer === "string") picked = [answer];
    else if (q.multiSelect && Array.isArray(answer) && answer.every((a) => typeof a === "string")) {
      picked = answer as string[];
    } else return null;
    if (picked.length === 0 || new Set(picked).size !== picked.length) return null;
    if (!picked.every((label) => labels.has(label))) return null;
    // Keep the options' own order so the same selection always produces the same string.
    answers[q.question] = q.options
      .map((o) => o.label)
      .filter((label) => picked.includes(label))
      .join(", ");
  }
  return answers;
}
