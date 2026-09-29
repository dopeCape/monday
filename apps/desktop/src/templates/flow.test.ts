// The draft_from_template Step on the Workflow card (slice 38): its summary,
// the line that says when it runs unattended, and a Run's check badges.

import { describe, expect, test } from "bun:test";
import type { RunView, WorkflowSketch } from "@monday/shared";
import { defaultSettings } from "@monday/shared";
import { flowModel, flowStrings } from "../screens/workflows/flow.ts";
import { badgeStrings, previewBadges } from "./badges.ts";

const s = defaultSettings();
const doc = (standing: boolean): WorkflowSketch => ({
  name: "Invoices",
  sentence: "",
  kind: "hybrid",
  trigger: { kind: "manual" },
  placement: null,
  standingApprovals: standing ? ["reply"] : [],
  steps: [
    {
      id: "reply",
      name: "Reply",
      kind: "draft_from_template",
      template: "t_thanks_received",
      send: "send",
    },
  ],
});

describe("the Workflow card", () => {
  test("says the Step runs on its standing approval only when every check passes", () => {
    const card = flowModel(doc(true), flowStrings(s)).cards[1];
    expect(card?.summary).toBe("Writes a reply from Thanks, received and sends it");
    expect(card?.tier?.kind).toBe("standing");
    expect(card?.fields?.at(-1)?.text).toEqual([
      "Runs on your standing approval when every check passes",
    ]);
    const asks = flowModel(doc(false), flowStrings(s)).cards[1];
    expect(asks?.tier?.kind).toBe("ask");
  });

  test("a Run's Step card shows the three badges", () => {
    const checks = {
      answers: {
        state: "flagged" as const,
        answered: 1,
        total: 2,
        unanswered: ["Can you send the W-9?"],
      },
      promises: { state: "clean" as const, unsupported: [] },
      leaks: { state: "unsure" as const, details: [], confidential: false },
    };
    const run = {
      id: "run-1",
      workflowId: "wf",
      workspaceId: "ws",
      version: 1,
      status: "paused",
      trigger: { kind: "manual", threadId: "t1" },
      threadId: "t1",
      subject: "Invoice",
      currentStep: 0,
      failedStep: null,
      waitingActivityId: "a1",
      waitingStep: 0,
      error: null,
      steps: [
        {
          index: 0,
          stepId: "reply",
          name: "Reply",
          kind: "draft_from_template",
          status: "waiting",
          detail: "Waiting for your approval: Leaves 1 unanswered: Can you send the W-9?",
          activityId: "a1",
          at: "2026-09-20T10:00:00.000Z",
          checks,
        },
      ],
      startedAt: "2026-09-20T10:00:00.000Z",
      finishedAt: null,
    } satisfies RunView;
    const card = flowModel(doc(true), flowStrings(s), { run, badges: badgeStrings(s) }).cards[1];
    expect(card?.badges?.map((b) => [b.state, b.text])).toEqual([
      ["flagged", "Leaves 1 unanswered: Can you send the W-9?"],
      ["clean", "No new promises"],
      ["unsure", "Could not check"],
    ]);
    expect(
      previewBadges({ kind: "send", to: [], cc: [], subject: "x", text: "y", checks }, s).length,
    ).toBe(3);
    expect(previewBadges({ kind: "send", to: [], cc: [], subject: "x", text: "y" }, s)).toEqual([]);
  });
});
