/// <reference types="bun-types" />
// The first sync screen through the DOM (docs/spec/onboarding.md, "First
// sync"): the gate shows it while the Inbox's headers, or its window bodies,
// are pending per `sync.first_run_wait`, and opens the app on its own once
// they are not; nothing behind it is in the DOM meanwhile (no nav, palette or
// agent bar); the bars never go backwards, also across a remount; an error
// offers exactly Retry and Open settings; a Server without the route never
// blocks the app.

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { FirstSyncProgress, PartialSettings } from "@monday/shared";
import { dom } from "@monday/ui/test-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { type Api, ApiError, createApi } from "../platform/api.ts";
import { StaticShell } from "../shell/Shell.tsx";
import { FirstSyncGate, resetFirstSyncMemory } from "./FirstSync.tsx";
import { emptyTracker, remainingMs, steadyEta, track } from "./first-sync/model.ts";

let createRoot: Awaited<ReturnType<typeof dom>>["createRoot"];
beforeAll(async () => {
  ({ createRoot } = await dom());
});

let root: Root | null = null;
let host: HTMLElement | null = null;
beforeEach(() => resetFirstSyncMemory());
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

const POLL = 0.02; // seconds: the tests read fast
// Twice: an update that lands inside one act runs its effects (the exit beat) at its end.
const settle = async (ms = 60) => {
  await act(async () => Bun.sleep(ms));
  await act(async () => Bun.sleep(5));
};
const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const qa = <T extends Element = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)];

function reading(
  headers: FirstSyncProgress["headers"],
  bodies: FirstSyncProgress["bodies"],
  extra: Partial<FirstSyncProgress> = {},
): FirstSyncProgress {
  return {
    accountId: "acct-1",
    workspaceId: "ws-1",
    provider: "gmail",
    address: "sam@monday.test",
    headers,
    bodies,
    pacing: false,
    error: null,
    at: "2026-09-23T10:00:00Z",
    ...extra,
  };
}

const HEADERS_PENDING = reading(
  { done: 1204, total: 12418, complete: false },
  { done: 0, total: 300, complete: false },
);
const BODIES_PENDING = reading(
  { done: 12418, total: 12418, complete: true },
  { done: 380, total: 640, complete: false },
);
const DONE = reading(
  { done: 12418, total: 12418, complete: true },
  { done: 640, total: 640, complete: true },
);

/** A Server that answers the progress from `now.value`, and records Retry. */
function fakeServer(initial: FirstSyncProgress | ApiError) {
  const now: { value: FirstSyncProgress | ApiError } = { value: initial };
  const calls = { sync: 0, retry: 0 };
  const base = createApi(() => null);
  const api: Api = {
    ...base,
    accounts: {
      ...base.accounts,
      sync: async () => {
        calls.sync += 1;
        if (now.value instanceof ApiError) throw now.value;
        return { progress: now.value };
      },
      retrySync: async () => {
        calls.retry += 1;
      },
    },
  };
  return { api, now, calls };
}

/** What the app would put on screen: nav, palette trigger and agent bar. */
function Behind() {
  return (
    <div className="app" data-testid="behind">
      <nav className="nav">Inbox</nav>
      <div className="cmdk" />
      <div className="agent-bar" />
    </div>
  );
}

async function mount(api: Api, settings: PartialSettings = {}, now?: () => number) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const account = { id: "acct-1", address: "sam@monday.test", provider: "gmail" as const };
  await act(async () =>
    root?.render(
      <StaticShell settings={{ "sync.first_run_poll_seconds": POLL, ...settings }} shell={{ api }}>
        <FirstSyncGate account={account} now={now}>
          <Behind />
        </FirstSyncGate>
      </StaticShell>,
    ),
  );
  await settle();
}

const screen = () => q('[data-screen="first-sync"]');
const behind = () => q('[data-testid="behind"]');
const barValue = (phase: string) =>
  Number(
    q(`.first-sync-line[data-phase="${phase}"] [role="progressbar"]`)?.getAttribute(
      "aria-valuenow",
    ) ?? "NaN",
  );
const detail = (phase: string) =>
  q(`.first-sync-line[data-phase="${phase}"] .first-sync-detail`)?.textContent ?? "";

