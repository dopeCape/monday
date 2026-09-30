// Views II, Extractions (docs/spec/views.md; acceptance 10, 14 and 15):
// "all my Amazon orders with shipped and delivered lanes and total spend per
// month" is drafted, tried on the owner's own mail with every question of
// the draft in each Thread's one request (the Threads asked concurrently),
// the totals and order numbers picked by the (fake) judge among the spans
// code found, one row per order in the card's Blocks; pinned, a new order's
// values are picked in the arrival request, kept sealed, and read back for
// the Device.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Account, ViewDoc } from "@monday/shared";
import { AMAZON_ORDERS_VIEW, viewExtractionId, viewSignalId } from "@monday/shared";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys } from "../src/crypto/keys.ts";
import { changes, settings as settingsTable, signalAnswers } from "../src/db/schema.ts";
import { createIntelligence, type Intelligence } from "../src/intelligence/index.ts";
import { createFakeChat, createFakeJudge } from "../src/intelligence/runtime/fake/index.ts";
import { createMailstore, type Mailstore } from "../src/mailstore/index.ts";
import { viewRoutes } from "../src/routes/views.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const NOW = new Date("2026-10-15T12:00:00Z");
const owner = { name: "Sam Okafor", email: "sam@monday.test" };
const amazon = { name: "Amazon.com", email: "auto-confirm@amazon.com" };
const VIEW = "v_all_my_amazon_orders";
const { id: _id, version: _v, examples: _e, ...WRITTEN } = AMAZON_ORDERS_VIEW;

const status = viewSignalId(VIEW, "status");
const total = viewExtractionId(VIEW, "order_total");
const number = viewExtractionId(VIEW, "order_number");
const tracking = viewExtractionId(VIEW, "tracking_link");

