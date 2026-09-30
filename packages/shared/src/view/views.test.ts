// Views in code (docs/spec/views.md, ADR 0016): a Board document reads as a
// View with one Block; validation of Fields, Blocks, Extractions and
// actions; an Extraction's value three-valued by its floor; queries with
// dedupe, groups, time buckets, money per currency and the previous period;
// every example View from the spec over fixture Threads.

import { describe, expect, test } from "bun:test";
import type { SignalReading } from "../signals.ts";
import { DEFAULT_SIGNAL_RULES } from "../signals.ts";
import {
  AMAZON_ORDERS_VIEW,
  actionShows,
  blockActions,
  computeBlock,
  computeBlocks,
  type ExtractedValue,
  factLanesOnly,
  formatAggregate,
  formatChange,
  INVOICES_OWED_VIEW,
  mergeThreads,
  previewBlock,
  readExtraction,
  runQuery,
  SUPPORT_TODAY_VIEW,
  TRAVEL_VIEW,
  upgradeView,
  type ViewContext,
  type ViewDoc,
  type ViewThread,
  validateView,
  viewBase,
  viewExtractionId,
  viewSignalId,
  WHO_EMAILS_VIEW,
} from "./index.ts";

const NOW = new Date("2026-10-15T12:00:00Z");
const ctx: ViewContext = {
  rules: DEFAULT_SIGNAL_RULES,
  now: NOW,
  zone: "UTC",
  owner: "sam@monday.test",
  extractFloor: 0.6,
};

function thread(over: Partial<ViewThread> = {}): ViewThread {
  return {
    id: "t1",
    messageCount: 1,
    lastActivity: "2026-10-01T10:00:00.000Z",
    receivedAt: "2026-10-01T10:00:00.000Z",
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
    recipients: ["sam@monday.test"],
    facts: {},
    readings: {},
    ...over,
  };
}

/** A picked value: the answer row says "picked", the value rides beside it. */
function picked(
  doc: ViewDoc,
  id: string,
  text: string,
  value: ExtractedValue["value"],
  confidence = 0.9,
): { readings: Record<string, SignalReading>; values: Record<string, ExtractedValue> } {
  const key = viewExtractionId(doc.id, id);
  return {
    readings: { [key]: { choice: "picked", confidence } },
    values: { [key]: { text, value, confidence } },
  };
}

function none(doc: ViewDoc, id: string, confidence = 0.95): Record<string, SignalReading> {
  return { [viewExtractionId(doc.id, id)]: { choice: "none", confidence } };
}

/** Merges several readings and values into one Thread's. */
function answers(
  ...parts: Array<{
    readings?: Record<string, SignalReading>;
    values?: Record<string, ExtractedValue>;
  }>
) {
  const readings: Record<string, SignalReading> = {};
  const values: Record<string, ExtractedValue> = {};
  for (const p of parts) {
    Object.assign(readings, p.readings ?? {});
    Object.assign(values, p.values ?? {});
  }
  return { readings, values };
}

const status = (doc: ViewDoc, choice: string): { readings: Record<string, SignalReading> } => ({
  readings: { [viewSignalId(doc.id, "status")]: { choice, confidence: 0.9 } },
});

