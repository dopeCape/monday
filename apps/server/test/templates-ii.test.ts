// Templates II (slice 37): suggestions while typing through the two requests
// with the gate and the reject-all floor (the skill-suggestion cookbook), the
// on-open suggestion that names the Reply chip, writing a Template from
// example Messages with the language model and the duplicate Score, and the
// Agent's Template tools with their cards and Undo. Fake judge and fake chat
// at the seams; Postgres for the routes.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
  Account,
  JudgeQuestions,
  Template,
  TemplateDraftResult,
  TemplateSuggestResult,
} from "@monday/shared";
import { BUILTIN_TEMPLATES, defaultSettings, findBuiltinTemplate } from "@monday/shared";
import type { Hono } from "hono";
import { type AppEnv, createApp } from "../src/app.ts";
import { createAuth } from "../src/auth/index.ts";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys } from "../src/crypto/keys.ts";
import { settings as settingsTable, signalAnswers } from "../src/db/schema.ts";
import {
  createMemoryActivityLog,
  createToolServer,
  toolCallOf,
} from "../src/intelligence/agent/index.ts";
import { createFakeToolHost } from "../src/intelligence/agent/tools/fake-host.ts";
import type { TemplatesSeam } from "../src/intelligence/agent/tools/templates.ts";
import { createIntelligence, type Intelligence } from "../src/intelligence/index.ts";
import {
  createFakeChat,
  createFakeJudge,
  type FakeChat,
  type FakeJudge,
} from "../src/intelligence/runtime/fake/index.ts";
import type { Ask } from "../src/intelligence/templates/ask.ts";
import {
  findDuplicate,
  parseTemplateDraft,
  rankQuestions,
  type SuggestSettings,
  suggestTemplate,
} from "../src/intelligence/templates/index.ts";
import { createJobs } from "../src/jobs/index.ts";
import { createMailstore, type Mailstore } from "../src/mailstore/index.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const d = defaultSettings();
const SUGGEST: SuggestSettings = {
  gate: d["templates.suggest.gate"],
  fitsFloor: d["templates.suggest.fits_floor"],
  hintFloor: d["templates.suggest.hint_floor"],
  shortlist: d["templates.suggest.shortlist"],
  choiceMax: d["templates.suggest.choice_max"],
  questions: {
    which: d["templates.suggest.question.which"],
    none: d["templates.suggest.question.none"],
    gateStandard: d["templates.suggest.question.gate_standard"],
    gatePurpose: d["templates.suggest.question.gate_purpose"],
    gatePersonal: d["templates.suggest.question.gate_personal"],
    rerank: d["templates.suggest.question.rerank"],
    fits: d["templates.suggest.question.fits"],
  },
};

/** An Ask over the fake judge, recording each request's questions. */
function askOver(judge: FakeJudge): Ask {
  return async (state, questions) => {
    const r = await judge.judge({ model: "jev", key: "k", state, questions });
    return { answers: r.answers as never, by: "typesafe" };
  };
}

const choice = (probabilities: Record<string, number>) => {
  const [choice] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0] ?? [""];
  return { type: "choice" as const, choice, probabilities, confidence: 0.9 };
};