describe("Amazon orders: Extractions from the draft to the Device", () => {
  let db: TestDatabase;
  let store: Mailstore;
  let workspaceId: string;
  const judge = createFakeJudge();
  const chat = createFakeChat();
  let intelligence: Intelligence;

  const addThread = async (key: string, subject: string, date: string, body: string) => {
    const threadId = await store.upsertThread({
      workspaceId,
      providerThreadId: key,
      subject,
      participants: [amazon, owner],
      lastActivity: date,
    });
    await store.upsertMessage({
      threadId,
      providerMessageId: `m-${key}`,
      from: amazon,
      to: [owner],
      cc: [],
      date,
      headers: {},
      bodyText: body,
      bodyHtml: null,
      snippet: body.slice(0, 80),
    });
    return threadId;
  };

  beforeAll(async () => {
    db = await testDatabase();
    const keys = createKeys(db.handle.db);
    await keys.unlock(randomKey());
    store = createMailstore(db.handle.db, keys);
    const account: Account = {
      id: "acct-views-x",
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
    chat.answer(() => JSON.stringify(WRITTEN));
    await addThread(
      "o1-confirm",
      "Your Amazon.com order of two books",
      "2026-09-20T09:00:00.000Z",
      "Order #113-1111111-1111111\nItem subtotal: $38.00\nShipping: $3.97\nOrder total: $41.97",
    );
    await addThread(
      "o1-delivered",
      "Delivered: your package",
      "2026-09-23T09:00:00.000Z",
      "Your package with order #113-1111111-1111111 was delivered.",
    );
    await addThread(
      "o2-confirm",
      "Your Amazon.com order of a desk lamp",
      "2026-10-02T09:00:00.000Z",
      "Order #113-2222222-2222222\nItem subtotal: $110.00\nTax: $10.00\nOrder total: $120.00",
    );
    await addThread(
      "o2-shipped",
      "Shipped: your desk lamp",
      "2026-10-03T09:00:00.000Z",
      "Order #113-2222222-2222222 has shipped. Track your package: https://track.amazon.com/x2",
    );
    await addThread(
      "ad",
      "Deals picked for you",
      "2026-10-04T09:00:00.000Z",
      "Save $20.00 on headphones this week only.",
    );
    const has = (state: unknown, words: string) => JSON.stringify(state).includes(words);
    // What the judge reads: the status, and among the spans code found, the order total and number.
    judge.when((s) => has(s, "Order total: $41.97"), {
      [status]: "ordered",
      [total]: "$41.97",
      [number]: "113-1111111-1111111",
    });
    judge.when((s) => has(s, "was delivered"), {
      [status]: "delivered",
      [number]: "113-1111111-1111111",
    });
    judge.when((s) => has(s, "Order total: $120.00"), {
      [status]: "ordered",
      [total]: "$120.00",
      [number]: "113-2222222-2222222",
    });
    judge.when((s) => has(s, "has shipped"), {
      [status]: "shipped",
      [number]: "113-2222222-2222222",
      [tracking]: "l1",
    });
    judge.when((s) => has(s, "Deals picked"), { [status]: "none", [total]: "none" });
    judge.when((s) => has(s, "sunglasses"), {
      [status]: "ordered",
      [total]: {
        type: "choice",
        choice: "$64.50",
        probabilities: { "$64.50": 0.9, none: 0.1 },
        confidence: 0.9,
      },
      [number]: "113-3333333-3333333",
    });
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

  let draftId = "";

  test("the try asks each Thread once with every question, and the card draws the Blocks from the picks", async () => {
    const before = judge.calls.length;
    const out = await intelligence.agent.tools(workspaceId).call(
      {
        name: "create_view",
        args: {
          sentence:
            "all my Amazon orders with shipped and delivered lanes and total spend per month",
        },
        callId: "c-1",
        sessionId: "s-1",
      },
      { ask: async () => "approved" as const },
    );
    expect(out.isError).toBe(false);
    draftId = (out.activity.preview as { draftId: string }).draftId;
    const draft = await intelligence.views.drafting.drafts.get(draftId);
    expect(draft.doc.id).toBe(VIEW);
    // One request per Thread, and each carries the View's questions together.
    const calls = judge.calls.slice(before);
    expect(calls).toHaveLength(5);
    for (const c of calls) expect(c.questions).toContain(status);
    const confirm = calls.find((c) => JSON.stringify(c.state).includes("$41.97"));
    expect(confirm?.questions).toEqual(expect.arrayContaining([status, total, number]));
    // The link question is asked only where code found a link.
    expect(calls.filter((c) => c.questions.includes(tracking))).toHaveLength(1);

    const t = draft.test;
    const [stat, chart, lanes] = t?.blocks ?? [];
    expect(stat).toMatchObject({ type: "stat", value: "$120.00", change: "up 186%" });
    expect(chart?.items.map((i) => [i.label, i.value])).toEqual([
      ["Sep", "$41.97"],
      ["Oct", "$120.00"],
    ]);
    expect(lanes?.items.map((i) => [i.label, i.count])).toEqual([
      ["Delivered", 1],
      ["Shipped", 1],
      ["Ordered", 0],
      ["Unsure", 0],
    ]);
    // The tried rows carry their values and the buttons they would show.
    const shipped = t?.shown.find((r) => r.subject.startsWith("Shipped"));
    expect(shipped?.values.find((v) => v.extraction === "tracking_link")).toMatchObject({
      state: "value",
      text: "https://track.amazon.com/x2",
    });
    expect(shipped?.actions).toEqual(["Track package"]);
    const lamp = t?.shown.find(
      (r) => r.subject.includes("desk lamp") && r.subject.startsWith("Your"),
    );
    expect(lamp?.values.find((v) => v.extraction === "order_total")).toMatchObject({
      state: "value",
      text: "$120.00",
      candidates: ["$110.00", "$10.00", "$120.00"],
    });
  });

  test("pinned, a new order is read on arrival: the pick stays sealed, the feed says which Thread, the Device reads it", async () => {
    const pinned = await intelligence.views.drafting.pin(draftId);
    expect(pinned.view.id).toBe(VIEW);
    const threadId = await addThread(
      "o3-confirm",
      "Your Amazon.com order of sunglasses",
      "2026-10-14T09:00:00.000Z",
      "Order #113-3333333-3333333\nItem subtotal: $60.00\nTax: $4.50\nOrder total: $64.50",
    );
    await intelligence.signals.ask(workspaceId, threadId, { reason: "arrival" });
    const rows = await db.handle.db.select().from(signalAnswers);
    const own = rows.filter((r) => r.threadId === threadId && r.signalId === total);
    // The answer row says only that one was picked; the span is sealed with the Facts.
    expect(own.map((r) => [r.choice, r.confidence])).toEqual([["picked", 0.9]]);
    const feed = await db.handle.db.select().from(changes);
    expect(feed.some((c) => c.kind === "view_values" && c.entityId === threadId)).toBe(true);
    const app = viewRoutes(intelligence.views);
    const res = await app.request(`/views/${VIEW}/values`);
    const { values } = (await res.json()) as {
      values: Record<string, Record<string, { text: string; value: unknown; confidence: number }>>;
    };
    expect(values[threadId]?.[total]).toEqual({
      text: "$64.50",
      value: { value: 64.5, currency: "USD" },
      confidence: 0.9,
    });
    expect(values[threadId]?.[number]?.value).toBe("113-3333333-3333333");
    const some = await app.request("/views/values", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: workspaceId, threadIds: [threadId] }),
    });
    const body = (await some.json()) as { values: Record<string, unknown> };
    expect(Object.keys(body.values)).toEqual([threadId]);
  });

  test("a checklist mark is kept per Thread version", async () => {
    const view = (await intelligence.views.store.get(VIEW)) as { doc: ViewDoc };
    expect(view.doc.extractions).toHaveLength(3);
    const marked = await intelligence.views.store.setDone(VIEW, "t-any", true, 2);
    expect(marked.done["t-any"]?.messageCount).toBe(2);
    const cleared = await intelligence.views.store.setDone(VIEW, "t-any", false, 2);
    expect(cleared.done).toEqual({});
  });
});
