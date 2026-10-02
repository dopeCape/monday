// A View whose scope is a full search (docs/spec/views.md, "Scope by a
// search"): the words are only inside three old, archived Threads, under
// twenty-five newer newsletters, and their subjects say nothing. The try finds
// them through the full search and counts them (a floor past
// views.query.count_max); inspect_view_thread says what the search matched;
// pinned, the walk finds the members (ids only, on the feed and the members
// route) and asks them its questions; an arriving Thread joins, and a new
// Message that the search now refuses takes it out; the Signal request asks a
// View's question only of its members; a locked Server waits.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
  Account,
  JudgeQuestions,
  JudgeResponse,
  ViewMembersChange,
  ViewPreview,
  ViewReadingChange,
} from "@monday/shared";
import { viewExtractionId } from "@monday/shared";
import { and, asc, eq } from "drizzle-orm";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys, type Keys } from "../src/crypto/keys.ts";
import {
  changes,
  settings as settingsTable,
  signalAnswers,
  viewMembers,
} from "../src/db/schema.ts";
import { createIntelligence, type Intelligence } from "../src/intelligence/index.ts";
import { createFakeChat, createFakeJudge } from "../src/intelligence/runtime/fake/index.ts";
import type { JudgeCall, JudgeModel } from "../src/intelligence/runtime/index.ts";
import { VIEW_MEMBERS_STEP } from "../src/intelligence/views/members.ts";
import { createJobs, type Jobs } from "../src/jobs/index.ts";
import { createMailstore, type Mailstore } from "../src/mailstore/index.ts";
import { viewRoutes } from "../src/routes/views.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const NOW = new Date("2026-09-30T12:00:00Z");
const owner = { name: "Sam Okafor", email: "sam@monday.test" };
const shop = { name: "Shop Support", email: "support@shop.test" };
const paper = { name: "The Paper", email: "news@paper.test" };
const VIEW = "v_my_refunds";
const amount = viewExtractionId(VIEW, "amount");
const QUERY = '"refund approved" -cancelled';

const DOC = {
  name: "Refunds",
  sentence: "my refunds",
  scope: { facts: { query: QUERY, folder: "any" }, limit: 500 },
  extractions: [{ id: "amount", label: "Amount", find: "money", question: "The amount refunded." }],
  blocks: [
    {
      id: "refunds",
      type: "table",
      columns: [
        { label: "Refund", field: "subject" },
        { label: "Amount", field: "x:amount", format: "money" },
      ],
    },
  ],
  nav: { icon: "receipt", count: "total" },
};

