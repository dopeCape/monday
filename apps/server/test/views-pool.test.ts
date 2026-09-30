// The Threads a View's test tries (docs/spec/views.md, "Making a View",
// step 3): the newest Threads its scope admits across the whole mailbox,
// never the few of them among the newest of everything. A real session
// narrowed "my orders" to five senders over a year and the test found
// almost none of them among the newest 200 Threads; here the orders are
// older than 210 newer newsletters, and every one is still tried.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Account, Person } from "@monday/shared";
import { viewExtractionId } from "@monday/shared";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys } from "../src/crypto/keys.ts";
import { settings as settingsTable } from "../src/db/schema.ts";
import { createIntelligence, type Intelligence } from "../src/intelligence/index.ts";
import { createFakeChat, createFakeJudge } from "../src/intelligence/runtime/fake/index.ts";
import { createMailstore, type Mailstore } from "../src/mailstore/index.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const NOW = new Date("2026-09-30T12:00:00Z");
const owner = { name: "Sam Okafor", email: "sam@monday.test" };
const amazon = { name: "Amazon.in", email: "auto-confirm@amazon.in" };
const myntra = { name: "Myntra", email: "orders@myntra.com" };
const substack = { name: "A newsletter", email: "digest@substack.com" };

/** The order View the Agent wrote in the real session, narrowed to the order senders. */
export const ORDERS_DOC = {
  name: "Orders",
  sentence: "a custom view for orders with a chart of how much I bought per month",
  scope: {
    facts: { from_any: ["auto-confirm@amazon.in"], folder: "any", received: { last_days: 365 } },
    limit: 50,
  },
  signals: [],
  uses: [],
  extractions: [
    {
      id: "total",
      label: "Total",
      find: "money",
      question: "The figure under the word Total: what the whole order cost.",
    },
  ],
  lanes: [],
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
  actions: [],
  nav: { icon: "shopping-bag", count: "total" },
};

