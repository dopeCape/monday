// Groups and Custom actions in the one request (slice 33; docs/spec/signals.md
// "Sections, Groups and Custom actions"): an arriving Thread costs one judge
// request for routing (the Group Choice and the speculative Sub-group
// Choices), the Sections (a Section's own statement), the brief policy and a
// Custom action's statement together, whichever of the route and judge Jobs
// runs first; the placement lands in thread_routes, the answers in the
// Signal store.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Account } from "@monday/shared";
import { DEFAULT_SECTION_RULES } from "@monday/shared";
import { eq } from "drizzle-orm";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys } from "../src/crypto/keys.ts";
import { settings as settingsTable, threads } from "../src/db/schema.ts";
import { createIntelligence, type Intelligence } from "../src/intelligence/index.ts";
import { createFakeChat, createFakeJudge } from "../src/intelligence/runtime/fake/index.ts";
import { createJobs, type Jobs } from "../src/jobs/index.ts";
import { createMailstore, type Mailstore } from "../src/mailstore/index.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const NOW = new Date("2026-09-29T12:00:00Z");
const owner = { name: "Sam Okafor", email: "sam@monday.test" };

describe("the arrival request carries routing, Sections, the brief policy and Custom actions", () => {
  let db: TestDatabase;
  let store: Mailstore;
  let jobs: Jobs;
  let workspaceId: string;
  const judge = createFakeJudge();
  let intelligence: Intelligence;
  let financeId = "";
  let dueId = "";

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
    for (let i = 0; i < 100; i++) {
      const job = await jobs.claim("server-a", ["needs-process"], 30_000);
      if (!job) return ran;
      await jobs.run(job, 30_000);
      ran[job.class] = (ran[job.class] ?? 0) + 1;
    }
    throw new Error("jobs did not settle");
  };
  const arrive = async (key: string, subject: string, text: string) => {
    const from = { name: "Hetzner Billing", email: "billing@hetzner.com" };
    const at = new Date(NOW.getTime() - 60_000).toISOString();
    const threadId = await store.upsertThread({
      workspaceId,
      providerThreadId: key,
      subject,
      participants: [from, owner],
      lastActivity: at,
    });
    await store.upsertMessage({
      threadId,
      providerMessageId: `m-${key}`,
      from,
      to: [owner],
      cc: [],
      date: at,
      headers: {},
      bodyText: text,
      bodyHtml: null,
      snippet: text.slice(0, 60),
    });
    return { threadId, at };
  };

  beforeAll(async () => {
    db = await testDatabase();
    const keys = createKeys(db.handle.db);
    await keys.unlock(randomKey());
    store = createMailstore(db.handle.db, keys);
    jobs = createJobs(db.handle.db, { now: () => NOW });
    const account: Account = {
      id: "acct-arrival",
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
      judge: judge.judge,
      keys: async (provider) => (provider === "typesafe" ? "ts-key" : null),
      now: () => NOW,
    });
    intelligence.registerSteps(jobs);
    financeId = (
      await intelligence.routing.createGroup(workspaceId, { name: "Finance", sentence: "Invoices" })
    ).id;
    dueId = (
      await intelligence.routing.createGroup(workspaceId, {
        name: "Due",
        sentence: "Bills still to pay",
        parentId: financeId,
      })
    ).id;
    await intelligence.routing.createGroup(workspaceId, { name: "Press", sentence: "Journalists" });
    await setSetting("sections.rules", [
      ...DEFAULT_SECTION_RULES,
      {
        id: "owe",
        when: {},
        judge: "The thread is a bill the owner has not paid yet.",
        createdBy: "agent",
      },
    ]);
    await setSetting("actions.custom", [
      {
        id: "forward-accounts",
        label: "Forward to accounts",
        on: { judge: "The thread is an invoice." },
        tool: "forward_thread",
        args: { to: "accounts@monday.test" },
      },
    ]);
    judge.answer("group", "finance");
    judge.answer(`subgroup_${financeId}`, "due");
    judge.answer("section:owe", 0.91);
    judge.answer("action:forward-accounts", 0.94);
    judge.answer("brief_worth", 2);
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  });

  test("one judge request places the Thread, answers the Section, the action and the brief policy", async () => {
    await intelligence.signals.defs(workspaceId);
    await intelligence.signalBackfills.cancel(workspaceId);
    const { threadId, at } = await arrive(
      "inv",
      "Invoice INV-2291",
      "Your invoice over $1,315.50 is due on 3 October.",
    );
    const before = judge.calls.length;
    // The sync engine's hooks: the route Job and the judge Job, and the brief policy asking on its own.
    await intelligence.routing.onArrival(workspaceId, threadId, at);
    await intelligence.judgments.threadReady(workspaceId, threadId);
    await runDue();
    const fresh = await intelligence.judgments.judgeThread(workspaceId, threadId);
    expect(fresh.briefWorth).toBe(2);
    const sent = judge.calls.slice(before);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.questions).toEqual(
      expect.arrayContaining([
        "group",
        `subgroup_${financeId}`,
        "section:owe",
        "action:forward-accounts",
        "brief_worth",
        "needs_reply",
      ]),
    );
    const row = await db.handle.db.query.threads.findFirst({ where: eq(threads.id, threadId) });
    expect(row?.groupId).toBe(financeId);
    expect(row?.subgroupId).toBe(dueId);
    const readings = (await intelligence.signals.readings([threadId])).get(threadId) ?? {};
    expect(readings["section:owe"]?.noul).toBeCloseTo(0.91);
    expect(readings["action:forward-accounts"]?.noul).toBeCloseTo(0.94);
    // The on-demand path reads the same answers and asks nothing.
    const judged = await intelligence.organize.judge(workspaceId, [threadId]);
    expect(judged[0]?.rules).toMatchObject({
      owe: expect.any(Number),
      "forward-accounts": expect.any(Number),
    });
    expect(judge.calls.length - before).toBe(1);
    const month = await intelligence.meter.month(workspaceId, "2026-09");
    expect(month.lines.find((l) => l.task === "judge.route")).toBeUndefined();
  });

  test("a new Message is a new version: one request again, and routing, done on arrival, is not asked twice", async () => {
    const { threadId } = await arrive("inv2", "Invoice INV-2292", "Another invoice for $20.00.");
    await intelligence.judgments.threadReady(workspaceId, threadId);
    await intelligence.routing.onArrival(workspaceId, threadId, NOW.toISOString());
    const before = judge.calls.length;
    await runDue();
    expect(judge.calls.length - before).toBe(1);
    await store.upsertMessage({
      threadId,
      providerMessageId: "m-inv2-b",
      from: owner,
      to: [{ name: "Hetzner Billing", email: "billing@hetzner.com" }],
      cc: [],
      date: NOW.toISOString(),
      headers: {},
      bodyText: "Paid, thanks.",
      bodyHtml: null,
      snippet: "Paid, thanks.",
    });
    await intelligence.judgments.threadReady(workspaceId, threadId);
    await runDue();
    const again = judge.calls.slice(before + 1);
    expect(again).toHaveLength(1);
    expect(again[0]?.questions).not.toContain("group");
    expect(again[0]?.questions).toContain("needs_reply");
  });
});
