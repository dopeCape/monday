// Judgments on arrival (slice 25, ADR 0012) through the interfaces over the
// fake seams: the routing Choice and its placement from probabilities and
// confidence, the arrival request's questions and how its answers are read,
// the judge brief policy, and the recorded fixture mailbox synced through the
// engine with the fake judge scripted by subject: routes and Sections with
// the expected confidences, the judge Jobs from the thread observer, the feed
// rows, a newsletter that gets no Brief and the term sheet that gets one
// before open. The same mailbox through the language model path gives the
// same placements.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
  Account,
  Change,
  GroupView,
  RoutingApplied,
  RoutingPreview,
  Thread,
  ThreadJudgments,
} from "@monday/shared";
import { DEFAULT_SECTION_RULES, defaultSettings, sectionOf } from "@monday/shared";
import type { Hono } from "hono";
import { type AppEnv, createApp } from "../src/app.ts";
import { createAuth } from "../src/auth/index.ts";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys, type Keys } from "../src/crypto/keys.ts";
import { briefs as briefsTable, settings as settingsTable } from "../src/db/schema.ts";
import {
  BRIEF_STEP,
  createIntelligence,
  type Intelligence,
  JUDGE_STEP,
  judgedPolicy,
  judgmentQuestions,
  judgmentState,
  ROUTE_STEP,
  readJudgments,
} from "../src/intelligence/index.ts";
import {
  judgedPlacement,
  NONE_OPTION,
  optionName,
  routeQuestion,
} from "../src/intelligence/routing/judge.ts";
import {
  createFakeChat,
  createFakeJudge,
  type FakeJudgeAnswer,
} from "../src/intelligence/runtime/fake/index.ts";
import type { ChatCall } from "../src/intelligence/runtime/index.ts";
import { createJobs, type Jobs } from "../src/jobs/index.ts";
import { createMailstore, type Mailstore } from "../src/mailstore/index.ts";
import { createCredentialStore } from "../src/providers/credentials.ts";
import {
  createFakeProvider,
  type FakeProvider,
  fakeCredentials,
  generateFixture,
} from "../src/providers/fake/index.ts";
import { createProviderRegistry } from "../src/providers/index.ts";
import { createSyncEngine, defaultSyncSettings, type SyncEngine } from "../src/providers/sync.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const SIDECAR_TOKEN = "per-launch-token";
const fixture = generateFixture();
const NOW = new Date(fixture.recordedAt);
const thresholds = { route: 0.8, ask: 0.5, tieMargin: 0.1 };

const account: Account = {
  id: "acct-judgments",
  provider: "imap",
  address: fixture.address,
  displayName: fixture.owner.name,
  capabilities: {
    push: true,
    labels: false,
    snooze: false,
    mute: false,
    calendar: false,
    meetingLink: null,
  },
};

/** A Thread's subject as the fixture names it, whichever reply the engine saw first. */
const plainSubject = (subject: string) => subject.replace(/^(re|fwd?):\s*/i, "");

/** The subject inside a judge request's state, for scripting by Thread. */
const subjectOf = (state: unknown): string =>
  plainSubject(String((state as { thread?: { subject?: unknown } } | null)?.thread?.subject ?? ""));

/**
 * The routing answers per fixture subject, as the language model path's
 * table in routing.test.ts gives them, now as one Choice over the option
 * names with the same numbers as probabilities. The Thursday call is the
 * uncertain one: the judge's confidence is low, so it is Needs a decision.
 */
const ROUTE: Record<string, FakeJudgeAnswer> = {
  "Candidate: Elin Vos, backend": {
    type: "choice",
    choice: "hiring",
    probabilities: {
      hiring: 0.96,
      finance: 0.02,
      press: 0.01,
      candidates: 0.93,
      interviews: 0.2,
      none: 0.01,
    },
    confidence: 1,
  },
  "Interview loop for Monday": {
    type: "choice",
    choice: "hiring",
    probabilities: {
      hiring: 0.9,
      finance: 0.03,
      press: 0.02,
      candidates: 0.3,
      interviews: 0.88,
      none: 0.05,
    },
    confidence: 1,
  },
  "Renewal for the domain": {
    type: "choice",
    choice: "finance",
    probabilities: { hiring: 0.02, finance: 0.9, press: 0.01, none: 0.07 },
    confidence: 1,
  },
  "Podcast recording slot": {
    type: "choice",
    choice: "press",
    probabilities: { hiring: 0.03, finance: 0.01, press: 0.97, none: 0 },
    confidence: 1,
  },
  "Can we move Thursday's call?": {
    type: "choice",
    choice: "hiring",
    probabilities: { hiring: 0.62, finance: 0.05, press: 0.55, none: 0.1 },
    confidence: 0.4,
  },
};
const ROUTE_NONE: FakeJudgeAnswer = {
  type: "choice",
  choice: NONE_OPTION,
  probabilities: { hiring: 0, finance: 0, press: 0, none: 1 },
  confidence: 1,
};

