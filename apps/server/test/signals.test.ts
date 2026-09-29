// The Signal store and the Signal request (slice 30; docs/spec/signals.md)
// through the Intelligence interface over the fake judge: one request per
// Thread version carrying every shipped Signal, answers stamped with their
// Question version, a reworded question making answers stale without
// emptying the Sections, a Section statement's migrated answers claimed at
// the current version, Waiting on you from waiting_on_me, the language model
// path without TypeSafe, and the state's own words.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Account, Change, SignalsChange, Thread } from "@monday/shared";
import { DEFAULT_SECTION_RULES, sectionOf } from "@monday/shared";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys } from "../src/crypto/keys.ts";
import { settings as settingsTable, signalAnswers } from "../src/db/schema.ts";
import { createIntelligence, type Intelligence, JUDGE_STEP } from "../src/intelligence/index.ts";
import { createFakeChat, createFakeJudge } from "../src/intelligence/runtime/fake/index.ts";
import { ownWords, signalState, splitQuestions } from "../src/intelligence/signals/index.ts";
import { createJobs, type Jobs } from "../src/jobs/index.ts";
import { createMailstore, type Mailstore } from "../src/mailstore/index.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const NOW = new Date("2026-09-29T12:00:00Z");
const owner = { name: "Sam Okafor", email: "sam@monday.test" };
const client = { name: "Dana Reyes", email: "dana@client.test" };