describe("a Board is a View", () => {
  test("a Board document with a layout reads as a View with one Block of that component", () => {
    const board = {
      id: "b_old",
      name: "Old board",
      scope: { facts: {}, limit: 10 },
      lanes: [{ id: "a", label: "A", tone: "ok", when: { fact: "unread", is: true } }],
      unsure: { label: "Unsure" },
      layout: {
        component: "table",
        columns: [
          { label: "Received", fact: "received_at", format: "date" },
          { label: "Age", field: "age" },
        ],
        sort: "oldest_first",
      },
      nav: { icon: "folder", count: "total" },
    };
    const up = upgradeView(board) as ViewDoc;
    expect(up.blocks).toEqual([
      {
        id: "table",
        type: "table",
        columns: [
          { label: "Received", field: "received_at", format: "date" },
          { label: "Age", field: "last_activity_at", format: "relative" },
        ],
        sort: "oldest_first",
      },
    ]);
    const r = validateView(board);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.doc.extractions).toEqual([]);
      expect(r.doc.actions).toEqual([]);
    }
  });

  test("the example Views validate", () => {
    for (const doc of [
      SUPPORT_TODAY_VIEW,
      AMAZON_ORDERS_VIEW,
      INVOICES_OWED_VIEW,
      WHO_EMAILS_VIEW,
      TRAVEL_VIEW,
    ]) {
      const r = validateView(doc);
      expect(r.ok ? [] : r.errors).toEqual([]);
    }
  });
});

describe("validation", () => {
  const base = WHO_EMAILS_VIEW;
  const errorsOf = (doc: unknown, refs = {}) => {
    const r = validateView(doc, undefined, undefined, refs);
    return r.ok ? [] : r.errors;
  };

  test("a bare domain in from_any matches nothing, so it fails and names from_domain", () => {
    const e = errorsOf({
      ...base,
      scope: { facts: { from_any: ["orders@shop.com", "flomattress.com"] }, limit: 100 },
    });
    expect(e.join(" ")).toContain("from_domain");
    expect(
      errorsOf({ ...base, scope: { facts: { from_any: ["orders@shop.com"] }, limit: 100 } }),
    ).toEqual([]);
  });

  test("a Block naming a Field the View does not have fails, with the reason", () => {
    const e = errorsOf({
      ...base,
      blocks: [{ id: "t", type: "table", columns: [{ label: "Total", field: "x:total" }] }],
    });
    expect(e.join(" ")).toContain("x:total");
  });

  test("a chart needs a group_by, a stat an aggregate, a sum a number", () => {
    const e = errorsOf({
      ...base,
      extractions: [{ id: "vendor", find: "company", question: "The vendor." }],
      blocks: [
        { id: "c", type: "chart", chart: "bar" },
        { id: "s", type: "stat" },
        {
          id: "s2",
          type: "stat",
          query: { aggregate: { op: "sum", field: "x:vendor" } },
        },
      ],
    }).join(" ");
    expect(e).toContain("Block c is a chart");
    expect(e).toContain("Block s is a stat");
    expect(e).toContain("sum adds up numbers or money");
  });

  test("a date bucket needs a date; an Extraction's at_least needs money or a number", () => {
    const e = errorsOf({
      ...base,
      extractions: [{ id: "ref", find: "reference", question: "The order number." }],
      blocks: [
        {
          id: "c",
          type: "chart",
          chart: "bar",
          query: {
            group_by: { field: "from_domain", bucket: "month" },
            where: { extract: "ref", at_least: 3 },
          },
        },
      ],
    }).join(" ");
    expect(e).toContain("needs a date Field");
    expect(e).toContain("ref is not a number");
  });

  test("a Lane cannot read Lanes; a lanes Block needs Lanes", () => {
    const e = errorsOf({
      ...base,
      lanes: [{ id: "a", label: "A", tone: "ok", when: { lane: "b" } }],
      blocks: [{ id: "l", type: "lanes" }],
    }).join(" ");
    expect(e).toContain("cannot read Lanes");
    const e2 = errorsOf({ ...base, blocks: [{ id: "l", type: "lanes" }] }).join(" ");
    expect(e2).toContain("the View has none");
  });

  test("an Extraction that asks to add up fails; so does an unknown Extraction kind", () => {
    const e = errorsOf({
      ...base,
      extractions: [
        { id: "total", find: "money", question: "The sum of all the amounts in the thread." },
      ],
    }).join(" ");
    expect(e).toContain("Extraction total asks the model to count");
    const e2 = errorsOf({
      ...base,
      extractions: [{ id: "total", find: "price", question: "The price." }],
    }).join(" ");
    expect(e2).toContain("extractions.0.find");
  });

  test("actions: from the catalog, naming what exists, a link that is a link", () => {
    const doc = {
      ...AMAZON_ORDERS_VIEW,
      actions: [
        ...AMAZON_ORDERS_VIEW.actions,
        {
          id: "refund",
          label: "Refund",
          icon: "arrow-u-up-left",
          do: { kind: "run_workflow", workflow: "wf_gone", inputs: { order: "x:order_number" } },
        },
        {
          id: "open",
          label: "Open",
          icon: "link",
          do: { kind: "open_link", link: "x:order_total" },
        },
        { id: "bad", label: "Bad", icon: "link", do: { kind: "launch_rocket" } },
      ],
    };
    const e = errorsOf(doc, { workflows: ["wf_refund"] }).join(" ");
    expect(e).toContain("actions.3.do");
    const ok = errorsOf({ ...doc, actions: doc.actions.slice(0, 3) }, { workflows: ["wf_refund"] });
    expect(ok.join(" ")).toContain("Workflow wf_gone");
    expect(ok.join(" ")).toContain("x:order_total is not a link");
  });

  test("the limits: Blocks, Extractions and actions", () => {
    const blocks = Array.from({ length: 9 }, (_, i) => ({
      id: `t${i}`,
      type: "text",
      text: "A note.",
    }));
    expect(errorsOf({ ...base, blocks }).join(" ")).toContain("at most 8 Blocks");
  });
});

