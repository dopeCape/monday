// Backfill, rate and budget (slice 31; docs/spec/signals.md "Backfill",
// "Budget and rate"): the limiter puts arrival first and halves background
// concurrency after a 429, then grows it back; a reworded Signal starts one
// backfill that asks each Thread only what it lacks; a second change widens
// the running walk; above the threshold it asks first with an estimate; a
// spent monthly budget pauses it with the reason while arrival goes on; and a
// running Backlog sort carries the missing Signals in its one request per Thread.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Account, JudgeQuestions, JudgeResponse } from "@monday/shared";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys } from "../src/crypto/keys.ts";
import { meter, settings as settingsTable } from "../src/db/schema.ts";
import { createIntelligence, type Intelligence, JUDGE_STEP } from "../src/intelligence/index.ts";
import { createFakeChat, createFakeJudge } from "../src/intelligence/runtime/fake/index.ts";
import type { JudgeCall, JudgeModel } from "../src/intelligence/runtime/index.ts";
import { TypeSafeError } from "../src/intelligence/runtime/typesafe.ts";
import { SIGNALS_BACKFILL_STEP } from "../src/intelligence/signals/backfill.ts";
import { createJudgeLimiter } from "../src/intelligence/signals/limiter.ts";
import { createJobs, type Jobs } from "../src/jobs/index.ts";
import { createMailstore, type Mailstore } from "../src/mailstore/index.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const NOW = new Date("2026-09-29T12:00:00Z");
const owner = { name: "Sam Okafor", email: "sam@monday.test" };

describe("the judge's limiter", () => {
  test("a 429 halves background concurrency while arrival goes first, then it grows back", async () => {
    let clock = 0;
    const limiter = createJudgeLimiter({
      now: () => clock,
      sleep: async () => {
        clock += 10;
        await Promise.resolve();
      },
      settings: async () => ({ requestsPerMinute: 1000, concurrency: 4, cooldownSeconds: 1 }),
    });
    const order: string[] = [];
    // Four background requests hold every background slot; an arrival request still goes at once.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const background = Array.from({ length: 4 }, (_, i) =>
      limiter.run("background", async () => {
        order.push(`b${i}`);
        await gate;
      }),
    );
    await Promise.resolve();
    await limiter.run("arrival", async () => {
      order.push("a");
    });
    expect(order).toContain("a");
    expect(limiter.state().inFlight.background).toBe(4);
    release();
    await Promise.all(background);
    // A 429 with retry-after: retried after the wait, the background limit halves.
    let first = true;
    const answer = await limiter.run("background", async () => {
      if (first) {
        first = false;
        throw new TypeSafeError("rate_limited", 429, "slow down", 500);
      }
      return "ok";
    });
    expect(answer).toBe("ok");
    expect(limiter.state().backgroundLimit).toBe(2);
    expect(limiter.state().coolingUntil).toBeGreaterThan(clock - 1000);
    // After the cooldown each background request grows it back by one.
    clock += 2000;
    for (let i = 0; i < 3; i++) await limiter.run("background", async () => "ok");
    await new Promise((r) => setTimeout(r, 5));
    expect(limiter.state().backgroundLimit).toBe(4);
  });

  test("arrival requests queued ahead of background ones go first", async () => {
    let clock = 0;
    const limiter = createJudgeLimiter({
      now: () => clock,
      sleep: async () => {
        clock += 1;
        await new Promise((r) => setTimeout(r, 0));
      },
      settings: async () => ({ requestsPerMinute: 1000, concurrency: 1, cooldownSeconds: 0 }),
    });
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const busy = limiter.run("background", async () => {
      await gate;
    });
    const waitingBackground = limiter.run("background", async () => {
      order.push("background");
    });
    const arrival = limiter.run("arrival", async () => {
      order.push("arrival");
    });
    await arrival;
    release();
    await Promise.all([busy, waitingBackground]);
    expect(order).toEqual(["arrival", "background"]);
  });
});

