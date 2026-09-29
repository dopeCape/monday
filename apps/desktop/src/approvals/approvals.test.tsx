/// <reference types="bun-types" />
// Live Runs and the approvals waiting for the user, through their seams: the
// live Runs read in one request and followed on the Changes feed (a poll
// only while a Run is going), a notice once per waiting Step within the
// Settings, the Approvals queue's items, and the App: the nav's running dot
// and approvals count, the title badge, the queue opened from the nav, its
// shortcut and the palette, answering through the Run's approval route with
// the item leaving, and the Workflows page following a going Run Step by Step.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  type ActivityRecord,
  defaultSettings,
  type RunChange,
  type RunView,
  type Settings,
} from "@monday/shared";
import { dom } from "@monday/ui/test-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { App } from "../App.tsx";
import { fixtureComposer } from "../screens/compose/composer.ts";
import { fixtureInbox } from "../screens/inbox/actions.ts";
import { paletteNavigation } from "../screens/Palette.tsx";
import { Workflows } from "../screens/Workflows.tsx";
import {
  fixtureWorkflows,
  fixtureWorkflowsApi,
  type WorkflowsApi,
} from "../screens/workflows/workflow-data.ts";
import { StaticShell } from "../shell/Shell.tsx";
import { createLiveRuns, type LiveRunsSnapshot, type LiveRunsTimers } from "./live-runs.ts";
import { approvalNotices, waitingKey } from "./notices.ts";
import { approvalItems } from "./queue.ts";
import { type RunFeed, useApprovals } from "./useApprovals.ts";

const NOW = new Date("2026-09-16T10:00:00");
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000).toISOString();

const step = (
  index: number,
  stepId: string,
  name: string,
  status: RunView["steps"][number]["status"],
  detail: string,
  at = minutesAgo(2),
): RunView["steps"][number] => ({
  index,
  stepId,
  name,
  kind: "notify",
  status,
  detail,
  activityId: null,
  at,
});

/** Candidate intake (w1) paused at Slack, its fourth Step. */
function pausedRun(id = "r9", at = minutesAgo(2)): RunView {
  return {
    id,
    workflowId: "w1",
    workspaceId: "ws",
    version: 1,
    status: "paused",
    trigger: { kind: "arrival", threadId: `t-${id}` },
    threadId: `t-${id}`,
    subject: "Priya Raman, Rust engineer",
    currentStep: 3,
    failedStep: null,
    waitingActivityId: `a-${id}`,
    waitingStep: 3,
    error: null,
    steps: [
      step(0, "extract", "Extract", "done", "name: Priya Raman"),
      step(1, "notion", "Notion", "done", "Row added to Hiring"),
      step(2, "rust", "If role is Rust", "done", "Yes"),
      step(3, "slack", "Slack", "waiting", "Waiting for your approval", at),
    ],
    startedAt: minutesAgo(3),
    finishedAt: null,
  };
}

/** Invoices to Drive (w2) running its second Step. */
function runningRun(id = "r8"): RunView {
  return {
    id,
    workflowId: "w2",
    workspaceId: "ws",
    version: 1,
    status: "running",
    trigger: { kind: "arrival", threadId: `t-${id}` },
    threadId: `t-${id}`,
    subject: "Hetzner invoice",
    currentStep: 1,
    failedStep: null,
    waitingActivityId: null,
    waitingStep: null,
    error: null,
    steps: [step(0, "read", "Read", "done", "vendor: Hetzner")],
    startedAt: minutesAgo(1),
    finishedAt: null,
  };
}

const waitingRow = (run: RunView, at = minutesAgo(2)): ActivityRecord => ({
  id: run.waitingActivityId as string,
  workspaceId: "ws",
  sessionId: null,
  runId: run.id,
  tool: "post_to_slack",
  tier: "always-ask",
  inputSummary: "#hiring",
  status: "waiting",
  approvedBy: null,
  undoable: false,
  undoneAt: null,
  actor: "automation",
  callId: "step-3",
  input: {},
  preview: { kind: "text", text: "Slack #hiring:\nNew candidate: Priya Raman" },
  decision: null,
  at,
});

