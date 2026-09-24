import { describe, expect, test } from "bun:test";
import {
  cronMatches,
  describeWorkflow,
  diffWorkflow,
  evaluateCondition,
  nextCronRun,
  parseCron,
  parseWorkflowInput,
  renderTemplate,
  stepTier,
} from "./index.ts";

describe("the Workflow document", () => {
  test("a hybrid document parses with defaults filled in", () => {
    const parsed = parseWorkflowInput({
      name: "Candidate intake",
      trigger: { kind: "arrival", group: "g1" },
      steps: [
        { id: "extract", kind: "agentic", name: "Extract", prompt: "Extract the role." },
        { id: "label", kind: "tag", name: "Label", add: ["candidate"] },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toMatchObject({
      kind: "hybrid",
      placement: null,
      failurePolicy: "stop",
      standingApprovals: [],
    });
    expect(parsed.value.steps[0]).toMatchObject({ tools: [], budget: {}, outputs: [] });
    expect(parsed.value.steps[1]).toMatchObject({ add: ["candidate"], remove: [] });
  });

  test("the rules the schema enforces read as one line each", () => {
    const twice = parseWorkflowInput({
      name: "x",
      trigger: { kind: "manual" },
      steps: [
        { id: "a", kind: "archive", name: "A" },
        { id: "a", kind: "archive", name: "B" },
      ],
    });
    expect(twice).toEqual({ ok: false, error: 'steps.1.id: step id "a" is used twice' });
    const agentic = parseWorkflowInput({
      name: "x",
      kind: "agentic",
      trigger: { kind: "manual" },
      steps: [{ id: "a", kind: "archive", name: "A" }],
    });
    expect(agentic).toMatchObject({
      ok: false,
      error: expect.stringContaining("exactly one agentic step"),
    });
    const standing = parseWorkflowInput({
      name: "x",
      trigger: { kind: "manual" },
      steps: [{ id: "a", kind: "archive", name: "A" }],
      standingApprovals: ["zz"],
    });
    expect(standing).toMatchObject({ ok: false, error: expect.stringContaining("unknown step") });
    const cron = parseWorkflowInput({
      name: "x",
      trigger: { kind: "schedule", cron: "every friday" },
      steps: [{ id: "a", kind: "archive", name: "A" }],
    });
    expect(cron).toMatchObject({ ok: false, error: expect.stringContaining("five cron fields") });
  });

  test("what leaves the mailbox asks; the rest is reversible or silent", () => {
    expect(stepTier("send")).toBe("always-ask");
    expect(stepTier("slack")).toBe("always-ask");
    expect(stepTier("mcp")).toBe("always-ask");
    expect(stepTier("tag")).toBe("reversible");
    expect(stepTier("condition")).toBe("read-only");
    expect(stepTier("agentic")).toBe("read-only");
  });

  test("describeWorkflow draws the chain the page shows", () => {
    const nodes = describeWorkflow(
      {
        trigger: { kind: "arrival", group: "g1" },
        steps: [
          {
            id: "extract",
            kind: "agentic",
            name: "Extract",
            prompt: "",
            tools: [],
            budget: {},
            outputs: ["name", "role"],
          },
          {
            id: "rust",
            kind: "condition",
            name: "If role is Rust",
            when: { left: "x", op: "exists" },
            otherwise: "stop",
          },
          { id: "slack", kind: "slack", name: "Slack", channel: "#hiring", text: "" },
        ],
      },
      (id) => (id === "g1" ? "Hiring › Candidates" : id),
    );
    expect(nodes.map((n) => [n.kind, n.label, n.detail])).toEqual([
      ["trig", "Email arrives", "matches Hiring › Candidates"],
      ["act", "Extract", "name, role"],
      ["cond", "If role is Rust", undefined],
      ["act", "Slack", "#hiring"],
    ]);
  });
});

describe("templates and conditions", () => {
  const ctx = {
    thread: { id: "t1", subject: "Application: Rust", from: "Aoife <a@x.test>" },
    run: { id: "r1", workflow: "w1" },
    steps: { extract: { role: "Senior Rust engineer", links: ["a", "b"] } },
  };
  test("holes render from the thread, the run and earlier steps; unknown paths render empty", () => {
    expect(renderTemplate("{{thread.subject}} by {{ thread.from }} in {{run.id}}", ctx)).toBe(
      "Application: Rust by Aoife <a@x.test> in r1",
    );
    expect(
      renderTemplate("{{steps.extract.links}} / {{steps.nope.x}} / {{thread.nope}}", ctx),
    ).toBe("a, b /  / ");
  });
  test("conditions test the rendered value", () => {
    expect(
      evaluateCondition({ left: "{{steps.extract.role}}", op: "contains", value: "rust" }, ctx),
    ).toBe(true);
    expect(
      evaluateCondition({ left: "{{steps.extract.role}}", op: "equals", value: "rust" }, ctx),
    ).toBe(false);
    expect(
      evaluateCondition({ left: "{{steps.extract.role}}", op: "matches", value: "^senior" }, ctx),
    ).toBe(true);
    expect(evaluateCondition({ left: "{{steps.nope.x}}", op: "exists" }, ctx)).toBe(false);
    expect(
      evaluateCondition({ left: "{{thread.subject}}", op: "not_contains", value: "invoice" }, ctx),
    ).toBe(true);
  });
});

describe("cron", () => {
  test("parses names, lists, ranges and steps", () => {
    const s = parseCron("0,30 9-17/4 * * mon-fri");
    expect([...s.minutes]).toEqual([0, 30]);
    expect([...s.hours]).toEqual([9, 13, 17]);
    expect([...s.weekdays]).toEqual([1, 2, 3, 4, 5]);
    expect(() => parseCron("60 * * * *")).toThrow("cron: bad value");
    expect(() => parseCron("* * * *")).toThrow("five fields");
  });
  test("matches and finds the next minute", () => {
    const friday16 = parseCron("0 16 * * fri");
    // 2026-09-16 is a Wednesday.
    const wed = new Date("2026-09-16T12:00:00Z");
    expect(cronMatches(friday16, new Date("2026-09-18T16:00:00Z"))).toBe(true);
    expect(cronMatches(friday16, new Date("2026-09-18T16:01:00Z"))).toBe(false);
    expect(nextCronRun(friday16, wed)?.toISOString()).toBe("2026-09-18T16:00:00.000Z");
    expect(nextCronRun(friday16, new Date("2026-09-18T16:00:00Z"))?.toISOString()).toBe(
      "2026-09-25T16:00:00.000Z",
    );
    const firstOfMonth = parseCron("1 6 1 * *");
    expect(nextCronRun(firstOfMonth, wed)?.toISOString()).toBe("2026-10-01T06:01:00.000Z");
    // Day-of-month or day-of-week when both are set (cron's rule).
    const either = parseCron("0 0 15 * mon");
    expect(nextCronRun(either, wed)?.toISOString()).toBe("2026-09-21T00:00:00.000Z");
  });
});

describe("what an edit changes", () => {
  const doc = (steps: unknown[], trigger: unknown = { kind: "manual" }, name = "Digest") => {
    const p = parseWorkflowInput({ name, trigger, steps });
    if (!p.ok) throw new Error(p.error);
    return p.value;
  };
  const archive = { id: "archive", kind: "archive", name: "Archive" };
  const notify = { id: "tell", kind: "notify", name: "Tell me", text: "Done" };

  test("Steps are matched by id: new, changed, the same, and the ones taken out", () => {
    const before = doc([archive, notify, { id: "wait", kind: "wait", name: "Wait", hours: 2 }]);
    const after = doc([
      { ...notify, text: "Done: {{thread.subject}}" },
      archive,
      { id: "tag", kind: "tag", name: "Label", add: ["done"] },
    ]);
    const d = diffWorkflow(before, after);
    expect(d.steps).toEqual([
      { id: "tell", change: "changed" },
      { id: "archive", change: "same" },
      { id: "tag", change: "added" },
    ]);
    expect(d.removed.map((s) => s.id)).toEqual(["wait"]);
    expect(d.trigger).toBe("same");
    expect(d.renamed).toBe(false);
    expect(d.changed).toBe(true);
  });

  test("key order never counts as a change; a new trigger or name does", () => {
    const a = doc([archive], { kind: "arrival", group: "g", predicate: { hasAttachment: true } });
    const b = doc([archive], { predicate: { hasAttachment: true }, group: "g", kind: "arrival" });
    expect(diffWorkflow(a, b).changed).toBe(false);
    const c = doc([archive], { kind: "schedule", cron: "0 16 * * fri" }, "Weekly");
    const d = diffWorkflow(a, c);
    expect(d.trigger).toBe("changed");
    expect(d.renamed).toBe(true);
    expect(d.changed).toBe(true);
  });
});
