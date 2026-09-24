/// <reference types="bun-types" />
// The flow's words through flowModel: each trigger in plain words, Steps
// with their summary, fields and approval, the Steps a condition guards set
// in under it, an edit's New, Changed and Removed, and a Run's outcomes.

import { describe, expect, test } from "bun:test";
import type { RunView, WorkflowSketch } from "@monday/shared";
import { defaultSettings, diffWorkflow, parseWorkflowInput, sketchOf } from "@monday/shared";
import { diffLine, flowModel, flowStrings, plain, templateText } from "./flow.ts";

const s = flowStrings(defaultSettings());

function doc(raw: Record<string, unknown>): WorkflowSketch {
  const p = parseWorkflowInput({ name: "W", ...raw });
  if (!p.ok) throw new Error(p.error);
  return sketchOf(p.value);
}

const archive = { id: "archive", kind: "archive", name: "Archive it" };
const trigger = (t: unknown) => flowModel(doc({ trigger: t, steps: [archive] }), s).cards[0];

describe("the trigger card", () => {
  test("says when a Workflow starts, in plain words, with its conditions as chips", () => {
    expect(trigger({ kind: "arrival" })?.title).toBe("Mail arrives");
    expect(
      trigger({ kind: "arrival", predicate: { senders: ["ap@acme.test"], hasAttachment: true } }),
    ).toMatchObject({ title: "Mail arrives from ap@acme.test", facts: ["With an attachment"] });
    const judged = flowModel(
      doc({
        trigger: {
          kind: "arrival",
          group: "g1",
          predicate: { domains: ["acme.test"], subjectPatterns: ["invoice"] },
          judge: { statement: "the customer is upset", threshold: 0.8 },
        },
        steps: [archive],
      }),
      s,
      { groupName: (id) => (id === "g1" ? "Support" : id) },
    ).cards[0];
    expect(judged).toMatchObject({
      title: "Mail arrives in Support",
      eyebrow: "When",
      facts: [
        "From acme.test",
        "Subject has invoice",
        "The judge agrees: the customer is upset, 80% sure or more",
      ],
    });
    expect(trigger({ kind: "schedule", cron: "0 16 * * fri" })).toMatchObject({
      title: "On a schedule: Fridays 16:00",
      facts: ["Cron, UTC 0 16 * * fri"],
      icon: "calendar",
    });
    expect(trigger({ kind: "manual" })?.title).toBe("Only when you run it");
    expect(trigger({ kind: "silence", days: 3 })?.title).toBe("No reply from you for 3 days");
    expect(trigger({ kind: "thread_event", event: "tagged", value: "urgent" })).toMatchObject({
      title: "A thread is tagged",
      facts: ["Which urgent"],
    });
  });
});

