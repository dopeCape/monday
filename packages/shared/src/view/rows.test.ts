// Many values per Thread and rows that are items or Messages (docs/spec/views.md,
// "Many values" and "Rows"): an order confirmation with 9 totals adds all 9 to
// the month, a Dependabot digest is one row per package with its own severity,
// and a thread of advisories is one row per Message on that Message's date.
// Code adds, counts and groups; the values and answers are as the judge picked.

import { describe, expect, test } from "bun:test";
import { DEFAULT_SIGNAL_RULES } from "../signals.ts";
import { computeBlocks, previewBlock } from "./blocks.ts";
import {
  expandRows,
  readExtraction,
  rowKey,
  type ViewContext,
  type ViewThread,
  viewExtractionId,
  viewSignalId,
} from "./core.ts";
import { readField } from "./fields.ts";
import { viewBase } from "./query.ts";
import type { ExtractedItem, ViewDoc } from "./types.ts";
import { validateView } from "./validate.ts";

const NOW = new Date("2026-09-30T12:00:00Z");
const ctx: ViewContext = {
  rules: DEFAULT_SIGNAL_RULES,
  now: NOW,
  zone: "UTC",
  owner: "sam@monday.test",
  extractFloor: 0.6,
};

function thread(id: string, at: string, extra: Partial<ViewThread> = {}): ViewThread {
  return {
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
    from: "orders@shop.test",
    recipients: [],
    facts: {},
    readings: {},
    values: {},
    subject: id,
    ...extra,
  };
}

const inr = (n: number): ExtractedItem => ({
  key: `${n} INR`,
  text: `${n} INR`,
  value: { value: n, currency: "INR" },
  confidence: 0.9,
});

const ORDERS: ViewDoc = {
  id: "v_orders",
  name: "Orders",
  sentence: "orders spend per month",
  version: 1,
  scope: { facts: { folder: "any" }, limit: 100 },
  signals: [],
  uses: [],
  extractions: [
    {
      id: "total",
      label: "Total",
      find: "money",
      many: true,
      question: "Each order's Total: what one order cost.",
    },
  ],
  lanes: [],
  unsure: { label: "Unsure" },
  others: "hide",
  blocks: [
    {
      id: "by_month",
      type: "chart",
      chart: "bar",
      query: {
        group_by: { field: "received_at", bucket: "month" },
        aggregate: { op: "sum", field: "x:total" },
      },
    },
    { id: "spent", type: "stat", query: { aggregate: { op: "sum", field: "x:total" } } },
    { id: "orders", type: "stat", query: { aggregate: { op: "count", field: "x:total" } } },
  ],
  actions: [],
  nav: { icon: "shopping-bag", count: "total" },
  examples: {},
};

describe("many values", () => {
  const total = viewExtractionId(ORDERS.id, "total");
  const picked = (items: ExtractedItem[]) => ({
    readings: { [total]: { choice: "picked", confidence: 0.9, version: 1 } },
    values: {
      [total]: {
        text: items[0]?.text ?? "",
        value: items[0]?.value ?? null,
        confidence: 0.9,
        items,
      },
    },
  });
  // One confirmation bundling nine orders in August, one single order in September.
  const nine = [100, 200, 300, 400, 500, 600, 700, 800, 900].map(inr);
  const threads = [
    thread("sep", "2026-09-10T10:00:00Z", picked([inr(1500)])),
    thread("aug", "2026-08-10T10:00:00Z", picked(nine)),
    thread(
      "unsure",
      "2026-08-12T10:00:00Z",
      picked([{ ...inr(50), confidence: 0.5, unsure: true }]),
    ),
  ];

  test("every value of a Thread adds to its month and to the total; a count counts each", () => {
    const base = viewBase(ORDERS, threads, ctx);
    const [chart, spent, orders] = computeBlocks(base).map((b) => previewBlock(b, ctx));
    expect(chart?.items.map((i) => [i.label, i.value])).toEqual([
      ["Aug", "₹4,500.00"],
      ["Sep", "₹1,500.00"],
    ]);
    expect(chart?.unsure).toBe(1);
    expect(spent?.value).toBe("₹6,000.00");
    expect(orders?.value).toBe("10");
  });

  test("a row reads its values as their total and lists them; only Unsure ones read Unsure", () => {
    const aug = threads[1] as ViewThread;
    const read = readField(ORDERS, aug, "x:total", ctx);
    expect(read.state === "value" && read.value).toEqual({ value: 4500, currency: "INR" });
    expect(read.state === "value" && read.items?.length).toBe(9);
    expect(readExtraction(ORDERS, threads[2] as ViewThread, "total", ctx).state).toBe("unsure");
    // An Extraction's own max keeps the first ones only.
    const capped: ViewDoc = {
      ...ORDERS,
      extractions: [{ ...(ORDERS.extractions[0] as ViewDoc["extractions"][number]), max: 3 }],
    };
    const r = readExtraction(capped, aug, "total", ctx);
    expect(r.state === "value" && r.items?.map((i) => i.text)).toEqual([
      "100 INR",
      "200 INR",
      "300 INR",
    ]);
  });
});