describe("an Extraction's value", () => {
  const doc = AMAZON_ORDERS_VIEW;
  test("above its floor it is a value; below, Unsure; none is empty; a pick not mirrored yet is not read", () => {
    const ok = thread(picked(doc, "order_total", "$41.97", { value: 41.97, currency: "USD" }));
    expect(readExtraction(doc, ok, "order_total", ctx)).toMatchObject({
      state: "value",
      text: "$41.97",
    });
    const low = thread(
      picked(doc, "order_total", "$41.97", { value: 41.97, currency: "USD" }, 0.4),
    );
    expect(readExtraction(doc, low, "order_total", ctx).state).toBe("unsure");
    expect(
      readExtraction(doc, thread({ readings: none(doc, "order_total") }), "order_total", ctx).state,
    ).toBe("empty");
    const notYet = thread({
      readings: {
        [viewExtractionId(doc.id, "order_total")]: { choice: "picked", confidence: 0.9 },
      },
    });
    expect(readExtraction(doc, notYet, "order_total", ctx).state).toBe("not_read");
  });
});

/* ------------------------------ The spec's examples ------------------------------ */

function amazonThreads(): ViewThread[] {
  const d = AMAZON_ORDERS_VIEW;
  const at = (iso: string) => ({ lastActivity: iso, receivedAt: iso, facts: { received_at: iso } });
  const order1 = "113-1111111-1111111";
  const order2 = "113-2222222-2222222";
  return [
    thread({
      id: "o2-shipped",
      subject: "Shipped: your order",
      ...at("2026-10-03T09:00:00.000Z"),
      ...answers(
        status(d, "shipped"),
        picked(d, "order_number", order2, order2),
        { readings: none(d, "order_total") },
        picked(d, "tracking_link", "https://track.amazon.com/x2", {
          url: "https://track.amazon.com/x2",
          domain: "track.amazon.com",
        }),
      ),
    }),
    thread({
      id: "o2-confirm",
      subject: "Your order of a desk lamp",
      ...at("2026-10-02T09:00:00.000Z"),
      ...answers(
        status(d, "ordered"),
        picked(d, "order_number", order2, order2),
        picked(d, "order_total", "$120.00", { value: 120, currency: "USD" }),
      ),
    }),
    thread({
      id: "ad",
      subject: "Deals picked for you",
      ...at("2026-09-28T09:00:00.000Z"),
      ...answers(status(d, "none"), { readings: none(d, "order_number") }),
    }),
    thread({
      id: "o1-delivered",
      subject: "Delivered: your package",
      ...at("2026-09-23T09:00:00.000Z"),
      ...answers(status(d, "delivered"), picked(d, "order_number", order1, order1), {
        readings: none(d, "order_total"),
      }),
    }),
    thread({
      id: "o1-shipped",
      subject: "Shipped: your order",
      ...at("2026-09-21T09:00:00.000Z"),
      ...answers(status(d, "shipped"), picked(d, "order_number", order1, order1)),
    }),
    thread({
      id: "o1-confirm",
      subject: "Your order of two books",
      ...at("2026-09-20T09:00:00.000Z"),
      ...answers(
        status(d, "ordered"),
        picked(d, "order_number", order1, order1),
        picked(d, "order_total", "$41.97", { value: 41.97, currency: "USD" }),
      ),
    }),
  ];
}

