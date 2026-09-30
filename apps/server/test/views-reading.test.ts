// Reading a pinned View (docs/spec/views.md, "Reading a pinned View"): pinned,
// an orders View over archived receipts from months ago reads its whole scope
// in the background, one Thread per request, and ends with every row read; the
// Threads the try already asked are written at Pin view, never asked again; a
// new version asks only the question it changed; pause, resume and stop hold;
// a spent monthly budget stops the walk with its reason; the feed carries
// "N of M" for the View's bar.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Account, JudgeQuestions, JudgeResponse, ViewReadingChange } from "@monday/shared";
import { viewExtractionId } from "@monday/shared";
import { and, asc, eq } from "drizzle-orm";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys } from "../src/crypto/keys.ts";
import { changes, meter, settings as settingsTable, signalAnswers } from "../src/db/schema.ts";
import { createIntelligence, type Intelligence } from "../src/intelligence/index.ts";
import { createFakeChat, createFakeJudge } from "../src/intelligence/runtime/fake/index.ts";
import type { JudgeCall, JudgeModel } from "../src/intelligence/runtime/index.ts";
import { VIEW_BACKFILL_STEP } from "../src/intelligence/views/backfill.ts";
import { createJobs, type Jobs } from "../src/jobs/index.ts";
import { createMailstore, type Mailstore } from "../src/mailstore/index.ts";
import { viewRoutes } from "../src/routes/views.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const NOW = new Date("2026-09-30T12:00:00Z");
const owner = { name: "Sam Okafor", email: "sam@monday.test" };
const amazon = { name: "Amazon.in", email: "auto-confirm@amazon.in" };
const VIEW = "v_my_orders_by_month";
const total = viewExtractionId(VIEW, "total");
const number = viewExtractionId(VIEW, "order_number");

const DOC = {
  name: "Orders",
  sentence: "my orders by month",
  scope: {
    facts: { from_any: [amazon.email], folder: "any", received: { last_days: 365 } },
    limit: 500,
  },
  extractions: [
    { id: "total", label: "Total", find: "money", question: "The total of the whole order." },
    {
      id: "order_number",
      label: "Order",
      find: "reference",
      question: "The order number this message is about.",
    },
  ],
  blocks: [
    {
      id: "per_month",
      type: "chart",
      chart: "bar",
      query: {
        group_by: { field: "received_at", bucket: "month" },
        aggregate: { op: "sum", field: "x:total" },
      },
    },
  ],
  nav: { icon: "shopping-bag", count: "total" },
};