describe("the Step cards", () => {
  test("each Step reads as its kind, a summary, its fields with named holes, and the approval it runs under", () => {
    const { cards } = flowModel(
      doc({
        trigger: { kind: "manual" },
        steps: [
          {
            id: "extract",
            kind: "agentic",
            name: "Extract",
            prompt: "Find the {{thread.subject}} role.",
            outputs: ["role"],
            budget: { calls: 5 },
          },
          {
            id: "post",
            kind: "slack",
            name: "Post",
            channel: "#hiring",
            text: "New: {{steps.extract.role}}",
          },
          { id: "draft", kind: "draft_reply", name: "Draft", instructions: "Short." },
          { id: "send", kind: "send", name: "Send it", draftFrom: "draft", onFailure: "notify" },
        ],
        standingApprovals: ["post"],
      }),
      s,
    );
    const [, extract, post, draft, send] = cards;
    // No allowlist means every tool, so an agent Step asks.
    expect(extract).toMatchObject({
      eyebrow: "Step 1 · Agent step",
      tier: { kind: "ask", label: "Asks first" },
      summary: "The agent follows your instructions",
    });
    expect(extract?.fields?.map((f) => f.label)).toEqual([
      "Instructions",
      "May use",
      "Reports",
      "Budget",
    ]);
    expect(extract?.fields?.[1]?.chips).toEqual(["Every tool"]);
    expect(extract?.fields?.[0]?.text).toEqual(["Find the ", { hole: "the subject" }, " role."]);
    expect(post).toMatchObject({
      summary: "Posts to #hiring on Slack",
      tier: { kind: "standing", label: "Runs on your standing approval" },
    });
    expect(post?.fields?.[0]?.text).toEqual(["New: ", { hole: "role from Extract" }]);
    expect(draft).toMatchObject({
      summary: "Writes a reply in your voice and leaves it in Drafts",
      tier: { kind: "undo", label: "Applies with Undo" },
    });
    expect(send).toMatchObject({
      summary: "Sends the draft from Draft",
      tier: { kind: "ask" },
      note: "If this fails, you are told and the run goes on",
    });
  });

  test("a condition says what happens either way; the Steps it guards sit under its yes", () => {
    const { cards } = flowModel(
      doc({
        trigger: { kind: "manual" },
        steps: [
          { id: "a", kind: "archive", name: "A" },
          {
            id: "maybe",
            kind: "condition",
            name: "Only urgent",
            when: { left: "{{thread.subject}}", op: "contains", value: "urgent" },
            otherwise: "skip_next",
          },
          { id: "b", kind: "notify", name: "Tell me", text: "Urgent" },
          { id: "c", kind: "archive", name: "C" },
          {
            id: "gate",
            kind: "condition",
            name: "Upset",
            when: { op: "judged", statement: "the sender is upset" },
          },
          { id: "d", kind: "archive", name: "D" },
          { id: "e", kind: "archive", name: "E" },
        ],
      }),
      s,
    );
    expect(cards.map((c) => [c.title, c.depth])).toEqual([
      ["Only when you run it", 0],
      ["A", 0],
      ["Only urgent", 0],
      ["Tell me", 1],
      ["C", 0],
      ["Upset", 0],
      ["D", 1],
      ["E", 1],
    ]);
    expect(cards[2]).toMatchObject({
      tone: "cond",
      summary: 'Goes on only if the subject contains "urgent"',
      branches: { yes: "If yes", no: "If not, skips Tell me", noKind: "skip" },
    });
    expect(cards[2]?.tier).toBeUndefined();
    expect(cards[5]).toMatchObject({
      summary: "Goes on only if the judge agrees: the sender is upset",
      branches: { no: "If not, the run ends here", noKind: "stop" },
    });
  });
});

describe("an edit and a Run over the flow", () => {
  test("an edit marks new and changed Steps and hands back the removed ones", () => {
    const before = doc({
      trigger: { kind: "manual" },
      steps: [
        { id: "a", kind: "archive", name: "A" },
        { id: "t", kind: "tag", name: "Label", add: ["x"] },
      ],
    });
    const after = doc({
      trigger: { kind: "schedule", cron: "0 9 * * mon" },
      steps: [
        { id: "a", kind: "archive", name: "Archive now" },
        { id: "n", kind: "notify", name: "Tell me", text: "Done" },
      ],
    });
    const diff = diffWorkflow(before, after);
    const { cards, removed } = flowModel(after, s, { diff });
    expect(cards.map((c) => c.change?.label ?? "")).toEqual(["Changed", "Changed", "New"]);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({
      title: "Label",
      summary: "Adds x",
      change: { kind: "removed", label: "Removed" },
    });
    expect(diffLine(diff, s)).toBe("1 new, 1 changed, 1 removed");
    expect(diffLine(diffWorkflow(before, before), s)).toBe("The steps stay the same");
  });

  test("a Run's Step results lay over the cards; a finished Run marks what it never reached", () => {
    const w = doc({
      trigger: { kind: "manual" },
      steps: [
        { id: "a", kind: "archive", name: "A" },
        { id: "b", kind: "archive", name: "B" },
      ],
    });
    const run = {
      status: "failed",
      steps: [
        {
          index: 0,
          stepId: "a",
          name: "A",
          kind: "archive",
          status: "failed",
          detail: "The Thread is gone",
          activityId: null,
          at: "2026-09-16T10:00:00Z",
        },
      ],
    } as unknown as RunView;
    const { cards } = flowModel(w, s, { run });
    expect(cards.slice(1).map((c) => c.run)).toEqual([
      { status: "failed", label: "Failed", detail: "The Thread is gone" },
      { status: "not_reached", label: "Not reached", detail: undefined },
    ]);
  });

  test("template holes read as names", () => {
    const text = templateText("{{steps.x.vendor}} on {{thread.from}}: {{other.path}}", s, (id) =>
      id === "x" ? "Read" : id,
    );
    expect(plain(text)).toBe("vendor from Read on the sender: other.path");
  });
});