describe("Amazon orders (acceptance 10)", () => {
  const doc = AMAZON_ORDERS_VIEW;
  const base = viewBase(doc, amazonThreads(), ctx);

  test("one card per order in its latest status; the ad is no order and stays out", () => {
    const lanes = computeBlock(base, doc.blocks[2] as ViewDoc["blocks"][number]);
    if (lanes.type !== "lanes") throw new Error("lanes");
    const byLane = Object.fromEntries(
      lanes.groups.map((g) => [g.id, g.rows.map((r) => r.thread.id)]),
    );
    expect(byLane).toEqual({
      delivered: ["o1-delivered"],
      shipped: ["o2-shipped"],
      ordered: [],
      unsure: [],
    });
    // The merged row carries the total from the confirmation.
    const shipped = lanes.groups.find((g) => g.id === "shipped")?.rows[0];
    expect(shipped?.threads.map((t) => t.id)).toEqual(["o2-shipped", "o2-confirm"]);
    expect(readExtraction(doc, shipped?.thread as ViewThread, "order_total", ctx)).toMatchObject({
      state: "value",
      text: "$120.00",
    });
  });

  test("the stat adds up this month's orders once each, and compares with last month", () => {
    const stat = computeBlock(base, doc.blocks[0] as ViewDoc["blocks"][number]);
    if (stat.type !== "stat") throw new Error("stat");
    expect(stat.value).toMatchObject({ value: 120, currency: "USD" });
    expect(stat.previous).toMatchObject({ value: 41.97, currency: "USD" });
    expect(formatAggregate(stat.value)).toBe("$120.00");
    expect(formatChange(stat.change)).toBe("up 186%");
  });

  test("the chart has September and October, each order counted once", () => {
    const chart = computeBlock(base, doc.blocks[1] as ViewDoc["blocks"][number]);
    if (chart.type !== "chart") throw new Error("chart");
    expect(chart.groups.map((g) => [g.label, g.value.value])).toEqual([
      ["Sep", 41.97],
      ["Oct", 120],
    ]);
  });

  test("Track package shows on the shipped order with a tracking link, not on the delivered one", () => {
    const lanes = computeBlock(base, doc.blocks[2] as ViewDoc["blocks"][number]);
    if (lanes.type !== "lanes") throw new Error("lanes");
    const [track] = blockActions(doc, doc.blocks[2] as ViewDoc["blocks"][number]);
    if (!track) throw new Error("track");
    const row = (id: string) => lanes.groups.flatMap((g) => g.rows).find((r) => r.thread.id === id);
    expect(actionShows(base, track, row("o2-shipped") as never)).toBe(true);
    expect(actionShows(base, track, row("o1-delivered") as never)).toBe(false);
  });

  test("the card's preview writes every Block small", () => {
    const previews = computeBlocks(base).map((b) => previewBlock(b, ctx));
    expect(previews[0]).toMatchObject({ type: "stat", value: "$120.00", change: "up 186%" });
    expect(previews[1]?.items.map((i) => i.value)).toEqual(["$41.97", "$120.00"]);
    expect(previews[2]?.items.find((i) => i.label === "Shipped")).toMatchObject({ count: 1 });
  });
});