describe("a pinned View reads its own scope", () => {
  let db: TestDatabase;
  let store: Mailstore;
  let jobs: Jobs;
  let workspaceId: string;
  const fake = createFakeJudge();
  const chat = createFakeChat();
  /** Each request: the receipt it was about and the questions it carried. */
  const requests: Array<{ receipt: string; questions: string[] }> = [];
  const judge: JudgeModel = async <Q extends JudgeQuestions>(
    call: JudgeCall<Q>,
  ): Promise<JudgeResponse<Q>> => {
    const m = /Receipt (\d+)/.exec(JSON.stringify(call.state));
    requests.push({ receipt: m?.[1] ?? "?", questions: Object.keys(call.questions) });
    return fake.judge(call);
  };
  let intelligence: Intelligence;
  const receipts: string[] = [];

  const setSetting = async (key: string, value: unknown) => {
    await db.handle.db
      .insert(settingsTable)
      .values({ scope: "global", deviceId: null, key, value })
      .onConflictDoUpdate({
        target: [settingsTable.scope, settingsTable.deviceId, settingsTable.key],
        set: { value },
      });
  };
  const runDue = async () => {
    const ran: Record<string, number> = {};
    for (let i = 0; i < 300; i++) {
      const job = await jobs.claim("server-a", ["needs-process"], 30_000);
      if (!job) return ran;
      await jobs.run(job, 30_000);
      ran[job.class] = (ran[job.class] ?? 0) + 1;
    }
    throw new Error("jobs did not settle");
  };
  const readingFeed = () =>
    db.handle.db
      .select()
      .from(changes)
      .where(eq(changes.kind, "view_reading"))
      .orderBy(asc(changes.seq));
  const ownAsked = () =>
    requests.filter((r) => r.questions.some((q) => q === total || q === number));
  const answered = async (signalId: string) =>
    (
      await db.handle.db
        .select({ threadId: signalAnswers.threadId })
        .from(signalAnswers)
        .where(
          and(eq(signalAnswers.workspaceId, workspaceId), eq(signalAnswers.signalId, signalId)),
        )
    ).map((r) => r.threadId);

  beforeAll(async () => {
    db = await testDatabase();
    const keys = createKeys(db.handle.db);
    await keys.unlock(randomKey());
    store = createMailstore(db.handle.db, keys);
    jobs = createJobs(db.handle.db, { now: () => NOW });
    const account: Account = {
      id: "acct-views-reading",
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
    await setSetting("calendar.time_zone", "UTC");
    await setSetting("views.test.pool", 5);
    await setSetting("views.backfill.page_size", 3);
    await setSetting("signals.budget.background_monthly_usd", 3);
    // Eight receipts over the past year, every one archived, and one older than the scope.
    for (let i = 1; i <= 9; i++) {
      const date = new Date(NOW.getTime() - (i === 9 ? 400 : i * 40) * 86_400_000).toISOString();
      const threadId = await store.upsertThread({
        workspaceId,
        providerThreadId: `r${i}`,
        subject: `Your order ${i}`,
        participants: [amazon, owner],
        lastActivity: date,
        archived: true,
      });
      await store.upsertMessage({
        threadId,
        providerMessageId: `m-r${i}`,
        from: amazon,
        to: [owner],
        cc: [],
        date,
        headers: {},
        bodyText: `Receipt ${i}\nOrder #408-000000${i}-1234567\nItem ${i}00 INR\nTotal ${i}05 INR`,
        bodyHtml: null,
        snippet: `Receipt ${i}`,
      });
      receipts.push(threadId);
      fake.when((s) => JSON.stringify(s).includes(`Receipt ${i}\\n`), {
        [total]: `${i}05 INR`,
        [number]: `408-000000${i}-1234567`,
      });
    }
    intelligence = createIntelligence({
      level: async () => "automate",
      db: db.handle.db,
      mailstore: store,
      chat: chat.chat,
      judge,
      keys: async (provider) =>
        provider === "typesafe" ? "ts-key" : provider === "anthropic" ? "sk-ant-fake" : null,
      now: () => NOW,
    });
    intelligence.registerSteps(jobs);
    // The shipped Signals exist before any View, as in a mailbox monday has read.
    await intelligence.signals.defs(workspaceId);
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  });

  test("pinned, it reads every archived receipt in its scope; the tried ones are never asked again", async () => {
    chat.answer(() => JSON.stringify(DOC));
    const draft = await intelligence.views.drafting.propose(workspaceId, DOC.sentence);
    expect(draft.doc.id).toBe(VIEW);
    expect(draft.threadIds).toHaveLength(5);
    const tried = new Set(draft.threadIds);
    requests.length = 0;
    await intelligence.views.drafting.pin(draft.id);
    // Pin view wrote what the try answered: no request, every tried Thread answered.
    expect(ownAsked()).toHaveLength(0);
    expect((await answered(total)).sort()).toEqual([...tried].sort());
    const before = await intelligence.views.reading.status(VIEW);
    expect(before).toMatchObject({ status: "running", done: 0, total: 8 });
    expect(await runDue()).toMatchObject({ [VIEW_BACKFILL_STEP]: 1 });
    // Only the three the try did not reach were asked, one Thread per request.
    const walk = ownAsked();
    expect(walk).toHaveLength(3);
    expect(walk.every((r) => !tried.has(receipts[Number(r.receipt) - 1] ?? ""))).toBe(true);
    expect(walk.map((r) => r.receipt).sort()).toEqual(["6", "7", "8"]);
    expect(await intelligence.views.reading.status(VIEW)).toMatchObject({
      status: "done",
      done: 8,
      total: 8,
    });
    // Every row of the View is read; the receipt older than a year is not in scope.
    expect((await answered(total)).length).toBe(8);
    expect(await answered(total)).not.toContain(receipts[8]);
    const res = await viewRoutes(intelligence.views).request(`/views/${VIEW}/values`);
    const { values } = (await res.json()) as {
      values: Record<string, Record<string, { text: string }>>;
    };
    expect(receipts.slice(0, 8).map((id) => values[id]?.[total]?.text)).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8].map((i) => `${i}05 INR`),
    );
    // The feed told the Device how far it had read, ending at 8 of 8.
    const feed = await readingFeed();
    const last = feed.at(-1)?.payload as ViewReadingChange | undefined;
    expect(last).toEqual({ viewId: VIEW, status: "done", reason: null, done: 8, total: 8 });
    expect(feed.some((c) => (c.payload as ViewReadingChange).done === 3)).toBe(true);
    const route = await viewRoutes(intelligence.views).request(`/views/${VIEW}/reading`);
    expect(((await route.json()) as { reading: { done: number } }).reading.done).toBe(8);
  });

  test("a new version asks only the question it changed", async () => {
    chat.answer(() =>
      JSON.stringify({
        ...DOC,
        extractions: [
          {
            id: "total",
            label: "Total",
            find: "money",
            question: "What the whole order cost, beside the word Total.",
          },
          DOC.extractions[1],
        ],
      }),
    );
    const proposal = await intelligence.views.drafting.proposeUpdate(VIEW, {
      instruction: "read the total beside the word Total",
    });
    expect(proposal.kind).toBe("draft");
    if (proposal.kind !== "draft") return;
    requests.length = 0;
    await intelligence.views.drafting.apply(proposal.draft.id);
    expect(ownAsked()).toHaveLength(0);
    expect(await intelligence.views.reading.status(VIEW)).toMatchObject({
      status: "running",
      signals: [total],
      total: 8,
    });
    await runDue();
    const walk = ownAsked();
    // The five the edit's try asked are written; the other three are asked the total only.
    expect(walk).toHaveLength(3);
    expect(walk.every((r) => r.questions.join() === total)).toBe(true);
    expect(await intelligence.views.reading.status(VIEW)).toMatchObject({ status: "done" });
  });

  test("pause holds its place, resume finishes, stop ends it", async () => {
    await intelligence.signals.forget(workspaceId, number);
    await intelligence.views.reading.request(workspaceId, VIEW, [number]);
    await intelligence.views.reading.pause(VIEW);
    requests.length = 0;
    await runDue();
    expect(ownAsked()).toHaveLength(0);
    expect(await intelligence.views.reading.status(VIEW)).toMatchObject({
      status: "paused",
      done: 0,
    });
    await viewRoutes(intelligence.views).request(`/views/${VIEW}/reading/resume`, {
      method: "POST",
    });
    await runDue();
    expect(ownAsked()).toHaveLength(8);
    expect(ownAsked().every((r) => r.questions.join() === number)).toBe(true);
    expect(await intelligence.views.reading.status(VIEW)).toMatchObject({
      status: "done",
      done: 8,
    });
    await intelligence.signals.forget(workspaceId, number);
    await intelligence.views.reading.request(workspaceId, VIEW, [number]);
    await viewRoutes(intelligence.views).request(`/views/${VIEW}/reading/stop`, { method: "POST" });
    requests.length = 0;
    await runDue();
    expect(ownAsked()).toHaveLength(0);
    expect(await intelligence.views.reading.status(VIEW)).toMatchObject({ status: "cancelled" });
  });

  test("a spent monthly budget stops the reading with its reason", async () => {
    await db.handle.db.insert(meter).values({
      id: crypto.randomUUID(),
      workspaceId,
      task: "judge.backfill",
      provider: "typesafe",
      model: "jev-1.13.0",
      inputTokens: 1,
      outputTokens: 0,
      cachedTokens: 0,
      costMicros: 3_000_000,
      durationMs: 1,
      jobId: null,
      createdAt: NOW,
    });
    await intelligence.views.reading.request(workspaceId, VIEW, [number]);
    requests.length = 0;
    await runDue();
    expect(ownAsked()).toHaveLength(0);
    expect(await intelligence.views.reading.status(VIEW)).toMatchObject({
      status: "waiting",
      reason: "budget",
      done: 0,
    });
    const feed = await readingFeed();
    expect((feed.at(-1)?.payload as ViewReadingChange).reason).toBe("budget");
  });
});
