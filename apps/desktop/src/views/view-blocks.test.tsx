/// <reference types="bun-types" />
// A View's Blocks on the Device (slice 47; docs/spec/views.md, "The Block
// catalog") through the DOM with happy-dom: the Amazon orders View draws its
// stat, its bar chart and its lanes from cached rows with picked values; a
// table writes an undecided value as Unsure; a checklist item is checked; a
// row's button runs its action, and a press goes through the View's run:
// archive with Undo, a link asked first with its domain, a forward that
// opens compose and sends nothing.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type {
  ExtractedValue,
  SignalReading,
  Thread,
  View,
  ViewAction,
  ViewDoc,
  ViewThread,
} from "@monday/shared";
import {
  AMAZON_ORDERS_VIEW,
  DEFAULT_SIGNAL_RULES,
  defaultSettings,
  INVOICES_OWED_VIEW,
  viewBase,
  viewExtractionId,
  viewSignalId,
  WHO_EMAILS_VIEW,
} from "@monday/shared";
import { dom } from "@monday/ui/test-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { CachedViewThread } from "../store/views.ts";
import type { InboxViewHost } from "./actions.ts";
import { ViewBlocks, viewBlockData } from "./ViewBlocks.tsx";
import { runFromView } from "./ViewScreen.tsx";

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

const NOW = new Date("2026-10-15T12:00:00Z");
const ctx = {
  rules: DEFAULT_SIGNAL_RULES,
  now: NOW,
  zone: "UTC",
  owner: "sam@monday.test",
  extractFloor: 0.6,
};
const S = defaultSettings();

type Picks = Record<string, [string, ExtractedValue["value"], number?]>;

function cached(
  doc: ViewDoc,
  id: string,
  at: string,
  subject: string,
  signals: Record<string, SignalReading>,
  picks: Picks,
): CachedViewThread {
  const readings: Record<string, SignalReading> = { ...signals };
  const values: Record<string, ExtractedValue> = {};
  for (const [x, [text, value, confidence = 0.9]] of Object.entries(picks)) {
    const key = viewExtractionId(doc.id, x);
    readings[key] = { choice: "picked", confidence };
    values[key] = { text, value, confidence };
  }
  const thread: Thread = {
    id,
    workspaceId: "ws",
    subject,
    participants: [{ name: "Amazon.com", email: "orders@amazon.com" }],
    lastActivity: at,
    messageCount: 1,
    unread: false,
    starred: false,
    archived: false,
    snoozedUntil: null,
    section: null,
    group: null,
    subgroup: null,
    tags: [],
    labels: [],
    hasAttachments: false,
    snippet: subject,
  };
  const t: ViewThread = {
    id,
    messageCount: 1,
    lastActivity: at,
    receivedAt: at,
    unread: false,
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
    facts: { received_at: at },
    readings,
    values,
    subject,
  };
  return { ...t, thread };
}

const status = (doc: ViewDoc, choice: string) => ({
  [viewSignalId(doc.id, "status")]: { choice, confidence: 0.9 },
});

function amazon(): CachedViewThread[] {
  const d = AMAZON_ORDERS_VIEW;
  const link = "https://track.amazon.com/x2";
  return [
    cached(
      d,
      "o2-shipped",
      "2026-10-03T09:00:00.000Z",
      "Shipped: your lamp",
      status(d, "shipped"),
      {
        order_number: ["113-2", "113-2"],
        tracking_link: [link, { url: link, domain: "track.amazon.com" }],
      },
    ),
    cached(
      d,
      "o2-confirm",
      "2026-10-02T09:00:00.000Z",
      "Your order of a lamp",
      status(d, "ordered"),
      {
        order_number: ["113-2", "113-2"],
        order_total: ["$120.00", { value: 120, currency: "USD" }],
      },
    ),
    cached(
      d,
      "o1-delivered",
      "2026-09-23T09:00:00.000Z",
      "Delivered: books",
      status(d, "delivered"),
      {
        order_number: ["113-1", "113-1"],
      },
    ),
    cached(
      d,
      "o1-confirm",
      "2026-09-20T09:00:00.000Z",
      "Your order of books",
      status(d, "ordered"),
      {
        order_number: ["113-1", "113-1"],
        order_total: ["$41.97", { value: 41.97, currency: "USD" }],
      },
    ),
  ];
}

