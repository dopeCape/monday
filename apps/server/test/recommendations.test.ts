// Recommended actions (docs/spec/actions.md; slice 34): the catalog's fit
// Signals ride in the one Signal request with their argument Choices; code
// gates the recipient Choice on the people it found and builds its options;
// code assembles the snooze time; the actions reach the feed with headers
// only and their arguments stay sealed; stale and low-trust answers never
// act; the Agent reads the same list. Acceptance 4 (a forward shows only at a
// recipient confidence of 0.8 or more; compose opens, nothing is sent) is
// split between here (the confidence the Server keeps) and the chips'
// choosing in packages/shared (actions.test.ts) and the Device.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
  Account,
  Change,
  ChoiceQuestion,
  RecommendationsChange,
  SignalReading,
} from "@monday/shared";
import { chooseRecommended, defaultSettings, recommendationRules } from "@monday/shared";
import { eq } from "drizzle-orm";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys } from "../src/crypto/keys.ts";
import {
  people as peopleTable,
  settings as settingsTable,
  signalAnswers,
  threadRecommendations,
  threads as threadsTable,
} from "../src/db/schema.ts";
import {
  candidatePeople,
  parsePerson,
  type RecommendSettings,
  RULES_VERSION,
  recommendFor,
  snoozeUntil,
  unreadStreak,
} from "../src/intelligence/actions/recommend.ts";
import { ACTION_SIGNAL } from "../src/intelligence/actions/signals.ts";
import { recommendationText } from "../src/intelligence/agent/tools/recommended.ts";
import { createIntelligence, type Intelligence } from "../src/intelligence/index.ts";
import { createFakeChat, createFakeJudge } from "../src/intelligence/runtime/fake/index.ts";
import { createMailstore, type Mailstore } from "../src/mailstore/index.ts";
import { recommendationsRoutes } from "../src/routes/recommendations.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const NOW = new Date("2026-09-29T12:00:00Z");
const WORDS = {
  named: defaultSettings()["strings.actions.recommended.candidate.named"],
  handoff: defaultSettings()["strings.actions.recommended.candidate.handoff"],
  forwarded: defaultSettings()["strings.actions.recommended.candidate.forwarded"],
  copied: defaultSettings()["strings.actions.recommended.candidate.copied"],
  colleague: defaultSettings()["strings.actions.recommended.candidate.colleague"],
  frequent: defaultSettings()["strings.actions.recommended.candidate.frequent"],
};
const owner = { name: "Sam Okafor", email: "sam@monday.test" };

const SETTINGS: RecommendSettings = {
  noulLow: 0.3,
  noulHigh: 0.7,
  confidenceBelow: 0.5,
  nonEnglish: "unsure",
  zone: "UTC",
  morningHour: 8,
  afternoonHour: 14,
  eveningHour: 18,
  weekStart: 1,
  beforeDeadlineHours: 24,
};
const part = (choice: string, confidence = 0.9) => ({ choice, confidence });
// Written Tuesday 29 September 2026.
const written = new Date("2026-09-29T09:00:00Z");

describe("code puts the snooze time together", () => {
  const until = (
    anchor: string | null,
    extra: { weekday?: string; part?: string; deadlineAt?: string; confidence?: number } = {},
  ) =>
    snoozeUntil({
      anchor: anchor ? part(anchor, extra.confidence) : null,
      weekday: extra.weekday ? part(extra.weekday) : null,
      part: extra.part ? part(extra.part) : null,
      deadlineAt: extra.deadlineAt ?? null,
      written,
      now: NOW,
      settings: SETTINGS,
    }).until;
  test("a named day, tomorrow, next week, before a deadline and a date, at the part of the day", () => {
    expect(until("weekday", { weekday: "monday" })).toBe("2026-10-05T08:00:00.000Z");
    expect(until("weekday", { weekday: "tuesday", part: "evening" })).toBe(
      "2026-10-06T18:00:00.000Z",
    );
    expect(until("tomorrow", { part: "afternoon" })).toBe("2026-09-30T14:00:00.000Z");
    expect(until("next_week")).toBe("2026-10-05T08:00:00.000Z");
    expect(until("deadline", { deadlineAt: "2026-10-03T23:59:00.000Z" })).toBe(
      "2026-10-02T23:59:00.000Z",
    );
    expect(until("date", { deadlineAt: "2026-10-03T23:59:00.000Z" })).toBe(
      "2026-10-03T08:00:00.000Z",
    );
  });
  test("no day, an unsure anchor or a time already past opens the picker instead", () => {
    expect(until(null)).toBeNull();
    expect(until("none")).toBeNull();
    expect(until("weekday", { weekday: "monday", confidence: 0.3 })).toBeNull();
    expect(until("deadline", { deadlineAt: "2026-09-30T06:00:00.000Z" })).toBeNull();
    expect(until("deadline")).toBeNull();
  });
  test("the day counts in the Workspace's zone", () => {
    const at = snoozeUntil({
      anchor: part("tomorrow"),
      weekday: null,
      part: null,
      deadlineAt: null,
      written: new Date("2026-09-29T23:30:00Z"),
      now: NOW,
      settings: { ...SETTINGS, zone: "Europe/Dublin" },
    }).until;
    // Written at 00:30 on Wednesday in Dublin: tomorrow is Thursday, 08:00 Irish summer time.
    expect(at).toBe("2026-10-01T07:00:00.000Z");
  });
});