describe("Invoices I owe (acceptance 11)", () => {
  const doc = INVOICES_OWED_VIEW;
  const direction = (d: string) => ({ money_direction: { choice: d, confidence: 0.9 } });
  const invoice = (
    id: string,
    amount: [string, number, number],
    due: string,
    vendor: string,
    dir = "owner_pays",
  ) =>
    thread({
      id,
      subject: `Invoice ${id}`,
      from: `billing@${vendor.toLowerCase()}.com`,
      ...answers(
        { readings: direction(dir) },
        picked(doc, "amount_due", amount[0], { value: amount[1], currency: "USD" }, amount[2]),
        picked(doc, "due_date", due, due),
        picked(doc, "vendor", vendor, vendor),
      ),
    });
  const threads = [
    invoice("a", ["$1,315.50", 1315.5, 0.92], "2026-10-20", "Northwind"),
    invoice("b", ["$80.00", 80, 0.4], "2026-10-18", "Contoso"),
    invoice("c", ["$42.00", 42, 0.9], "2026-11-02", "Fabrikam"),
    invoice("d", ["$500.00", 500, 0.9], "2026-10-16", "Initech", "owner_is_paid"),
  ];

  test("rows sorted by the due date code picked; money written as money; a low pick is Unsure", () => {
    const table = computeBlock(
      viewBase(doc, threads, ctx),
      doc.blocks[0] as ViewDoc["blocks"][number],
    );
    if (table.type !== "table") throw new Error("table");
    expect(table.rows.map((r) => r.row.thread.id)).toEqual(["b", "a", "c"]);
    const preview = previewBlock(table, ctx);
    expect(preview.items.map((i) => i.value)).toEqual([
      "Contoso · Unsure · Oct 18",
      "Northwind · $1,315.50 · Oct 20",
      "Fabrikam · $42.00 · Nov 2",
    ]);
  });

  test("an Unsure amount is left out of a sum and counted", () => {
    const base = viewBase(doc, threads, ctx);
    const r = runQuery(base, {
      where: { signal: "money_direction", is: "owner_pays" },
      aggregate: { op: "sum", field: "x:amount_due" },
    });
    expect(r.value).toMatchObject({ value: 1357.5, unsure: 1, currency: "USD" });
  });
});

describe("Who emails me most (acceptance 12)", () => {
  test("people and companies counted by code, no question at all", () => {
    const doc = WHO_EMAILS_VIEW;
    const mk = (id: string, email: string, name: string, at: string) =>
      thread({
        id,
        from: email,
        correspondent: { name, email },
        lastActivity: at,
        receivedAt: at,
        facts: { received_at: at },
      });
    const threads = [
      mk("1", "aoife@northwind.com", "Aoife Brennan", "2026-10-10T09:00:00Z"),
      mk("2", "aoife@northwind.com", "Aoife Brennan", "2026-10-11T09:00:00Z"),
      mk("3", "kenji@northwind.com", "Kenji Watanabe", "2026-10-01T09:00:00Z"),
      mk("4", "sofia@gmail.com", "Sofia Lindqvist", "2026-09-01T09:00:00Z"),
      mk("5", "old@acme.com", "Old", "2026-01-01T09:00:00Z"),
    ];
    expect(validateView(doc).ok).toBe(true);
    const base = viewBase(doc, threads, ctx);
    const people = computeBlock(base, doc.blocks[0] as ViewDoc["blocks"][number]);
    if (people.type !== "people") throw new Error("people");
    expect(people.people.map((p) => [p.label, p.count])).toEqual([
      ["Aoife Brennan", 2],
      ["Kenji Watanabe", 1],
      ["Sofia Lindqvist", 1],
    ]);
    const chart = computeBlock(base, doc.blocks[1] as ViewDoc["blocks"][number]);
    if (chart.type !== "chart") throw new Error("chart");
    expect(chart.groups.map((g) => [g.label, g.value.value])).toEqual([
      ["Northwind", 3],
      ["Sofia Lindqvist", 1],
    ]);
  });
});