/**
 * The arrival request's answers per subject, after the research note's
 * table: the candidate thread needs a reply, the contract (the term sheet)
 * is worth a Brief before open and the owner is waiting on it, the digest
 * is a newsletter worth nothing, the invoice is automated and asks to be
 * paid, the podcast host wants a call.
 */
const ARRIVAL: Record<string, Record<string, FakeJudgeAnswer>> = {
  "Candidate: Elin Vos, backend": {
    needs_reply: 0.64,
    waiting_on_others: 0.2,
    newsletter: 0.07,
    automated: 0.05,
    brief_worth: 1.0,
    urgency: 1.2,
    chip_reply: 0.84,
    chip_call: 0.86,
    chip_open_attachment: 0.1,
  },
  "Draft contract for review": {
    needs_reply: 0.58,
    waiting_on_others: 0.8,
    newsletter: 0.07,
    automated: 0.03,
    brief_worth: 1.9,
    urgency: 1.8,
    chip_reply: 0.4,
    chip_open_attachment: 0.74,
    chip_review_link: 0.3,
  },
  "Weekly digest": {
    needs_reply: 0.07,
    waiting_on_others: 0.02,
    newsletter: 0.93,
    automated: 0.6,
    brief_worth: 0,
    urgency: 1.0,
    chip_snooze: 0.7,
  },
  "Invoice 2041 for August": {
    needs_reply: 0.03,
    waiting_on_others: 0.1,
    newsletter: 0.2,
    automated: 0.9,
    brief_worth: 0,
    urgency: 0.5,
    chip_pay_or_file: 0.9,
  },
  "Podcast recording slot": {
    needs_reply: 0.91,
    waiting_on_others: 0.05,
    newsletter: 0.11,
    automated: 0.05,
    brief_worth: 0.5,
    urgency: 0.5,
    chip_reply: 0.7,
    chip_call: 0.93,
  },
};
const ARRIVAL_DEFAULT: Record<string, FakeJudgeAnswer> = {
  needs_reply: 0.2,
  waiting_on_others: 0.1,
  newsletter: 0.05,
  automated: 0.05,
  brief_worth: 0.7,
  urgency: 0.4,
};

/** The language model's classify answer, the same table as routing.test.ts. */
const CONFIDENCE: Record<string, Record<string, number>> = {
  "Candidate: Elin Vos, backend": {
    Hiring: 0.96,
    Finance: 0.02,
    Press: 0.01,
    Candidates: 0.93,
    Interviews: 0.2,
  },
  "Interview loop for Monday": {
    Hiring: 0.9,
    Finance: 0.03,
    Press: 0.02,
    Candidates: 0.3,
    Interviews: 0.88,
  },
  "Renewal for the domain": { Hiring: 0.02, Finance: 0.9, Press: 0.01 },
  "Podcast recording slot": { Hiring: 0.03, Finance: 0.01, Press: 0.97 },
  "Can we move Thursday's call?": { Hiring: 0.62, Finance: 0.05, Press: 0.55 },
};

function classifyAnswer(call: ChatCall): string {
  const subject = plainSubject(/^Subject: (.*)$/m.exec(call.prompt)?.[1] ?? "");
  const table = CONFIDENCE[subject] ?? {};
  const out: Record<string, number> = {};
  for (const m of call.prompt.matchAll(/^(G\d+)\. (.+)$/gm)) {
    out[m[1] as string] = table[m[2] as string] ?? 0.05;
  }
  return JSON.stringify(out);
}

const BRIEF = JSON.stringify({
  bullets: ["**Priya** sent the redline; the **indemnity** cap is the open point."],
  actions: [{ kind: "reply", label: "Reply", proposedLine: "Thanks, looking now." }],
});

async function allThreads(store: Mailstore, workspaceId: string): Promise<Thread[]> {
  const out: Thread[] = [];
  let cursor: string | null = null;
  do {
    const page = await store.listThreads(workspaceId, {
      limit: 100,
      cursor,
      includeArchived: true,
    });
    out.push(...page.threads);
    cursor = page.cursor;
  } while (cursor);
  return out;
}

/* ------------------------------ Pure ------------------------------ */