describe("suggestions while typing (the two requests)", () => {
  test("request 1 ranks the library as name: fits-when with a none option and three gate Nouls", () => {
    const { questions, chunks } = rankQuestions(BUILTIN_TEMPLATES, SUGGEST);
    expect(chunks).toHaveLength(1);
    const which = questions.which;
    expect(which?.type).toBe("choice");
    expect(which && "criteria" in which ? Object.keys(which.criteria as object) : []).toHaveLength(
      22,
    );
    expect((which as { criteria: Record<string, string> }).criteria.t_confirm_time).toBe(
      "Confirm the time: Someone proposed a time for a call or meeting and the owner accepts it",
    );
    expect(Object.keys(questions).slice(1)).toEqual([
      "gate_standard",
      "gate_purpose",
      "gate_personal",
    ]);
  });

  test("a library above 255 is split into several Choices, and the winners of each go to request 2", async () => {
    const big: Template[] = Array.from({ length: 300 }, (_, i) => ({
      ...(BUILTIN_TEMPLATES[0] as Template),
      id: `tpl_${i}`,
      name: `Template ${i}`,
    }));
    const { questions, chunks } = rankQuestions(big, SUGGEST);
    expect(chunks.map((c) => c.length)).toEqual([254, 46]);
    expect(Object.keys(questions).slice(0, 2)).toEqual(["which_0", "which_1"]);
    const judge = createFakeJudge({
      gate_standard: 0.9,
      gate_purpose: 0.9,
      gate_personal: 0.1,
      which_0: choice({ tpl_3: 0.6, tpl_7: 0.3, none: 0.1 }),
      which_1: choice({ tpl_280: 0.8, none: 0.2 }),
      which: "tpl_280",
      fits_tpl_280: 0.9,
    });
    const r = await suggestTemplate({
      ask: askOver(judge),
      workspaceId: "ws",
      library: big,
      thread: null,
      draft: { to: [], subject: "", typed: "Hi" },
      settings: SUGGEST,
    });
    expect(judge.calls[1]?.questions).toEqual([
      "which",
      "fits_tpl_280",
      "fits_tpl_3",
      "fits_tpl_7",
    ]);
    expect(r).toMatchObject({ status: "suggested", templateId: "tpl_280" });
  });

  test("below the gate nothing is suggested and request 2 is not sent", async () => {
    const judge = createFakeJudge({ gate_standard: 0.2, gate_purpose: 0.3, gate_personal: 0.9 });
    const r = await suggestTemplate({
      ask: askOver(judge),
      workspaceId: "ws",
      library: BUILTIN_TEMPLATES,
      thread: null,
      draft: { to: [], subject: "", typed: "I was so sorry to hear about your father" },
      settings: SUGGEST,
    });
    expect(r).toMatchObject({ status: "none", reason: "gate" });
    expect(judge.calls).toHaveLength(1);
  });

  test("request 2 may reject all of them below the floor", async () => {
    const judge = createFakeJudge({
      gate_standard: 0.9,
      gate_purpose: 0.8,
      gate_personal: 0.1,
      which: choice({ t_confirm_time: 0.5, t_offer_times: 0.3, t_reschedule: 0.2 }),
      fits_t_confirm_time: 0.3,
      fits_t_offer_times: 0.2,
      fits_t_reschedule: 0.1,
    });
    const r = await suggestTemplate({
      ask: askOver(judge),
      workspaceId: "ws",
      library: BUILTIN_TEMPLATES,
      thread: null,
      draft: { to: [], subject: "", typed: "About the call" },
      settings: SUGGEST,
    });
    expect(r).toMatchObject({ status: "none", reason: "floor" });
    // The ranking comes back likeliest first, and request 1's first choice,
    // at least templates.suggest.hint_floor likely, is offered softly.
    expect(r.status === "none" ? r.ranking : null).toEqual([
      { templateId: "t_confirm_time", p: 0.5 },
      { templateId: "t_offer_times", p: 0.3 },
      { templateId: "t_reschedule", p: 0.2 },
    ]);
    expect(r).toMatchObject({
      maybe: { templateId: "t_confirm_time", name: "Confirm the time", p: 0.5 },
    });
  });

  test("below the hint floor, or below the gate, nothing is offered even softly", async () => {
    const run = (answers: Parameters<typeof createFakeJudge>[0]) =>
      suggestTemplate({
        ask: askOver(createFakeJudge(answers)),
        workspaceId: "ws",
        library: BUILTIN_TEMPLATES,
        thread: null,
        draft: { to: [], subject: "", typed: "About the call" },
        settings: SUGGEST,
      });
    const low = await run({
      gate_standard: 0.9,
      gate_purpose: 0.8,
      gate_personal: 0.1,
      which: choice({ t_confirm_time: 0.3, t_offer_times: 0.25, none: 0.45 }),
      fits_t_confirm_time: 0.2,
      fits_t_offer_times: 0.2,
    });
    expect(low).toMatchObject({ status: "none", reason: "floor" });
    expect("maybe" in low).toBe(false);
    const personal = await run({
      gate_standard: 0.1,
      gate_purpose: 0.2,
      gate_personal: 0.9,
      which: choice({ t_confirm_time: 0.8, none: 0.2 }),
    });
    // A personal message still gets the soft line when a template is likely.
    expect(personal).toMatchObject({
      status: "none",
      reason: "gate",
      maybe: { templateId: "t_confirm_time", name: "Confirm the time", p: 0.8 },
    });
  });

  test("rankOnly sends request 1 alone and answers with the ranking, gate or not", async () => {
    const judge = createFakeJudge({
      gate_standard: 0.1,
      gate_purpose: 0.1,
      gate_personal: 0.9,
      which: choice({ t_offer_times: 0.6, t_reschedule: 0.25, none: 0.15 }),
    });
    const r = await suggestTemplate({
      ask: askOver(judge),
      workspaceId: "ws",
      library: BUILTIN_TEMPLATES,
      thread: null,
      draft: { to: [], subject: "", typed: "can we do another time?" },
      settings: SUGGEST,
      rankOnly: true,
    });
    expect(judge.calls).toHaveLength(1);
    expect(r).toMatchObject({
      status: "ranked",
      ranking: [
        { templateId: "t_offer_times", p: 0.6 },
        { templateId: "t_reschedule", p: 0.25 },
      ],
    });
  });
});

