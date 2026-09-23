import { describe, expect, test } from "bun:test";
import {
  type FirstSyncProgress,
  firstSyncComplete,
  firstSyncFraction,
  firstSyncPhase,
} from "./first-sync.ts";
import { defaultSettings } from "./settings/index.ts";

function progress(
  headers: FirstSyncProgress["headers"],
  bodies: FirstSyncProgress["bodies"],
): FirstSyncProgress {
  return {
    accountId: "a",
    workspaceId: "w",
    provider: "gmail",
    address: "sam@monday.test",
    headers,
    bodies,
    pacing: false,
    error: null,
    at: "2026-09-23T10:00:00Z",
  };
}

describe("the first sync definition", () => {
  const headersPending = progress(
    { done: 10, total: 100, complete: false },
    { done: 0, total: 20, complete: false },
  );
  const bodiesPending = progress(
    { done: 100, total: 100, complete: true },
    { done: 5, total: 20, complete: false },
  );
  const done = progress(
    { done: 100, total: 100, complete: true },
    { done: 20, total: 20, complete: true },
  );

  test("the Setting defaults to waiting for the Inbox's bodies", () => {
    expect(defaultSettings()["sync.first_run_wait"]).toBe("inbox_bodies");
  });

  test("headers pending blocks under either wait", () => {
    expect(firstSyncComplete(headersPending, "headers")).toBe(false);
    expect(firstSyncComplete(headersPending, "inbox_bodies")).toBe(false);
    expect(firstSyncPhase(headersPending, "inbox_bodies")).toBe("headers");
  });

  test("bodies pending blocks only when the Setting waits for them", () => {
    expect(firstSyncComplete(bodiesPending, "headers")).toBe(true);
    expect(firstSyncComplete(bodiesPending, "inbox_bodies")).toBe(false);
    expect(firstSyncPhase(bodiesPending, "inbox_bodies")).toBe("bodies");
    expect(firstSyncPhase(done, "inbox_bodies")).toBe("done");
  });

  test("the fraction spans both phases and is whole only when complete", () => {
    const a = firstSyncFraction(headersPending, "inbox_bodies");
    const b = firstSyncFraction(bodiesPending, "inbox_bodies");
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(b).toBeLessThan(1);
    expect(firstSyncFraction(done, "inbox_bodies")).toBe(1);
    expect(firstSyncFraction(headersPending, "headers")).toBeCloseTo(0.1);
    // An unknown total counts as not started rather than guessed.
    expect(
      firstSyncFraction(
        progress(
          { done: 40, total: null, complete: false },
          { done: 0, total: 0, complete: false },
        ),
        "headers",
      ),
    ).toBe(0);
  });
});
