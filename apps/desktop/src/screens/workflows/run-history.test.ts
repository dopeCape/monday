/// <reference types="bun-types" />
// Run history's words over RunView: four states, the trigger in plain
// words, lengths in the user's units, the Step a failed Run stopped at, and
// the newest Runs first.

import { describe, expect, test } from "bun:test";
import { defaultSettings, type RunView } from "@monday/shared";
import {
  durationLine,
  durationText,
  failedStepLine,
  historyState,
  historyStrings,
  newestRuns,
  triggerLabel,
} from "./run-history.ts";

const s = historyStrings(defaultSettings());

const run = (over: Partial<RunView>): RunView => ({
  id: "r",
  workflowId: "w",
  workspaceId: "ws",
  version: 1,
  status: "done",
  trigger: { kind: "manual", threadId: null },
  threadId: null,
  subject: "",
  currentStep: 0,
  failedStep: null,
  waitingActivityId: null,
  waitingStep: null,
  error: null,
  steps: [],
  startedAt: "2026-09-16T10:00:00.000Z",
  finishedAt: "2026-09-16T10:00:12.000Z",
  ...over,
});

describe("Run history words", () => {
  test("queued reads as running and paused as waiting", () => {
    expect(historyState(run({ status: "queued" }))).toBe("running");
    expect(historyState(run({ status: "running" }))).toBe("running");
    expect(historyState(run({ status: "paused" }))).toBe("waiting");
    expect(historyState(run({ status: "failed" }))).toBe("failed");
  });

  test("triggers in plain words", () => {
    expect(triggerLabel(run({}), s)).toBe("Run by hand");
    expect(triggerLabel(run({ trigger: { kind: "schedule", at: "x" } }), s)).toBe("On a schedule");
    expect(triggerLabel(run({ trigger: { kind: "silence", threadId: "t" } }), s)).toBe(
      "No reply came",
    );
  });

  test("lengths in seconds, minutes and hours; an unfinished Run is still running", () => {
    expect(durationLine(run({}), s)).toBe("Took 12 s");
    expect(durationText(3 * 60_000, s)).toBe("3 min");
    expect(durationText(64 * 60_000, s)).toBe("1 h 4 min");
    expect(durationLine(run({ finishedAt: null, status: "running" }), s)).toBe("Still running");
  });

  test("a failed Run names the Step it stopped at, by index or by its failed Step", () => {
    const steps = [
      { index: 0, stepId: "a", name: "Read", kind: "agentic", status: "done", detail: "" },
      { index: 1, stepId: "b", name: "Drive", kind: "drive", status: "failed", detail: "" },
    ] as RunView["steps"];
    expect(failedStepLine(run({ status: "failed", failedStep: 1, steps }), s)).toBe(
      "Failed at step 2, Drive",
    );
    expect(failedStepLine(run({ status: "failed", steps }), s)).toBe("Failed at step 2, Drive");
    expect(failedStepLine(run({ status: "done", steps }), s)).toBeNull();
    expect(failedStepLine(run({ status: "failed" }), s)).toBeNull();
  });

  test("the newest first, at most the limit", () => {
    const runs = [
      run({ id: "a", startedAt: "2026-09-10T00:00:00Z" }),
      run({ id: "b", startedAt: "2026-09-12T00:00:00Z" }),
      run({ id: "c", startedAt: "2026-09-11T00:00:00Z" }),
    ];
    expect(newestRuns(runs, 2).map((r) => r.id)).toEqual(["b", "c"]);
  });
});