describe("the duplicate Score", () => {
  const candidate = {
    ...(findBuiltinTemplate("t_thanks_received") as Template),
    name: "Got it",
  };
  test("same at 1.5 or above, related from 0.5, nothing below", async () => {
    for (const [score, level] of [
      [1.8, "same"],
      [1, "related"],
      [0.2, null],
    ] as const) {
      const judge = createFakeJudge({
        nearest: choice({ t_thanks_received: 0.8, t_thank_you: 0.2 }),
        dup_t_thanks_received: score,
        dup_t_thank_you: 0,
      });
      const v = await findDuplicate({
        ask: askOver(judge),
        workspaceId: "ws",
        candidate,
        library: BUILTIN_TEMPLATES,
        settings: {
          sameAt: 1.5,
          relatedAt: 0.5,
          shortlist: 3,
          choiceMax: 255,
          shortlistQuestion: d["templates.duplicate.shortlist_question"],
          none: d["templates.suggest.question.none"],
          question: d["templates.duplicate.question"],
          levels: d["templates.duplicate.levels"],
        },
      });
      expect(v?.level ?? null).toBe(level);
      if (level) expect(v?.name).toBe("Thanks, received");
      const second = judge.calls[1];
      expect(second?.questions).toEqual(["dup_t_thanks_received", "dup_t_thank_you"]);
      expect(JSON.stringify(second?.state)).toContain("Got it");
    }
  });

  test("the model's draft is read and tidied; missing parts come back empty", () => {
    const t = parseTemplateDraft(
      'Here you go: {"name": "Got it", "fits_when": "a file arrives", "kind": "reply", "subject": "x", "body": "Hi {first_name}, thanks for {thing}.", "placeholders": [{"name": "thing", "type": "text", "hint": "what"}, {"name": "first_name", "type": "first_name"}]}',
    );
    expect(t.subject).toBeNull();
    expect(t.placeholders.map((p) => p.name)).toEqual(["first_name", "thing"]);
  });
});

/* ------------------------------ Over Postgres ------------------------------ */

const SIDECAR_TOKEN = "per-launch-token";
const me = "sam@monday.test";
const sofia = { name: "Sofia Lindqvist", email: "sofia@lindqvist.se" };
const ravi = { name: "Ravi Menon", email: "ravi@studio.test" };
const sam = { name: "Sam Rivera", email: me };
const account: Account = {
  id: "acct-tpl2",
  provider: "imap",
  address: me,
  displayName: "Sam",
  capabilities: {
    push: false,
    labels: false,
    snooze: false,
    mute: false,
    calendar: false,
    meetingLink: null,
  },
};