describe("the routing Choice", () => {
  const facts = {
    subject: "Invoice 2041",
    from: { name: "Mateo", email: "mateo@lumen.test" },
    to: [{ name: "Sam", email: "sam@monday.test" }],
    participants: [{ name: "Aoife", email: "aoife@northwind.test" }],
    headers: { "list-id": "<x.test>", "x-mailer": "y" },
    snippet: "Amount due by Friday, see attached.",
    hasAttachments: true,
    messageCount: 2,
  };
  const groups = [
    {
      id: "g-a",
      name: "Finance",
      sentence: "Money in and out.",
      prompt: "",
      predicate: { domains: ["lumen.test"] },
      examples: [],
    },
    {
      id: "g-b",
      name: "Hiring & People",
      sentence: "Candidates.",
      prompt: "Candidates and recruiters, never invoices.",
      predicate: {},
      examples: [
        { positive: false, from: { name: "", email: "b@x.test" }, subject: "invoice 1" },
        { positive: true, from: null, subject: "take-home" },
      ],
    },
  ];
  const settings = {
    instructions: "Which Group?",
    noneOption: "No Group fits.",
    snippetChars: 20,
    examplesInPrompt: 6,
  };

  test("options are the Groups by name plus none, the Examples ride inside the instructions, the state is headers and a snippet", () => {
    const asked = routeQuestion(facts, groups, "sam@monday.test", settings);
    expect(asked.options).toEqual({ finance: "g-a", hiring_people: "g-b" });
    expect(asked.question.type).toBe("choice");
    expect(Object.keys(asked.question.criteria)).toEqual(["finance", "hiring_people", "none"]);
    expect(asked.question.criteria.finance).toEqual({
      name: "Finance",
      rule: "Money in and out.",
      always: { domains: ["lumen.test"] },
    });
    expect(asked.question.criteria.hiring_people).toMatchObject({
      criteria: "Candidates and recruiters, never invoices.",
    });
    expect(asked.question.criteria.none).toBe("No Group fits.");
    expect(asked.question.instructions).toEqual({
      question: "Which Group?",
      examples_note: "The owner's own past decisions; they outrank the descriptions.",
      examples: [
        { group: "hiring_people", belongs: true, from: null, subject: "take-home" },
        {
          group: "hiring_people",
          belongs: false,
          from: { name: null, email: "b@x.test" },
          subject: "invoice 1",
        },
      ],
    });
    expect(asked.state).toEqual({
      owner: "sam@monday.test",
      thread: {
        subject: "Invoice 2041",
        from: { name: "Mateo", email: "mateo@lumen.test" },
        to: [{ name: "Sam", email: "sam@monday.test" }],
        also_on_thread: [{ name: "Aoife", email: "aoife@northwind.test" }],
        message_count: 2,
        has_attachments: true,
        list_headers: { "list-id": "<x.test>" },
        newest_message_snippet: "Amount due by Friday",
      },
    });
    // Without Examples the instructions are the plain question.
    const plain = routeQuestion(facts, [groups[0] as (typeof groups)[0]], "me", settings);
    expect(plain.question.instructions).toBe("Which Group?");
    // Option names never collide, not even with none.
    const taken = new Set(["none", "finance"]);
    expect(optionName("Finance", taken)).toBe("finance_2");
    expect(optionName("None", taken)).toBe("none_group");
    expect(optionName("!!!", taken)).toBe("group");
  });

  test("placement reads the probabilities and the confidence: route, ask on low confidence, none leaves alone", () => {
    const options = { finance: "g-a", hiring: "g-b" };
    const sure = judgedPlacement(
      {
        type: "choice",
        choice: "finance",
        probabilities: { finance: 0.9, hiring: 0.1 },
        confidence: 1,
      },
      options,
      thresholds,
    );
    expect(sure.placement).toEqual({ kind: "route", groupId: "g-a", confidence: 0.9 });
    expect(sure.scores).toEqual([
      { groupId: "g-a", confidence: 0.9 },
      { groupId: "g-b", confidence: 0.1 },
    ]);
    // A Group's own threshold still applies to the probability.
    expect(
      judgedPlacement(
        { type: "choice", choice: "finance", probabilities: { finance: 0.9 }, confidence: 1 },
        options,
        thresholds,
        (id) => (id === "g-a" ? 0.95 : null),
      ).placement,
    ).toEqual({ kind: "ask", candidates: [{ groupId: "g-a", confidence: 0.9 }] });
    // Low confidence is Needs a decision with the likeliest Groups, best first.
    const unsure = judgedPlacement(
      {
        type: "choice",
        choice: "hiring",
        probabilities: { finance: 0.45, hiring: 0.5 },
        confidence: 0.3,
      },
      options,
      thresholds,
    );
    expect(unsure.placement).toEqual({
      kind: "ask",
      candidates: [
        { groupId: "g-b", confidence: 0.5 },
        { groupId: "g-a", confidence: 0.45 },
      ],
    });
    expect(unsure.confidence).toBe(0.3);
    // none leaves the Thread alone even at a high probability elsewhere.
    expect(
      judgedPlacement(
        {
          type: "choice",
          choice: "none",
          probabilities: { finance: 0.85, none: 0.15 },
          confidence: 0.9,
        },
        options,
        thresholds,
      ).placement,
    ).toEqual({ kind: "none", best: { groupId: "g-a", confidence: 0.85 } });
  });
});