describe("Travel on a calendar (acceptance 13)", () => {
  test("each booking on the day code picked; the offers stay out", () => {
    const doc = TRAVEL_VIEW;
    const booking = (p: number) => ({
      readings: { [viewSignalId(doc.id, "is_booking")]: { noul: p } },
    });
    const threads = [
      thread({
        id: "flight",
        subject: "Your flight to Lisbon",
        ...answers(
          booking(0.95),
          picked(doc, "travel_date", "Nov 4", "2026-11-04"),
          picked(doc, "booking_ref", "ABC123", "ABC123"),
        ),
      }),
      thread({
        id: "hotel",
        subject: "Hotel confirmation",
        ...answers(
          booking(0.9),
          picked(doc, "travel_date", "4 November 2026", "2026-11-04"),
          picked(doc, "booking_ref", "H-77", "H-77"),
        ),
      }),
      thread({ id: "offer", subject: "Fly for less", ...answers(booking(0.05)) }),
      thread({ id: "maybe", subject: "Trip?", ...answers(booking(0.5)) }),
    ];
    const cal = computeBlock(
      viewBase(doc, threads, ctx),
      doc.blocks[0] as ViewDoc["blocks"][number],
    );
    if (cal.type !== "calendar") throw new Error("calendar");
    expect(cal.items.map((i) => [i.row.thread.id, i.date])).toEqual([
      ["flight", "2026-11-04"],
      ["hotel", "2026-11-04"],
    ]);
    expect(cal.unsure).toBe(1);
  });
});

describe("queries", () => {
  const doc: ViewDoc = {
    ...WHO_EMAILS_VIEW,
    extractions: [{ id: "paid", find: "money", question: "The amount paid." }],
    blocks: [{ id: "t", type: "text", text: "Hi." }],
  };

  test("money adds up per currency, never converted", () => {
    const threads = [
      thread({ id: "a", ...picked(doc, "paid", "$10.00", { value: 10, currency: "USD" }) }),
      thread({ id: "b", ...picked(doc, "paid", "$5.50", { value: 5.5, currency: "USD" }) }),
      thread({ id: "c", ...picked(doc, "paid", "EUR 12", { value: 12, currency: "EUR" }) }),
    ];
    const r = runQuery(viewBase(doc, threads, ctx), { aggregate: { op: "sum", field: "x:paid" } });
    expect(r.value).toMatchObject({
      value: 15.5,
      currency: "USD",
      others: [{ currency: "EUR", value: 12 }],
    });
    expect(formatAggregate(r.value as never)).toBe("$15.50 + €12.00");
  });

  test("time buckets between the first and the last show as zero", () => {
    const at = (iso: string) => ({
      lastActivity: iso,
      receivedAt: iso,
      facts: { received_at: iso },
    });
    const threads = [
      thread({ id: "a", ...at("2026-07-20T09:00:00Z") }),
      thread({ id: "b", ...at("2026-09-03T09:00:00Z") }),
      thread({ id: "c", ...at("2026-09-13T09:00:00Z") }),
    ];
    const r = runQuery(viewBase(doc, threads, ctx), {
      group_by: { field: "received_at", bucket: "month" },
    });
    expect(r.groups?.map((g) => [g.label, g.value.value])).toEqual([
      ["Jul", 1],
      ["Aug", 0],
      ["Sep", 2],
    ]);
  });

  test("a where that cannot decide counts the row as Unsure", () => {
    const threads = [
      thread({ id: "a", ...picked(doc, "paid", "$10.00", { value: 10, currency: "USD" }) }),
      thread({ id: "b", ...picked(doc, "paid", "$99.00", { value: 99, currency: "USD" }, 0.3) }),
      thread({ id: "c" }),
    ];
    const r = runQuery(viewBase(doc, threads, ctx), { where: { extract: "paid", at_least: 5 } });
    expect(r.rows.map((x) => x.thread.id)).toEqual(["a"]);
    expect(r.unsure.map((x) => x.thread.id).sort()).toEqual(["b", "c"]);
  });

  test("merging keeps the newest known value of each answer", () => {
    const newer = thread({ id: "n", readings: none(doc, "paid") });
    const older = thread({
      id: "o",
      ...picked(doc, "paid", "$3.00", { value: 3, currency: "USD" }),
    });
    const merged = mergeThreads([newer, older]);
    expect(merged.id).toBe("n");
    expect(readExtraction(doc, merged, "paid", ctx).state).toBe("value");
  });
});