describe("Templates II over the routes", () => {
  let db: TestDatabase;
  let store: Mailstore;
  let intelligence: Intelligence;
  let app: Hono<AppEnv>;
  let judge: FakeJudge;
  let chat: FakeChat;
  let workspaceId: string;
  let deckThread: string;
  const sentIds: string[] = [];

  const request = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${SIDECAR_TOKEN}` },
    });
  const json = async <T>(res: Response | Promise<Response>): Promise<T> => (await res).json() as T;

  beforeAll(async () => {
    db = await testDatabase();
    const keys = createKeys(db.handle.db);
    await keys.unlock(randomKey());
    store = createMailstore(db.handle.db, keys);
    judge = createFakeJudge();
    chat = createFakeChat("");
    intelligence = createIntelligence({
      level: async () => "automate",
      db: db.handle.db,
      mailstore: store,
      chat: chat.chat,
      judge: judge.judge,
      keys: async (provider) =>
        ({ typesafe: "ts", anthropic: "sk" })[provider as "typesafe"] ?? null,
    });
    app = createApp({
      db: db.handle.db,
      auth: createAuth({ db: db.handle.db, sidecarToken: SIDECAR_TOKEN }),
      mode: "sidecar",
      keys,
      mailstore: store,
      jobs: createJobs(db.handle.db),
      intelligence,
      remoteAddress: () => "127.0.0.1",
    });
    workspaceId = (await store.createWorkspace(account)).id;
    deckThread = await store.upsertThread({
      workspaceId,
      providerThreadId: "thr-deck",
      subject: "Board deck",
      participants: [sofia, sam],
      lastActivity: "2026-09-15T09:30:00.000Z",
    });
    await store.upsertMessage({
      threadId: deckThread,
      providerMessageId: "msg-deck",
      from: sofia,
      to: [sam],
      cc: [],
      date: "2026-09-15T09:30:00.000Z",
      headers: {},
      bodyText: "Hi Sam, attached is the board deck for Thursday.",
      bodyHtml: null,
      snippet: "attached is the board deck",
    });
    // Two replies the owner sent, for "Make a template from this".
    for (const [i, who, thing] of [
      [1, sofia, "the board deck"],
      [2, ravi, "the studio contract"],
    ] as const) {
      const thread = await store.upsertThread({
        workspaceId,
        providerThreadId: `thr-sent-${i}`,
        subject: `Files ${i}`,
        participants: [who, sam],
        lastActivity: `2026-09-1${i}T10:00:00.000Z`,
      });
      sentIds.push(
        await store.upsertMessage({
          threadId: thread,
          providerMessageId: `msg-sent-${i}`,
          from: sam,
          to: [who],
          cc: [],
          date: `2026-09-1${i}T10:00:00.000Z`,
          headers: {},
          bodyText: `Hi ${who.name.split(" ")[0]},\n\nThanks for sending ${thing}. I've got it and will take a look.\n\nThanks,`,
          bodyHtml: null,
          snippet: "Thanks for sending",
        }),
      );
    }
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  });

  const suggestFor = (typed: string, threadId: string | null = deckThread) =>
    json<TemplateSuggestResult>(
      request("/templates/suggest", {
        method: "POST",
        body: JSON.stringify({
          workspace: workspaceId,
          threadId,
          draft: { to: [sofia], subject: "", typed },
        }),
      }),
    );

  test("typing Thanks for sending the, in a reply to a Thread with an attachment, suggests Thanks, received", async () => {
    const isThanks = (state: unknown) =>
      /thanks for sending/i.test(JSON.stringify((state as { draft?: unknown }).draft));
    judge.when(
      (state, questions: JudgeQuestions) => isThanks(state) && "gate_standard" in questions,
      {
        gate_standard: 0.9,
        gate_purpose: 0.85,
        gate_personal: 0.1,
        which: choice({ t_thanks_received: 0.7, t_here_is_the_file: 0.2, t_thank_you: 0.1 }),
      },
    );
    judge.when((state, questions) => isThanks(state) && "fits_t_thanks_received" in questions, {
      which: "t_thanks_received",
      fits_t_thanks_received: 0.92,
      fits_t_here_is_the_file: 0.2,
      fits_t_thank_you: 0.3,
    });
    judge.when(
      (state, questions) =>
        "gate_standard" in questions &&
        (state as { draft?: { typed?: string } }).draft?.typed !== "" &&
        !/another time/.test(JSON.stringify((state as { draft?: unknown }).draft)),
      {
        gate_standard: 0.1,
        gate_purpose: 0.4,
        gate_personal: 0.95,
      },
    );
    const r = await suggestFor("Thanks for sending the");
    expect(r).toMatchObject({
      status: "suggested",
      templateId: "t_thanks_received",
      name: "Thanks, received",
    });
    // Both requests read the Thread and what was typed.
    const [first, second] = judge.calls.slice(-2);
    expect(JSON.stringify(first?.state)).toContain("attached is the board deck");
    expect((second?.state as { draft?: { typed?: string } } | undefined)?.draft?.typed).toBe(
      "Thanks for sending the",
    );
    // A personal paragraph suggests nothing, and asks only once.
    const before = judge.calls.length;
    expect(
      await suggestFor("I was so sorry to hear about your father, please take all the time"),
    ).toMatchObject({ status: "none", reason: "gate" });
    expect(judge.calls.length).toBe(before + 1);
  });

  test("past templates.suggest.max_typed_chars, or with the Setting off, nothing is asked", async () => {
    const before = judge.calls.length;
    expect(await suggestFor("x".repeat(250))).toMatchObject({ status: "none", reason: "disabled" });
    await db.handle.db
      .insert(settingsTable)
      .values({ scope: "global", deviceId: null, key: "templates.suggest.enabled", value: false });
    expect(await suggestFor("Thanks for sending the")).toMatchObject({
      status: "none",
      reason: "disabled",
    });
    await db.handle.db.delete(settingsTable);
    expect(judge.calls.length).toBe(before);
  });

  test("rankOnly over the route: the picker's ranking past max_typed_chars, and off with templates.picker.rank", async () => {
    judge.when(
      (state, questions) =>
        "gate_standard" in questions &&
        /another time/.test(JSON.stringify((state as { draft?: unknown }).draft)),
      {
        gate_standard: 0.8,
        gate_purpose: 0.8,
        gate_personal: 0.2,
        which: choice({ t_offer_times: 0.55, t_reschedule: 0.3, none: 0.15 }),
      },
    );
    const rank = (typed: string) =>
      json<TemplateSuggestResult>(
        request("/templates/suggest", {
          method: "POST",
          body: JSON.stringify({
            workspace: workspaceId,
            threadId: deckThread,
            draft: { to: [sofia], subject: "", typed },
            rankOnly: true,
          }),
        }),
      );
    const before = judge.calls.length;
    expect(await rank(`${"x".repeat(250)} can we do another time?`)).toMatchObject({
      status: "ranked",
      ranking: [
        { templateId: "t_offer_times", p: 0.55 },
        { templateId: "t_reschedule", p: 0.3 },
      ],
    });
    expect(judge.calls.length).toBe(before + 1);
    await db.handle.db
      .insert(settingsTable)
      .values({ scope: "global", deviceId: null, key: "templates.picker.rank", value: false });
    expect(await rank("can we do another time?")).toMatchObject({
      status: "none",
      reason: "disabled",
    });
    await db.handle.db.delete(settingsTable);
    expect(judge.calls.length).toBe(before + 1);
  });

  test("on open, a Thread that needs a reply names the Reply chip; one that does not asks nothing", async () => {
    const onOpen = () =>
      json<TemplateSuggestResult>(
        request(`/threads/${deckThread}/template-suggestion?workspace=${workspaceId}`),
      );
    const before = judge.calls.length;
    expect(await onOpen()).toMatchObject({ status: "none", reason: "gate" });
    expect(judge.calls.length).toBe(before);
    const latest = (await store.listMessages(deckThread)).at(-1);
    // The Thread needs a reply: the shipped needs_reply Signal holds (the Signal store, slice 30).
    await db.handle.db.insert(signalAnswers).values({
      threadId: deckThread,
      workspaceId,
      signalId: "needs_reply",
      version: 1,
      model: "jev",
      judgedAt: new Date(),
      messageCount: 1,
      latestMessageId: latest?.id ?? "",
      noul: 0.9,
    });
    judge.when((state) => (state as { draft?: { typed?: string } }).draft?.typed === "", {
      gate_standard: 0.9,
      gate_purpose: 0.9,
      gate_personal: 0.1,
      which: "t_thanks_received",
      fits_t_thanks_received: 0.9,
    });
    expect(await onOpen()).toMatchObject({ status: "suggested", name: "Thanks, received" });
    const asked = judge.calls.length;
    // Remembered per Thread version: a second open asks nothing.
    expect(await onOpen()).toMatchObject({ status: "suggested" });
    expect(judge.calls.length).toBe(asked);
  });

  test("Make a template from this on two replies: Placeholders where they differ, and You already have Thanks, received", async () => {
    chat.answer((call) => {
      expect(call.prompt).toContain("Thanks for sending the board deck");
      expect(call.prompt).toContain("Thanks for sending the studio contract");
      return JSON.stringify({
        name: "Got the file",
        fits_when: "Someone sent a file the owner will look at",
        kind: "reply",
        subject: null,
        body: "Hi {first_name},\n\nThanks for sending {thing}. I've got it and will take a look.\n\nThanks,",
        placeholders: [
          { name: "first_name", type: "first_name", optional: false, hint: "their first name" },
          { name: "thing", type: "text", optional: false, hint: "what they sent" },
        ],
      });
    });
    judge.when((state) => Boolean((state as { new_template?: unknown }).new_template), {
      nearest: choice({ t_thanks_received: 0.9, t_here_is_the_file: 0.1 }),
      dup_t_thanks_received: 1.9,
      dup_t_here_is_the_file: 0.3,
    });
    const r = await json<TemplateDraftResult>(
      request("/templates/draft", {
        method: "POST",
        body: JSON.stringify({ workspace: workspaceId, messageIds: sentIds }),
      }),
    );
    expect(r.template.body).toContain("Thanks for sending {thing}");
    expect(r.template.placeholders.map((p) => p.name)).toEqual(["first_name", "thing"]);
    expect(r.duplicate).toMatchObject({ templateId: "t_thanks_received", level: "same" });
    expect(r.duplicate?.name).toBe("Thanks, received");
  });

  test("a draft that does not validate is asked again once with the errors, then refused", async () => {
    let calls = 0;
    chat.answer((call) => {
      calls++;
      if (calls === 2) expect(call.prompt).toContain("{thing} is used but not declared.");
      return JSON.stringify({ name: "Bad", kind: "reply", body: "Hi {thing}", placeholders: [] });
    });
    const res = await request("/templates/draft", {
      method: "POST",
      body: JSON.stringify({ workspace: workspaceId, texts: [{ subject: "x", text: "Hi there" }] }),
    });
    expect(res.status).toBe(422);
    expect(calls).toBe(2);
  });
});

