/// <reference types="bun-types" />
// The View card in the Agent (slice 40) through the DOM with happy-dom: the
// tried Threads with their Lane and reasons, the counts, the quiet-scope
// line; Pin view waits until the tried Threads are shown; Move to and Wrong
// are corrections sent to the draft; Revise sends the Agent a turn; Pin
// view saves; an edit shows its moves and Apply, with Undo; without a
// TypeSafe key only the Fact Lanes can be kept. The Server is a scripted api.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { ViewDraft, ViewTest } from "@monday/shared";
import { AMAZON_ORDERS_VIEW, SUPPORT_TODAY_VIEW } from "@monday/shared";
import { dom } from "@monday/ui/test-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { ComposerEnvContext } from "../agent/aui/context.tsx";
import { type Api, createApi } from "../platform/api.ts";
import { StaticShell } from "../shell/Shell.tsx";
import { canPin, ViewCard } from "./ViewCard.tsx";

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

const tried = (i: number, lane: string, reasons: string[]) => ({
  threadId: `t${i}`,
  from: `c${i}@customer.test`,
  subject: `Export broken ${i}`,
  lastActivity: "2026-09-29T09:00:00.000Z",
  lane,
  notRead: false,
  certainty: 0.8,
  reasons,
  nouls: [{ signal: "is_support_request", label: "support request", noul: 0.9 }],
  values: [],
  actions: [],
});

const TEST: ViewTest = {
  tried: 12,
  shown: [
    tried(1, "red", ["support request 95%", "blocked 2.0 of 2"]),
    ...Array.from({ length: 9 }, (_, i) => tried(i + 2, "green", ["support request 90%"])),
  ],
  counts: { red: 1, yellow: 0, green: 11, unsure: 0, others: 0 },
  widened: { when: "today", count: 4 },
  empty: false,
  inScope: 4,
  agreement: null,
  changes: [],
  needsJudge: false,
  moves: null,
  blocks: [],
};

const DRAFT: ViewDraft = {
  id: "bd_1",
  workspaceId: "ws",
  viewId: null,
  status: "open",
  doc: SUPPORT_TODAY_VIEW,
  previous: null,
  test: TEST,
  threadIds: [],
  createdAt: "2026-09-29T10:00:00.000Z",
  updatedAt: "2026-09-29T10:00:00.000Z",
};

function scripted(initial: ViewDraft) {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  let draft = initial;
  const base = createApi(() => ({ baseUrl: "http://127.0.0.1:4242", token: "t" }));
  const api: Api = {
    ...base,
    views: {
      ...base.views,
      draft: async () => draft,
      correct: async (id, c) => {
        calls.push({ name: "correct", args: [id, c] });
        const key = c.lane ? "_lanes" : (c.signal ?? "");
        draft = {
          ...draft,
          doc: {
            ...draft.doc,
            examples: {
              ...draft.doc.examples,
              [key]: [
                { threadId: c.threadId, ...(c.lane ? { lane: c.lane } : { holds: c.holds }) },
              ],
            },
          },
        };
        return draft;
      },
      pinDraft: async (id, options) => {
        calls.push({ name: "pin", args: [id, options] });
        draft = { ...draft, status: "pinned" };
        return { view: {} as never, draft };
      },
      applyDraft: async (id) => {
        calls.push({ name: "apply", args: [id] });
        draft = { ...draft, status: "applied" };
        return { view: { id: "b1", version: 2 } as never, draft, previous: 1 };
      },
      revert: async (id, version) => {
        calls.push({ name: "revert", args: [id, version] });
        return {} as never;
      },
      discardDraft: async (id) => {
        calls.push({ name: "discard", args: [id] });
        draft = { ...draft, status: "discarded" };
        return draft;
      },
    },
  };
  return { api, calls };
}