const DIGEST: ViewDoc = {
  id: "v_vulns",
  name: "Vulnerabilities",
  sentence: "a chart of all the vulnerabilities my GitHub repos have gotten",
  version: 1,
  scope: { facts: { folder: "any", from_domain: ["github.com"] }, limit: 100 },
  grain: "item",
  item_of: "advisory",
  signals: [
    {
      id: "severity",
      kind: "choice",
      each: true,
      question: {
        type: "choice",
        instructions: "How severe is this one advisory?",
        criteria: {
          critical: "Critical",
          high: "High",
          moderate: "Moderate",
          low: "Low",
          none: "The line is not an advisory.",
        },
      },
    },
  ],
  uses: [],
  extractions: [
    {
      id: "advisory",
      label: "Advisory",
      find: "item",
      many: true,
      question: "Each package named with a security advisory.",
    },
  ],
  lanes: [
    {
      id: "critical",
      label: "Critical",
      tone: "danger",
      when: { signal: "severity", is: "critical" },
    },
    { id: "high", label: "High", tone: "warning", when: { signal: "severity", is: "high" } },
  ],
  unsure: { label: "Unsure" },
  others: { label: "Lower" },
  blocks: [
    {
      id: "by_severity",
      type: "chart",
      chart: "bar",
      query: { group_by: { field: "signal:severity" }, aggregate: { op: "count" } },
    },
    { id: "table", type: "table", columns: [{ label: "Package", field: "x:advisory" }] },
  ],
  actions: [],
  nav: { icon: "shield", count: "total" },
  examples: {},
};

describe("rows that are items", () => {
  const adv = viewExtractionId(DIGEST.id, "advisory");
  const sev = viewSignalId(DIGEST.id, "severity");
  const item = (key: string, at: string): ExtractedItem => ({
    key,
    text: key,
    value: key,
    confidence: 0.92,
    message: "m1",
    at,
  });
  const digest = thread("digest", "2026-09-07T08:00:00Z", {
    from: "noreply@github.com",
    readings: {
      [adv]: { choice: "picked", confidence: 0.9, version: 1 },
      [sev]: { choice: "each", confidence: 1, version: 1 },
    },
    values: {
      [adv]: {
        text: "lodash",
        value: "lodash",
        confidence: 0.92,
        items: [
          item("lodash", "2026-09-07T08:00:00Z"),
          item("axios", "2026-09-07T08:00:00Z"),
          item("minimist", "2026-09-07T08:00:00Z"),
          { ...item("left-pad", "2026-09-07T08:00:00Z"), confidence: 0.4, unsure: true },
        ],
      },
      [sev]: {
        text: "each",
        value: null,
        confidence: 1,
        answers: {
          lodash: { choice: "critical", confidence: 0.9 },
          axios: { choice: "high", confidence: 0.85 },
          minimist: { choice: "low", confidence: 0.9 },
        },
      },
    },
  });
  const quiet = thread("quiet", "2026-09-01T08:00:00Z", {
    from: "noreply@github.com",
    readings: { [adv]: { choice: "none", confidence: 1, version: 1 } },
  });

  test("each value picked is its own row with its own answer; a Thread with none has no rows", () => {
    const rows = expandRows(DIGEST, [digest, quiet]);
    expect(rows.map(rowKey)).toEqual(["digest#lodash", "digest#axios", "digest#minimist"]);
    expect(rows.every((r) => r.id === "digest")).toBe(true);
    const base = viewBase(DIGEST, [digest, quiet], ctx);
    expect(base.lanes.counts).toMatchObject({ critical: 1, high: 1, others: 1, unsure: 0 });
    const [chart, table] = computeBlocks(base).map((b) => previewBlock(b, ctx));
    expect(chart?.items.map((i) => [i.label, i.value])).toEqual([
      ["critical", "1"],
      ["high", "1"],
      ["low", "1"],
    ]);
    expect(table?.items.map((i) => i.label)).toEqual(["digest", "digest", "digest"]);
  });

  test("the grain is validated: item_of names a many-Extraction, each needs rows", () => {
    expect(validateView(DIGEST).ok).toBe(true);
    const errors = (doc: unknown) => {
      const r = validateView(doc);
      return r.ok ? "" : r.errors.join(" ");
    };
    expect(errors({ ...DIGEST, item_of: undefined })).toContain("item_of");
    expect(
      errors({
        ...DIGEST,
        extractions: [{ ...(DIGEST.extractions[0] as object), many: false }],
      }),
    ).toContain("many: true");
    expect(errors({ ...DIGEST, grain: "thread", item_of: undefined })).toContain("each");
    expect(
      errors({ ...ORDERS, extractions: [{ ...ORDERS.extractions[0], many: false, max: 3 }] }),
    ).toContain("max");
    // Picking many is allowed; a question that adds them up is not.
    expect(
      errors({
        ...ORDERS,
        extractions: [{ ...ORDERS.extractions[0], question: "The sum of all the order totals." }],
      }),
    ).toContain("many: true");
  });
});