/** The fixture API with these live Runs; decide answers and the Run leaves; every call is recorded. */
function liveApi(initial: RunView[]) {
  const base = fixtureWorkflowsApi();
  const live = [...initial];
  const asked: string[] = [];
  const api: WorkflowsApi & { calls: string[]; asked: string[]; live: RunView[] } = {
    ...base,
    calls: base.calls,
    asked,
    live,
    list: async (w) => {
      asked.push("list");
      return base.list(w);
    },
    runs: async (w, options = {}) => {
      asked.push(`runs:${[options.status ?? []].flat().join(",")}`);
      const wanted = [options.status ?? []].flat();
      const older = await base.runs(w, {
        ...(options.workflowId ? { workflowId: options.workflowId } : {}),
      });
      return [...live, ...older].filter(
        (r) =>
          (wanted.length === 0 || wanted.includes(r.status)) &&
          (!options.workflowId || r.workflowId === options.workflowId),
      );
    },
    runActivity: async (runId) => {
      asked.push(`activity:${runId}`);
      const run = live.find((r) => r.id === runId);
      return run?.waitingActivityId ? [waitingRow(run)] : [];
    },
    decide: async (runId, decision, standing = false) => {
      base.calls.push(`decide:${runId}:${decision}:${standing}`);
      const i = live.findIndex((r) => r.id === runId);
      const run = live[i] as RunView;
      live.splice(i, 1);
      return { ...run, status: decision === "approved" ? "done" : "failed" };
    },
  };
  return api;
}

/** Timers the test fires by hand. */
function handTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let next = 1;
  const timers: LiveRunsTimers & { pending: typeof pending; fire(): Promise<void> } = {
    pending,
    set: (fn, ms) => {
      const id = next++;
      pending.set(id, { fn, ms });
      return id;
    },
    clear: (id) => pending.delete(id as number),
    async fire() {
      const all = [...pending.values()];
      pending.clear();
      for (const t of all) t.fn();
      await Bun.sleep(5);
    },
  };
  return timers;
}

/* ------------------------------ Live Runs ------------------------------ */

describe("live Runs", () => {
  test("are one request for every live status; the waiting Step is read once; nothing polls while only an approval waits", async () => {
    const api = liveApi([pausedRun()]);
    const timers = handTimers();
    const live = createLiveRuns({ api, workspaceId: "ws", pollSeconds: () => 5, timers });
    await live.refresh();
    const s = live.snapshot();
    expect(s.loaded).toBe(true);
    expect(s.runs.map((r) => r.id)).toEqual(["r9"]);
    expect(s.activity.get("a-r9")?.tool).toBe("post_to_slack");
    expect(s.workflows.get("w1")?.name).toBe("Candidate intake");
    expect(api.asked).toEqual(["runs:queued,running,paused", "list", "activity:r9"]);
    // A paused Run can wait for days: no poll is planned for it.
    expect(timers.pending.size).toBe(0);
    await live.refresh();
    expect(api.asked.filter((a) => a.startsWith("activity"))).toHaveLength(1);
    live.stop();
  });

  test("poll every workflows.live.poll_seconds only while a Run is going, and stop once it is not", async () => {
    const api = liveApi([runningRun()]);
    const timers = handTimers();
    let seconds = 5;
    const live = createLiveRuns({ api, workspaceId: "ws", pollSeconds: () => seconds, timers });
    await live.refresh();
    expect([...timers.pending.values()].map((t) => t.ms)).toEqual([5000]);
    await timers.fire();
    expect(api.asked.filter((a) => a.startsWith("runs"))).toHaveLength(2);
    // The Run finished: the next read plans nothing.
    api.live.splice(0, 1);
    await timers.fire();
    expect(live.snapshot().runs).toEqual([]);
    expect(timers.pending.size).toBe(0);
    // 0 relies on the feed alone.
    seconds = 0;
    api.live.push(runningRun("r7"));
    await live.refresh();
    expect(timers.pending.size).toBe(0);
    live.stop();
  });

  test("feed wakes arriving together are one read", async () => {
    const api = liveApi([]);
    const timers = handTimers();
    const live = createLiveRuns({ api, workspaceId: "ws", pollSeconds: () => 5, timers });
    await live.refresh();
    const reads = () => api.asked.filter((a) => a.startsWith("runs")).length;
    expect(reads()).toBe(1);
    api.live.push(pausedRun());
    live.wake();
    live.wake();
    live.wake();
    expect(timers.pending.size).toBe(1);
    await timers.fire();
    expect(reads()).toBe(2);
    expect(live.snapshot().runs.map((r) => r.id)).toEqual(["r9"]);
    live.stop();
  });

  test("answering goes through the Run's approval route and the Run leaves the list at once", async () => {
    const api = liveApi([pausedRun()]);
    const live = createLiveRuns({
      api,
      workspaceId: "ws",
      pollSeconds: () => 0,
      timers: handTimers(),
    });
    await live.refresh();
    await live.decide("r9", "approved", true);
    expect(api.calls).toContain("decide:r9:approved:true");
    expect(live.snapshot().runs).toEqual([]);
    live.stop();
  });
});