describe("a View whose scope is a full search", () => {
  let db: TestDatabase;
  let store: Mailstore;
  let keys: Keys;
  let jobs: Jobs;
  let workspaceId: string;
  const fake = createFakeJudge();
  const chat = createFakeChat();
  const requests: Array<{ text: string; questions: string[] }> = [];
  const judge: JudgeModel = async <Q extends JudgeQuestions>(
    call: JudgeCall<Q>,
  ): Promise<JudgeResponse<Q>> => {
    requests.push({ text: JSON.stringify(call.state), questions: Object.keys(call.questions) });
    return fake.judge(call);
  };
  let intelligence: Intelligence;
  const refunds: string[] = [];
  let processing = "";
  let cancelled = "";
  const news: string[] = [];
  const root = randomKey();

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
  const add = async (
    key: string,
    from: typeof shop,
    subject: string,
    body: string,
    daysAgo: number,
    archived: boolean,
  ) => {
    const date = new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();
    const threadId = await store.upsertThread({
      workspaceId,
      providerThreadId: key,
      subject,
      participants: [from, owner],
      lastActivity: date,
      archived,
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
      snippet: body.slice(0, 40),
    });
    return threadId;
  };
  const membersOf = async () =>
    (
      await db.handle.db
        .select({ threadId: viewMembers.threadId })
        .from(viewMembers)
        .where(eq(viewMembers.viewId, VIEW))
    )
      .map((r) => r.threadId)
      .sort();
  const membersFeed = async () =>
    (
      await db.handle.db
        .select()
        .from(changes)
        .where(eq(changes.kind, "view_members"))
        .orderBy(asc(changes.seq))
    ).map((c) => c.payload as ViewMembersChange);
  const answered = async (signalId: string) =>
    (
      await db.handle.db
        .select({ threadId: signalAnswers.threadId })
        .from(signalAnswers)
        .where(
          and(eq(signalAnswers.workspaceId, workspaceId), eq(signalAnswers.signalId, signalId)),
        )
    )
      .map((r) => r.threadId)
      .sort();

  beforeAll(async () => {
    db = await testDatabase();
    keys = createKeys(db.handle.db);
    await keys.unlock(root);
    store = createMailstore(db.handle.db, keys);
    jobs = createJobs(db.handle.db, { now: () => NOW });
    const account: Account = {
      id: "acct-views-query",
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
    await setSetting("views.query.page_size", 10);
    // Three refunds months old, archived; their subjects never say "refund".
    for (let i = 1; i <= 3; i++) {
      refunds.push(
        await add(
          `refund-${i}`,
          shop,
          `Update on your request #${i}`,
          `Hello Sam,\nGood news: your refund approved today.\nAmount 4${i}.00 INR back to your card.`,
          90 + i * 10,
          true,
        ),
      );
      fake.when((s) => JSON.stringify(s).includes(`Amount 4${i}.00 INR`), {
        [amount]: `4${i}.00 INR`,
      });
    }
    processing = await add(
      "processing",
      shop,
      "Update on your request #4",
      "Hello Sam,\nYour request is still processing.",
      80,
      true,
    );
    cancelled = await add(
      "cancelled",
      shop,
      "Update on your request #5",
      "Your refund approved earlier was cancelled after review. Amount 50.00 INR.",
      85,
      true,
    );
    // Twenty-five newer newsletters, all in the inbox.
    for (let i = 1; i <= 25; i++) {
      news.push(
        await add(
          `news-${i}`,
          paper,
          `The Paper, issue ${i}`,
          `Weekly digest number ${i}.`,
          i,
          false,
        ),
      );
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
    await intelligence.signals.defs(workspaceId);
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  });

  test("the try finds Threads matched only in their bodies, older than every newer one", async () => {
    chat.answer(() => JSON.stringify(DOC));
    requests.length = 0;
    const tools = intelligence.agent.tools(workspaceId);
    const out = await tools.call(
      { name: "create_view", args: { sentence: DOC.sentence }, callId: "c-1", sessionId: "s-1" },
      { ask: async () => "approved" as const },
    );
    expect(out.isError).toBe(false);
    const preview = out.activity.preview as ViewPreview;
    const draft = preview.draft;
    expect(draft?.doc.id).toBe(VIEW);
    expect([...(draft?.threadIds ?? [])].sort()).toEqual([...refunds].sort());
    expect(draft?.test?.inScope).toBe(3);
    expect(draft?.test?.inScopeAtLeast).toBeUndefined();
    expect(draft?.test?.pool).toMatchObject({ query: true, fresh: 3 });
    // One request per tried Thread, none for a newsletter or the cancelled refund.
    expect(requests).toHaveLength(3);
    expect(out.text).toContain("In scope: 3 threads its search matched");
    // Counted past views.query.count_max, the count is a floor.
    await setSetting("views.query.count_max", 10);
    const many = await intelligence.views.drafting.propose(workspaceId, DOC.sentence);
    expect(many.test?.inScope).toBe(3);
    chat.answer(() =>
      JSON.stringify({ ...DOC, scope: { facts: { query: "digest", folder: "any" }, limit: 500 } }),
    );
    const digest = await intelligence.views.drafting.propose(workspaceId, "the digests");
    expect(digest.test?.inScope).toBe(10);
    expect(digest.test?.inScopeAtLeast).toBe(true);
    await db.handle.db.delete(settingsTable).where(eq(settingsTable.key, "views.query.count_max"));
  });

  test("a query that cannot be a scope fails validation with the reason", async () => {
    const bad = {
      ...DOC,
      scope: { facts: { query: "is:unread refund older_than:7d", folder: "any" }, limit: 500 },
    };
    // The first answer is refused with its reasons; the retry with a plain query validates.
    chat.answer((call) =>
      JSON.stringify(call).includes("did not validate") ? JSON.stringify(DOC) : JSON.stringify(bad),
    );
    const from = chat.calls.length;
    const draft = await intelligence.views.drafting.propose(workspaceId, DOC.sentence);
    expect(draft.doc.scope.facts.query).toBe(QUERY);
    const retry = JSON.stringify(chat.calls.slice(from));
    expect(retry).toContain("dates go in the scope's received or active");
    expect(retry).toContain("is:, in:, tag: and label: change as mail is read and filed");
  });

  test("inspect_view_thread says what the search matched", async () => {
    chat.answer(() => JSON.stringify(DOC));
    const draft = await intelligence.views.drafting.propose(workspaceId, DOC.sentence);
    const first = await intelligence.views.drafting.inspect(draft.id, refunds[0] ?? "");
    expect(first.admitted).toBe(true);
    expect(first.scope.join("; ")).toContain(
      `the search "${QUERY}" matches it: refund approved in a message's text`,
    );
    const no = await intelligence.views.drafting.inspect(draft.id, cancelled);
    expect(no.admitted).toBe(false);
    expect(no.scope.join("; ")).toContain(`the search "${QUERY}" does not match it`);
  });

  test("pinned, the walk finds the members, ids only, and asks them its questions", async () => {
    chat.answer(() => JSON.stringify(DOC));
    const draft = await intelligence.views.drafting.propose(workspaceId, DOC.sentence);
    requests.length = 0;
    await intelligence.views.drafting.pin(draft.id);
    const ran = await runDue();
    expect(ran).toMatchObject({ "views-backfill": expect.any(Number) });
    expect(await membersOf()).toEqual([...refunds].sort());
    const reading = await intelligence.views.reading.status(VIEW);
    expect(reading).toMatchObject({ status: "done", phase: "read", found: 3 });
    // The feed carried a reset and the members, ids only.
    const feed = await membersFeed();
    expect(feed[0]).toMatchObject({ viewId: VIEW, reset: true });
    expect(feed.flatMap((c) => c.added).sort()).toEqual([...refunds].sort());
    expect(JSON.stringify(feed)).not.toContain("refund approved");
    const res = await viewRoutes(intelligence.views).request(`/views/${VIEW}/members`);
    expect(((await res.json()) as { threadIds: string[] }).threadIds.sort()).toEqual(
      [...refunds].sort(),
    );
    // Every member has its amount; no newsletter was asked.
    expect(await answered(amount)).toEqual([...refunds].sort());
    expect(requests.every((r) => !r.text.includes("Weekly digest"))).toBe(true);
    // Where the View lands now on the Server reads its members.
    const placed = await intelligence.views.place(
      workspaceId,
      (await intelligence.views.store.get(VIEW))?.doc ?? draft.doc,
    );
    expect(placed.threads.map((t) => t.id).sort()).toEqual([...refunds].sort());
  });

  test("an arriving Thread joins, and one a new Message takes out of the search leaves", async () => {
    const fresh = await add(
      "refund-new",
      shop,
      "Update on your request #9",
      "Good news: your refund approved. Amount 99.00 INR.",
      1,
      false,
    );
    fake.when((s) => JSON.stringify(s).includes("Amount 99.00 INR"), { [amount]: "99.00 INR" });
    await intelligence.views.threadReady(workspaceId, fresh);
    expect(await runDue()).toMatchObject({ [VIEW_MEMBERS_STEP]: 1 });
    expect(await membersOf()).toContain(fresh);
    expect((await membersFeed()).at(-1)).toEqual({ viewId: VIEW, added: [fresh], removed: [] });
    // A newsletter is not a member, and costs no feed row.
    const before = (await membersFeed()).length;
    await intelligence.views.threadReady(workspaceId, news[0] ?? "");
    await runDue();
    expect((await membersFeed()).length).toBe(before);
    // A reply cancels it: the search no longer matches.
    await store.upsertMessage({
      threadId: fresh,
      providerMessageId: "m-refund-new-2",
      from: shop,
      to: [owner],
      cc: [],
      date: new Date(NOW.getTime() - 3_600_000).toISOString(),
      headers: {},
      bodyText: "Sorry, that refund was cancelled.",
      bodyHtml: null,
      snippet: "Sorry",
    });
    await intelligence.views.threadReady(workspaceId, fresh);
    await runDue();
    expect(await membersOf()).not.toContain(fresh);
    expect((await membersFeed()).at(-1)).toEqual({ viewId: VIEW, added: [], removed: [fresh] });
  });

  test("the Signal request asks a View's question only of its members, matching a new one there", async () => {
    const arriving = await add(
      "refund-arrival",
      shop,
      "Update on your request #10",
      "Your refund approved. Amount 10.00 INR.",
      0,
      false,
    );
    fake.when((s) => JSON.stringify(s).includes("Amount 10.00 INR"), { [amount]: "10.00 INR" });
    requests.length = 0;
    await intelligence.signals.ask(workspaceId, arriving, { reason: "arrival" });
    expect(requests.some((r) => r.questions.includes(amount))).toBe(true);
    expect(await membersOf()).toContain(arriving);
    requests.length = 0;
    await intelligence.signals.ask(workspaceId, processing, { reason: "arrival", force: true });
    expect(requests.some((r) => r.questions.includes(amount))).toBe(false);
  });

  test("a new query finds its members again; a locked Server waits", async () => {
    const view = await intelligence.views.store.get(VIEW);
    if (!view) throw new Error("no view");
    await intelligence.views.store.update(VIEW, {
      ...view.doc,
      scope: { ...view.doc.scope, facts: { ...view.doc.scope.facts, query: '"still processing"' } },
    });
    await intelligence.views.changed(workspaceId);
    // The old members went at once; the Device heard the reset.
    expect(await membersOf()).toEqual([]);
    expect((await membersFeed()).at(-1)).toMatchObject({ reset: true });
    keys.lock();
    await runDue();
    const waiting = (await intelligence.views.reading.status(VIEW)) as ViewReadingChange;
    expect(waiting).toMatchObject({ status: "waiting", reason: "locked", phase: "search" });
    await keys.unlock(root);
    await intelligence.views.reading.resume(VIEW);
    await runDue();
    expect(await membersOf()).toEqual([processing]);
    expect(await intelligence.views.reading.status(VIEW)).toMatchObject({
      status: "done",
      found: 1,
    });
  });
});