async function mount(draft: ViewDraft, sent: string[] = []) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const r = root;
  const { api, calls } = scripted(draft);
  const env = {
    strings: {} as never,
    now: new Date(),
    runStartedAt: null,
    actions: {
      approve() {},
      decline() {},
      undo() {},
      retry() {},
      openThread() {},
      openLink() {},
      recall() {},
      send: (text: string) => sent.push(text),
      newSession() {},
      attach() {},
    },
  };
  await act(async () =>
    r.render(
      <StaticShell
        shell={{
          api,
          server: { kind: "sidecar", target: { baseUrl: "http://127.0.0.1:4242", token: "t" } },
        }}
      >
        <ComposerEnvContext.Provider value={env}>
          <ViewCard
            preview={{
              kind: "view",
              action: "create",
              draftId: draft.id,
              viewId: draft.viewId,
              name: draft.doc.name,
              draft,
            }}
          />
        </ComposerEnvContext.Provider>
      </StaticShell>,
    ),
  );
  return { calls, el: host };
}

const click = async (el: Element | null | undefined) => {
  if (!el) throw new Error("nothing to click");
  await act(async () => (el as HTMLElement).click());
};
const button = (el: ParentNode, label: string) =>
  [...el.querySelectorAll("button")].find((b) => b.textContent === label);