/* ------------------------------ Notices ------------------------------ */

function snapshot(runs: RunView[], activity = true): LiveRunsSnapshot {
  return {
    runs,
    workflows: new Map(fixtureWorkflows.map((w) => [w.id, w])),
    activity: new Map(
      activity
        ? runs.flatMap((r) =>
            r.waitingActivityId ? [[r.waitingActivityId, waitingRow(r)] as const] : [],
          )
        : [],
    ),
    loaded: true,
    version: 1,
  };
}

const noticeSettings = (over: Partial<Settings> = {}): Settings => ({
  ...defaultSettings(),
  ...over,
});

describe("approval notices", () => {
  test("a Run that starts waiting is told once, with the Workflow and what the Step wants to do", () => {
    const first = approvalNotices({
      live: snapshot([pausedRun()]),
      told: new Set(),
      settings: noticeSettings(),
      now: NOW,
    });
    expect(first.notices.map((n) => [n.title, n.body])).toEqual([
      ["Candidate intake is waiting for your approval", "Step 4, Slack: post to slack #hiring"],
    ]);
    // The same waiting Step is not told again.
    const again = approvalNotices({
      live: snapshot([pausedRun()]),
      told: first.told,
      settings: noticeSettings(),
      now: NOW,
    });
    expect(again.notices).toEqual([]);
    // The same Run waiting on another Step is news again.
    const later = { ...pausedRun(), waitingActivityId: "a-r9-2" };
    expect(
      approvalNotices({
        live: snapshot([later]),
        told: again.told,
        settings: noticeSettings(),
        now: NOW,
      }).notices,
    ).toHaveLength(1);
  });

  test("waits for the Step's Activity row, so the notice can say what it does", () => {
    const pending = approvalNotices({
      live: snapshot([pausedRun()], false),
      told: new Set(),
      settings: noticeSettings(),
      now: NOW,
    });
    expect(pending.notices).toEqual([]);
    expect(pending.told.size).toBe(0);
  });

  test("respects notifications.enabled and notifications.workflow_approvals, and never tells a skipped Step later", () => {
    for (const off of [
      { "notifications.enabled": false },
      { "notifications.workflow_approvals": false },
    ] as Partial<Settings>[]) {
      const quiet = approvalNotices({
        live: snapshot([pausedRun()]),
        told: new Set(),
        settings: noticeSettings(off),
        now: NOW,
      });
      expect(quiet.notices).toEqual([]);
      const back = approvalNotices({
        live: snapshot([pausedRun()]),
        told: quiet.told,
        settings: noticeSettings(),
        now: NOW,
      });
      expect(back.notices).toEqual([]);
    }
  });

  test("a Step that was already waiting long before stays quiet (notifications.workflow_approvals_recent_minutes)", () => {
    const old = pausedRun("r5", minutesAgo(600));
    const run = { ...old };
    const live = snapshot([run]);
    (live.activity as Map<string, ActivityRecord | null>).set(
      "a-r5",
      waitingRow(run, minutesAgo(600)),
    );
    expect(
      approvalNotices({ live, told: new Set(), settings: noticeSettings(), now: NOW }).notices,
    ).toEqual([]);
    expect(
      approvalNotices({
        live,
        told: new Set(),
        settings: noticeSettings({ "notifications.workflow_approvals_recent_minutes": 720 }),
        now: NOW,
      }).notices,
    ).toHaveLength(1);
  });
});