describe("The test pool is the newest Threads in scope", () => {
  let db: TestDatabase;
  let store: Mailstore;
  let workspaceId: string;
  const judge = createFakeJudge();
  const chat = createFakeChat();
  let intelligence: Intelligence;
  const ids: Record<string, string> = {};
  const id = (key: string) => ids[key] ?? key;

  const addThread = async (key: string, from: Person, date: string, body: string) => {
    const threadId = await store.upsertThread({
      workspaceId,
      providerThreadId: key,
      subject: key,
      participants: [from, owner],
      lastActivity: date,
    });
    await store.upsertMessage({
      threadId,
      providerMessageId: `m-${key}`,
      from,
      to: [owner],
      cc: [],
      date,
      headers: {},
      bodyText: body,
      bodyHtml: null,
      snippet: body.slice(0, 80),
    });
    ids[key] = threadId;
    return threadId;
  };

  beforeAll(async () => {
    db = await testDatabase();
    const keys = createKeys(db.handle.db);
    await keys.unlock(randomKey());
    store = createMailstore(db.handle.db, keys);
    const account: Account = {
      id: "acct-views-pool",
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
    // A small cap, so "the newest few hundred, then filter" would miss every order below.
    await db.handle.db
      .insert(settingsTable)
      .values({ scope: "global", deviceId: null, key: "views.scope.max_threads", value: 50 });
    for (let i = 1; i <= 4; i++) {
      await addThread(
        `amazon-${i}`,
        amazon,
        `2026-0${i}-10T09:00:00.000Z`,
        `Order placed\n* Something ${i}\n  Quantity: 1\n  ${i}00 INR\n\nTotal\n${i}05 INR`,
      );
    }
    await addThread(
      "myntra-1",
      myntra,
      "2026-05-10T09:00:00.000Z",
      "Your Myntra order\nBlue shirt, size M\nRs. 799\nOrder total: Rs. 799",
    );
    for (let i = 0; i < 210; i++) {
      const day = String(1 + (i % 28)).padStart(2, "0");
      const hour = String(i % 24).padStart(2, "0");
      await addThread(
        `news-${i}`,
        substack,
        `2026-09-${day}T${hour}:00:00.000Z`,
        "This week in reading: three essays.",
      );
    }
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
  }, 240_000);

  afterAll(async () => {
    await db.drop();
  });

  test("orders older than 210 newer newsletters are all tried, and the scope's size is counted in SQL", async () => {
    chat.answer(() => JSON.stringify(ORDERS_DOC));
    const draft = await intelligence.views.drafting.propose(workspaceId, ORDERS_DOC.sentence);
    const amazonIds = [1, 2, 3, 4].map((i) => id(`amazon-${i}`));
    expect([...draft.threadIds].sort()).toEqual([...amazonIds].sort());
    expect(draft.test?.tried).toBe(4);
    expect(draft.test?.inScope).toBe(4);
    expect(draft.test?.widened).toBeNull();
    const total = viewExtractionId(draft.doc.id, "total");
    // Each order was asked its total among the amounts code found in it.
    const asked = judge.calls.filter((c) => c.questions.includes(total));
    expect(asked).toHaveLength(4);
  });

  test("a revision that narrows the scope tries the Threads the new scope admits, not the old ones", async () => {
    // The first draft looked at everything; the newest 30 are all newsletters.
    const broad = { ...ORDERS_DOC, scope: { facts: { folder: "any" }, limit: 50 } };
    chat.answer(() => JSON.stringify(broad));
    const first = await intelligence.views.drafting.propose(workspaceId, ORDERS_DOC.sentence);
    expect(first.threadIds).toHaveLength(30);
    const newsletters = new Set(
      Object.entries(ids)
        .filter(([k]) => k.startsWith("news-"))
        .map(([, v]) => v),
    );
    expect(first.threadIds.every((t) => newsletters.has(t))).toBe(true);
    // Revised to the order senders: the newsletters are dropped and the orders tried.
    const narrow = {
      ...ORDERS_DOC,
      scope: {
        facts: { from_any: ["auto-confirm@amazon.in", "orders@myntra.com"], folder: "any" },
        limit: 50,
      },
    };
    chat.answer(() => JSON.stringify(narrow));
    const revised = await intelligence.views.drafting.revise(first.id, "only my order senders");
    const orders = [1, 2, 3, 4].map((i) => id(`amazon-${i}`)).concat(id("myntra-1"));
    expect([...revised.threadIds].sort()).toEqual([...orders].sort());
    expect(revised.test?.tried).toBe(5);
    expect(revised.test?.inScope).toBe(5);
    expect(revised.test?.pool).toMatchObject({ kept: 0, fresh: 5, skipped: 0 });
    // Revised again with the same scope: the same Threads, kept for comparison.
    const again = await intelligence.views.drafting.revise(first.id);
    expect(again.threadIds).toEqual(revised.threadIds);
    expect(again.test?.pool).toMatchObject({ kept: 5, fresh: 0, skipped: 0 });
  });

  test("where the View lands now reads its scope in SQL too", async () => {
    chat.answer(() => JSON.stringify(ORDERS_DOC));
    const draft = await intelligence.views.drafting.propose(workspaceId, ORDERS_DOC.sentence);
    const placed = await intelligence.views.place(workspaceId, {
      ...draft.doc,
      scope: { ...draft.doc.scope, limit: 3 },
    });
    expect(placed.threads.map((t) => t.id)).toEqual([
      id("amazon-4"),
      id("amazon-3"),
      id("amazon-2"),
    ]);
  });

  test("a View that adds up totals prefers the Threads that hold amounts, and says how many it passed over", async () => {
    await db.handle.db
      .insert(settingsTable)
      .values({ scope: "global", deviceId: null, key: "views.test.scan", value: 250 });
    const broad = { ...ORDERS_DOC, scope: { facts: { folder: "any" }, limit: 50 } };
    chat.answer(() => JSON.stringify(broad));
    const before = judge.calls.length;
    const draft = await intelligence.views.drafting.propose(workspaceId, ORDERS_DOC.sentence);
    const orders = [1, 2, 3, 4].map((i) => id(`amazon-${i}`)).concat(id("myntra-1"));
    // Every order is tried, though all are older than the newsletters; the rest fill the pool.
    for (const o of orders) expect(draft.threadIds).toContain(o);
    expect(draft.threadIds).toHaveLength(30);
    expect(draft.test?.pool).toEqual({ kept: 0, fresh: 30, skipped: 185, scanned: 215 });
    // Looking costs no judge call: only the tried Threads holding an amount are asked, once each.
    expect(judge.calls.length - before).toBe(5);
    await db.handle.db
      .insert(settingsTable)
      .values({ scope: "global", deviceId: null, key: "views.test.prefer_readable", value: false });
    const plain = await intelligence.views.drafting.propose(workspaceId, ORDERS_DOC.sentence);
    for (const o of orders) expect(plain.threadIds).not.toContain(o);
  });

  test("the tool says how each value read over every tried thread, and inspect_view_thread shows why", async () => {
    // A shipping notice from the same sender holds no amount at all.
    await addThread(
      "amazon-ship",
      amazon,
      "2026-04-20T09:00:00.000Z",
      "Your package is on its way. Arriving Thursday.",
    );
    const doc = {
      ...ORDERS_DOC,
      extractions: [
        ...ORDERS_DOC.extractions,
        { id: "item", label: "Item", find: "item", question: "The product that was bought." },
      ],
    };
    chat.answer(() => JSON.stringify(doc));
    const total = viewExtractionId("v_a_custom_view_for", "total");
    const has = (s: unknown, w: string) => JSON.stringify(s).includes(w);
    judge.when((s) => has(s, "Something 1"), { [total]: "105 INR" });
    judge.when((s) => has(s, "Something 2"), { [total]: "none" });
    judge.when((s) => has(s, "Something 3"), {
      [total]: {
        type: "choice",
        choice: "305 INR",
        probabilities: { "300 INR": 0.35, "305 INR": 0.45, none: 0.2 },
        confidence: 0.4,
      },
    });
    judge.when((s) => has(s, "Something 4"), { [total]: "405 INR" });
    const tools = intelligence.agent.tools(workspaceId);
    const ask = { ask: async () => "approved" as const };
    const out = await tools.call(
      { name: "create_view", args: { sentence: doc.sentence }, callId: "c-1", sessionId: "s-1" },
      ask,
    );
    expect(out.isError).toBe(false);
    const draftId = (out.activity.preview as { draftId: string }).draftId;
    const draft = await intelligence.views.drafting.drafts.get(draftId);
    expect(draft.doc.id).toBe("v_a_custom_view_for");
    expect(draft.test?.coverage?.fields.find((f) => f.field === "x:total")).toEqual({
      field: "x:total",
      label: "Total",
      resolved: 2,
      none: 1,
      unsure: 1,
      noCandidates: 1,
      notRead: 0,
      capped: 0,
      examples: ["405 INR", "105 INR"],
    });
    expect(draft.test?.coverage?.senders).toEqual([{ from: "auto-confirm@amazon.in", count: 5 }]);
    expect(out.text).toContain("In scope: 5 threads.");
    expect(out.text).toContain("Tried threads come from: auto-confirm@amazon.in 5.");
    expect(out.text).toContain(
      "Total (x:total, find money): a value on 2 of 5; none of the candidates on 1; below its confidence floor on 1; no candidates found on 1 (code found no money in their text, so nothing was asked).",
    );
    expect(out.text).toContain("Item (x:item, find item): a value on 4 of 5");
    expect(out.text).toContain(`inspect_view_thread with draft_id ${draftId}`);
    expect(out.text).not.toContain("—");

    const inspect = async (threadId: string) =>
      tools.call(
        {
          name: "inspect_view_thread",
          args: { draft_id: draftId, thread_id: threadId },
          callId: `c-inspect-${threadId}`,
          sessionId: "s-1",
        },
        ask,
      );
    const third = await inspect(id("amazon-3"));
    expect(third.isError).toBe(false);
    expect(third.text).toContain("The test tried it.");
    expect(third.text).toContain("Scope: admits it");
    expect(third.text).toContain("started by auto-confirm@amazon.in, in from_any");
    expect(third.text).toContain(
      'Total (x:total, find money): picked "305 INR" at only 40%, below its floor, so Unsure.',
    );
    expect(third.text).toContain('"300 INR" 35%');
    expect(third.text).toContain('"305 INR" 45%');
    expect(third.text).toContain('Item (x:item, find item): picked "Something 3"');
    const ship = await inspect(id("amazon-ship"));
    expect(ship.text).toContain("code found no money in its text, so nothing was asked");
    // A thread the test never tried: what code finds, nothing asked, and why the scope refuses it.
    const calls = judge.calls.length;
    const news = await inspect(id("news-1"));
    expect(news.text).toContain("The test did not try it");
    expect(news.text).toContain("Scope: does not admit it");
    expect(news.text).toContain("started by digest@substack.com, not in from_any");
    expect(judge.calls.length).toBe(calls);
  });

  test("a scope by words in the subject finds them under every newer thread, as a search did", async () => {
    const shop = { name: "Flo", email: "hello@flomattress.com" };
    const add = async (key: string, subject: string, date: string) => {
      const threadId = await store.upsertThread({
        workspaceId,
        providerThreadId: key,
        subject,
        participants: [shop, owner],
        lastActivity: date,
      });
      await store.upsertMessage({
        threadId,
        providerMessageId: `m-${key}`,
        from: shop,
        to: [owner],
        cc: [],
        date,
        headers: {},
        bodyText: "Thanks for your order. Order Total: Rs. 12,000",
        bodyHtml: null,
        snippet: "Thanks for your order.",
      });
      ids[key] = threadId;
    };
    await add("flo-1", "Your Order   Confirmation #FLO-1001", "2026-01-05T09:00:00.000Z");
    await add("flo-2", "Order confirmation: pillow", "2026-01-20T09:00:00.000Z");
    await add("flo-3", "Your order has shipped", "2026-01-25T09:00:00.000Z");
    const doc = {
      ...ORDERS_DOC,
      scope: { facts: { folder: "any", subject_any: ["Order Confirmation"] }, limit: 50 },
    };
    chat.answer(() => JSON.stringify(doc));
    const draft = await intelligence.views.drafting.propose(workspaceId, ORDERS_DOC.sentence);
    expect(draft.doc.scope.facts.subject_any).toEqual(["order confirmation"]);
    expect([...draft.threadIds].sort()).toEqual([id("flo-1"), id("flo-2")].sort());
    expect(draft.test?.inScope).toBe(2);
    const inspected = await intelligence.views.drafting.inspect(draft.id, id("flo-3"));
    expect(inspected.admitted).toBe(false);
    expect(inspected.scope).toContain("the subject holds none of subject_any");
  });
});
