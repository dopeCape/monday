/// <reference types="bun-types" />
// A Workflow's status in one word: locked by the AI level first, then
// switched off, waiting for an approval, failing on its latest Run, on.

import { describe, expect, test } from "bun:test";
import type { RunView, WorkflowView } from "@monday/shared";
import { defaultSettings } from "@monday/shared";
import { statusLabel, workflowStatus } from "./status.ts";
import { fixtureRuns, fixtureWorkflows } from "./workflow-data.ts";

const w = fixtureWorkflows[0] as WorkflowView;
const run = (status: RunView["status"], startedAt: string): RunView => ({
  ...(fixtureRuns[0] as RunView),
  id: `x-${status}-${startedAt}`,
  workflowId: w.id,
  status,
  startedAt,
});

describe("workflowStatus", () => {
  test("locked wins, then off, then waiting, then the latest finished Run", () => {
    expect(workflowStatus(w, fixtureRuns, true)).toBe("locked");
    expect(workflowStatus({ ...w, enabled: false }, fixtureRuns, false)).toBe("off");
    expect(workflowStatus({ ...w, paused: 1 }, fixtureRuns, false)).toBe("waiting");
    // The loaded Runs are newest first: the newest finished one decides.
    expect(workflowStatus(w, [run("failed", "2026-09-16T11:00:00Z"), ...fixtureRuns], false)).toBe(
      "failing",
    );
    expect(workflowStatus(w, fixtureRuns, false)).toBe("on");
    // Without loaded Runs, the recent outcomes stand in.
    expect(workflowStatus({ ...w, recent: ["done", "failed", "running"] }, [], false)).toBe(
      "failing",
    );
  });

  test("the words are Settings; waiting carries its count", () => {
    const s = defaultSettings();
    expect(statusLabel("waiting", 2, s)).toBe("2 waiting");
    expect(statusLabel("off", 0, s)).toBe("Paused");
    expect(statusLabel("locked", 0, { ...s, "strings.workflows.status.locked": "Held" })).toBe(
      "Held",
    );
  });
});