/* ------------------------------ The queue ------------------------------ */

describe("the Approvals queue's items", () => {
  test("a paused Run says where it comes from, what it will do and which Thread; the Session's calls follow", () => {
    const items = approvalItems({
      live: snapshot([pausedRun()]),
      session: [
        {
          id: "c1",
          sessionId: "s1",
          runId: null,
          tool: "send_draft",
          tier: "always-ask",
          inputSummary: "to ana@acme.test",
          status: "waiting",
          approvedBy: null,
          undoable: false,
        },
      ],
      external: [],
      strings: defaultSettings(),
    });
    expect(items.map((i) => [i.kind, i.from, i.what, i.about])).toEqual([
      [
        "run",
        "Candidate intake · Step 4: Slack",
        "post to slack #hiring",
        "About Priya Raman, Rust engineer",
      ],
      ["session", "The agent, in your current session", "send draft to ana@acme.test", null],
    ]);
    const run = items[0];
    // Slack has no Standing approval yet, so "Always allow this step" is offered.
    expect(run?.kind === "run" && run.standing).toBe(true);
  });
});

/* ------------------------------ The App ------------------------------ */

let createRoot: Awaited<ReturnType<typeof dom>>["createRoot"];
beforeAll(async () => {
  ({ createRoot } = await dom());
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

const tick = () => act(async () => Bun.sleep(20));
const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const qa = <T extends Element = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)];
const navItem = (key: string) => q(`.nav .nav-item[data-key="${key}"]`);
async function click(el: Element | null | undefined) {
  if (!el) throw new Error("nothing to click");
  await act(async () => (el as HTMLElement).click());
  await tick();
}
async function press(init: KeyboardEventInit) {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  });
  await tick();
}