describe("the first sync gate", () => {
  test("headers pending: the screen shows and nothing behind it is in the DOM", async () => {
    const server = fakeServer(HEADERS_PENDING);
    await mount(server.api, { "sync.first_run_wait": "headers" });
    expect(screen()).not.toBeNull();
    expect(q(".first-sync-account b")?.textContent).toBe("sam@monday.test");
    expect(detail("headers")).toBe("1,204 of 12,418");
    expect(document.body.textContent).toContain(
      "monday reads your inbox once so it opens instantly from now on.",
    );
    // Under `headers` there is no bodies line.
    expect(q('.first-sync-line[data-phase="bodies"]')).toBeNull();
    // Nothing of the app: no nav, no palette, no agent bar, no keymap to press.
    expect(behind()).toBeNull();
    expect(qa(".nav, .cmdk, .agent-bar")).toHaveLength(0);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "/" }));
    });
    await settle();
    expect(qa(".cmdk")).toHaveLength(0);
    // The only controls are the screen's own (none while syncing).
    expect(qa("button")).toHaveLength(0);
  });

  test("the app opens on its own once the headers are in, under `headers`", async () => {
    const server = fakeServer(HEADERS_PENDING);
    await mount(server.api, { "sync.first_run_wait": "headers" });
    expect(behind()).toBeNull();
    server.now.value = BODIES_PENDING;
    await settle(120);
    expect(screen()).toBeNull();
    expect(behind()).not.toBeNull();
    // Once open the gate stops reading.
    const reads = server.calls.sync;
    await settle(120);
    expect(server.calls.sync).toBe(reads);
  });

  test("under `inbox_bodies` the window's bodies keep it shut until they are fetched", async () => {
    const server = fakeServer(BODIES_PENDING);
    await mount(server.api, { "sync.first_run_wait": "inbox_bodies" });
    expect(screen()).not.toBeNull();
    expect(behind()).toBeNull();
    expect(detail("headers")).toBe("Done");
    expect(detail("bodies")).toBe("380 of 640");
    expect(q('.first-sync-line[data-phase="bodies"]')?.getAttribute("data-state")).toBe("active");
    server.now.value = DONE;
    await settle(120);
    expect(screen()).toBeNull();
    expect(behind()).not.toBeNull();
  });

  test("bodies pending with the Setting at `headers`: the app opens at once, no screen", async () => {
    const server = fakeServer(BODIES_PENDING);
    await mount(server.api, { "sync.first_run_wait": "headers" });
    expect(screen()).toBeNull();
    expect(behind()).not.toBeNull();
  });

  test("while the headers page, the bodies line waits its turn", async () => {
    const server = fakeServer(HEADERS_PENDING);
    await mount(server.api);
    const line = q('.first-sync-line[data-phase="bodies"]');
    expect(line?.getAttribute("data-state")).toBe("waiting");
    expect(detail("bodies")).toBe("Next");
  });

  test("the bars never go backwards, even when the Provider's total grows", async () => {
    const server = fakeServer(
      reading({ done: 500, total: 1000, complete: false }, { done: 0, total: 10, complete: false }),
    );
    await mount(server.api);
    expect(barValue("headers")).toBe(50);
    // More mail arrived: 510 of 2000 is a smaller share than 500 of 1000.
    server.now.value = reading(
      { done: 510, total: 2000, complete: false },
      { done: 0, total: 10, complete: false },
    );
    await settle(120);
    expect(detail("headers")).toBe("510 of 2,000");
    expect(barValue("headers")).toBe(50);
    // A reading with a lower count (a stale replica) never lowers the count shown.
    server.now.value = reading(
      { done: 400, total: 2000, complete: false },
      { done: 0, total: 10, complete: false },
    );
    await settle(120);
    expect(detail("headers")).toBe("510 of 2,000");
    expect(barValue("headers")).toBe(50);
  });

  test("a remount resumes at the same progress", async () => {
    const server = fakeServer(
      reading({ done: 700, total: 1000, complete: false }, { done: 0, total: 10, complete: false }),
    );
    await mount(server.api);
    expect(barValue("headers")).toBe(70);
    await act(async () => root?.unmount());
    root = null;
    host?.remove();
    // Reopened while the total grew: the screen comes back where it was.
    server.now.value = reading(
      { done: 700, total: 1400, complete: false },
      { done: 0, total: 10, complete: false },
    );
    await mount(server.api);
    expect(screen()).not.toBeNull();
    expect(barValue("headers")).toBe(70);
    expect(detail("headers")).toBe("700 of 1,400");
  });

  test("an error says why in plain words and offers only Retry and Open settings", async () => {
    const server = fakeServer(
      reading(
        { done: 40, total: 1000, complete: false },
        { done: 0, total: 10, complete: false },
        { error: { kind: "auth", message: "invalid_grant" } },
      ),
    );
    await mount(server.api);
    const alert = q('[role="alert"]');
    expect(alert?.textContent).toContain("Syncing stopped");
    expect(alert?.textContent).toContain(
      "Gmail no longer accepts monday's sign-in for sam@monday.test.",
    );
    expect(alert?.textContent).not.toContain("invalid_grant");
    const labels = qa("button").map((b) => b.textContent?.trim());
    expect(labels).toEqual(["Open settings", "Retry"]);
    expect(behind()).toBeNull();

    // Retry clears the failure on the Server and reads again at once.
    server.now.value = reading(
      { done: 60, total: 1000, complete: false },
      { done: 0, total: 10, complete: false },
    );
    const before = server.calls.sync;
    const retry = qa<HTMLButtonElement>("button").find((b) => b.textContent === "Retry");
    await act(async () => retry?.click());
    await settle(30);
    expect(server.calls.retry).toBe(1);
    expect(server.calls.sync).toBeGreaterThan(before);
    expect(q('[role="alert"]')).toBeNull();
  });

  test("Open settings reaches the Accounts section, with a way back and nothing else", async () => {
    const server = fakeServer(
      reading(
        { done: 40, total: 1000, complete: false },
        { done: 0, total: 10, complete: false },
        { error: { kind: "network", message: "ECONNREFUSED" } },
      ),
    );
    await mount(server.api);
    expect(q('[role="alert"]')?.textContent).toContain("monday cannot reach Gmail right now.");
    const open = qa<HTMLButtonElement>("button").find((b) => b.textContent === "Open settings");
    await act(async () => open?.click());
    await settle();
    expect(screen()).toBeNull();
    expect(q(".first-sync-back")).not.toBeNull();
    expect(behind()).toBeNull();
    const back = q<HTMLButtonElement>(".first-sync-back button");
    await act(async () => back?.click());
    await settle();
    expect(screen()).not.toBeNull();
  });

  test("an unreachable Server shows its own line, never a blank window", async () => {
    const server = fakeServer(new ApiError(0, "connection refused"));
    await mount(server.api);
    expect(q('[role="alert"]')?.textContent).toContain(
      "monday cannot reach its sync server to read the progress.",
    );
    expect(behind()).toBeNull();
  });

  test("a Server without the route never blocks the app", async () => {
    const server = fakeServer(new ApiError(404, "not found"));
    await mount(server.api);
    expect(screen()).toBeNull();
    expect(behind()).not.toBeNull();
  });

  test("pacing says so instead of a frozen bar", async () => {
    const server = fakeServer({ ...HEADERS_PENDING, pacing: true });
    await mount(server.api);
    expect(q('[data-note="pacing"]')?.textContent).toContain(
      "Gmail asked monday to slow down to stay within its limits.",
    );
  });
});