describe("the Signal backfill", () => {
  let db: TestDatabase;
  let store: Mailstore;
  let jobs: Jobs;
  let workspaceId: string;
  const fake = createFakeJudge();
  const requests: Array<{ questions: string[]; subject: string }> = [];
  const judge: JudgeModel = async <Q extends JudgeQuestions>(
    call: JudgeCall<Q>,
  ): Promise<JudgeResponse<Q>> => {
    requests.push({
      questions: Object.keys(call.questions),
      subject: (call.state as { thread?: { subject?: string } }).thread?.subject ?? "",
    });
    return fake.judge(call);
  };
  let intelligence: Intelligence;
  const ids: string[] = [];

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

  beforeAll(async () => {
    db = await testDatabase();
    const keys = createKeys(db.handle.db);
    await keys.unlock(randomKey());
    store = createMailstore(db.handle.db, keys);
    jobs = createJobs(db.handle.db, { now: () => NOW });
    const account: Account = {
      id: "acct-backfill",
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
    intelligence = createIntelligence({
      level: async () => "automate",
      db: db.handle.db,
      mailstore: store,
      chat: createFakeChat("{}").chat,
      judge,
      keys: async (provider) => (provider === "typesafe" ? "ts-key" : null),
      now: () => NOW,
    });
    intelligence.registerSteps(jobs);
    for (let i = 0; i < 6; i++) {
      const at = new Date(NOW.getTime() - (i + 1) * 3_600_000).toISOString();
      const from = { name: "Client", email: `c${i}@client.test` };
      const threadId = await store.upsertThread({
        workspaceId,
        providerThreadId: `t${i}`,
        subject: i % 2 === 0 ? `Invoice ${i}` : `Note ${i}`,
        participants: [from, owner],
        lastActivity: at,
      });
      await store.upsertMessage({
        threadId,
        providerMessageId: `m${i}`,
        from,
        to: [owner],
        cc: [],
        date: at,
        headers: {},
        bodyText: `Hello ${i}`,
        bodyHtml: null,
        snippet: `Hello ${i}`,
      });
      ids.push(threadId);
      await intelligence.judgments.threadReady(workspaceId, threadId);
    }
    expect(await runDue()).toEqual({ [JUDGE_STEP]: 6 });
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  });

  test("a reworded Signal starts one backfill that asks each Thread only that Signal", async () => {
    requests.length = 0;
    await setSetting("judgments.questions.urgency", "How soon must the owner act on this thread?");
    await intelligence.signals.defs(workspaceId);
    const status = await intelligence.signalBackfills.status(workspaceId);
    expect(status).toMatchObject({ status: "running", signals: ["urgency"], total: 6 });
    // One step streams the whole walk through the pool and sees it end.
    expect(await runDue()).toEqual({ [SIGNALS_BACKFILL_STEP]: 1 });
    expect(requests).toHaveLength(6);
    expect(requests.every((r) => r.questions.join() === "urgency")).toBe(true);
    expect(await intelligence.signalBackfills.status(workspaceId)).toMatchObject({
      status: "done",
      done: 6,
      asked: 6,
      calls: 6,
    });
    const month = await intelligence.meter.month(workspaceId, "2026-09");
    expect(month.lines.find((l) => l.task === "judge.backfill")?.calls).toBe(6);
  });

  test("above the threshold it asks first with the count and an estimate; a second change widens the walk", async () => {
    requests.length = 0;
    await setSetting("signals.backfill.confirm_above", 3);
    await setSetting(
      "judgments.questions.newsletter",
      "The thread is a newsletter the owner subscribed to.",
    );
    await intelligence.signals.defs(workspaceId);
    const asking = await intelligence.signalBackfills.status(workspaceId);
    expect(asking?.status).toBe("confirm");
    expect(asking?.estimate?.threads).toBe(6);
    expect(asking?.estimate?.costMicros).toBeGreaterThan(0);
    expect(await runDue()).toEqual({});
    // Another rewording while it waits joins the same walk.
    await setSetting("judgments.questions.automated", "A system sent it, not a person.");
    await intelligence.signals.defs(workspaceId);
    expect((await intelligence.signalBackfills.status(workspaceId))?.signals.sort()).toEqual([
      "automated",
      "newsletter",
    ]);
    await intelligence.signalBackfills.confirm(workspaceId);
    await runDue();
    expect(requests).toHaveLength(6);
    expect(requests.every((r) => r.questions.sort().join() === "automated,newsletter")).toBe(true);
    await setSetting("signals.backfill.confirm_above", 2000);
  });

  test("a spent budget pauses the walk with its reason while arrival requests continue", async () => {
    requests.length = 0;
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
    await setSetting("judgments.questions.brief_worth", "How much would a summary help the owner?");
    await intelligence.signals.defs(workspaceId);
    await runDue();
    const paused = await intelligence.signalBackfills.status(workspaceId);
    expect(paused).toMatchObject({ status: "waiting", reason: "budget" });
    expect(paused?.budget?.budgetMicros).toBe(3_000_000);
    expect(paused?.budget?.spentMicros).toBeGreaterThanOrEqual(3_000_000);
    expect(requests).toHaveLength(0);
    // New mail is never capped.
    await store.upsertMessage({
      threadId: ids[0] as string,
      providerMessageId: "m-new",
      from: { name: "Client", email: "c0@client.test" },
      to: [owner],
      cc: [],
      date: NOW.toISOString(),
      headers: {},
      bodyText: "One more thing.",
      bodyHtml: null,
      snippet: "One more thing.",
    });
    await intelligence.judgments.threadReady(workspaceId, ids[0] as string);
    const ran = await runDue();
    expect(ran[JUDGE_STEP]).toBe(1);
    expect(requests).toHaveLength(1);
    await intelligence.signalBackfills.cancel(workspaceId);
  });

  test("a running Backlog sort carries the missing Signals in its one request per Thread", async () => {
    await setSetting("signals.budget.background_monthly_usd", 100);
    await setSetting(
      "actions.recommended.snooze.question",
      "The owner will want to come back to this later.",
    );
    await intelligence.signalBackfills.cancel(workspaceId);
    await intelligence.signals.defs(workspaceId);
    await intelligence.signalBackfills.cancel(workspaceId);
    await intelligence.routing.createGroup(workspaceId, { name: "Finance", sentence: "Invoices" });
    requests.length = 0;
    await intelligence.backlog.start(workspaceId, { kind: "all" });
    await runDue();
    const sorted = requests.filter((r) => r.questions.includes("group"));
    expect(sorted).toHaveLength(6);
    // The Group Choice and every Signal the Thread lacked, in the same request.
    expect(sorted.every((r) => r.questions.includes("action:snooze.fits"))).toBe(true);
    // brief_worth was reworded while the budget was spent: every Thread but the one new mail re-read lacks it.
    expect(sorted.filter((r) => r.questions.includes("brief_worth"))).toHaveLength(5);
    expect(requests).toHaveLength(6);
    const month = await intelligence.meter.month(workspaceId, "2026-09");
    expect(month.lines.find((l) => l.task === "judge.backlog")?.calls).toBe(6);
  });
});