describe("the other Blocks", () => {
  const doc: ViewDoc = {
    ...WHO_EMAILS_VIEW,
    extractions: [{ id: "promise", find: "sentence", question: "What the owner promised." }],
    blocks: [
      { id: "todo", type: "checklist", item: "x:promise" },
      { id: "heat", type: "heatmap", date: "received_at" },
      {
        id: "cards",
        type: "cards",
        card_title: "subject",
        subtitle: "person",
        badges: ["from_domain"],
      },
    ],
  };
  const threads = [
    thread({
      id: "a",
      messageCount: 2,
      subject: "Report",
      facts: { received_at: "2026-10-12T09:30:00Z", from_domain: "acme.com" },
      ...picked(
        doc,
        "promise",
        "I will send the report by Friday.",
        "I will send the report by Friday.",
      ),
    }),
    thread({
      id: "b",
      subject: "Call",
      facts: { received_at: "2026-10-13T15:00:00Z", from_domain: "acme.com" },
      ...picked(doc, "promise", "I'll call you back.", "I'll call you back."),
    }),
  ];

  test("a checklist item stays checked for the Thread version it was checked at", () => {
    const data = computeBlock(
      viewBase(doc, threads, ctx),
      doc.blocks[0] as ViewDoc["blocks"][number],
      {
        done: {
          a: { messageCount: 1, at: "2026-10-12T10:00:00Z" },
          b: { messageCount: 1, at: "x" },
        },
      },
    );
    if (data.type !== "checklist") throw new Error("checklist");
    expect(data.items.map((i) => [i.row.thread.id, i.done])).toEqual([
      ["a", false],
      ["b", true],
    ]);
  });

  test("a heatmap counts by weekday and hour", () => {
    const data = computeBlock(
      viewBase(doc, threads, ctx),
      doc.blocks[1] as ViewDoc["blocks"][number],
    );
    if (data.type !== "heatmap") throw new Error("heatmap");
    expect(data.cells[0]?.[9]).toBe(1); // Monday 09:00
    expect(data.cells[1]?.[15]).toBe(1); // Tuesday 15:00
    expect(data.max).toBe(1);
  });

  test("cards carry a title, a subtitle and badges", () => {
    const data = computeBlock(
      viewBase(doc, threads, ctx),
      doc.blocks[2] as ViewDoc["blocks"][number],
    );
    if (data.type !== "cards") throw new Error("cards");
    expect(data.cards[0]?.title).toMatchObject({ state: "value", text: "Report" });
    expect(data.cards[0]?.badges[0]).toMatchObject({ state: "value", text: "acme.com" });
  });

  test("without a TypeSafe key only what needs no reading is kept", () => {
    const kept = factLanesOnly(doc);
    expect(kept?.blocks.map((b) => b.id)).toEqual(["heat", "cards"]);
    expect(
      factLanesOnly({ ...doc, blocks: [doc.blocks[0] as ViewDoc["blocks"][number]] }),
    ).toBeNull();
  });
});