describe("the time remaining", () => {
  const eta = { windowMs: 60_000, minSamples: 5, tolerance: 0.25 };
  const at = (done: number) =>
    reading({ done, total: 1000, complete: false }, { done: 0, total: 0, complete: false });

  test("hidden until enough steady readings, then shown", () => {
    let t = emptyTracker();
    for (let i = 0; i < 4; i++) t = track(t, at(100 + i * 10), "headers", i * 1000, eta);
    expect(steadyEta(t, eta)).toBeNull();
    t = track(t, at(140), "headers", 4000, eta);
    const ms = steadyEta(t, eta);
    expect(ms).not.toBeNull();
    // 1% a second with 86% to go.
    expect(Math.round((ms ?? 0) / 1000)).toBe(86);
  });

  test("hidden again when the rate swings", () => {
    let t = emptyTracker();
    for (let i = 0; i < 5; i++) t = track(t, at(100 + i * 10), "headers", i * 1000, eta);
    expect(steadyEta(t, eta)).not.toBeNull();
    t = track(t, at(400), "headers", 5000, eta);
    expect(steadyEta(t, eta)).toBeNull();
  });

  test("no movement, no estimate", () => {
    expect(
      remainingMs([
        { at: 0, fraction: 0.2 },
        { at: 1000, fraction: 0.2 },
      ]),
    ).toBeNull();
  });
});