describe("which actions a Thread's answers allow", () => {
  const current = (noul: number): SignalReading => ({ noul, stale: false, version: 1 });
  const base = {
    now: NOW,
    facts: { last_activity_at: written.toISOString(), deadline_at: null },
    picks: undefined,
    people: [],
    settings: SETTINGS,
  };
  test("Reply reads needs_reply; Archive only when nothing on the Thread still wants the owner", () => {
    const recs = recommendFor({
      ...base,
      answers: {
        needs_reply: current(0.1),
        waiting_on_me: current(0.05),
        [ACTION_SIGNAL.archiveFits]: current(0.92),
      },
    });
    expect(recs.map((r) => r.kind)).toEqual(["archive"]);
    const busy = recommendFor({
      ...base,
      answers: {
        needs_reply: current(0.85),
        waiting_on_me: current(0.05),
        [ACTION_SIGNAL.archiveFits]: current(0.92),
      },
    });
    expect(busy.map((r) => r.kind)).toEqual(["reply"]);
    // A deadline still ahead keeps the Thread in view, unless has_deadline clearly fails.
    const ahead = recommendFor({
      ...base,
      facts: { ...base.facts, deadline_at: "2026-10-03T23:59:00.000Z" },
      answers: {
        needs_reply: current(0.1),
        waiting_on_me: current(0.1),
        has_deadline: current(0.5),
        [ACTION_SIGNAL.archiveFits]: current(0.92),
      },
    });
    expect(ahead).toEqual([]);
  });
  test("a stale answer is never acted on; a low-trust Thread gets nothing", () => {
    const stale = recommendFor({
      ...base,
      answers: {
        needs_reply: { noul: 0.9, stale: true },
        [ACTION_SIGNAL.snoozeFits]: current(0.9),
      },
    });
    expect(stale.map((r) => r.kind)).toEqual(["snooze"]);
    const french = recommendFor({
      ...base,
      answers: { needs_reply: { noul: 0.9, stale: false, lowTrust: "not_english" } },
    });
    expect(french).toEqual([]);
    const screened = recommendFor({
      ...base,
      answers: { needs_reply: current(0.9), hidden_instructions: current(0.95) },
    });
    expect(screened).toEqual([]);
  });
  test("Forward and Hand to need the person the judge picked among the ones code offered", () => {
    const answers = {
      [ACTION_SIGNAL.forwardFits]: current(0.9),
      [ACTION_SIGNAL.delegateFits]: current(0.2),
      [ACTION_SIGNAL.forwardTo]: { choice: "picked", confidence: 0.86, stale: false },
    };
    expect(recommendFor({ ...base, answers })).toEqual([]);
    const recs = recommendFor({
      ...base,
      answers,
      picks: { [ACTION_SIGNAL.forwardTo]: { value: "priya@monday.test", confidence: 0.86 } },
      people: [{ email: "priya@monday.test", name: "Priya Raman" }],
    });
    expect(recs).toEqual([
      {
        kind: "forward",
        fit: 0.9,
        rank: 0.9,
        to: { name: "Priya Raman", email: "priya@monday.test" },
        confidence: 0.86,
      },
    ]);
  });
  test("the people offered: never the owner, the sender or someone on the Thread", () => {
    const people = candidatePeople({
      owner: "sam@monday.test",
      sender: "billing@hetzner.com",
      named: ["accounts@monday.test", "sam@monday.test", "billing@hetzner.com", "ops@monday.test"],
      participants: ["ops@monday.test"],
      handoff: ["Priya Raman <Priya@monday.test>", "not an address"],
      forwarded: [],
      max: 12,
      words: { ...WORDS, named: "Named", handoff: "Hand-off list", forwarded: "Forwarded {count}" },
    });
    expect(people).toEqual([
      { email: "priya@monday.test", name: "Priya Raman", line: "Priya Raman, Hand-off list" },
      { email: "accounts@monday.test", name: "", line: "Named" },
    ]);
    expect(parsePerson("x@y.test")).toEqual({ name: "", email: "x@y.test" });
  });
  test("an unread streak counts the issue being read as unread, so opening it keeps Unsubscribe", () => {
    const issues = [
      { id: "n5", unread: false },
      { id: "n4", unread: true },
      { id: "n3", unread: true },
    ];
    // The newest issue was just opened in the reader (marked read): the streak holds for it.
    expect(unreadStreak(issues, "n5", 3)).toBe(true);
    // Seen from another issue, the read one breaks the streak.
    expect(unreadStreak(issues, "n4", 3)).toBe(false);
    // Fewer issues than the streak asks for is no streak.
    expect(unreadStreak(issues.slice(1), "n4", 3)).toBe(false);
  });
  test("the people offered beyond past forwards: copied, colleagues, frequent, each saying how they relate", () => {
    const people = candidatePeople({
      owner: "sam@genai-labs.io",
      sender: "billing@hetzner.com",
      named: ["named@else.test"],
      participants: [],
      handoff: [],
      forwarded: [{ email: "accounts@genai-labs.io", name: "", count: 3 }],
      copied: [{ email: "priya@genai-labs.io", name: "Priya Raman", count: 4 }],
      colleagues: [
        { email: "priya@genai-labs.io", name: "Priya Raman", count: 40 },
        { email: "jo@genai-labs.io", name: "Jo Park", count: 12 },
        { email: "sam@genai-labs.io", name: "Sam", count: 99 },
      ],
      frequent: [{ email: "mum@gmail.com", name: "", count: 30 }],
      names: new Map([["accounts@genai-labs.io", "Accounts"]]),
      max: 4,
      words: WORDS,
    });
    expect(people).toEqual([
      {
        email: "accounts@genai-labs.io",
        name: "Accounts",
        line: "Accounts, you forwarded 3 of billing@hetzner.com's threads to them",
      },
      {
        email: "priya@genai-labs.io",
        name: "Priya Raman",
        line: "Priya Raman, you copied them on 4 of your mails to hetzner.com",
      },
      {
        email: "jo@genai-labs.io",
        name: "Jo Park",
        line: "Jo Park, colleague at genai-labs.io, you wrote 12 times",
      },
      { email: "named@else.test", name: "", line: "Named in this thread" },
    ]);
  });
});