/* ------------------------------ The Agent's tools ------------------------------ */

describe("the Agent's Template tools", () => {
  function setup() {
    const host = createFakeToolHost(
      [
        {
          id: "t-deck",
          subject: "Board deck",
          from: "Sofia Lindqvist <sofia@lindqvist.se>",
          lastActivity: "2026-09-16T10:00:00.000Z",
        },
      ],
      { now: () => new Date("2026-09-17T10:00:00Z") },
    );
    const own = new Map<string, Template>();
    let n = 0;
    const seam: TemplatesSeam = {
      store: {
        library: async () => [...own.values(), ...BUILTIN_TEMPLATES],
        get: async (id) => own.get(id) ?? findBuiltinTemplate(id) ?? null,
        create: async (workspaceId, input) => {
          const t: Template = {
            ...input,
            id: `tpl_${++n}`,
            workspaceId,
            shareGroupId: null,
            builtIn: null,
            createdBy: "agent",
            updatedAt: "",
          };
          own.set(t.id, t);
          return [t];
        },
        update: async (id, input, o) => {
          const cur = own.get(id);
          if (!cur) {
            const t: Template = {
              ...input,
              id: `tpl_${++n}`,
              workspaceId: o?.workspaceId ?? "",
              shareGroupId: null,
              builtIn: id,
              createdBy: "agent",
              updatedAt: "",
            };
            own.set(t.id, t);
            return [t];
          }
          const next = { ...cur, ...input };
          own.set(id, next);
          return [next];
        },
        remove: async (id) => {
          const cur = own.get(id);
          own.delete(id);
          return cur ? [cur] : [];
        },
        restore: async () => [],
      },
      fill: async (_ws, templateId) => ({
        templateId,
        judge: "typesafe",
        fills: [
          {
            name: "first_name",
            value: "Sofia",
            span: "Sofia Lindqvist",
            by: "code",
            confidence: 1,
            candidates: [],
          },
          {
            name: "thing",
            value: null,
            span: null,
            by: null,
            confidence: 0,
            candidates: [{ span: "the board deck", value: "the board deck" }],
          },
        ],
      }),
      draftFromExamples: async () => ({
        template: {
          name: "Got it",
          fitsWhen: "",
          kind: "reply",
          subject: null,
          body: "Hi {first_name}.",
          placeholders: [{ name: "first_name", type: "first_name", optional: false, hint: "" }],
        },
        duplicate: {
          templateId: "t_thanks_received",
          name: "Thanks, received",
          score: 1.7,
          level: "same",
        },
      }),
      duplicateOf: async () => null,
    };
    const activity = createMemoryActivityLog();
    const server = createToolServer({
      host,
      activity,
      settings: async () => ({ previewAbove: 10, alwaysAsk: [], searchLimit: 100 }),
      extensions: { templates: seam },
    });
    let seq = 0;
    const call = (name: string, args: unknown) =>
      server.call(
        { name, args, callId: `c${++seq}`, sessionId: "s1" },
        { ask: async () => "approved" as const },
      );
    return { host, server, call, own };
  }

  test("list_templates reads silently; use_template makes a Draft with chips and says which it started from", async () => {
    const { host, call } = setup();
    const listed = await call("list_templates", { query: "thanks" });
    expect(listed.activity.tier).toBe("read-only");
    expect(listed.text).toContain("t_thanks_received: Thanks, received (reply, built in)");
    const used = await call("use_template", {
      template_id: "t_thanks_received",
      thread_id: "t-deck",
    });
    expect(used.activity.tier).toBe("reversible");
    expect(used.text).toContain("Started from Thanks, received.");
    expect(used.text).toContain("Left for the user to fill: thing.");
    const draft = host.drafts.get("draft-1");
    expect(draft?.bodyHtml).toContain('data-filled="first_name"');
    expect(draft?.bodyHtml).toContain('data-placeholder="thing"');
    expect(draft?.bodyText).toContain("Hi Sofia,");
    expect(toolCallOf(used.activity).open?.draftId).toBe("draft-1");
  });

  test("create_template from messages carries the duplicate on its card; update and delete undo", async () => {
    const { server, call, own } = setup();
    const made = await call("create_template", { from_message_ids: ["m1", "m2"] });
    expect(made.text).toContain("saved");
    const preview = made.activity.preview;
    expect(preview).toMatchObject({
      kind: "template",
      action: "create",
      duplicate: { level: "same" },
    });
    expect(made.text).toContain("the user already has Thanks, received");
    expect([...own.keys()]).toEqual(["tpl_1"]);
    const changed = await call("update_template", { template_id: "tpl_1", name: "Got it, thanks" });
    expect(own.get("tpl_1")?.name).toBe("Got it, thanks");
    await server.undo(changed.activity.id, "s1");
    expect(own.get("tpl_1")?.name).toBe("Got it");
    const bad = await call("create_template", { name: "X", body: "Hi {who}", placeholders: [] });
    expect(bad.isError).toBe(false);
    expect(bad.text).toContain("saved");
    const del = await call("delete_template", { template_id: "tpl_1" });
    expect(own.has("tpl_1")).toBe(false);
    expect(del.activity.tier).toBe("reversible");
    const builtin = await call("delete_template", { template_id: "t_decline" });
    expect(builtin.isError).toBe(true);
    expect(builtin.text).toContain("templates.builtin.hidden");
    await server.undo(made.activity.id, "s1");
  });
});
