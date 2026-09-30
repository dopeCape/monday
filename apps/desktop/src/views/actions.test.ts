// A View's action buttons (docs/spec/views.md, "Actions on items") over a
// fake host: reversible ones apply with one Undo for a batch; a forward and
// a reply open compose and send nothing; a link asks first with its domain;
// a Workflow gets its inputs from the row's Fields; a Custom action the
// Device cannot run says so; ask_agent writes one sentence; a `when` that is
// false or unknown hides the button.

import { describe, expect, test } from "bun:test";
import type { ExtractedValue, ViewAction, ViewDoc, ViewThread } from "@monday/shared";
import {
  AMAZON_ORDERS_VIEW,
  DEFAULT_SIGNAL_RULES,
  viewBase,
  viewExtractionId,
  viewSignalId,
} from "@monday/shared";
import { presetMoment, runViewAction, type ViewActionHost } from "./actions.ts";

const NOW = new Date(2026, 9, 15, 12, 0, 0); // Thursday 15 October 2026, local time
const ctx = { rules: DEFAULT_SIGNAL_RULES, now: NOW, zone: "", owner: "sam@monday.test" };
const doc = AMAZON_ORDERS_VIEW;

function thread(
  id: string,
  status: string,
  values: Record<string, [string, ExtractedValue["value"]]>,
) {
  const readings: ViewThread["readings"] = {
    [viewSignalId(doc.id, "status")]: { choice: status, confidence: 0.9 },
  };
  const picked: Record<string, ExtractedValue> = {};
  for (const [x, [text, value]] of Object.entries(values)) {
    const key = viewExtractionId(doc.id, x);
    (readings as Record<string, unknown>)[key] = { choice: "picked", confidence: 0.9 };
    picked[key] = { text, value, confidence: 0.9 };
  }
  return {
    id,
    messageCount: 2,
    lastActivity: "2026-10-10T10:00:00.000Z",
    receivedAt: "2026-10-10T10:00:00.000Z",
    unread: true,
    starred: false,
    archived: false,
    deleted: false,
    snoozed: false,
    group: null,
    subgroup: null,
    section: null,
    hasAttachments: false,
    from: "orders@amazon.com",
    recipients: [],
    facts: {},
    readings,
    values: picked,
    subject: `Order ${id}`,
  } satisfies ViewThread;
}

const threads = [
  thread("a", "shipped", {
    tracking_link: [
      "https://track.amazon.com/a",
      { url: "https://track.amazon.com/a", domain: "track.amazon.com" },
    ],
    order_number: ["113-1", "113-1"],
    order_total: ["$41.97", { value: 41.97, currency: "USD" }],
  }),
  thread("b", "shipped", { order_number: ["113-2", "113-2"] }),
  thread("c", "delivered", {}),
];

function fakeHost(answer = true) {
  const calls: Array<[string, ...unknown[]]> = [];
  const host: ViewActionHost = {
    archive: async (ids) => {
      calls.push(["archive", [...ids]]);
      return "undo-archive";
    },
    markRead: async (ids, read) => {
      calls.push(["markRead", [...ids], read]);
      return "undo-read";
    },
    snooze: async (ids, until) => {
      calls.push(["snooze", [...ids], until.toISOString()]);
      return "undo-snooze";
    },
    move: async (ids, g) => {
      calls.push(["move", [...ids], g]);
      return "undo-move";
    },
    tag: async () => "unavailable",
    compose: (kind, id, seed) => calls.push(["compose", kind, id, seed]),
    runWorkflow: async (w, id, inputs) => {
      calls.push(["workflow", w, id, inputs]);
    },
    customAction: async () => false,
    confirm: async (text) => {
      calls.push(["confirm", text]);
      return answer;
    },
    openLink: (url) => {
      calls.push(["open", url]);
    },
    setLane: async (id, lane) => {
      calls.push(["lane", id, lane]);
    },
    markDone: async (id, n) => {
      calls.push(["done", id, n]);
    },
    ask: (text) => calls.push(["ask", text]),
  };
  return { host, calls };
}

const OPTIONS = {
  morningHour: 8,
  eventMinutes: 30,
  opensWords: "Open {domain}?",
  askWords: "{prompt} (threads: {threads})",
};

const action = (a: Omit<ViewAction, "on"> & { on?: ViewAction["on"] }): ViewAction => ({
  on: "row",
  ...a,
});

function setup(actions: ViewAction[]) {
  const d: ViewDoc = { ...doc, actions, blocks: doc.blocks };
  const base = viewBase(d, threads, ctx);
  const row = (id: string) => {
    const r = base.rows.find((x) => x.thread.id === id);
    if (!r) throw new Error(id);
    return r;
  };
  return { base, row };
}

