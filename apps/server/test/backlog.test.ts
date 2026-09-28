// The Backlog sort and scoped re-runs (CONTEXT.md "Sort scope", "Backlog
// sort"; docs/spec/routing.md): a re-run over each kind of scope picks the
// right Threads; a scope above routing.rerun.preview_max previews a sample
// and Apply starts the background Job; the Job batches at the configured
// size (a fake TypeSafe counting requests and questions), resumes after a
// restart, stops at a count scope's limit, leaves user-placed Threads alone,
// takes Threads that land in scope while it runs, and waits cleanly when
// nothing can sort; the language model path asks a few Threads per prompt;
// the Group proposal moves its sample on approval and queues the rest, and
// its Undo stops the background sorting.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
  Account,
  ApprovalDecision,
  ChoiceQuestion,
  JudgeAnswer,
  JudgeQuestions,
  JudgeResponse,
  RoutingBacklog,
  RoutingPreview,
  ToolPreview,
} from "@monday/shared";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, createApp } from "../src/app.ts";
import { createAuth } from "../src/auth/index.ts";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys, type Keys } from "../src/crypto/keys.ts";
import { settings as settingsTable, syncState, threads } from "../src/db/schema.ts";
import { BACKLOG_STEP, createIntelligence, type Intelligence } from "../src/intelligence/index.ts";
import {
  classifyBatchPrompt,
  estimateTokens,
  packBatches,
  parseClassifyBatchOutput,
  routeBatchQuestions,
} from "../src/intelligence/routing/batch.ts";
import { createFakeChat } from "../src/intelligence/runtime/fake/index.ts";
import type { ChatCall, JudgeCall, JudgeModel } from "../src/intelligence/runtime/index.ts";
import { createJobs, type Jobs } from "../src/jobs/index.ts";
import { createMailstore, type Mailstore } from "../src/mailstore/index.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const SIDECAR_TOKEN = "backlog-token";
const NOW = new Date("2026-09-16T12:00:00Z");
const DAY = 86_400_000;
const owner = { name: "Sam Rivera", email: "sam@monday.test" };

const account = (id: string): Account => ({
  id,
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
});

/** A TypeSafe stand-in: invoices go to Finance, the rest to none; every request is recorded. */
function countingJudge() {
  const requests: Array<{ questions: number; subjects: string[] }> = [];
  const judge: JudgeModel = async <Q extends JudgeQuestions>(call: JudgeCall<Q>) => {
    const state = call.state as {
      threads?: Record<string, { subject: string }>;
      thread?: { subject: string };
    };
    const subjects: string[] = [];
    const answers: Record<string, JudgeAnswer> = {};
    for (const [id, q] of Object.entries(call.questions)) {
      const question = q as ChoiceQuestion;
      const subject = state.threads?.[id]?.subject ?? state.thread?.subject ?? "";
      subjects.push(subject);
      const names = Object.keys(question.criteria);
      const pick = /invoice/i.test(subject) && names.includes("finance") ? "finance" : "none";
      answers[id] = {
        type: "choice",
        choice: pick,
        probabilities: Object.fromEntries(
          names.map((n) => [n, n === pick ? 0.95 : 0.05 / names.length]),
        ),
        confidence: 0.93,
      };
    }
    requests.push({ questions: Object.keys(call.questions).length, subjects });
    return {
      answers: answers as JudgeResponse<Q>["answers"],
      model: "jev-1.13.0",
      usage: { inputTokens: estimateTokens(call.state) },
    };
  };
  return { judge, requests };
}

function approver(...answers: ApprovalDecision[]) {
  const asked: ToolPreview[] = [];
  return {
    asked,
    ask: async (_row: unknown, preview: ToolPreview) => {
      asked.push(preview);
      const next = answers.shift();
      if (!next) throw new Error("asked more than scripted");
      return next;
    },
  };
}

