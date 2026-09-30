// Many values per Thread, end to end (docs/spec/views.md, "Many values" and
// "Rows"): an order confirmation bundling three orders adds all three totals
// to its month; a Dependabot digest is one row per package with its own
// severity; a thread of advisories is one row per Message on that Message's
// date. Each Thread is still asked once, every question in its one request,
// and the values stay sealed until the Device reads them.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Account, Person } from "@monday/shared";
import { viewExtractionId, viewSignalId } from "@monday/shared";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys } from "../src/crypto/keys.ts";
import { settings as settingsTable } from "../src/db/schema.ts";
import { createIntelligence, type Intelligence } from "../src/intelligence/index.ts";
import {
  createFakeChat,
  createFakeJudge,
  type FakeJudgeAnswer,
} from "../src/intelligence/runtime/fake/index.ts";
import { createMailstore, type Mailstore } from "../src/mailstore/index.ts";
import { viewRoutes } from "../src/routes/views.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const NOW = new Date("2026-10-15T12:00:00Z");
const owner = { name: "Sam Okafor", email: "sam@monday.test" };
const amazon = { name: "Amazon.in", email: "auto-confirm@amazon.in" };
const github = { name: "GitHub", email: "noreply@github.com" };

const confirmation = (orders: Array<[string, number, number]>) =>
  [
    `Your ${orders.length} orders are confirmed.`,
    ...orders.flatMap(([item, price, total]) => [
      `${item} ${price.toLocaleString("en-IN")} INR`,
      `Order Total: ${total.toLocaleString("en-IN")} INR`,
    ]),
    `Grand Total: ${orders.reduce((n, o) => n + o[2], 0).toLocaleString("en-IN")} INR`,
  ].join("\n");

/** Scripted Nouls for many values: yes on these candidate numbers, a clear no on the rest. */
const nouls = (id: string, count: number, yes: number[]): Record<string, FakeJudgeAnswer> =>
  Object.fromEntries(
    Array.from({ length: count }, (_, i) => [`${id}#i${i + 1}`, yes.includes(i + 1) ? 0.95 : 0.05]),
  );

const ORDERS_DOC = {
  name: "Orders",
  scope: { facts: { from_any: [amazon.email], folder: "any" }, limit: 500 },
  extractions: [
    {
      id: "total",
      label: "Total",
      find: "money",
      many: true,
      question: "Each order's total: what one order cost, under the words Order Total.",
      none: "The span is an item's price or the grand total of all orders, not one order's total.",
    },
  ],
  blocks: [
    {
      id: "by_month",
      type: "chart",
      chart: "bar",
      title: "Spend per month",
      query: {
        group_by: { field: "received_at", bucket: "month" },
        aggregate: { op: "sum", field: "x:total" },
      },
    },
  ],
  nav: { icon: "shopping-bag", count: "total" },
};

const DIGEST_DOC = {
  name: "Vulnerabilities",
  scope: { facts: { from_any: [github.email], folder: "any" }, limit: 500 },
  grain: "item",
  item_of: "advisory",
  signals: [
    {
      id: "severity",
      kind: "choice",
      label: "severity",
      each: true,
      question: {
        type: "choice",
        instructions: "How severe does the message say this one advisory is?",
        criteria: {
          critical: "Critical.",
          high: "High.",
          moderate: "Moderate.",
          low: "Low.",
          none: "The line is not a security advisory.",
        },
      },
    },
  ],
  extractions: [
    {
      id: "advisory",
      label: "Package",
      find: "item",
      many: true,
      question: "Each package line that reports a security advisory.",
    },
  ],
  blocks: [
    {
      id: "by_severity",
      type: "chart",
      chart: "bar",
      title: "By severity",
      query: { group_by: { field: "signal:severity" }, aggregate: { op: "count" } },
    },
  ],
  nav: { icon: "shield", count: "total" },
};