/** A feed the test drives: what the Store's onRuns would hear. */
function handFeed() {
  const listeners = new Set<(runs: readonly RunChange[]) => void>();
  const feed: RunFeed & { tell(): void } = {
    onRuns(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    tell() {
      for (const l of listeners) l([]);
    },
  };
  return feed;
}

async function mountApp(api: WorkflowsApi, feed?: RunFeed, settings: Partial<Settings> = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const r = root;
  await act(async () =>
    r.render(
      <StaticShell
        settings={{
          "ai.level": "automate",
          "workflows.page.refresh_seconds": 0,
          "workflows.live.poll_seconds": 0,
          "onboarding.state": {},
          ...settings,
        }}
      >
        <App
          inbox={fixtureInbox()}
          composer={fixtureComposer({ drafts: [], now: () => NOW })}
          agentClient={null}
          accounts={null}
          keys={null}
          now={NOW}
          workflowsApi={api}
          runFeed={feed}
        />
      </StaticShell>,
    ),
  );
  await tick();
  await tick();
}

describe("in the App", () => {
  test("the nav counts the approvals waiting, the title carries them, and a going Run breathes beside Workflows", async () => {
    await mountApp(liveApi([pausedRun(), runningRun()]));
    const approvals = navItem("approvals");
    expect(approvals?.querySelector(".n.attn")?.textContent).toBe("1");
    expect(approvals?.getAttribute("title")).toBe("1 waiting for your approval");
    expect(navItem("workflows")?.querySelector(".live-dot")).not.toBeNull();
    expect(navItem("workflows")?.getAttribute("title")).toBe("1 running now");
    expect(document.title).toBe("(1) Inbox · monday");
  });

  test("Just mail shows no Approvals entry and no count in the title", async () => {
    await mountApp(liveApi([pausedRun()]), undefined, { "ai.level": "off" });
    expect(navItem("approvals")).toBeNull();
    expect(document.title).toBe("Inbox · monday");
  });

  test("the nav opens the queue: the Run's Step, what it will do and its Thread; Approve resumes it through the Run's route and it leaves", async () => {
    const api = liveApi([pausedRun()]);
    await mountApp(api);
    await click(navItem("approvals"));
    const sheet = q(".appr");
    expect(sheet?.getAttribute("role")).toBe("dialog");
    expect(qa(".appr-item .appr-from-text").map((e) => e.textContent)).toEqual([
      "Candidate intake · Step 4: Slack",
    ]);
    expect(q(".appr-item .appr-link")?.textContent).toBe("About Priya Raman, Rust engineer");
    expect(q(".appr-item .preview")?.textContent).toContain("New candidate: Priya Raman");
    const approve = qa<HTMLButtonElement>(".appr-item button").find(
      (b) => b.textContent === "Approve",
    );
    await click(approve);
    expect(api.calls).toContain("decide:r9:approved:false");
    expect(qa(".appr-item")).toHaveLength(0);
    expect(q(".appr-empty")?.textContent).toContain("Nothing is waiting for you.");
    expect(navItem("approvals")?.querySelector(".n")).toBeNull();
    expect(document.title).toBe("Inbox · monday");
  });

  test("Decline and Always allow this step answer through the same route", async () => {
    const api = liveApi([pausedRun("r9"), pausedRun("r10", minutesAgo(1))]);
    await mountApp(api);
    await click(navItem("approvals"));
    expect(qa(".appr-item")).toHaveLength(2);
    const buttons = (label: string) =>
      qa<HTMLButtonElement>(".appr-item button").filter((b) => b.textContent === label);
    await click(buttons("Decline")[0]);
    expect(api.calls).toContain("decide:r9:declined:false");
    await click(buttons("Always allow this step")[0]);
    expect(api.calls).toContain("decide:r10:approved:true");
    expect(qa(".appr-item")).toHaveLength(0);
  });

  test("its shortcut opens and closes it from any screen, Escape closes it, and the palette offers it", async () => {
    await mountApp(liveApi([pausedRun()]));
    await press({ key: "A", shiftKey: true, ctrlKey: true });
    expect(q(".appr")).not.toBeNull();
    await act(async () => {
      q(".appr")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await tick();
    expect(q(".appr")).toBeNull();
    // From the Workflows page too.
    await click(navItem("workflows"));
    await press({ key: "a", shiftKey: true, ctrlKey: true });
    expect(q(".appr")).not.toBeNull();
    await press({ key: "a", shiftKey: true, ctrlKey: true });
    expect(q(".appr")).toBeNull();
    const nav = paletteNavigation({ ...defaultSettings(), "ai.level": "assist" }, false, []);
    expect(nav.find((n) => n.target === "approvals")?.label).toBe("Approvals waiting for you");
    expect(
      paletteNavigation({ ...defaultSettings(), "ai.level": "off" }, false, []).some(
        (n) => n.target === "approvals",
      ),
    ).toBe(false);
  });

  test("picking it in the palette opens the queue over the Inbox", async () => {
    await mountApp(liveApi([pausedRun()]));
    await press({ key: "k", ctrlKey: true });
    const input = q<HTMLInputElement>(".cmdk input");
    if (!input) throw new Error("no palette");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(input, "approvals");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await tick();
    const row = qa(".cmdk .cmdk-item").find((e) =>
      e.textContent?.includes("Approvals waiting for you"),
    );
    await click(row);
    await tick();
    expect(q(".appr")).not.toBeNull();
    expect(qa(".appr-item")).toHaveLength(1);
  });

  test("a feed wake brings a new waiting approval into the count without a poll", async () => {
    const api = liveApi([]);
    const feed = handFeed();
    await mountApp(api, feed);
    expect(navItem("approvals")?.querySelector(".n")).toBeNull();
    api.live.push(pausedRun());
    await act(async () => feed.tell());
    await act(async () => Bun.sleep(250));
    expect(navItem("approvals")?.querySelector(".n")?.textContent).toBe("1");
  });
});

describe("the notice as a Run starts waiting", () => {
  test("fires once for the waiting Step as the feed says the Run moved, and not again on the next wake", async () => {
    const api = liveApi([]);
    const feed = handFeed();
    const told: string[] = [];
    function Harness() {
      useApprovals({
        api,
        workspaceId: "ws",
        feed,
        settings: { ...defaultSettings(), "workflows.live.poll_seconds": 0 },
        session: [],
        external: [],
        tell: (n) => told.push(`${n.title} | ${n.body}`),
        now: () => NOW,
      });
      return null;
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const r = root;
    await act(async () => r.render(<Harness />));
    await tick();
    expect(told).toEqual([]);
    api.live.push(pausedRun());
    await act(async () => feed.tell());
    await act(async () => Bun.sleep(250));
    expect(told).toEqual([
      "Candidate intake is waiting for your approval | Step 4, Slack: post to slack #hiring",
    ]);
    await act(async () => feed.tell());
    await act(async () => Bun.sleep(250));
    expect(told).toHaveLength(1);
  });

  test("a Step the Sidecar told while monday was closed is not told again; notices wait for that answer", async () => {
    const api = liveApi([]);
    const feed = handFeed();
    const told: string[] = [];
    let sidecarTold: ReadonlySet<string> | null = null;
    function Harness({ bySidecar }: { bySidecar: ReadonlySet<string> | null }) {
      useApprovals({
        api,
        workspaceId: "ws",
        feed,
        settings: { ...defaultSettings(), "workflows.live.poll_seconds": 0 },
        session: [],
        external: [],
        tell: (n) => told.push(n.key),
        now: () => NOW,
        toldBySidecar: bySidecar,
      });
      return null;
    }
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const r = root;
    await act(async () => r.render(<Harness bySidecar={sidecarTold} />));
    await tick();
    const run = pausedRun();
    api.live.push(run);
    await act(async () => feed.tell());
    await act(async () => Bun.sleep(250));
    // Still asking the Sidecar: nothing yet.
    expect(told).toEqual([]);
    sidecarTold = new Set([waitingKey(run)]);
    await act(async () => r.render(<Harness bySidecar={sidecarTold} />));
    await act(async () => Bun.sleep(50));
    expect(told).toEqual([]);
    await act(async () => feed.tell());
    await act(async () => Bun.sleep(250));
    expect(told).toEqual([]);
  });
});

/* ------------------------------ The Workflows page ------------------------------ */

describe("the Workflows page follows a live Run", () => {
  async function mountPage(api: WorkflowsApi, live: RunView[]) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const r = root;
    await act(async () =>
      r.render(
        <StaticShell settings={{ "ai.level": "automate", "workflows.page.refresh_seconds": 0 }}>
          <Workflows api={api} now={NOW} live={{ runs: live, loaded: true }} />
        </StaticShell>,
      ),
    );
    await tick();
  }

  test("a running Run shows the Step it is on, animated, with the Steps done before it checked", async () => {
    const run = {
      ...runningRun(),
      workflowId: "w1",
      steps: [step(0, "extract", "Extract", "done", "name: Aoife")],
    };
    await mountPage(liveApi([run]), [run]);
    const nodes = qa(".wflow-node");
    const state = (key: string) =>
      nodes.find((n) => n.getAttribute("data-key") === key)?.getAttribute("data-run");
    expect(state("extract")).toBe("done");
    expect(state("notion")).toBe("running");
    expect(state("slack")).toBeNull();
    expect(q(".wfx-showing")?.textContent).toContain(
      "Running now on Hetzner invoice: step 2 of 4, Notion",
    );
    expect(q(".wfx-row[aria-current=true] .wfx-row-live")?.textContent).toBe("Step 2 of 4: Notion");
  });

  test("a paused Run marks its Step as waiting for your approval and shows the card", async () => {
    const run = pausedRun();
    await mountPage(liveApi([run]), [run]);
    const slack = qa(".wflow-node").find((n) => n.getAttribute("data-key") === "slack");
    expect(slack?.getAttribute("data-run")).toBe("waiting");
    expect(slack?.querySelector(".wflow-run")?.textContent).toBe("Waiting for your approval");
    expect(q(".wfx-showing")?.getAttribute("data-live")).toBe("paused");
    expect(q(".run-approval")).not.toBeNull();
    // Put away, the flow reads as written.
    const hide = qa<HTMLButtonElement>(".wfx-showing button")[0];
    await click(hide);
    expect(q(".wfx-showing")).toBeNull();
    expect(qa(".wflow-node[data-run]")).toHaveLength(0);
  });
});