describe("the Backlog sort", () => {
  let db: TestDatabase;
  let keys: Keys;
  let store: Mailstore;
  let clock = NOW.getTime();
  const now = () => new Date(clock);
  let jobs: Jobs;
  const counting = countingJudge();
  let intelligence: Intelligence;
  let app: Hono<AppEnv>;
  let calls = 0;

  const setSetting = async (key: string, value: unknown) => {
    await db.handle.db
      .insert(settingsTable)
      .values({ scope: "global", deviceId: null, key, value })
      .onConflictDoUpdate({
        target: [settingsTable.scope, settingsTable.deviceId, settingsTable.key],
        set: { value },
      });
  };

  const send = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json", authorization: `Bearer ${SIDECAR_TOKEN}` },
    });

  /** A Workspace with `n` Threads, one every `every` days back from NOW; every third an invoice. */
  const seed = async (id: string, n: number, every = 5) => {
    const workspaceId = (await store.createWorkspace(account(id))).id;
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      ids.push(
        await addThread(
          workspaceId,
          `${id}-${i}`,
          i % 3 === 0 ? `Invoice ${i}` : `Note ${i}`,
          new Date(NOW.getTime() - i * every * DAY - 60_000),
        ),
      );
    }
    return { workspaceId, ids };
  };
  const addThread = async (workspaceId: string, key: string, subject: string, at: Date) => {
    const from = { name: "Billing", email: `billing-${key}@vendor.test` };
    const threadId = await store.upsertThread({
      workspaceId,
      providerThreadId: `t-${key}`,
      subject,
      participants: [from, owner],
      lastActivity: at.toISOString(),
    });
    await store.upsertMessage({
      threadId,
      providerMessageId: `m-${key}`,
      from,
      to: [owner],
      cc: [],
      date: at.toISOString(),
      headers: {},
      bodyText: `About ${subject}.`,
      bodyHtml: null,
      snippet: `About ${subject}.`,
    });
    return threadId;
  };

  /** Runs every Job that is due, like a Server would, and counts them by class. */
  const runDue = async (max = 500): Promise<Record<string, number>> => {
    const ran: Record<string, number> = {};
    for (let i = 0; i < max; i++) {
      const job = await jobs.claim("server-a", ["needs-process"], 30_000);
      if (!job) return ran;
      await jobs.run(job, 30_000);
      ran[job.class] = (ran[job.class] ?? 0) + 1;
    }
    throw new Error("jobs did not settle");
  };
  const status = async (workspaceId: string) =>
    (await intelligence.backlog.status(workspaceId)) as RoutingBacklog;
  const groupOf = async (threadId: string) =>
    (await db.handle.db.query.threads.findFirst({ where: eq(threads.id, threadId) }))?.groupId ??
    null;

  const makeIntelligence = (
    options: {
      judge?: JudgeModel;
      keys?: Record<string, string>;
      chat?: ReturnType<typeof createFakeChat>;
    } = {},
  ) => {
    const shared: Record<string, string> = options.keys ?? { typesafe: "ts-shared" };
    return createIntelligence({
      level: async () => "automate",
      db: db.handle.db,
      mailstore: store,
      chat: (options.chat ?? createFakeChat("{}")).chat,
      judge: options.judge ?? counting.judge,
      keys: async (provider) => shared[provider] ?? null,
      now,
    });
  };

  beforeAll(async () => {
    db = await testDatabase();
    keys = createKeys(db.handle.db);
    await keys.unlock(randomKey());
    store = createMailstore(db.handle.db, keys);
    jobs = createJobs(db.handle.db, { now });
    intelligence = makeIntelligence();
    intelligence.registerSteps(jobs);
    const auth = createAuth({ db: db.handle.db, sidecarToken: SIDECAR_TOKEN });
    app = createApp({
      db: db.handle.db,
      auth,
      mode: "sidecar",
      keys,
      mailstore: store,
      jobs,
      intelligence,
      remoteAddress: () => "127.0.0.1",
    });
    // Small batches, so a few dozen Threads make several requests.
    await setSetting("routing.backfill.batch_size", 4);
    await setSetting("routing.backfill.concurrency", 2);
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  });

  test("packs a batch under the count and both token budgets, and parses a prompt's tables", () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    expect(
      packBatches(items, 0, () => ({ state: 10, question: 5 }), {
        count: 4,
        requestTokens: 10_000,
        stateTokens: 10_000,
      }).map((b) => b.length),
    ).toEqual([4, 4, 2]);
    // The state budget (state plus the longest question) cuts first here.
    expect(
      packBatches(items, 20, () => ({ state: 10, question: 5 }), {
        count: 100,
        requestTokens: 10_000,
        stateTokens: 55,
      }).map((b) => b.length),
    ).toEqual([3, 3, 3, 1]);
    // The request budget (state plus every question).
    expect(
      packBatches(items, 0, () => ({ state: 10, question: 10 }), {
        count: 100,
        requestTokens: 60,
        stateTokens: 10_000,
      }).map((b) => b.length),
    ).toEqual([3, 3, 3, 1]);
    // One item too large for any batch still goes, alone.
    expect(
      packBatches([1, 2], 0, () => ({ state: 500, question: 1 }), {
        count: 10,
        requestTokens: 100,
        stateTokens: 100,
      }),
    ).toEqual([[1], [2]]);

    const facts = (subject: string) => ({
      subject,
      from: { name: "A", email: "a@x.test" },
      to: [owner],
      participants: [],
      headers: {},
      snippet: "hello",
      hasAttachments: false,
      messageCount: 1,
    });
    const group = {
      id: "g1",
      name: "Finance",
      sentence: "Invoices",
      prompt: "",
      predicate: {},
      examples: [],
    };
    const batch = routeBatchQuestions(
      [
        { key: "t1", facts: facts("Invoice 1") },
        { key: "t2", facts: facts("Lunch") },
      ],
      [group],
      owner.email,
      { instructions: "Which Group?", noneOption: "None", snippetChars: 100, examplesInPrompt: 3 },
    );
    expect(Object.keys(batch.questions)).toEqual(["t1", "t2"]);
    expect(batch.options).toEqual({ finance: "g1" });
    expect(JSON.stringify(batch.questions.t2?.instructions)).toContain("`threads.t2`");
    expect(
      (batch.state as { threads: Record<string, { subject: string }> }).threads.t1?.subject,
    ).toBe("Invoice 1");
    const prompt = classifyBatchPrompt(
      [
        { key: "t1", facts: facts("Invoice 1") },
        { key: "t2", facts: facts("Lunch") },
      ],
      [group],
      { snippetChars: 100, examplesInPrompt: 3 },
    );
    expect(prompt.threads).toEqual({ T1: "t1", T2: "t2" });
    const parsed = parseClassifyBatchOutput('{"T1": {"G1": 0.9}}', prompt.labels, prompt.threads);
    expect(parsed.get("t1")).toEqual([{ groupId: "g1", confidence: 0.9 }]);
    expect(parsed.has("t2")).toBe(false);
  });

  test("a re-run over each kind of scope scores the right Threads", async () => {
    const { workspaceId } = await seed("scopes", 30);
    await intelligence.routing.createGroup(workspaceId, { name: "Finance", sentence: "Invoices" });
    const run = (scope: string) =>
      send("/routing/rerun", { workspace: workspaceId, scope }).then(
        (r) => r.json() as Promise<RoutingPreview>,
      );
    const latest = await run("latest 7");
    expect(latest).toMatchObject({ considered: 7, inScope: 7, complete: true, scope: "latest 7" });
    // One Thread every 5 days: 20 days back holds 0, 5, 10, 15 and 20 days, less a minute.
    expect(await run("last 20 days")).toMatchObject({ considered: 4, inScope: 4, complete: true });
    expect(await run("last 2 months")).toMatchObject({ considered: 13, inScope: 13 });
    expect(await run("last 1 year")).toMatchObject({ considered: 30, inScope: 30 });
    expect(await run("since 2026-08-01")).toMatchObject({ considered: 10, inScope: 10 });
    const all = await run("all");
    expect(all).toMatchObject({ considered: 30, inScope: 30, complete: true });
    // Every invoice would move into Finance; nothing else.
    expect(all.moves).toHaveLength(10);
    expect(Object.values(all.byTarget ?? {})).toEqual([10]);
    // A Setting names the default scope when none is asked for.
    await setSetting("routing.rerun.scope", "latest 3");
    expect(
      await send("/routing/rerun", { workspace: workspaceId }).then((r) => r.json()),
    ).toMatchObject({
      considered: 3,
      scope: "latest 3",
    });
    await setSetting("routing.rerun.scope", "latest 50");
    expect((await send("/routing/rerun", { workspace: workspaceId, scope: "some" })).status).toBe(
      400,
    );
  }, 60_000);

  test("a large scope previews a sample; Apply moves it and the Backlog sort does the rest in batches", async () => {
    const { workspaceId, ids } = await seed("large", 30);
    const finance = await intelligence.routing.createGroup(workspaceId, {
      name: "Finance",
      sentence: "Invoices",
    });
    await setSetting("routing.rerun.preview_max", 10);
    await setSetting("routing.rerun.sample", 6);
    const preview = (await (
      await send("/routing/rerun", { workspace: workspaceId, scope: "all" })
    ).json()) as RoutingPreview;
    expect(preview).toMatchObject({ considered: 6, inScope: 30, complete: false });
    expect(preview.after?.id).toBe(ids[5]);
    // The sample moves at once: invoices 0 and 3.
    const res = await send("/routing/backlog", {
      workspace: workspaceId,
      scope: "all",
      moves: preview.moves,
      after: preview.after,
      done: preview.considered,
    });
    expect(res.status).toBe(202);
    const started = (await res.json()) as { backlog: RoutingBacklog; applied: { moved: number } };
    expect(started.applied.moved).toBe(2);
    expect(started.backlog).toMatchObject({
      status: "running",
      done: 6,
      total: 30,
      moved: 2,
      scope: "all",
    });
    expect(await groupOf(ids[3] as string)).toBe(finance.id);
    expect(await groupOf(ids[6] as string)).toBeNull();

    const before = counting.requests.length;
    const ran = await runDue();
    expect(ran[BACKLOG_STEP]).toBeGreaterThan(1);
    const sent = counting.requests.slice(before);
    // 24 Threads left, 4 per request: 6 requests, none larger than the Setting.
    expect(sent.map((r) => r.questions)).toEqual([4, 4, 4, 4, 4, 4]);
    // None of the sample was asked again.
    expect(sent.flatMap((r) => r.subjects)).not.toContain("Invoice 3");
    const done = await status(workspaceId);
    expect(done).toMatchObject({
      status: "done",
      done: 30,
      total: 30,
      moved: 10,
      sorter: "typesafe",
      batchSize: 4,
    });
    expect(done.batches).toBe(6);
    expect(await groupOf(ids[27] as string)).toBe(finance.id);
    // The meter recorded each request under judge.route.
    const month = await intelligence.meter.month(workspaceId, "2026-09");
    expect(month.lines.find((l) => l.task === "judge.route")?.calls).toBe(6 + 6);
    await setSetting("routing.rerun.preview_max", 500);
    await setSetting("routing.rerun.sample", 100);
  }, 60_000);

  test("stops at a count scope's limit and leaves Threads the user placed", async () => {
    const { workspaceId, ids } = await seed("limit", 20);
    const finance = await intelligence.routing.createGroup(workspaceId, {
      name: "Finance",
      sentence: "Invoices",
    });
    const other = await intelligence.routing.createGroup(workspaceId, {
      name: "Other",
      sentence: "Anything else",
    });
    // The user put invoice 3 in Other themselves.
    await store.applyIntent({
      kind: "move",
      threadId: ids[3] as string,
      group: other.id,
      subgroup: null,
      at: NOW.toISOString(),
      actor: "user",
    });
    const before = counting.requests.length;
    await intelligence.backlog.start(workspaceId, { kind: "latest", count: 10 });
    await runDue();
    const asked = counting.requests.slice(before).flatMap((r) => r.subjects);
    expect(asked).toHaveLength(9);
    expect(asked).not.toContain("Invoice 3");
    expect(asked).not.toContain("Invoice 12");
    expect(await status(workspaceId)).toMatchObject({
      status: "done",
      done: 10,
      skipped: 1,
      moved: 3,
    });
    expect(await groupOf(ids[3] as string)).toBe(other.id);
    expect(await groupOf(ids[9] as string)).toBe(finance.id);
    expect(await groupOf(ids[12] as string)).toBeNull();
  }, 60_000);

  test("resumes where it was after a restart", async () => {
    const { workspaceId, ids } = await seed("restart", 24);
    await intelligence.routing.createGroup(workspaceId, { name: "Finance", sentence: "Invoices" });
    const before = counting.requests.length;
    await intelligence.backlog.start(workspaceId, { kind: "all" });
    // One round (two requests of four), then the Server goes away.
    const job = await jobs.claim("server-a", [], 30_000);
    expect(job?.class).toBe(BACKLOG_STEP);
    await jobs.run(job as NonNullable<typeof job>, 30_000);
    expect(await status(workspaceId)).toMatchObject({ status: "running", done: 8 });
    // A new Server over the same database: its own Intelligence and Jobs.
    const restartedJobs = createJobs(db.handle.db, { now });
    const restarted = makeIntelligence();
    restarted.registerSteps(restartedJobs);
    for (;;) {
      const next = await restartedJobs.claim("server-b", [], 30_000);
      if (!next) break;
      await restartedJobs.run(next, 30_000);
    }
    const asked = counting.requests.slice(before).flatMap((r) => r.subjects);
    expect(asked).toHaveLength(24);
    expect(new Set(asked).size).toBe(24);
    expect(await status(workspaceId)).toMatchObject({ status: "done", done: 24, moved: 8 });
    expect(await groupOf(ids[21] as string)).not.toBeNull();
  }, 60_000);

  test("takes Threads that land in scope while it runs, and waits for the first sync", async () => {
    const { workspaceId, ids } = await seed("arrivals", 8, 1);
    const finance = await intelligence.routing.createGroup(workspaceId, {
      name: "Finance",
      sentence: "Invoices",
    });
    // The first sync is still paging: older mail is coming.
    await db.handle.db.insert(syncState).values({
      workspaceId,
      accountId: "arrivals",
      pending: ["INBOX"],
    });
    await intelligence.backlog.start(workspaceId, { kind: "last", amount: 3, unit: "months" });
    await runDue();
    expect(await status(workspaceId)).toMatchObject({ status: "waiting", reason: "sync", done: 8 });
    // Older mail arrives, inside the scope, and one new invoice lands above the top.
    const older = await addThread(
      workspaceId,
      "arrivals-old",
      "Invoice old",
      new Date(NOW.getTime() - 40 * DAY),
    );
    const outside = await addThread(
      workspaceId,
      "arrivals-ancient",
      "Invoice ancient",
      new Date(NOW.getTime() - 200 * DAY),
    );
    const newer = await addThread(
      workspaceId,
      "arrivals-new",
      "Invoice new",
      new Date(NOW.getTime() + 60_000),
    );
    await db.handle.db
      .update(syncState)
      .set({ pending: [], lastFullSync: now() })
      .where(eq(syncState.workspaceId, workspaceId));
    clock += 120_000;
    await runDue();
    expect(await status(workspaceId)).toMatchObject({ status: "done", done: 10 });
    expect(await groupOf(older)).toBe(finance.id);
    expect(await groupOf(newer)).toBe(finance.id);
    expect(await groupOf(outside)).toBeNull();
    expect(await groupOf(ids[0] as string)).toBe(finance.id);
  }, 60_000);

  test("waits cleanly with nothing to sort, and pause, resume and stop hold", async () => {
    const lonely = createJobs(db.handle.db, { now });
    const nobody = makeIntelligence({ keys: {} });
    nobody.registerSteps(lonely);
    const { workspaceId } = await seed("nobody", 6);
    await nobody.routing.createGroup(workspaceId, { name: "Finance", sentence: "Invoices" });
    await nobody.backlog.start(workspaceId, { kind: "all" });
    const job = await lonely.claim("server-c", [], 30_000);
    expect(await lonely.run(job as NonNullable<typeof job>, 30_000)).toEqual({ sleepMs: 300_000 });
    expect(await nobody.backlog.status(workspaceId)).toMatchObject({
      status: "waiting",
      reason: "no_judge",
      done: 0,
    });
    // The Job is asleep, not failed.
    expect((await lonely.get(job?.id as string))?.status).toBe("queued");
    // Pause while it waits: the sleeping Job stops when it wakes; resume starts a fresh one.
    expect(await nobody.backlog.pause(workspaceId)).toMatchObject({ status: "paused" });
    clock += 400_000;
    const woke = await lonely.claim("server-c", [], 30_000);
    expect(await lonely.run(woke as NonNullable<typeof woke>, 30_000)).toBe("done");
    expect(await nobody.backlog.status(workspaceId)).toMatchObject({ status: "paused" });
    expect(await nobody.backlog.resume(workspaceId)).toMatchObject({ status: "running" });
    expect(await nobody.backlog.cancel(workspaceId)).toMatchObject({ status: "cancelled" });
    const last = await lonely.claim("server-c", [], 30_000);
    expect(await lonely.run(last as NonNullable<typeof last>, 30_000)).toBe("done");
    expect(await nobody.backlog.status(workspaceId)).toMatchObject({
      status: "cancelled",
      done: 0,
    });
  }, 60_000);

  test("on a language model, a few Threads per prompt", async () => {
    const prompts: ChatCall[] = [];
    const chat = createFakeChat((call) => {
      prompts.push(call);
      const labels = [...call.prompt.matchAll(/^(T\d+)\.\nSubject: (.*)$/gm)];
      // The last Thread alone goes through the one-Thread prompt.
      if (labels.length === 0) {
        return JSON.stringify({ G1: /Subject: Invoice/.test(call.prompt) ? 0.95 : 0.02 });
      }
      const table = Object.fromEntries(
        labels.map((m) => [m[1], { G1: /invoice/i.test(m[2] ?? "") ? 0.95 : 0.02 }]),
      );
      return JSON.stringify(table);
    });
    const llmJobs = createJobs(db.handle.db, { now });
    const llm = makeIntelligence({ keys: { anthropic: "sk-ant" }, chat });
    llm.registerSteps(llmJobs);
    await setSetting("routing.backfill.llm_batch_size", 3);
    const { workspaceId, ids } = await seed("llm", 7);
    const finance = await llm.routing.createGroup(workspaceId, {
      name: "Finance",
      sentence: "Invoices",
    });
    await llm.backlog.start(workspaceId, { kind: "all" });
    for (;;) {
      const job = await llmJobs.claim("server-d", [], 30_000);
      if (!job) break;
      await llmJobs.run(job, 30_000);
    }
    const batched = prompts.filter((p) => p.system.includes("Several threads follow"));
    expect(batched.map((p) => [...p.prompt.matchAll(/^T\d+\.$/gm)].length)).toEqual([3, 3]);
    expect(await llm.backlog.status(workspaceId)).toMatchObject({
      status: "done",
      done: 7,
      sorter: "llm",
      moved: 3,
    });
    expect(await groupOf(ids[6] as string)).toBe(finance.id);
  }, 60_000);

  test("a Group proposal moves its sample on approval, queues the rest, and Undo stops it", async () => {
    const { workspaceId, ids } = await seed("proposal", 20);
    await setSetting("routing.backfill.sample", 6);
    await setSetting("routing.backfill.scope", "all");
    const a = approver("approved");
    const outcome = await intelligence.agent.tools(workspaceId).call(
      {
        name: "propose_groups",
        args: { groups: [{ name: "Finance", sentence: "Invoices and receipts" }] },
        callId: `p-${++calls}`,
        sessionId: null,
      },
      a,
    );
    expect(outcome.isError).toBe(false);
    const card = a.asked[0] as Extract<ToolPreview, { kind: "groups" }>;
    expect(card.considered).toBe(6);
    expect(card.groups[0]).toMatchObject({ name: "Finance", moves: 2 });
    expect(card.backlog).toEqual({ scope: "all your mail", threads: 20 });
    // The sample moved at once; the rest waits for the Job.
    const finance = (await intelligence.routing.listGroups(workspaceId))[0];
    expect(await groupOf(ids[3] as string)).toBe(finance?.id ?? "?");
    expect(await groupOf(ids[9] as string)).toBeNull();
    expect(await status(workspaceId)).toMatchObject({ status: "running", done: 6, moved: 2 });
    expect(outcome.text).toContain("in the background");
    // Undo stops the background sorting and takes the Groups away.
    const undone = await intelligence.agent
      .tools(workspaceId)
      .call(
        { name: "undo", args: {}, callId: `u-${++calls}`, sessionId: null },
        approver("approved"),
      );
    expect(undone.isError).toBe(false);
    expect(await status(workspaceId)).toMatchObject({ status: "cancelled" });
    await runDue();
    expect(await status(workspaceId)).toMatchObject({ status: "cancelled", done: 6 });
    expect(await groupOf(ids[3] as string)).toBeNull();
    await setSetting("routing.backfill.scope", "last 3 months");
    await setSetting("routing.backfill.sample", 100);
  }, 60_000);

  test("organize_existing over a scope moves the sample into the Group and sorts the rest", async () => {
    const { workspaceId, ids } = await seed("organize", 16);
    const finance = await intelligence.routing.createGroup(workspaceId, {
      name: "Finance",
      sentence: "Invoices",
    });
    const a = approver("approved");
    const outcome = await intelligence.agent.tools(workspaceId).call(
      {
        name: "organize_existing",
        args: { group: "Finance", scope: "last 6 months", recent: 4 },
        callId: `o-${++calls}`,
        sessionId: null,
      },
      a,
    );
    expect(outcome.isError).toBe(false);
    expect(a.asked).toHaveLength(1);
    expect(JSON.stringify(a.asked[0])).toContain("the last 6 months");
    expect(await groupOf(ids[3] as string)).toBe(finance.id);
    await runDue();
    expect(await status(workspaceId)).toMatchObject({ status: "done", done: 16, moved: 6 });
    expect(await groupOf(ids[15] as string)).toBe(finance.id);
  }, 60_000);
});