describe("runViewAction", () => {
  test("archive over a Lane is one batch with one Undo", async () => {
    const a = action({
      id: "arch",
      label: "Archive",
      icon: "archive",
      on: "group",
      do: { kind: "archive" },
    });
    const { base, row } = setup([a]);
    const { host, calls } = fakeHost();
    const r = await runViewAction(base, a, [row("a"), row("b")], host, OPTIONS, "group");
    expect(r).toEqual({ ok: true, undo: ["undo-archive"], ran: 2 });
    expect(calls).toEqual([["archive", ["a", "b"]]]);
  });

  test("a snooze preset wakes at the morning hour", async () => {
    const a = action({
      id: "s",
      label: "Later",
      icon: "clock",
      do: { kind: "snooze", until: "next_week" },
    });
    const { base, row } = setup([a]);
    const { host, calls } = fakeHost();
    await runViewAction(base, a, [row("a")], host, OPTIONS);
    expect(calls[0]?.[2]).toBe(presetMoment("next_week", NOW, 8).toISOString());
    expect(presetMoment("next_week", NOW, 8).getDay()).toBe(1);
  });

  test("a forward to a Field opens compose and sends nothing; no address, no forward", async () => {
    const d: ViewDoc = {
      ...doc,
      extractions: [...doc.extractions, { id: "who", find: "email", question: "Who to tell." }],
    };
    const a = action({
      id: "f",
      label: "Forward",
      icon: "share",
      do: { kind: "forward", to: "x:who" },
    });
    const t = { ...thread("z", "shipped", {}), values: {} as Record<string, ExtractedValue> };
    const key = viewExtractionId(d.id, "who");
    (t.readings as Record<string, unknown>)[key] = { choice: "picked", confidence: 0.9 };
    t.values[key] = { text: "ops@acme.com", value: "ops@acme.com", confidence: 0.9 };
    const base = viewBase({ ...d, actions: [a] }, [t, threads[1] as ViewThread], ctx);
    const { host, calls } = fakeHost();
    const r = await runViewAction(base, a, [base.rows[0] as never], host, OPTIONS);
    expect(r.ok).toBe(true);
    expect(calls).toEqual([
      ["compose", "forward", "z", { to: [{ name: "", email: "ops@acme.com" }] }],
    ]);
    const none = await runViewAction(base, a, [base.rows[1] as never], host, OPTIONS);
    expect(none).toEqual({ ok: false, reason: "no_value" });
  });

  test("a link asks first with its domain, then opens; No leaves it closed", async () => {
    const [track] = doc.actions;
    if (!track) throw new Error("track");
    const { base, row } = setup([track]);
    const yes = fakeHost(true);
    expect((await runViewAction(base, track, [row("a")], yes.host, OPTIONS)).ok).toBe(true);
    expect(yes.calls).toEqual([
      ["confirm", "Open track.amazon.com?"],
      ["open", "https://track.amazon.com/a"],
    ]);
    const no = fakeHost(false);
    expect(await runViewAction(base, track, [row("a")], no.host, OPTIONS)).toEqual({
      ok: false,
      reason: "cancelled",
    });
    expect(no.calls.some((c) => c[0] === "open")).toBe(false);
  });

  test("a Workflow runs on the Thread with the row's Fields as its inputs", async () => {
    const a = action({
      id: "refund",
      label: "Refund",
      icon: "arrow-u-up-left",
      do: {
        kind: "run_workflow",
        workflow: "wf_refund",
        inputs: { order: "x:order_number", amount: "x:order_total" },
      },
    });
    const { base, row } = setup([a]);
    const { host, calls } = fakeHost();
    await runViewAction(base, a, [row("a")], host, OPTIONS);
    expect(calls).toEqual([["workflow", "wf_refund", "a", { order: "113-1", amount: "$41.97" }]]);
  });

  test("a Custom action the Device cannot run says so; ask_agent is one sentence", async () => {
    const c = action({
      id: "c",
      label: "File",
      icon: "folder",
      do: { kind: "custom_action", action: "file" },
    });
    const ask = action({
      id: "q",
      label: "Ask",
      icon: "sparkle",
      on: "group",
      do: { kind: "ask_agent", prompt: "Summarize these orders" },
    });
    const { base, row } = setup([c, ask]);
    const { host, calls } = fakeHost();
    expect(await runViewAction(base, c, [row("a")], host, OPTIONS)).toEqual({
      ok: false,
      reason: "unavailable",
    });
    await runViewAction(base, ask, [row("a"), row("b")], host, OPTIONS, "group");
    expect(calls).toEqual([["ask", "Summarize these orders (threads: Order a; Order b)"]]);
  });

  test("a when that is false or unknown hides the button", async () => {
    const [track] = doc.actions;
    if (!track) throw new Error("track");
    const { base, row } = setup([track]);
    const { host } = fakeHost();
    // b is shipped but has no tracking link (unknown: not read), c is delivered (false).
    expect(await runViewAction(base, track, [row("b"), row("c")], host, OPTIONS)).toEqual({
      ok: false,
      reason: "nothing",
    });
  });
});
