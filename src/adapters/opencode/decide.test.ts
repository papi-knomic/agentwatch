import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildOpenCodeDecideOutput, openCodeDecide } from "./decide.js";

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

const permission = {
  kind: "permission",
  sessionId: "ses_root",
  requestId: "per_1",
  toolName: "bash",
  preview: "cmd /c dir",
};
const question = {
  kind: "question",
  sessionId: "ses_root",
  requestId: "que_1",
  toolName: "question",
  questions: [
    {
      question: "Which colours?",
      header: "Colours",
      multiple: true,
      options: [
        { label: "Red", description: "r" },
        { label: "Blue", description: "b" },
      ],
    },
    {
      question: "Which size?",
      header: "Size",
      options: [
        { label: "S, small", description: "s" },
        { label: "L", description: "l" },
      ],
    },
  ],
};

describe("openCodeDecide", () => {
  it("is a concurrent permission request, with the child session as the asking agent", () => {
    expect(openCodeDecide.parse(permission, {})).toEqual({
      kind: "permission",
      sessionId: "ses_root",
      toolName: "bash",
      toolInput: {},
      preview: "cmd /c dir",
      concurrent: true,
    });
    expect(openCodeDecide.parse({ ...permission, agentSessionId: "ses_child_1" }, {})).toMatchObject({
      agentId: "ses_child_1",
    });
  });

  it("cuts an oversize preview to the usual 300 characters", () => {
    const parsed = openCodeDecide.parse({ ...permission, preview: "x".repeat(900) }, {});
    expect(parsed?.preview).toHaveLength(300);
    expect(parsed?.preview?.endsWith("…")).toBe(true);
  });

  it("approves as once and denies as reject, never always", () => {
    const request = openCodeDecide.parse(permission, {});
    if (!request) throw new Error("must parse");
    expect(openCodeDecide.buildOutput(request, { behavior: "allow" })).toBe('{"reply":"once"}');
    expect(openCodeDecide.buildOutput(request, { behavior: "deny" })).toBe('{"reply":"reject"}');
    expect(openCodeDecide.buildOutput(request, { answers: { a: "b" } })).toBeNull();
  });

  it("maps question answers to one list of labels per question, in order", () => {
    const request = openCodeDecide.parse(question, {});
    if (!request) throw new Error("must parse");
    expect(request.concurrent).toBe(true);
    expect(request.questions?.map((q) => q.multiSelect)).toEqual([true, false]);
    const out = buildOpenCodeDecideOutput(request, {
      answers: { "Which colours?": "Red, Blue", "Which size?": "S, small" },
    });
    // A single-select label may contain a comma; it must not be split.
    expect(JSON.parse(out ?? "")).toEqual({ answers: [["Red", "Blue"], ["S, small"]] });
    expect(buildOpenCodeDecideOutput(request, { answers: { "Which colours?": "Red" } })).toBeNull();
    expect(buildOpenCodeDecideOutput(request, { behavior: "allow" })).toBeNull();
  });

  it("leaves questions it can't answer exactly to OpenCode", () => {
    const tooLong = { ...question, questions: [{ ...question.questions[0], question: "q".repeat(600) }] };
    expect(openCodeDecide.parse(tooLong, {})).toBeNull();
    expect(openCodeDecide.parse({ ...question, questions: [] }, {})).toBeNull();
    // Free-text only: no options to pick from.
    expect(
      openCodeDecide.parse({ ...question, questions: [{ question: "Name?", header: "n", options: [] }] }, {}),
    ).toBeNull();
    // A multi-select label with a comma would make the answer ambiguous.
    const comma = [{ question: "Q", multiple: true, options: [{ label: "a, b" }] }];
    expect(openCodeDecide.parse({ ...question, questions: comma }, {})).toBeNull();
  });

  it("ignores anything else", () => {
    for (const bad of [
      null,
      "x",
      [],
      {},
      { ...permission, kind: "plan" },
      { ...permission, sessionId: "" },
      { ...permission, requestId: 4 },
    ]) {
      expect(openCodeDecide.parse(bad, {})).toBeNull();
    }
  });

  it("handles the payloads captured from OpenCode 1.19.3 (permission and question, answered from a sandbox dashboard)", () => {
    const asked = openCodeDecide.parse(fixture("decide/permission.json"), {});
    expect(asked).toMatchObject({ kind: "permission", toolName: "bash", preview: "echo agentwatch-live-ok" });
    const picked = openCodeDecide.parse(fixture("decide/question.json"), {});
    if (!picked) throw new Error("must parse");
    expect(buildOpenCodeDecideOutput(picked, { answers: { "Which colour do you like?": "Blue" } })).toBe(
      '{"answers":[["Blue"]]}',
    );
  });
});