describe("many values and rows that are items or Messages", () => {
  let db: TestDatabase;
  let store: Mailstore;
  let workspaceId: string;
  const judge = createFakeJudge();
  const chat = createFakeChat();
  let intelligence: Intelligence;

  const addThread = async (
    key: string,
    from: Person,
    messages: Array<{ date: string; body: string }>,
    subject = key,
  ) => {
    const threadId = await store.upsertThread({
      workspaceId,
      providerThreadId: key,
      subject,
      participants: [from, owner],
      lastActivity: messages[messages.length - 1]?.date ?? NOW.toISOString(),
    });
    for (const [n, m] of messages.entries()) {
      await store.upsertMessage({
        threadId,
        providerMessageId: `m-${key}-${n}`,
        from,
        to: [owner],
        cc: [],
        date: m.date,
        headers: {},
        bodyText: m.body,
        bodyHtml: null,
        snippet: m.body.slice(0, 80),
      });
    }
    return threadId;
  };

  beforeAll(async () => {
    db = await testDatabase();
    const keys = createKeys(db.handle.db);
    await keys.unlock(randomKey());
    store = createMailstore(db.handle.db, keys);
    const account: Account = {
      id: "acct-views-many",
      provider: "jmap",
      address: owner.email,
      displayName: owner.name,
      capabilities: {
        push: true,
        labels: false,
        snooze: false,
        mute: false,
        calendar: false,
        meetingLink: null,
      },
    };
    workspaceId = (await store.createWorkspace(account)).id;
    await db.handle.db
      .insert(settingsTable)
      .values({ scope: "global", deviceId: null, key: "calendar.time_zone", value: "UTC" });
    intelligence = createIntelligence({
      level: async () => "automate",
      db: db.handle.db,
      mailstore: store,
      chat: chat.chat,
      judge: judge.judge,
      keys: async (provider) =>
        provider === "typesafe" ? "ts-key" : provider === "anthropic" ? "sk-ant-fake" : null,
      now: () => NOW,
    });
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  });

  test("an order confirmation of three orders adds all three totals to its month, in one request", async () => {
    await addThread("bundle", amazon, [
      {
        date: "2026-09-12T09:00:00.000Z",
        body: confirmation([
          ["Kettle", 1200, 1250],
          ["Lamp", 800, 830],
          ["Rug", 2000, 2040],
        ]),
      },
    ]);
    const sentence = "orders spend per month";
    const id = "v_orders_spend_per_month";
    const total = viewExtractionId(id, "total");
    // Candidates in order: 1,200 1,250 800 830 2,000 2,040 4,120; the order totals are 2, 4 and 6.
    judge.when((s) => JSON.stringify(s).includes("Kettle"), nouls(total, 7, [2, 4, 6]));
    chat.answer(() => JSON.stringify({ ...ORDERS_DOC, sentence }));
    const before = judge.calls.length;
    const out = await intelligence.agent
      .tools(workspaceId)
      .call(
        { name: "create_view", args: { sentence }, callId: "c-orders", sessionId: "s-1" },
        { ask: async () => "approved" as const },
      );
    expect(out.isError).toBe(false);
    const calls = judge.calls.slice(before);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.questions).toEqual(Array.from({ length: 7 }, (_, i) => `${total}#i${i + 1}`));
    const draftId = (out.activity.preview as { draftId: string }).draftId;
    const draft = await intelligence.views.drafting.drafts.get(draftId);
    expect(draft.doc.id).toBe(id);
    const [chart] = draft.test?.blocks ?? [];
    expect(chart?.items.map((i) => [i.label, i.value])).toEqual([["Sep", "₹4,120.00"]]);
    expect(out.text).toContain("Total (x:total, find money): 3 values on 1 of 1 threads.");

    // Pinned: a new confirmation's totals are picked in its arrival request and read back whole.
    await intelligence.views.drafting.pin(draftId);
    const next = await addThread("bundle-2", amazon, [
      {
        date: "2026-10-03T09:00:00.000Z",
        body: confirmation([
          ["Mat", 500, 540],
          ["Cup", 90, 120],
        ]),
      },
    ]);
    judge.when((s) => JSON.stringify(s).includes("Mat 500"), nouls(total, 5, [2, 4]));
    await intelligence.signals.ask(workspaceId, next, { reason: "arrival" });
    const res = await viewRoutes(intelligence.views).request(`/views/${id}/values`);
    const { values } = (await res.json()) as {
      values: Record<string, Record<string, { items?: Array<{ text: string; unsure?: boolean }> }>>;
    };
    expect(values[next]?.[total]?.items?.map((i) => i.text)).toEqual(["540 INR", "120 INR"]);
  });

  test("a digest is one row per package, each with its own severity", async () => {
    await addThread(
      "digest",
      github,
      [
        {
          date: "2026-10-05T08:00:00.000Z",
          body: [
            "Dependabot found 3 vulnerabilities in dopeCape/monday.",
            "",
            "* lodash (critical) Prototype Pollution in lodash",
            "* axios (high) Server-Side Request Forgery in axios",
            "* minimist (low) Prototype Pollution in minimist",
          ].join("\n"),
        },
      ],
      "Your Dependabot alerts digest",
    );
    const sentence = "a chart of all the vulnerabilities my GitHub repos have gotten";
    const id = "v_a_chart_of_all";
    const advisory = viewExtractionId(id, "advisory");
    const severity = viewSignalId(id, "severity");
    judge.when((s) => JSON.stringify(s).includes("Dependabot found 3"), {
      ...nouls(advisory, 3, [1, 2, 3]),
      [`${severity}#i1`]: "critical",
      [`${severity}#i2`]: "high",
      [`${severity}#i3`]: "low",
    });
    chat.answer(() => JSON.stringify({ ...DIGEST_DOC, sentence }));
    const before = judge.calls.length;
    const out = await intelligence.agent
      .tools(workspaceId)
      .call(
        { name: "create_view", args: { sentence }, callId: "c-digest", sessionId: "s-1" },
        { ask: async () => "approved" as const },
      );
    expect(out.isError).toBe(false);
    // One request for the digest: a Noul per package line and a severity per package, together.
    const calls = judge.calls.slice(before);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.questions).toHaveLength(6);
    const draft = await intelligence.views.drafting.drafts.get(
      (out.activity.preview as { draftId: string }).draftId,
    );
    const [chart] = draft.test?.blocks ?? [];
    expect(chart?.items.map((i) => [i.label, i.value])).toEqual([
      ["critical", "1"],
      ["high", "1"],
      ["low", "1"],
    ]);
    expect(draft.test?.shown).toHaveLength(1);
    expect(out.text).toContain("Package (x:advisory, find item): 3 values on 1 of 1 threads.");
    expect(out.text).toContain("severity (signal:severity): asked per row: clear on 3 rows.");
  });

  test("a thread of advisories is one row per Message, on that Message's date", async () => {
    await addThread(
      "advisories",
      { name: "GitHub Security", email: "security@github.com" },
      [
        { date: "2026-07-02T08:00:00.000Z", body: "* lodash: Prototype Pollution (GHSA-35jh)" },
        {
          date: "2026-08-15T08:00:00.000Z",
          body: "* axios: Server-Side Request Forgery (GHSA-8hc4)",
        },
        { date: "2026-09-20T08:00:00.000Z", body: "* vite: Path traversal (GHSA-9cwx)" },
      ],
      "Security advisories for dopeCape/monday",
    );
    const sentence = "advisories per month as a chart";
    const id = "v_advisories_per_month_as";
    const pkg = viewExtractionId(id, "package");
    const severity = viewSignalId(id, "severity");
    judge.when((s) => JSON.stringify(s).includes("GHSA-35jh"), {
      [`${pkg}#m0`]: "lodash: Prototype Pollution (GHSA-35jh)",
      [`${pkg}#m1`]: "axios: Server-Side Request Forgery (GHSA-8hc4)",
      [`${pkg}#m2`]: "vite: Path traversal (GHSA-9cwx)",
      [`${severity}#m0`]: "critical",
      [`${severity}#m1`]: "high",
      [`${severity}#m2`]: "moderate",
    });
    chat.answer(() =>
      JSON.stringify({
        ...DIGEST_DOC,
        sentence,
        name: "Advisories",
        scope: { facts: { from_any: ["security@github.com"], folder: "any" }, limit: 500 },
        grain: "message",
        item_of: undefined,
        extractions: [
          {
            id: "package",
            label: "Package",
            find: "item",
            question: "The package this one advisory is about.",
          },
        ],
        blocks: [
          {
            id: "per_month",
            type: "chart",
            chart: "stacked_bar",
            title: "Advisories per month",
            query: {
              group_by: { field: "received_at", bucket: "month" },
              aggregate: { op: "count" },
            },
            series: { field: "signal:severity" },
          },
        ],
      }),
    );
    const before = judge.calls.length;
    const draft = await intelligence.views.drafting.propose(workspaceId, sentence);
    expect(draft.doc.grain).toBe("message");
    const calls = judge.calls.slice(before);
    expect(calls).toHaveLength(1);
    expect([...(calls[0]?.questions ?? [])].sort()).toEqual(
      [
        `${pkg}#m0`,
        `${pkg}#m1`,
        `${pkg}#m2`,
        `${severity}#m0`,
        `${severity}#m1`,
        `${severity}#m2`,
      ].sort(),
    );
    const [chart] = draft.test?.blocks ?? [];
    expect(chart?.items.map((i) => [i.label, i.value])).toEqual([
      ["Jul", "1"],
      ["Aug", "1"],
      ["Sep", "1"],
    ]);
  });
});