const view = (doc: ViewDoc, done: View["done"] = {}): View => ({
  id: doc.id,
  workspaceId: "ws",
  version: 1,
  pinned: true,
  position: 0,
  deletedAt: null,
  createdAt: "",
  updatedAt: "",
  doc,
  placements: {},
  checkBar: false,
  done,
});

interface Mounted {
  el: HTMLElement;
  actions: Array<{ id: string; rows: string[]; where: string }>;
  done: Array<[string, boolean, number]>;
  opened: string[];
}

async function mount(
  v: View,
  threads: CachedViewThread[],
  onMove?: (threadId: string, lane: string | null) => void,
): Promise<Mounted> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const r = root;
  const base = viewBase(v.doc, threads, ctx);
  const data = viewBlockData(v, base, S);
  const out: Mounted = { el: host, actions: [], done: [], opened: [] };
  await act(async () =>
    r.render(
      <ViewBlocks
        view={v}
        base={base}
        data={data}
        settings={S}
        now={NOW}
        row={(t) => <div className="row">{t.subject}</div>}
        focus={null}
        open={(id) => out.opened.push(id)}
        onAction={(a, rows, where) =>
          out.actions.push({ id: a.id, rows: rows.map((x) => x.thread.id), where })
        }
        onDone={(id, isDone, n) => out.done.push([id, isDone, n])}
        onMove={onMove}
      />,
    ),
  );
  return out;
}

const click = async (el: Element | null | undefined) => {
  if (!el) throw new Error("nothing to click");
  await act(async () => (el as HTMLElement).click());
};