describe("rows that are Messages", () => {
  const ADVISORIES: ViewDoc = {
    ...DIGEST,
    id: "v_advisories",
    grain: "message",
    item_of: undefined,
    extractions: [
      {
        id: "package",
        label: "Package",
        find: "item",
        question: "The package this advisory is about.",
      },
    ],
    blocks: [
      {
        id: "per_month",
        type: "chart",
        chart: "bar",
        query: { group_by: { field: "received_at", bucket: "month" }, aggregate: { op: "count" } },
      },
    ],
  };
  const pkg = viewExtractionId(ADVISORIES.id, "package");
  const sev = viewSignalId(ADVISORIES.id, "severity");
  const msg = (n: number, name: string, at: string): ExtractedItem => ({
    key: `${n}:${name}`,
    text: name,
    value: name,
    confidence: 0.9,
    message: `m${n}`,
    at,
  });

  test("each Message is a row on its own date, with its own value and answer", () => {
    const t = thread("advisories", "2026-09-20T08:00:00Z", {
      from: "noreply@github.com",
      messageCount: 3,
      readings: { [pkg]: { choice: "picked", confidence: 0.9, version: 1 } },
      values: {
        [pkg]: {
          text: "lodash",
          value: "lodash",
          confidence: 0.9,
          items: [
            msg(0, "lodash", "2026-07-02T08:00:00Z"),
            msg(1, "axios", "2026-08-15T08:00:00Z"),
            msg(2, "vite", "2026-09-20T08:00:00Z"),
          ],
        },
        [sev]: {
          text: "each",
          value: null,
          confidence: 1,
          answers: {
            m0: { choice: "critical", confidence: 0.9, message: "m0", at: "2026-07-02T08:00:00Z" },
            m1: { choice: "high", confidence: 0.9, message: "m1", at: "2026-08-15T08:00:00Z" },
            m2: { choice: "low", confidence: 0.9, message: "m2", at: "2026-09-20T08:00:00Z" },
          },
        },
      },
    });
    const rows = expandRows(ADVISORIES, [t]);
    expect(
      rows.map((r) => [r.row?.message, readField(ADVISORIES, r, "x:package", ctx).state]),
    ).toEqual([
      ["m2", "value"],
      ["m1", "value"],
      ["m0", "value"],
    ]);
    const base = viewBase(ADVISORIES, [t], ctx);
    expect(base.lanes.counts).toMatchObject({ critical: 1, high: 1, others: 1 });
    const [chart] = computeBlocks(base).map((b) => previewBlock(b, ctx));
    expect(chart?.items.map((i) => [i.label, i.value])).toEqual([
      ["Jul", "1"],
      ["Aug", "1"],
      ["Sep", "1"],
    ]);
    expect(validateView(ADVISORIES).ok).toBe(true);
  });
});