describe("the arrival request", () => {
  test("one question per Setting, the state without bodies, and the answers read back clamped", () => {
    const d = defaultSettings();
    const questions = judgmentQuestions({
      needsReply: d["judgments.questions.needs_reply"],
      waitingOnOthers: d["judgments.questions.waiting_on_others"],
      newsletter: d["judgments.questions.newsletter"],
      automated: d["judgments.questions.automated"],
      briefWorth: d["judgments.questions.brief_worth"],
      briefWorthLevels: d["judgments.questions.brief_worth_levels"],
      urgency: d["judgments.questions.urgency"],
      urgencyLevels: d["judgments.questions.urgency_levels"],
      chips: {
        reply: d["judgments.questions.chip.reply"],
        call: d["judgments.questions.chip.call"],
        review_link: d["judgments.questions.chip.review_link"],
        open_attachment: d["judgments.questions.chip.open_attachment"],
        pay_or_file: d["judgments.questions.chip.pay_or_file"],
        snooze: d["judgments.questions.chip.snooze"],
      },
    });
    expect(Object.keys(questions)).toEqual([
      "needs_reply",
      "waiting_on_others",
      "newsletter",
      "automated",
      "brief_worth",
      "urgency",
      "chip_reply",
      "chip_call",
      "chip_review_link",
      "chip_open_attachment",
      "chip_pay_or_file",
      "chip_snooze",
    ]);
    expect(questions.needs_reply).toEqual({
      type: "noul",
      instructions: d["judgments.questions.needs_reply"],
    });
    expect(questions.brief_worth).toMatchObject({ type: "score" });
    expect(questions.brief_worth.criteria).toHaveLength(4);
    expect(questions.urgency.criteria).toHaveLength(4);

    const state = judgmentState(
      {
        owner: "sam@monday.test",
        subject: "Term sheet redline v3",
        from: { name: "Kenji", email: "kenji@fund.test" },
        to: [{ name: "Sam", email: "sam@monday.test" }],
        participants: [{ name: "Kenji", email: "kenji@fund.test" }],
        headers: { "list-unsubscribe": "<x>", "x-mailer": "y" },
        snippet: "Redline attached, the indemnity cap moved.",
        hasAttachments: true,
        attachmentNames: ["term-sheet-v3.pdf"],
        messageCount: 3,
        ownerWroteLast: false,
      },
      16,
    );
    expect(state).toEqual({
      owner: "sam@monday.test",
      thread: {
        subject: "Term sheet redline v3",
        from: { name: "Kenji", email: "kenji@fund.test" },
        to: [{ name: "Sam", email: "sam@monday.test" }],
        also_on_thread: [],
        message_count: 3,
        owner_wrote_last: false,
        has_attachments: true,
        attachment_names: ["term-sheet-v3.pdf"],
        list_headers: { "list-unsubscribe": "<x>" },
        newest_message_snippet: "Redline attached",
      },
    });

    const judged = readJudgments(
      {
        needs_reply: { type: "noul", noul: 0.58 },
        waiting_on_others: { type: "noul", noul: 1.4 },
        newsletter: { type: "noul", noul: -1 },
        automated: { type: "noul", noul: 0.07 },
        brief_worth: { type: "score", score: 1.9, probabilities: [], confidence: 0.5 },
        urgency: { type: "score", score: 7, probabilities: [], confidence: 0.5 },
        chip_reply: { type: "noul", noul: 0.4 },
        chip_call: { type: "noul", noul: 0.1 },
        chip_review_link: { type: "noul", noul: 0.3 },
        chip_open_attachment: { type: "noul", noul: 0.74 },
        chip_pay_or_file: { type: "noul", noul: 0.05 },
        chip_snooze: { type: "noul", noul: 0.02 },
      },
      {
        threadId: "t1",
        model: "jev-1.13.0",
        judgedAt: "2026-09-21T09:00:00.000Z",
        levels: { briefWorth: 4, urgency: 4 },
      },
    );
    expect(judged).toEqual({
      threadId: "t1",
      needsReply: 0.58,
      waitingOnOthers: 1,
      newsletter: 0,
      automated: 0.07,
      briefWorth: 1.9,
      urgency: 3,
      chips: {
        reply: 0.4,
        call: 0.1,
        review_link: 0.3,
        open_attachment: 0.74,
        pay_or_file: 0.05,
        snooze: 0.02,
      },
      model: "jev-1.13.0",
      judgedAt: "2026-09-21T09:00:00.000Z",
    });
  });

  test("the judge brief policy: never below, always from, on open between, newsletters never in the background", () => {
    const d = defaultSettings();
    const gates = {
      alwaysAtLeast: d["briefs.judge.always_at_least"],
      neverBelow: d["briefs.judge.never_below"],
      newsletterAtLeast: d["briefs.judge.newsletter_at_least"],
    };
    const at = (briefWorth: number, newsletter = 0.1, automated = 0.1) =>
      judgedPolicy({ briefWorth, newsletter, automated }, gates);
    expect(at(1.9)).toBe("always");
    expect(at(1.5)).toBe("always");
    expect(at(1.0)).toBe("on_open");
    expect(at(0.5)).toBe("on_open");
    expect(at(0.4)).toBe("never");
    expect(at(0)).toBe("never");
    // A newsletter worth a lot still waits for open; one worth nothing gets nothing.
    expect(at(2.5, 0.92)).toBe("on_open");
    expect(at(2.5, 0.1, 0.9)).toBe("on_open");
    expect(at(0.4, 0.92)).toBe("never");
  });
});