describe("the Blocks on the Device", () => {
  test("Move to opens over the page, outside the sideways-scrolling lanes, and a pick moves the row", async () => {
    const moved: Array<[string, string | null]> = [];
    const { el } = await mount(view(AMAZON_ORDERS_VIEW), amazon(), (id, lane) =>
      moved.push([id, lane]),
    );
    const row = el.querySelector<HTMLElement>('[data-block="orders"] .view-row');
    await click(row?.querySelector(".view-move"));
    const pop = document.querySelector(".view-float .view-move-pop");
    expect(pop).not.toBeNull();
    // Not inside the lanes, whose sideways scroll clips what hangs below them.
    expect(el.querySelector(".view-lanes .view-move-pop")).toBeNull();
    await click(pop?.querySelector(".pop-item"));
    expect(moved).toHaveLength(1);
    expect(moved[0]?.[0]).toBe(row?.getAttribute("data-thread") ?? "");
    expect(document.querySelector(".view-float")).toBeNull();
  });

  test("Amazon orders: this month's spend, a bar a month, one card per order in its Lane", async () => {
    const { el, actions } = await mount(view(AMAZON_ORDERS_VIEW), amazon());
    expect(el.querySelector('[data-block="spend"] .view-stat .num')?.textContent).toBe("$120.00");
    expect(el.querySelector('[data-block="spend"] .chg')?.getAttribute("data-dir")).toBe("up");
    expect(el.querySelectorAll('[data-block="by_month"] svg rect')).toHaveLength(2);
    expect(el.querySelector('[data-block="by_month"]')?.textContent).toContain("$41.97");
    const lane = (id: string) =>
      [...el.querySelectorAll(`[data-block="orders"] .view-lane[data-lane="${id}"] .view-row`)].map(
        (r) => r.getAttribute("data-thread"),
      );
    expect(lane("shipped")).toEqual(["o2-shipped"]);
    expect(lane("delivered")).toEqual(["o1-delivered"]);
    // The shipped order carries Track package; the delivered one does not.
    expect(el.querySelector('[data-thread="o1-delivered"] .view-act')).toBeNull();
    await click(el.querySelector('[data-thread="o2-shipped"] .view-act[data-action="track"]'));
    expect(actions).toEqual([{ id: "track", rows: ["o2-shipped"], where: "row" }]);
  });

  test("a table writes an undecided value as Unsure and sorts by the due date", async () => {
    const d = INVOICES_OWED_VIEW;
    const owed = { money_direction: { choice: "owner_pays", confidence: 0.9 } };
    const inv = (id: string, amount: [string, number, number], due: string) =>
      cached(d, id, "2026-10-01T09:00:00.000Z", `Invoice ${id}`, owed, {
        amount_due: [amount[0], { value: amount[1], currency: "USD" }, amount[2]],
        due_date: [due, due],
        vendor: ["Northwind", "Northwind"],
      });
    const { el } = await mount(view(d), [
      inv("a", ["$1,315.50", 1315.5, 0.92], "2026-10-20"),
      inv("b", ["$80.00", 80, 0.4], "2026-10-18"),
    ]);
    const rows = [...el.querySelectorAll(".view-tr:not(.head)")];
    expect(rows.map((r) => r.getAttribute("data-thread"))).toEqual(["b", "a"]);
    const cells = rows.map((r) => [...r.querySelectorAll(".cell")].map((c) => c.textContent));
    expect(cells[0]).toEqual(["Northwind", "Unsure", "Oct 18"]);
    expect(cells[1]).toEqual(["Northwind", "$1,315.50", "Oct 20"]);
    expect(rows[0]?.querySelector(".unsure")).not.toBeNull();
  });

  test("a checklist item is checked for its Thread version; the done ones fold away", async () => {
    const d: ViewDoc = {
      ...WHO_EMAILS_VIEW,
      extractions: [{ id: "promise", find: "sentence", question: "What the owner promised." }],
      blocks: [{ id: "todo", type: "checklist", item: "x:promise" }],
    };
    const t1 = cached(
      d,
      "t1",
      "2026-10-12T09:00:00.000Z",
      "Report",
      {},
      {
        promise: ["I will send the report by Friday.", "I will send the report by Friday."],
      },
    );
    const t2 = cached(
      d,
      "t2",
      "2026-10-11T09:00:00.000Z",
      "Call",
      {},
      {
        promise: ["I will call back.", "I will call back."],
      },
    );
    const { el, done } = await mount(view(d, { t2: { messageCount: 1, at: "x" } }), [t1, t2]);
    const box = el.querySelector<HTMLInputElement>('.view-check[data-thread="t1"] input');
    await click(box);
    expect(done).toEqual([["t1", true, 1]]);
    expect(el.querySelector('.view-check[data-thread="t2"]')).toBeNull();
    expect(el.querySelector(".view-done-toggle")?.textContent).toBe("1 done");
  });

  test("a press goes through the View's run: Undo for archive, a link asked first, a forward sends nothing", async () => {
    const doc = AMAZON_ORDERS_VIEW;
    const base = viewBase(doc, amazon(), ctx);
    const shipped = base.rows.find((r) => r.thread.id === "o2-shipped");
    if (!shipped) throw new Error("row");
    const calls: Array<[string, ...unknown[]]> = [];
    const inbox: InboxViewHost = {
      archive: async (ids) => {
        calls.push(["archive", [...ids]]);
        return "undo-1";
      },
      markRead: async () => null,
      snooze: async () => null,
      move: async () => null,
      tag: async () => null,
      compose: (kind, id, seed) => calls.push(["compose", kind, id, seed]),
      runWorkflow: async () => {},
      customAction: async () => true,
      openLink: (url) => {
        calls.push(["open", url]);
      },
      toast: (text, undo) => calls.push(["toast", text, undo]),
    };
    const views = {
      place: async () => ({}) as never,
      done: async () => ({}) as never,
    };
    const run = (action: ViewAction, confirm = true) =>
      runFromView({
        base,
        viewId: doc.id,
        action,
        rows: [shipped],
        where: "row",
        host: inbox,
        settings: S,
        views,
        onAsk: (text) => calls.push(["ask", text]),
        confirm: async (text) => {
          calls.push(["confirm", text]);
          return confirm;
        },
      });
    await run({ id: "a", label: "Archive", icon: "archive", on: "row", do: { kind: "archive" } });
    expect(calls.splice(0)).toEqual([
      ["archive", ["o2-shipped"]],
      ["toast", "Archive: done", "undo-1"],
    ]);
    const [track] = doc.actions;
    if (!track) throw new Error("track");
    await run(track, false);
    expect(calls.splice(0)).toEqual([["confirm", "Open track.amazon.com?"]]);
    await run({
      id: "f",
      label: "Forward",
      icon: "share",
      on: "row",
      do: { kind: "forward", to: "accounts@acme.com" },
    });
    expect(calls.splice(0)).toEqual([
      ["compose", "forward", "o2-shipped", { to: [{ name: "", email: "accounts@acme.com" }] }],
      ["toast", "Forward: done", null],
    ]);
  });
});