describe("the View card", () => {
  test("the tried Threads, their Lanes and reasons, the counts and the quiet-scope line", async () => {
    const { el } = await mount(DRAFT);
    const rows = el.querySelectorAll(".bc-row");
    expect(rows).toHaveLength(10);
    expect(rows[0]?.querySelector(".why")?.textContent).toBe(
      "Red: support request 95%, blocked 2.0 of 2",
    );
    expect(el.textContent).toContain("Tried on 12 threads");
    expect(el.textContent).toContain("Tried on earlier days: today has 4 threads so far");
    expect(el.querySelector('.bc-lane[data-lane="green"] b')?.textContent).toBe("11");
    expect(button(el, "Pin view")?.hasAttribute("disabled")).toBe(false);
    // Fewer shown than tried and than the Setting: Pin waits.
    expect(canPin({ ...DRAFT, test: { ...TEST, shown: TEST.shown.slice(0, 3) } }, 10)).toBe(false);
    expect(canPin({ ...DRAFT, test: { ...TEST, shown: [], tried: 0, empty: true } }, 10)).toBe(
      true,
    );
  });

  test("Wrong and Move to are corrections; Revise asks the Agent; Pin view saves", async () => {
    const sent: string[] = [];
    const { el, calls } = await mount(DRAFT, sent);
    const first = el.querySelector(".bc-row");
    await click(first && button(first, "Wrong"));
    expect(calls[0]).toEqual({
      name: "correct",
      args: ["bd_1", { threadId: "t1", signal: "is_support_request", holds: false }],
    });
    await click(first && button(first, "Move to"));
    await click(
      [...el.querySelectorAll(".pop-item")].find((b) => b.textContent === "Unsure") ?? null,
    );
    expect(calls[1]).toEqual({
      name: "correct",
      args: ["bd_1", { threadId: "t1", lane: "unsure" }],
    });
    await click(button(el, "Revise with my corrections"));
    expect(sent).toEqual(["Revise the view draft bd_1 with my corrections"]);
    await click(button(el, "Pin view"));
    expect(calls.at(-1)).toEqual({ name: "pin", args: ["bd_1", undefined] });
    expect(el.textContent).toContain("Pinned in the nav.");
  });

  test("what it shows, the values on a tried row, Wrong value, and the buttons it would carry", async () => {
    const row = {
      ...tried(1, "red", ["support request 95%"]),
      values: [
        {
          extraction: "order_total",
          label: "Total",
          state: "value" as const,
          text: "$120.00",
          confidence: 0.9,
          candidates: ["$110.00", "$10.00", "$120.00"],
        },
        {
          extraction: "order_number",
          label: "Order",
          state: "unsure" as const,
          text: "113-2",
          confidence: 0.4,
          candidates: ["113-2"],
        },
      ],
      actions: ["Track package"],
    };
    const withBlocks: ViewDraft = {
      ...DRAFT,
      test: {
        ...TEST,
        shown: [row, ...TEST.shown.slice(1)],
        blocks: [
          {
            id: "spend",
            type: "stat",
            title: "Spent this month",
            value: "$120.00",
            change: "up 186%",
            items: [],
            unsure: 0,
          },
          {
            id: "by_month",
            type: "chart",
            title: "Spend per month",
            value: null,
            change: null,
            items: [
              { label: "Sep", count: 41.97, value: "$41.97" },
              { label: "Oct", count: 120, value: "$120.00" },
            ],
            unsure: 1,
          },
        ],
      },
    };
    const { el, calls } = await mount(withBlocks);
    expect(el.textContent).toContain("What it shows");
    expect(el.querySelector('.bc-block[data-block="spend"] .bstat')?.textContent).toBe(
      "$120.00up 186%",
    );
    expect(el.querySelectorAll('.bc-block[data-block="by_month"] svg rect')).toHaveLength(2);
    expect(el.querySelector('.bc-block[data-block="by_month"] .bunsure')?.textContent).toBe(
      "1 unsure",
    );
    const first = el.querySelector(".bc-row");
    expect(first?.querySelector(".vals")?.textContent).toBe("Total: $120.00Order: Unsure");
    const track = first && button(first, "Track package");
    expect(track?.hasAttribute("disabled")).toBe(true);
    const wrong = first?.querySelector('[data-extraction="order_total"]');
    await click(wrong);
    await click(
      [...el.querySelectorAll(".pop-item")].find((b) => b.textContent === "$110.00") ?? null,
    );
    expect(calls.at(-1)).toEqual({
      name: "correct",
      args: ["bd_1", { threadId: "t1", extraction: "order_total", value: "$110.00" }],
    });
    await click(first?.querySelector('[data-extraction="order_number"]'));
    await click(
      [...el.querySelectorAll(".pop-item")].find((b) => b.textContent === "Not stated") ?? null,
    );
    expect(calls.at(-1)).toEqual({
      name: "correct",
      args: ["bd_1", { threadId: "t1", extraction: "order_number", value: null }],
    });
  });

  test("an edit shows its moves and Apply, then Undo; no key keeps only the Fact Lanes", async () => {
    const edit: ViewDraft = {
      ...DRAFT,
      viewId: "b1",
      test: { ...TEST, moves: [{ from: "yellow", to: "green", threadIds: ["a", "b"] }] },
    };
    const { el, calls } = await mount(edit);
    expect(el.textContent).toContain("2 threads move: 2 Yellow to Green");
    await click(button(el, "Apply"));
    expect(el.textContent).toContain("Saved as version 2.");
    await click(button(el, "Undo"));
    expect(calls.at(-1)).toEqual({ name: "revert", args: ["b1", 1] });
    await act(async () => root?.unmount());
    root = null;
    const noKey = await mount({ ...DRAFT, test: { ...TEST, needsJudge: true } });
    expect(noKey.el.textContent).toContain("Views that read your mail need a TypeSafe key.");
    await click(button(noKey.el, "Keep only the lanes that need no reading"));
    expect(noKey.calls.at(-1)).toEqual({ name: "pin", args: ["bd_1", { factsOnly: true }] });
  });

  test("coverage under the Blocks: the pool line, senders, a warning below the floor, reasons that filter the rows", async () => {
    const order = (i: number) => ({
      ...tried(i, "ordered", ["status ordered 90%"]),
      subject: `Your order ${i}`,
      from: "auto-confirm@amazon.com",
    });
    const orders: ViewDraft = {
      ...DRAFT,
      doc: AMAZON_ORDERS_VIEW,
      test: {
        ...TEST,
        tried: 10,
        // Three shown; the two with no amount are among the rest.
        shown: [order(1), order(2), order(3)],
        rest: [order(4), order(5), order(6), order(7), order(8), order(9), order(10)],
        counts: { delivered: 0, shipped: 0, ordered: 10, unsure: 0, others: 0 },
        widened: null,
        inScope: 143,
        pool: { kept: 0, fresh: 10, skipped: 4, scanned: 120, prefer: ["money"] },
        coverage: {
          senders: [{ from: "auto-confirm@amazon.com", count: 10 }],
          fields: [
            {
              field: "x:order_total",
              label: "Total",
              resolved: 4,
              none: 1,
              unsure: 1,
              noCandidates: 4,
              notRead: 0,
              capped: 0,
              examples: ["$41.97"],
              threads: {
                resolved: ["t1", "t2", "t3", "t4"],
                none: ["t5"],
                unsure: ["t6"],
                noCandidates: ["t7", "t8", "t9", "t10"],
              },
            },
            {
              field: "signal:status",
              label: "status",
              resolved: 10,
              none: 0,
              unsure: 0,
              noCandidates: 0,
              notRead: 0,
              capped: 0,
              examples: ["ordered"],
              threads: { resolved: ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10"] },
            },
          ],
        },
      },
    };
    const { el } = await mount(orders);
    expect(el.querySelector(".bc-pool")?.textContent).toBe(
      "Tried on 10 of 143 matching threads, newest first, preferring ones with amounts, passed over 4 without them",
    );
    expect(el.querySelector(".bc-senders")?.textContent).toBe(
      "Mostly from auto-confirm@amazon.com (10)",
    );
    const total = el.querySelector('.bc-cov[data-field="x:order_total"]');
    expect(total?.querySelector(".lab")?.textContent).toBe("Total: 4 of 10 read");
    // The total is charted and read on 40% of the tried: marked, with the reasons beside it.
    expect(total?.getAttribute("data-warn")).toBe("true");
    expect(total?.querySelector(".ic")?.getAttribute("aria-label")).toBe(
      "Total read on fewer than 50% of the tried threads",
    );
    expect([...(total?.querySelectorAll(".bc-reason") ?? [])].map((r) => r.textContent)).toEqual([
      "1 none of these",
      "1 unsure",
      "4 had no amounts",
    ]);
    const status = el.querySelector('.bc-cov[data-field="signal:status"]');
    expect(status?.querySelector(".lab")?.textContent).toBe("status: 10 of 10 clear");
    expect(status?.hasAttribute("data-warn")).toBe(false);
    expect(el.querySelectorAll(".bc-row")).toHaveLength(3);
    // A reason filters the rows to the tried Threads it names, the ones not shown included.
    await click(total?.querySelector('[data-reason="noCandidates"]'));
    expect([...el.querySelectorAll(".bc-row")].map((r) => r.getAttribute("data-thread"))).toEqual([
      "t7",
      "t8",
      "t9",
      "t10",
    ]);
    expect(el.querySelector(".bc-filter")?.textContent).toContain(
      "Showing 4 threads: Total, 4 had no amounts",
    );
    await click(button(el, "Show all"));
    expect(el.querySelectorAll(".bc-row")).toHaveLength(3);
  });

  test("a draft tried before coverage was kept renders as before", async () => {
    const { el } = await mount({ ...DRAFT, doc: AMAZON_ORDERS_VIEW });
    expect(el.querySelector(".bc-coverage")).toBeNull();
    expect(el.querySelectorAll(".bc-row")).toHaveLength(10);
    // Coverage without the Threads behind it: the reasons are words, not filters.
    await act(async () => root?.unmount());
    root = null;
    const { el: el2 } = await mount({
      ...DRAFT,
      doc: AMAZON_ORDERS_VIEW,
      test: {
        ...TEST,
        coverage: {
          senders: [],
          fields: [
            {
              field: "x:order_total",
              label: "Total",
              resolved: 9,
              none: 0,
              unsure: 0,
              noCandidates: 3,
              notRead: 0,
              capped: 0,
              examples: [],
            },
          ],
        },
      },
    });
    const reason = el2.querySelector('.bc-cov [data-reason="noCandidates"]');
    expect(reason?.tagName).toBe("SPAN");
    expect(el2.querySelector(".bc-pool")?.textContent).toBe(
      "Tried on 12 of 4 matching threads, newest first",
    );
  });
});