const account: Account = {
  id: "acct-signals",
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

const subjectOf = (state: unknown) =>
  (state as { thread?: { subject?: string } }).thread?.subject ?? "";

describe("the Signal store", () => {
  let db: TestDatabase;
  let store: Mailstore;
  let jobs: Jobs;
  let workspaceId: string;
  const judge = createFakeJudge();
  let intelligence: Intelligence;
  let contract: string;
  let digest: string;

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

  const addThread = async (
    key: string,
    subject: string,
    messages: Array<{ from: typeof owner; text: string; at: string }>,
  ) => {
    const threadId = await store.upsertThread({
      workspaceId,
      providerThreadId: `t-${key}`,
      subject,
      participants: [client, owner],
      lastActivity: messages[messages.length - 1]?.at ?? NOW.toISOString(),
    });
    for (const [i, m] of messages.entries()) {
      await store.upsertMessage({
        threadId,
        providerMessageId: `m-${key}-${i}`,
        from: m.from,
        to: [m.from.email === owner.email ? client : owner],
        cc: [],
        date: m.at,
        headers: {},
        bodyText: m.text,
        bodyHtml: null,
        snippet: m.text.slice(0, 80),
      });
    }
    return threadId;
  };

  const feed = async (): Promise<Change[]> =>
    (await store.listChanges(workspaceId, { since: 0, limit: 1000 })).changes;

  beforeAll(async () => {
    db = await testDatabase();
    const keys = createKeys(db.handle.db);
    await keys.unlock(randomKey());
    store = createMailstore(db.handle.db, keys);
    jobs = createJobs(db.handle.db, { now: () => NOW });
    workspaceId = (await store.createWorkspace(account)).id;
    judge.when((state) => subjectOf(state) === "Contract for signature", {
      waiting_on_me: 0.92,
      needs_reply: 0.55,
      automated: 0.03,
      newsletter: 0.02,
    });
    judge.when((state) => subjectOf(state) === "Weekly digest", {
      newsletter: 0.95,
      automated: 0.7,
      waiting_on_me: 0.05,
    });
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
    contract = await addThread("contract", "Contract for signature", [
      { from: owner, text: "Here is the draft.", at: "2026-09-28T09:00:00.000Z" },
      {
        from: client,
        text: "Hi Sam, could you sign the attached contract by Friday?\n\n--\nDana Reyes\nClient Co\n\nOn Mon, Sam wrote:\n> Here is the draft.",
        at: "2026-09-29T09:00:00.000Z",
      },
    ]);
    digest = await addThread("digest", "Weekly digest", [
      {
        from: { name: "The Weekly", email: "news@weekly.test" },
        text: "This week in tech.",
        at: "2026-09-29T08:00:00.000Z",
      },
    ]);
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  });

  test("one request per Thread version carries every shipped Signal; the same version is never asked twice", async () => {
    const before = judge.calls.length;
    await intelligence.judgments.threadReady(workspaceId, contract);
    await intelligence.judgments.threadReady(workspaceId, digest);
    expect(await runDue()).toEqual({ [JUDGE_STEP]: 2 });
    const sent = judge.calls.slice(before);
    expect(sent).toHaveLength(2);
    expect(sent[0]?.questions.sort()).toEqual(
      [
        "automated",
        "brief_worth",
        "chip_call",
        "chip_pay_or_file",
        "chip_reply",
        "chip_snooze",
        "needs_reply",
        "newsletter",
        "urgency",
        "waiting_on_me",
        "waiting_on_others",
      ].sort(),
    );
    // The state is the one Thread: the owner, the newest message's own words, the earlier ones.
    const state = sent.find((c) => subjectOf(c.state) === "Contract for signature")?.state as {
      owner: { address: string };
      thread: {
        newest_message: { text: string; written: string };
        earlier_messages: unknown[];
      };
    };
    expect(state.owner.address).toBe(owner.email);
    expect(state.thread.newest_message.text).toBe(
      "Hi Sam, could you sign the attached contract by Friday?",
    );
    expect(state.thread.newest_message.written).toBe("Tuesday 29 September 2026");
    expect(state.thread.earlier_messages).toEqual([
      {
        from: { name: owner.name, email: owner.email },
        written: "Monday 28 September 2026",
        text: "Here is the draft.",
      },
    ]);
    // Asking again for the same version asks nothing.
    await intelligence.judgments.threadReady(workspaceId, contract);
    expect(await runDue()).toEqual({});
    expect(judge.calls.length - before).toBe(2);
    const rows = await db.handle.db.select().from(signalAnswers);
    expect(rows.filter((r) => r.threadId === contract)).toHaveLength(11);
    expect(rows.every((r) => r.version === 1)).toBe(true);
    // One `signals` change per request, numbers only.
    const changes = (await feed()).filter((c) => c.kind === "signals" && c.entityId === contract);
    expect(changes).toHaveLength(1);
    expect(JSON.stringify(changes[0]?.payload)).not.toContain("sign the attached");
    // Every Signal's definition reached the feed too.
    expect((await feed()).filter((c) => c.kind === "signal_def").length).toBeGreaterThanOrEqual(11);
    const month = await intelligence.meter.month(workspaceId, "2026-09");
    expect(month.lines.find((l) => l.task === "judge.signals")?.calls).toBe(2);
  });

  test("Waiting on you holds the Thread where the client asked the owner to sign and the owner has not answered", async () => {
    const readings = (await intelligence.signals.readings([contract])).get(contract) ?? {};
    expect(readings.waiting_on_me?.noul).toBeCloseTo(0.92);
    const thread = {
      id: contract,
      section: null,
      group: null,
      subgroup: null,
      messageCount: 2,
      unread: true,
      starred: false,
      hasAttachments: false,
      bulk: false,
    } as unknown as Thread;
    const facts = {
      lastSender: client.email,
      owner: owner.email,
      judgments: await intelligence.judgments.get(contract),
      signals: readings,
    };
    expect(
      sectionOf(thread, facts, DEFAULT_SECTION_RULES, [
        "needs-reply",
        "waiting",
        "fyi",
        "newsletters",
      ]),
    ).toBe("waiting");
  });

  test("a reworded question raises its version; the old answer shows as stale; only that Signal is asked again", async () => {
    await setSetting(
      "judgments.questions.newsletter",
      "The thread is a newsletter, digest or mailing the owner subscribed to.",
    );
    const defs = await intelligence.signals.defs(workspaceId);
    expect(defs.find((d) => d.id === "newsletter")?.version).toBe(2);
    expect(defs.find((d) => d.id === "needs_reply")?.version).toBe(1);
    const readings = (await intelligence.signals.readings([digest])).get(digest) ?? {};
    expect(readings.newsletter).toMatchObject({ stale: true, version: 1 });
    expect(readings.newsletter?.noul).toBeCloseTo(0.95);
    expect(readings.needs_reply?.stale).toBe(false);
    // Lists keep reading it: the digest stays in Newsletters meanwhile.
    expect((await intelligence.judgments.get(digest))?.newsletter).toBeCloseTo(0.95);
    // Nothing that acts reads it: the fresh Judgments are missing until it is read again.
    expect(await intelligence.judgments.fresh(digest)).toBeNull();
    expect(await intelligence.signals.missing(workspaceId, digest)).toEqual(["newsletter"]);
    const before = judge.calls.length;
    await intelligence.judgments.threadReady(workspaceId, digest);
    await runDue();
    // The judge Job re-reads the digest; the backfill the reword started reads the contract; nothing twice.
    const asked = judge.calls.slice(before);
    expect(asked.map((c) => c.questions)).toEqual([["newsletter"], ["newsletter"]]);
    expect(new Set(asked.map((c) => subjectOf(c.state))).size).toBe(2);
    expect((await intelligence.signals.readings([digest])).get(digest)?.newsletter?.stale).toBe(
      false,
    );
    const defChanges = (await feed()).filter(
      (c) => c.kind === "signal_def" && c.entityId === "newsletter",
    );
    expect(defChanges.at(-1)?.payload).toMatchObject({ version: 2, active: true });
  });

  test("a Section's migrated answers are claimed at the current version when asked with the same statement", async () => {
    await db.handle.db.insert(signalAnswers).values([
      {
        threadId: contract,
        workspaceId,
        signalId: "section:contracts",
        version: 0,
        model: "jev-1.13.0",
        judgedAt: NOW,
        noul: 0.9,
        legacyKey: "The thread is about a contract.",
      },
      {
        threadId: digest,
        workspaceId,
        signalId: "section:contracts",
        version: 0,
        model: "jev-1.13.0",
        judgedAt: NOW,
        noul: 0.1,
        legacyKey: "An older wording.",
      },
    ]);
    await setSetting("sections.rules", [
      ...DEFAULT_SECTION_RULES,
      { id: "contracts", when: {}, judge: "The thread is about a contract.", createdBy: "agent" },
    ]);
    const def = (await intelligence.signals.defs(workspaceId)).find(
      (d) => d.id === "section:contracts",
    );
    expect(def).toMatchObject({ version: 1, owner: { kind: "section", id: "contracts" } });
    const all = await intelligence.signals.readings([contract, digest]);
    expect(all.get(contract)?.["section:contracts"]).toMatchObject({ version: 1, stale: false });
    expect(all.get(digest)?.["section:contracts"]).toMatchObject({ version: 0, stale: true });
    // Removing the Section retires its Signal; the answers stay for an Undo.
    await setSetting("sections.rules", DEFAULT_SECTION_RULES);
    const retired = (await intelligence.signals.defs(workspaceId)).find(
      (d) => d.id === "section:contracts",
    );
    expect(retired?.active).toBe(false);
    expect(
      (await intelligence.signals.readings([contract])).get(contract)?.["section:contracts"],
    ).toBeDefined();
  });

  test("without TypeSafe the language model answers only what the shipped Sections read", async () => {
    const chat = createFakeChat(
      JSON.stringify({
        needs_reply: 0.8,
        waiting_on_me: 0.6,
        newsletter: 0.1,
        automated: 0.05,
        urgency: 3,
      }),
    );
    const llm = createIntelligence({
      level: async () => "automate",
      db: db.handle.db,
      mailstore: store,
      chat: chat.chat,
      keys: async (provider) => (provider === "anthropic" ? "sk-ant" : null),
      now: () => NOW,
    });
    const fresh = await addThread("llm", "Lunch on Friday?", [
      { from: client, text: "Are you free for lunch on Friday?", at: "2026-09-29T11:00:00.000Z" },
    ]);
    const result = await llm.signals.ask(workspaceId, fresh, { reason: "arrival" });
    expect(result.by).toBe("llm");
    expect(result.asked.sort()).toEqual([
      "automated",
      "needs_reply",
      "newsletter",
      "waiting_on_me",
    ]);
    expect(chat.calls).toHaveLength(1);
    expect(chat.calls[0]?.prompt).toContain("Are you free for lunch on Friday?");
    const readings = (await llm.signals.readings([fresh])).get(fresh) ?? {};
    expect(readings.needs_reply?.noul).toBeCloseTo(0.8);
    expect(readings.urgency).toBeUndefined();
    // `none` asks nothing.
    await setSetting("signals.llm_fallback", "none");
    await expect(
      llm.signals.ask(workspaceId, fresh, { reason: "arrival", force: true }),
    ).rejects.toThrow();
    await setSetting("signals.llm_fallback", "shipped_sections");
  });

  test("the state keeps a message's own words and the request splits only when it must", () => {
    expect(
      ownWords("Yes, Thursday works.\n\nOn Tue, 29 Sep 2026, Dana wrote:\n> Does Thursday work?"),
    ).toBe("Yes, Thursday works.");
    expect(ownWords("Thanks!\n-- \nSam\nCEO")).toBe("Thanks!");
    const state = signalState(
      {
        owner,
        subject: "s",
        messages: Array.from({ length: 30 }, (_, i) => ({
          from: i % 2 ? owner : client,
          to: [],
          cc: [],
          date: "2026-09-29T10:00:00.000Z",
          text: `message ${i} `.repeat(100),
        })),
        attachmentNames: [],
        listHeaders: {},
        timeZone: "",
      },
      { newestChars: 500, threadChars: 1500, earlierChars: 300 },
    ) as { thread: { newest_message: { text: string }; earlier_messages: unknown[] } };
    expect(state.thread.newest_message.text.length).toBeLessThanOrEqual(500);
    expect(state.thread.earlier_messages).toHaveLength(4);
    const questions = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [
        `q${i}`,
        { type: "noul" as const, instructions: "x".repeat(300) },
      ]),
    );
    expect(
      splitQuestions({}, questions, { requestTokens: 64_000, stateTokens: 32_000 }),
    ).toHaveLength(1);
    expect(
      splitQuestions({}, questions, { requestTokens: 400, stateTokens: 32_000 }).length,
    ).toBeGreaterThan(1);
  });

  test("a feed change carries numbers only", async () => {
    const change = (await feed()).find((c) => c.kind === "signals" && c.entityId === digest)
      ?.payload as SignalsChange;
    expect(change.answers.every((a) => typeof a.signalId === "string")).toBe(true);
  });
});