/* ------------------------------ The fixture mailbox ------------------------------ */

describe("judgments over the fixture mailbox", () => {
  let db: TestDatabase;
  let keys: Keys;
  let store: Mailstore;
  let jobs: Jobs;
  let engine: SyncEngine;
  let fake: FakeProvider;
  /** The judge path: a TypeSafe key and the fake judge. */
  let judged: Intelligence;
  /** The language model path: the same Server without a TypeSafe key. */
  let llm: Intelligence;
  let judge: ReturnType<typeof createFakeJudge>;
  let chat: ReturnType<typeof createFakeChat>;
  let app: Hono<AppEnv>;
  let workspaceId = "";
  const groupIds = { Hiring: "", Candidates: "", Interviews: "", Finance: "", Press: "" };
  let threadsBySubject: Map<string, Thread>;

  const request = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SIDECAR_TOKEN}`,
        ...(init.headers ?? {}),
      },
    });
  const send = (path: string, body: unknown, method = "POST") =>
    request(path, { method, body: JSON.stringify(body) });

  const setSetting = async (key: string, value: unknown) => {
    await db.handle.db
      .insert(settingsTable)
      .values({ scope: "global", deviceId: null, key, value })
      .onConflictDoUpdate({
        target: [settingsTable.scope, settingsTable.deviceId, settingsTable.key],
        set: { value },
      });
  };

  const subjectsOf = async () => {
    const map = new Map<string, Thread>();
    for (const t of await allThreads(store, workspaceId)) {
      map.set(plainSubject(await store.readThreadSubject(t.id)), t);
    }
    return map;
  };
  const threadOf = (subject: string): Thread => {
    const t = threadsBySubject.get(subject);
    if (!t) throw new Error(`no fixture thread ${subject}`);
    return t;
  };
  const runAll = async (): Promise<Record<string, number>> => {
    const ran: Record<string, number> = {};
    for (;;) {
      const job = await jobs.claim("server-a", ["needs-process"], 30_000);
      if (!job) return ran;
      expect(await jobs.run(job, 30_000)).toBe("done");
      ran[job.class] = (ran[job.class] ?? 0) + 1;
    }
  };
  const feed = async () =>
    (await store.listChanges(workspaceId, { since: 0, limit: 5000 })).changes;
  /** The Section the client would give a Thread, from the shipped rules over its row and its Judgments. */
  const sectionFor = async (subject: string) => {
    const t = threadOf(subject);
    const headers = await store.listMessages(t.id);
    const last = headers[headers.length - 1];
    return sectionOf(
      t,
      {
        lastSender: last?.from.email.toLowerCase() ?? null,
        owner: fixture.address,
        judgments: await judged.judgments.get(t.id),
      },
      DEFAULT_SECTION_RULES,
      ["needs-reply", "waiting", "fyi", "newsletters"],
    );
  };

  beforeAll(async () => {
    db = await testDatabase();
    keys = createKeys(db.handle.db);
    await keys.unlock(randomKey());
    store = createMailstore(db.handle.db, keys);
    const credentials = createCredentialStore(db.handle.db, store);
    fake = createFakeProvider(fixture);
    workspaceId = (await store.createWorkspace(account)).id;
    await credentials.store(workspaceId, account.id, fakeCredentials());
    jobs = createJobs(db.handle.db, { now: () => NOW });
    engine = createSyncEngine({
      db: db.handle.db,
      mailstore: store,
      providers: createProviderRegistry({ overrides: { imap: fake } }),
      credentials,
      // Every fixture body, so the thread observer sees all 24 Threads.
      settings: async () => ({ ...defaultSyncSettings(), batchSize: 25, bodyWindowDays: 365 }),
      now: () => NOW,
      watchDebounceMs: 50,
    });
    // The judge, scripted by the subject in the state: routing answers and arrival answers together.
    judge = createFakeJudge();
    for (const [subject, group] of Object.entries(ROUTE)) {
      judge.when((s) => subjectOf(s) === subject, { group, ...(ARRIVAL[subject] ?? {}) });
    }
    for (const [subject, answers] of Object.entries(ARRIVAL)) {
      if (!(subject in ROUTE))
        judge.when((s) => subjectOf(s) === subject, { group: ROUTE_NONE, ...answers });
    }
    judge.when(() => true, { group: ROUTE_NONE, ...ARRIVAL_DEFAULT });
    chat = createFakeChat((call) =>
      call.system.startsWith("You route email threads") ? classifyAnswer(call) : BRIEF,
    );
    const shared = { anthropic: "sk-ant-shared", typesafe: "ts-shared" };
    judged = createIntelligence({
      level: async () => "automate",
      db: db.handle.db,
      mailstore: store,
      chat: chat.chat,
      judge: judge.judge,
      keys: async (provider) => (shared as Record<string, string>)[provider] ?? null,
      now: () => NOW,
    });
    llm = createIntelligence({
      level: async () => "automate",
      db: db.handle.db,
      mailstore: store,
      chat: chat.chat,
      judge: judge.judge,
      keys: async (provider) => (provider === "anthropic" ? shared.anthropic : null),
      now: () => NOW,
    });
    judged.registerSteps(jobs);
    const auth = createAuth({ db: db.handle.db, sidecarToken: SIDECAR_TOKEN });
    app = createApp({
      db: db.handle.db,
      auth,
      mode: "sidecar",
      keys,
      mailstore: store,
      jobs,
      sync: engine,
      intelligence: judged,
      remoteAddress: () => "127.0.0.1",
    });
    // The fixture spans 120 days and its short notes: the background gates would hide the policy.
    await setSetting("briefs.background_lookback_days", 365);
    await setSetting("briefs.skip_under_words", 0);
    // The recorded mailbox, headers and bodies, through the engine.
    let report = await engine.syncAccount(account.id);
    for (let i = 0; i < 60 && report.more; i++) report = await engine.syncAccount(account.id);
    expect(report.more).toBe(false);
    threadsBySubject = await subjectsOf();
    expect(threadsBySubject.size).toBe(24);
    // The Groups of the routing test, made through the routes.
    const make = async (name: string, body: Record<string, unknown>) => {
      const res = await send("/groups", { workspace: workspaceId, name, ...body });
      expect(res.status).toBe(201);
      return ((await res.json()) as GroupView).id;
    };
    groupIds.Hiring = await make("Hiring", {
      sentence: "Candidates, recruiters and interview scheduling.",
    });
    groupIds.Candidates = await make("Candidates", {
      parentId: groupIds.Hiring,
      sentence: "First contact and take-home submissions",
    });
    groupIds.Interviews = await make("Interviews", {
      parentId: groupIds.Hiring,
      sentence: "Scheduling threads and calendar replies",
    });
    groupIds.Finance = await make("Finance", {
      sentence: "Invoices, receipts, renewals and payment notices.",
      predicate: { subjectPatterns: ["invoice"] },
      threshold: 0.85,
    });
    groupIds.Press = await make("Press", {
      sentence: "Journalists, podcast hosts and interview requests.",
    });
  }, 120_000);

  afterAll(async () => {
    await engine.close();
    await db.drop();
  });

  test("the fixture mailbox routes and sections on TypeSafe with the expected confidences, a newsletter gets no Brief, the term sheet gets one before open", async () => {
    // Routing: one Choice per stage through judge.route, no classify prompt.
    const before = judge.calls.length;
    const previewRes = await send("/routing/rerun", { workspace: workspaceId, recent: 50 });
    expect(previewRes.status).toBe(200);
    const preview = (await previewRes.json()) as RoutingPreview;
    expect(preview.considered).toBe(19);
    const proposed = new Map(preview.moves.map((m) => [plainSubject(m.subject), m.proposed]));
    expect([...proposed.keys()].sort()).toEqual([
      "Can we move Thursday's call?",
      "Candidate: Elin Vos, backend",
      "Interview loop for Monday",
      "Invoice 2041 for August",
      "Podcast recording slot",
      "Renewal for the domain",
    ]);
    // The Predicate still places the invoice at full Confidence without a call.
    expect(proposed.get("Invoice 2041 for August")).toEqual({
      kind: "route",
      groupId: groupIds.Finance,
      subgroupId: null,
      confidence: 1,
    });
    expect(proposed.get("Candidate: Elin Vos, backend")).toEqual({
      kind: "route",
      groupId: groupIds.Hiring,
      subgroupId: groupIds.Candidates,
      confidence: 0.96,
    });
    expect(proposed.get("Interview loop for Monday")).toEqual({
      kind: "route",
      groupId: groupIds.Hiring,
      subgroupId: groupIds.Interviews,
      confidence: 0.9,
    });
    expect(proposed.get("Renewal for the domain")).toEqual({
      kind: "route",
      groupId: groupIds.Finance,
      subgroupId: null,
      confidence: 0.9,
    });
    expect(proposed.get("Podcast recording slot")).toEqual({
      kind: "route",
      groupId: groupIds.Press,
      subgroupId: null,
      confidence: 0.97,
    });
    // The judge's confidence, not a number a model wrote, sends the call to Needs a decision.
    expect(proposed.get("Can we move Thursday's call?")).toEqual({
      kind: "ask",
      candidates: [
        { groupId: groupIds.Hiring, confidence: 0.62 },
        { groupId: groupIds.Press, confidence: 0.55 },
      ],
    });
    // 18 top-level Choices (the invoice skipped the judge) plus two Sub-group Choices; no chat at all.
    expect(preview.calls).toBe(20);
    expect(judge.calls.length - before).toBe(20);
    expect(chat.calls.filter((c) => c.system.startsWith("You route"))).toHaveLength(0);
    const routeCall = judge.calls[before];
    expect(routeCall?.questions).toEqual(["group"]);
    expect(routeCall?.state).toMatchObject({ owner: fixture.address });
    expect((await judged.meter.month(workspaceId, "2026-09")).lines).toEqual([
      expect.objectContaining({ task: "judge.route", provider: "typesafe", calls: 20 }),
    ]);

    // Apply the preview: the Threads land where the judge put them.
    const applied = (await (
      await send("/routing/rerun/apply", { workspace: workspaceId, moves: preview.moves })
    ).json()) as RoutingApplied;
    expect(applied).toEqual({ moved: 5, asked: 1 });
    threadsBySubject = await subjectsOf();
    expect(threadOf("Candidate: Elin Vos, backend")).toMatchObject({
      group: groupIds.Hiring,
      subgroup: groupIds.Candidates,
    });
    expect(threadOf("Podcast recording slot")).toMatchObject({ group: groupIds.Press });
    expect(threadOf("Can we move Thursday's call?")).toMatchObject({ group: null });

    // The thread observer queued one judge Job and one brief Job per Thread; they ran as Jobs.
    const ran = await runAll();
    expect(ran[JUDGE_STEP]).toBe(24);
    expect(ran[BRIEF_STEP]).toBe(24);
    expect(ran[ROUTE_STEP]).toBeUndefined();
    // Every Thread has its Judgments, asked once, in one judge.section request each.
    const lines = (await judged.meter.month(workspaceId, "2026-09")).lines;
    expect(lines).toHaveLength(3);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ task: "judge.route", calls: 20 }),
        expect.objectContaining({ task: "judge.section", provider: "typesafe", calls: 24 }),
        expect.objectContaining({ task: "brief", provider: "anthropic", calls: 1 }),
      ]),
    );
    const contract = await judged.judgments.get(threadOf("Draft contract for review").id);
    expect(contract).toMatchObject({
      needsReply: 0.58,
      waitingOnOthers: 0.8,
      newsletter: 0.07,
      briefWorth: 1.9,
      urgency: 1.8,
      chips: { open_attachment: 0.74, review_link: 0.3, reply: 0.4 },
      model: "jev-1.13.0",
    });
    const sectionCall = judge.calls.find(
      (c) =>
        c.questions.includes("brief_worth") && subjectOf(c.state) === "Draft contract for review",
    );
    expect(sectionCall?.questions).toHaveLength(12);
    expect(sectionCall?.state).toMatchObject({
      thread: { message_count: 4, owner_wrote_last: true, has_attachments: true },
    });
    expect(JSON.stringify(sectionCall?.state)).not.toContain("--- Message");
    // A repeat for the same Thread version asks nothing.
    await judged.judgments.threadReady(workspaceId, threadOf("Weekly digest").id);
    expect(await runAll()).toEqual({});
    expect(judge.calls.filter((c) => c.questions.includes("brief_worth"))).toHaveLength(24);

    // Sections from the Judgments: the candidate thread is read and the owner wrote last,
    // so the headers alone would file it under For your information.
    expect(await sectionFor("Candidate: Elin Vos, backend")).toBe("needs-reply");
    expect(await sectionFor("Podcast recording slot")).toBe("needs-reply");
    expect(await sectionFor("Draft contract for review")).toBe("waiting");
    expect(await sectionFor("Weekly digest")).toBe("newsletters");
    expect(await sectionFor("Invoice 2041 for August")).toBe("fyi");
    expect(await sectionFor("Q3 planning notes")).toBe("fyi");

    // The feed carries every Judgment as probabilities, nothing else.
    const changes = await feed();
    const judgments = changes.filter(
      (c): c is Change & { kind: "judgments" } => c.kind === "judgments",
    );
    expect(judgments).toHaveLength(24);
    const digestChange = judgments.find(
      (c) => c.entityId === threadOf("Weekly digest").id,
    )?.payload;
    expect(digestChange).toEqual({
      threadId: threadOf("Weekly digest").id,
      needsReply: 0.07,
      waitingOnOthers: 0.02,
      newsletter: 0.93,
      automated: 0.6,
      briefWorth: 0,
      urgency: 1,
      chips: {
        reply: 0.5,
        call: 0.5,
        review_link: 0.5,
        open_attachment: 0.5,
        pay_or_file: 0.5,
        snooze: 0.7,
      },
      model: "jev-1.13.0",
      judgedAt: NOW.toISOString(),
    } satisfies ThreadJudgments);

    // The brief policy read the Brief worth Score: the newsletter got no Brief and the term
    // sheet got one in the background, before anyone opened it.
    const rows = await db.handle.db.select().from(briefsTable);
    expect(rows.map((r) => r.threadId)).toEqual([threadOf("Draft contract for review").id]);
    expect(await judged.briefs.get(threadOf("Weekly digest").id)).toBeNull();
    expect(await judged.briefs.get(threadOf("Invoice 2041 for August").id)).toBeNull();
    const brief = await judged.briefs.get(threadOf("Draft contract for review").id);
    expect(brief?.bullets[0]).toEqual([
      { b: "Priya" },
      " sent the redline; the ",
      { b: "indemnity" },
      " cap is the open point.",
    ]);
    expect(changes.filter((c) => c.kind === "brief")).toHaveLength(1);
    // The reader's open finds it fresh: nothing more to compute.
    const opened = await judged.briefs.request(
      workspaceId,
      threadOf("Draft contract for review").id,
      "open",
    );
    expect(opened).toEqual({ status: "fresh" });
  });

  test("the language model path gives the same placements", async () => {
    const before = chat.calls.length;
    for (const [subject, thread] of threadsBySubject) {
      const viaJudge = await judged.routing.classify(thread.id);
      const viaModel = await llm.routing.classify(thread.id);
      const shape = (s: typeof viaJudge) => ({
        placement: s.placement.kind === "none" ? { kind: "none" } : s.placement,
        subgroup: s.subgroup,
        by: s.by,
      });
      expect(shape(viaModel), subject).toEqual(shape(viaJudge));
    }
    // The model path ran the classify prompt for every Thread the Predicate did not place, the judge path none.
    expect(chat.calls.slice(before).every((c) => c.system.startsWith("You route"))).toBe(true);
    expect(chat.calls.length - before).toBe(25);
    expect(await llm.runtime.judgeAvailable()).toBe(false);
    expect(await judged.runtime.judgeAvailable()).toBe(true);
  });

  test("threadReady queues one judge Job per Thread version, and nothing without a judge, without the Setting, or at assist", async () => {
    const sam = { name: fixture.owner.name, email: fixture.address };
    const priya = { name: "Priya Raman", email: "priya@raman.test" };
    const threadId = await store.upsertThread({
      workspaceId,
      providerThreadId: "thr-late",
      subject: "Board seat",
      participants: [priya, sam],
      lastActivity: "2026-09-16T09:00:00.000Z",
    });
    const message = (id: string, date: string) =>
      store.upsertMessage({
        threadId,
        providerMessageId: id,
        from: priya,
        to: [sam],
        cc: [],
        date,
        headers: {},
        bodyText: "Can we talk about the board seat this week?",
        bodyHtml: null,
        snippet: "Can we talk about the board seat this week?",
      });
    await message("late-1", "2026-09-16T09:00:00.000Z");
    // No judge on this Server: nothing is queued, the header rules stay in charge.
    await llm.judgments.threadReady(workspaceId, threadId);
    expect(await runAll()).toEqual({});
    // The Setting off: nothing.
    await setSetting("judgments.on_arrival", false);
    await judged.judgments.threadReady(workspaceId, threadId);
    expect(await runAll()).toEqual({});
    await setSetting("judgments.on_arrival", true);
    // Below automate: nothing either (the brief Job asks on open instead).
    const assist = createIntelligence({
      level: async () => "assist",
      db: db.handle.db,
      mailstore: store,
      chat: chat.chat,
      judge: judge.judge,
      keys: async (provider) =>
        provider === "typesafe" ? "ts-shared" : provider === "anthropic" ? "sk" : null,
      now: () => NOW,
    });
    assist.registerSteps(createJobs(db.handle.db, { now: () => NOW }));
    await assist.judgments.threadReady(workspaceId, threadId);
    expect(await runAll()).toEqual({});
    // At automate with a judge: one Job, once per version.
    await judged.judgments.threadReady(workspaceId, threadId);
    await judged.judgments.threadReady(workspaceId, threadId);
    expect(await runAll()).toEqual({ [JUDGE_STEP]: 1 });
    const first = await judged.judgments.get(threadId);
    expect(first).toMatchObject({ needsReply: 0.2, briefWorth: 0.7 });
    expect(await judged.judgments.fresh(threadId)).toEqual(first);
    // A new Message is a new version: judged again, the old row replaced, the feed told twice.
    await message("late-2", "2026-09-16T10:00:00.000Z");
    expect(await judged.judgments.fresh(threadId)).toBeNull();
    await judged.judgments.threadReady(workspaceId, threadId);
    expect(await runAll()).toEqual({ [JUDGE_STEP]: 1 });
    expect(await judged.judgments.fresh(threadId)).toMatchObject({ needsReply: 0.2 });
    const rows = (await feed()).filter((c) => c.kind === "judgments" && c.entityId === threadId);
    expect(rows).toHaveLength(2);
    // Removal tells the feed too.
    expect(await judged.judgments.remove(threadId)).toBe(true);
    expect(await judged.judgments.remove(threadId)).toBe(false);
    const gone = (await feed()).filter((c) => c.kind === "judgments" && c.entityId === threadId);
    expect(gone).toHaveLength(3);
    expect(gone[2]?.payload).toMatchObject({ deleted: true, needsReply: 0.2 });
  });
});