describe("Recommended actions over the Store", () => {
  let db: TestDatabase;
  let store: Mailstore;
  let workspaceId: string;
  const judge = createFakeJudge();
  let intelligence: Intelligence;

  const subjectOf = (state: unknown) =>
    (state as { thread?: { subject?: string } }).thread?.subject ?? "";
  const addThread = async (key: string, subject: string, text: string) => {
    const threadId = await store.upsertThread({
      workspaceId,
      providerThreadId: key,
      subject,
      participants: [{ name: "Hetzner Billing", email: "billing@hetzner.com" }, owner],
      lastActivity: "2026-09-29T09:00:00.000Z",
    });
    await store.upsertMessage({
      threadId,
      providerMessageId: `m-${key}`,
      from: { name: "Hetzner Billing", email: "billing@hetzner.com" },
      to: [owner],
      cc: [],
      date: "2026-09-29T09:00:00.000Z",
      headers: {},
      bodyText: text,
      bodyHtml: null,
      snippet: text.slice(0, 60),
    });
    return threadId;
  };
  const setSetting = async (key: string, value: unknown) => {
    await db.handle.db
      .insert(settingsTable)
      .values({ scope: "global", deviceId: null, key, value })
      .onConflictDoUpdate({
        target: [settingsTable.scope, settingsTable.deviceId, settingsTable.key],
        set: { value },
      });
  };
  const feed = async () =>
    (await store.listChanges(workspaceId, { since: 0, limit: 5000 })).changes as Change[];

  beforeAll(async () => {
    db = await testDatabase();
    const keys = createKeys(db.handle.db);
    await keys.unlock(randomKey());
    store = createMailstore(db.handle.db, keys);
    const account: Account = {
      id: "acct-recs",
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
    await setSetting("actions.delegate.people", ["Priya Raman <priya@monday.test>"]);
    judge.when((state) => subjectOf(state) === "Receipt for September", {
      needs_reply: 0.05,
      waiting_on_me: 0.05,
      has_deadline: 0.05,
      [ACTION_SIGNAL.archiveFits]: 0.93,
      [ACTION_SIGNAL.snoozeFits]: 0.8,
      [ACTION_SIGNAL.snoozeAnchor]: "weekday",
      [ACTION_SIGNAL.snoozeWeekday]: "monday",
      [ACTION_SIGNAL.snoozePart]: "none",
      [ACTION_SIGNAL.forwardFits]: 0.9,
      [ACTION_SIGNAL.delegateFits]: 0.1,
      [ACTION_SIGNAL.forwardTo]: {
        type: "choice",
        choice: "accounts@monday.test",
        probabilities: { "accounts@monday.test": 0.9, "priya@monday.test": 0.1, none: 0 },
        confidence: 0.85,
      },
    });
    judge.when((state) => subjectOf(state) === "Quick question", {
      needs_reply: 0.9,
      [ACTION_SIGNAL.forwardFits]: 0.9,
      [ACTION_SIGNAL.forwardTo]: {
        type: "choice",
        choice: "priya@monday.test",
        probabilities: { "priya@monday.test": 0.55, none: 0.45 },
        confidence: 0.1,
      },
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
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  });

  test("Forward candidates come from the owner's mail: copied on mail to the sender's domain, colleagues, people written to often", async () => {
    await db.handle.db.insert(peopleTable).values([
      { workspaceId, address: "dana@monday.test", name: "Dana Lee", sentCount: 40 },
      { workspaceId, address: "rare@monday.test", name: "Rare One", sentCount: 1 },
      { workspaceId, address: "mum@example.org", name: "Mum", sentCount: 25 },
    ]);
    const earlier = await store.upsertThread({
      workspaceId,
      providerThreadId: "owner-to-hetzner",
      subject: "Our invoice address",
      participants: [owner, { name: "Hetzner Billing", email: "billing@hetzner.com" }],
      lastActivity: "2026-09-01T09:00:00.000Z",
    });
    await store.upsertMessage({
      threadId: earlier,
      providerMessageId: "m-owner-to-hetzner",
      from: owner,
      to: [{ name: "Hetzner Support", email: "support@hetzner.com" }],
      cc: [{ name: "Kim Finance", email: "kim@monday.test" }],
      date: "2026-09-01T09:00:00.000Z",
      headers: {},
      bodyText: "Please use our new address.",
      bodyHtml: null,
      snippet: "Please use our new address.",
    });
    const found = await intelligence.recommendations.candidates({
      workspaceId,
      threadId: earlier,
      owner: owner.email,
      sender: "billing@hetzner.com",
      named: [],
      participants: [],
    });
    expect(found.people).toEqual([
      {
        email: "priya@monday.test",
        name: "Priya Raman",
        line: "Priya Raman, On your hand-off list",
      },
      {
        email: "kim@monday.test",
        name: "Kim Finance",
        line: "Kim Finance, you copied them on 1 of your mails to hetzner.com",
      },
      {
        email: "dana@monday.test",
        name: "Dana Lee",
        line: "Dana Lee, colleague at monday.test, you wrote 40 times",
      },
      { email: "mum@example.org", name: "Mum", line: "Mum, you wrote to them 25 times" },
    ]);
    // The rest of the suite starts from an owner with no such history.
    await db.handle.db.delete(peopleTable);
    await db.handle.db.delete(threadsTable).where(eq(threadsTable.id, earlier));
  });

  test("one Signal request carries the action Signals; the recipient Choice offers the people code found", async () => {
    const receipt = await addThread(
      "receipt",
      "Receipt for September",
      "Your payment was received. Please keep this receipt for your records or send it to accounts@monday.test.",
    );
    const before = judge.calls.length;
    await intelligence.signals.ask(workspaceId, receipt, { reason: "arrival" });
    const sent = judge.calls.slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.questions).toEqual(
      expect.arrayContaining([
        "needs_reply",
        ACTION_SIGNAL.archiveFits,
        ACTION_SIGNAL.snoozeFits,
        ACTION_SIGNAL.snoozeAnchor,
        ACTION_SIGNAL.snoozeWeekday,
        ACTION_SIGNAL.snoozePart,
        ACTION_SIGNAL.forwardFits,
        ACTION_SIGNAL.delegateFits,
        ACTION_SIGNAL.forwardTo,
      ]),
    );
    const defs = await intelligence.signals.defs(workspaceId);
    const to = defs.find((d) => d.id === ACTION_SIGNAL.forwardTo);
    expect(to?.owner).toEqual({ kind: "recommended_action", id: "forward" });
    expect(to?.gate).toBe("addresses");

    const recs = await intelligence.recommendations.get(receipt);
    expect(recs?.fromDomain).toBe("hetzner.com");
    expect(recs?.actions.map((a) => a.kind)).toEqual(["archive", "forward", "snooze"]);
    const forward = recs?.actions.find((a) => a.kind === "forward");
    expect(forward).toMatchObject({
      to: { email: "accounts@monday.test" },
      confidence: 0.85,
      fit: 0.9,
    });
    expect(recs?.actions.find((a) => a.kind === "snooze")).toMatchObject({
      until: "2026-10-05T08:00:00.000Z",
      anchor: "weekday",
    });

    // The person stays sealed: the answer row says only that one was picked; the feed carries kinds.
    const row = await db.handle.db.query.signalAnswers.findFirst({
      where: (t, { and, eq }) =>
        and(eq(t.threadId, receipt), eq(t.signalId, ACTION_SIGNAL.forwardTo)),
    });
    expect(row?.choice).toBe("picked");
    const changes = (await feed()).filter(
      (c): c is Change & { kind: "recommendations" } =>
        c.kind === "recommendations" && c.entityId === receipt,
    );
    expect(changes.at(-1)?.payload).toMatchObject({
      threadId: receipt,
      kinds: ["archive", "forward", "snooze"],
    } satisfies Partial<RecommendationsChange>);
    expect(JSON.stringify(changes)).not.toContain("accounts@monday.test");
  });

  test("the recipient Choice lists the people with their lines; a Thread with none is not asked", async () => {
    const receiptCall = judge.calls.find((c) => subjectOf(c.state) === "Receipt for September");
    expect(receiptCall).toBeDefined();
    const plain = await addThread("plain", "Plain note", "Thanks, all good.");
    await setSetting("actions.delegate.people", []);
    const before = judge.calls.length;
    await intelligence.signals.ask(workspaceId, plain, { reason: "arrival" });
    const sent = judge.calls.slice(before);
    expect(sent[0]?.questions).not.toContain(ACTION_SIGNAL.forwardTo);
    const answers = (await intelligence.signals.readings([plain])).get(plain);
    expect(answers?.[ACTION_SIGNAL.forwardTo]).toMatchObject({ choice: "none", model: "code" });
    await setSetting("actions.delegate.people", ["Priya Raman <priya@monday.test>"]);
  });

  test("a forward shows only when the person is picked at the recipient floor (acceptance 4)", async () => {
    const question = await addThread(
      "question",
      "Quick question",
      "Could you forward this to the team? Priya might know.",
    );
    await intelligence.signals.ask(workspaceId, question, { reason: "arrival" });
    const recs = await intelligence.recommendations.get(question);
    const forward = recs?.actions.find((a) => a.kind === "forward");
    // The Server keeps the unsure pick with its confidence; the chips hold it back.
    expect(forward).toMatchObject({ to: { email: "priya@monday.test" }, confidence: 0.1 });
    const rules = recommendationRules(defaultSettings());
    expect(
      chooseRecommended(recs?.actions ?? [], rules, { fromDomain: recs?.fromDomain ?? null }).map(
        (r) => r.kind,
      ),
    ).toEqual(["reply"]);
  });

  test("the reader's open works them out again; the route and the Agent read the same list", async () => {
    const receipt = (await db.handle.db.query.threads.findFirst({
      where: (t, { eq }) => eq(t.providerThreadId, "receipt"),
    })) as { id: string };
    const routes = recommendationsRoutes(intelligence);
    const got = await routes.request(`/threads/${receipt.id}/recommendations`);
    expect(got.status).toBe(200);
    const body = (await got.json()) as { actions: Array<{ kind: string }> };
    expect(body.actions.map((a) => a.kind)).toEqual(["archive", "forward", "snooze"]);
    expect((await routes.request("/threads/nope/recommendations")).status).toBe(404);
    const before = judge.calls.length;
    const opened = await routes.request(`/threads/${receipt.id}/recommendations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: workspaceId, zone: "Europe/Dublin" }),
    });
    expect(opened.status).toBe(200);
    // The Thread version was asked already: opening asks the judge nothing.
    expect(judge.calls.length).toBe(before);

    const view = await intelligence.recommendations.view(workspaceId, receipt.id);
    expect(view?.stale).toBe(false);
    expect(view?.shown.map((a) => a.label)).toEqual([
      "Archive",
      "Forward to accounts@monday.test",
      // Worked out again in the zone the Device reported: Monday at the morning hour in Dublin.
      "Snooze until Mon 08:00",
    ]);
    const text = recommendationText(view as NonNullable<typeof view>);
    expect(text).toContain("archive_threads");
    expect(text).toContain("Nothing was done.");
  });

  test("rows an older version of the rules worked out are worked out again from their answers, the judge not asked", async () => {
    const receipt = (await db.handle.db.query.threads.findFirst({
      where: (t, { eq }) => eq(t.providerThreadId, "receipt"),
    })) as { id: string };
    await db.handle.db
      .update(threadRecommendations)
      .set({ rules: 0, computedAt: new Date("2026-09-01T00:00:00Z") });
    const before = judge.calls.length;
    expect(await intelligence.recommendations.recomputeOutdated()).toBeGreaterThan(0);
    expect(judge.calls.length).toBe(before);
    const row = await db.handle.db.query.threadRecommendations.findFirst({
      where: (t, { eq }) => eq(t.threadId, receipt.id),
    });
    expect(row?.rules).toBe(RULES_VERSION);
    expect(row?.computedAt.toISOString()).toBe(NOW.toISOString());
    // Nothing older is left: a second walk works out nothing.
    expect(await intelligence.recommendations.recomputeOutdated()).toBe(0);
  });

  test("a new Message makes the answers stale: nothing acts on them until they are read again", async () => {
    const receipt = (await db.handle.db.query.threads.findFirst({
      where: (t, { eq }) => eq(t.providerThreadId, "receipt"),
    })) as { id: string };
    await store.upsertMessage({
      threadId: receipt.id,
      providerMessageId: "m-receipt-2",
      from: { name: "Hetzner Billing", email: "billing@hetzner.com" },
      to: [owner],
      cc: [],
      date: "2026-09-29T11:00:00.000Z",
      headers: {},
      bodyText: "One more thing: please check the attached statement.",
      bodyHtml: null,
      snippet: "One more thing",
    });
    const view = await intelligence.recommendations.view(workspaceId, receipt.id);
    expect(view?.stale).toBe(true);
    const again = await intelligence.recommendations.refresh(workspaceId, receipt.id);
    expect(again?.actions).toEqual([]);
    const rows = await db.handle.db.select().from(signalAnswers);
    expect(rows.length).toBeGreaterThan(0);
  });

  test("the judged chip questions are gone: no chip_* Signal is asked or defined", async () => {
    const defs = await intelligence.signals.defs(workspaceId);
    expect(defs.filter((d) => d.active && d.id.startsWith("chip_"))).toEqual([]);
    expect(judge.calls.some((c) => c.questions.some((q) => q.startsWith("chip_")))).toBe(false);
    const q = defs.find((d) => d.id === ACTION_SIGNAL.snoozeAnchor)?.question as ChoiceQuestion;
    expect(Object.keys(q.criteria).sort()).toEqual([
      "date",
      "deadline",
      "next_week",
      "none",
      "tomorrow",
      "weekday",
    ]);
  });
});
