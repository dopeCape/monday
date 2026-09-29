// Views II (slice 40; docs/spec/views.md, "Making a View: the Agent must
// test it" and "Changing and removing"): the sentence yields a card with 10
// tried Threads and their reasons and nothing in the nav until Pin view
// (acceptance 1); marking two tried Threads "not a support request" and
// revising shows the agreement line and the revised question, and pinning
// saves version 1 with those Examples (acceptance 3); "only paying
// customers" shows the moves before Apply and saves version 2, Undo restores
// version 1 (acceptance 5); a draft that asks Jev "has more than 3 replies"
// fails validation and the retry uses message_count (acceptance 7). Also: a
// quiet scope widens its dates, a View that reads mail without a key keeps
// only its Fact Lanes, and the tools and their card.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Account, ViewDoc } from "@monday/shared";
import { SUPPORT_TODAY_VIEW, TOOL_TIERS, viewSignalId } from "@monday/shared";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys } from "../src/crypto/keys.ts";
import { settings as settingsTable } from "../src/db/schema.ts";
import { createIntelligence, type Intelligence } from "../src/intelligence/index.ts";
import { createFakeChat, createFakeJudge } from "../src/intelligence/runtime/fake/index.ts";
import type { ChatCall } from "../src/intelligence/runtime/index.ts";
import { createMailstore, type Mailstore } from "../src/mailstore/index.ts";
import { viewRoutes } from "../src/routes/views.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const NOW = new Date("2026-09-29T15:00:00Z");
const owner = { name: "Sam Okafor", email: "sam@acme.com" };
const support = { name: "Acme Support", email: "support@acme.com" };

/** What the model writes: the fixture View without its id and version, as a model would. */
const { id: _id, version: _v, examples: _e, ...WRITTEN } = SUPPORT_TODAY_VIEW;

const COUNTING = {
  ...WRITTEN,
  name: "Long threads",
  signals: [
    {
      id: "many_replies",
      kind: "noul",
      question: { type: "noul", instructions: "The thread has more than 3 replies." },
    },
  ],
  uses: [],
  lanes: [
    { id: "long", label: "Long", tone: "info", when: { signal: "many_replies", holds: true } },
  ],
  nav: { icon: "chat-circle", count: "long" },
};
const COUNTING_FIXED = {
  ...COUNTING,
  signals: [],
  lanes: [
    { id: "long", label: "Long", tone: "info", when: { fact: "message_count", at_least: 4 } },
  ],
};

describe("the Agent makes a View and must test it", () => {
  let db: TestDatabase;
  let store: Mailstore;
  let workspaceId: string;
  const judge = createFakeJudge();
  const chat = createFakeChat();
  let intelligence: Intelligence;
  const SUPPORT = (id: string) => viewSignalId("b_show_today_s_support_requests", id);

  const setSetting = async (key: string, value: unknown) => {
    await db.handle.db
      .insert(settingsTable)
      .values({ scope: "global", deviceId: null, key, value })
      .onConflictDoUpdate({
        target: [settingsTable.scope, settingsTable.deviceId, settingsTable.key],
        set: { value },
      });
  };

  const addThread = async (
    key: string,
    subject: string,
    from: { name: string; email: string },
    date = "2026-09-29T09:00:00.000Z",
    messages = 1,
  ) => {
    const threadId = await store.upsertThread({
      workspaceId,
      providerThreadId: key,
      subject,
      participants: [from, owner],
      lastActivity: date,
    });
    for (let i = 0; i < messages; i++) {
      await store.upsertMessage({
        threadId,
        providerMessageId: `m-${key}-${i}`,
        from,
        to: [support],
        cc: [],
        date,
        headers: {},
        bodyText: `${subject}.`,
        bodyHtml: null,
        snippet: subject,
      });
    }
    return threadId;
  };

  /** The model: a draft, a retry, a revision or an edit, by what it is asked. */
  const script: Array<(call: ChatCall) => string | null> = [];
  const answer = (call: ChatCall) => {
    for (const s of script) {
      const out = s(call);
      if (out !== null) return out;
    }
    return JSON.stringify(WRITTEN);
  };

  beforeAll(async () => {
    db = await testDatabase();
    const keys = createKeys(db.handle.db);
    await keys.unlock(randomKey());
    store = createMailstore(db.handle.db, keys);
    const account: Account = {
      id: "acct-views-agent",
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
    chat.answer(answer);
    // Twelve support threads today: some are sales mail the judge reads as support at first.
    for (let i = 0; i < 12; i++) {
      await addThread(`s${i}`, i < 2 ? `Partnership offer ${i}` : `Export broken ${i}`, {
        name: `Customer ${i}`,
        email: `c${i}@customer.test`,
      });
    }
    // Once the question says partnerships are not support, the judge reads the sales mail right.
    judge.when(
      (state, questions) =>
        /Partnership offer/.test(JSON.stringify(state)) &&
        /partnerships and offers/.test(
          JSON.stringify(questions[SUPPORT("is_support_request")] ?? ""),
        ),
      { [SUPPORT("is_support_request")]: 0.05, [SUPPORT("severity")]: 0, frustrated: 0 },
    );
    judge.when((state) => /Partnership offer/.test(JSON.stringify(state)), {
      [SUPPORT("is_support_request")]: 0.8,
      [SUPPORT("severity")]: 0,
      frustrated: 0,
    });
    judge.when((state) => /Export broken [0-4]\b/.test(JSON.stringify(state)), {
      [SUPPORT("is_support_request")]: 0.95,
      [SUPPORT("severity")]: 2,
      frustrated: 1,
    });
    judge.when((state) => /Export broken/.test(JSON.stringify(state)), {
      [SUPPORT("is_support_request")]: 0.9,
      [SUPPORT("severity")]: 0.2,
      frustrated: 0,
    });
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
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  });

  let draftId = "";

  test("the sentence yields a card with 10 tried threads and their reasons; nothing is pinned yet", async () => {
    const tools = intelligence.agent.tools(workspaceId);
    const out = await tools.call(
      {
        name: "create_view",
        args: { sentence: "show today's support requests as red, yellow and green" },
        callId: "c-1",
        sessionId: "s-1",
      },
      { ask: async () => "approved" as const },
    );
    expect(out.isError).toBe(false);
    expect(out.activity.preview?.kind).toBe("view");
    const preview = out.activity.preview as { draftId: string; draft: { test: unknown } };
    draftId = preview.draftId;
    const draft = await intelligence.views.drafting.drafts.get(draftId);
    expect(draft.test?.tried).toBe(12);
    expect(draft.test?.shown).toHaveLength(10);
    expect(draft.test?.counts).toMatchObject({ red: 3, green: 9, unsure: 0 });
    const red = draft.test?.shown.find((t) => t.lane === "red");
    expect(red?.reasons).toEqual([
      "support request 95%",
      "blocked 2.0 of 2",
      "frustrated 1.0 of 3",
    ]);
    expect(red?.subject).toMatch(/Export broken/);
    expect(out.text).toContain("Nothing is saved until the user clicks Pin view");
    expect(await intelligence.views.store.list(workspaceId)).toEqual([]);
    expect(TOOL_TIERS.create_view).toBe("read");
  });

  test("two corrections, a revision: the agreement line and the revised question; Pin saves version 1 with the Examples", async () => {
    const draft = await intelligence.views.drafting.drafts.get(draftId);
    const sales = (draft.test?.shown ?? []).filter((t) => /Partnership/.test(t.subject));
    expect(sales.length).toBeGreaterThan(0);
    const app = viewRoutes(intelligence.views);
    const ids = draft.threadIds.slice(0);
    const salesIds: string[] = [];
    for (const id of ids) {
      if (/Partnership/.test(await store.readThreadSubject(id))) salesIds.push(id);
    }
    expect(salesIds).toHaveLength(2);
    for (const threadId of salesIds) {
      const res = await app.request(`/views/drafts/${draftId}/corrections`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threadId, signal: "is_support_request", holds: false }),
      });
      expect(res.status).toBe(200);
    }
    // The revision tightens the question; the judge now reads the sales mail right.
    const reworded = {
      ...WRITTEN,
      signals: WRITTEN.signals.map((s) =>
        s.id === "is_support_request"
          ? {
              ...s,
              question: {
                ...s.question,
                criteria: {
                  true: "A customer reports something broken or asks for help with the product.",
                  false: "Sales, partnerships and offers, even when they ask a question.",
                },
              },
            }
          : s,
      ),
    };
    script.push((call) =>
      call.prompt.includes("corrected these threads") ? JSON.stringify(reworded) : null,
    );
    const out = await intelligence.agent
      .tools(workspaceId)
      .call(
        { name: "revise_view", args: { draft_id: draftId }, callId: "c-2", sessionId: "s-1" },
        { ask: async () => "approved" as const },
      );
    expect(out.isError).toBe(false);
    const revised = await intelligence.views.drafting.drafts.get(draftId);
    expect(revised.test?.changes.join(" ")).toContain("rewrote the question for support request");
    expect(revised.test?.agreement).toEqual({ agree: 2, total: 2 });
    expect(revised.test?.counts.green).toBe(7);
    expect(revised.doc.examples.is_support_request).toHaveLength(2);
    // Pin view: version 1, pinned, with the Examples in the document and in the question asked.
    const pinned = await app.request(`/views/drafts/${draftId}/pin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(pinned.status).toBe(200);
    const { view } = (await pinned.json()) as {
      view: { id: string; version: number; doc: ViewDoc };
    };
    expect(view.version).toBe(1);
    expect(view.doc.examples.is_support_request).toHaveLength(2);
    const defs = await intelligence.signals.defs(workspaceId);
    const def = defs.find((d) => d.id === viewSignalId(view.id, "is_support_request"));
    expect(JSON.stringify(def?.question)).toContain("Partnership offer");
    expect((await intelligence.views.store.list(workspaceId)).map((b) => b.id)).toEqual([view.id]);
  });

  test("an edit that changes a Lane shows the moves before Apply, saves version 2, and Undo restores version 1", async () => {
    const [view] = await intelligence.views.store.list(workspaceId);
    if (!view) throw new Error("view");
    const paying = {
      ...WRITTEN,
      lanes: [
        WRITTEN.lanes[0],
        {
          id: "yellow",
          label: "Yellow",
          tone: "warning",
          when: {
            all: [
              { signal: "is_support_request", holds: true },
              { fact: "known_sender", is: true },
            ],
          },
        },
        WRITTEN.lanes[2],
      ],
    };
    script.push((call) =>
      call.prompt.includes("only paying customers") ? JSON.stringify(paying) : null,
    );
    const out = await intelligence.agent.tools(workspaceId).call(
      {
        name: "update_view",
        args: { view_id: view.id, instruction: "make yellow only paying customers" },
        callId: "c-3",
        sessionId: "s-1",
      },
      { ask: async () => "approved" as const },
    );
    expect(out.isError).toBe(false);
    const draftOf = (out.activity.preview as { draftId: string }).draftId;
    const draft = await intelligence.views.drafting.drafts.get(draftOf);
    expect(draft.test?.moves).not.toBeNull();
    // Nothing changed yet.
    expect((await intelligence.views.store.get(view.id))?.version).toBe(1);
    const applied = await intelligence.views.drafting.apply(draftOf);
    expect(applied.view.version).toBe(2);
    expect(applied.previous).toBe(1);
    await intelligence.views.store.revert(view.id, applied.previous);
    expect((await intelligence.views.store.get(view.id))?.version).toBe(1);
    // A pure name change applies at once with Undo.
    const rename = await intelligence.agent.tools(workspaceId).call(
      {
        name: "update_view",
        args: { view_id: view.id, name: "Support" },
        callId: "c-4",
        sessionId: "s-1",
      },
      { ask: async () => "approved" as const },
    );
    expect(rename.isError).toBe(false);
    expect((await intelligence.views.store.get(view.id))?.doc.name).toBe("Support");
    await intelligence.agent.tools(workspaceId).undo(rename.activity.id);
    expect((await intelligence.views.store.get(view.id))?.doc.name).not.toBe("Support");
  });

  test("a draft that asks the judge to count fails validation; the retry uses message_count", async () => {
    let calls = 0;
    script.unshift((call) => {
      if (!call.prompt.includes("long threads")) return null;
      calls += 1;
      return JSON.stringify(calls === 1 ? COUNTING : COUNTING_FIXED);
    });
    const draft = await intelligence.views.drafting.propose(workspaceId, "a view of long threads");
    expect(calls).toBe(2);
    expect(chat.calls.at(-1)?.prompt).toContain("message_count");
    expect(draft.doc.lanes[0]?.when).toEqual({ fact: "message_count", at_least: 4 });
    expect(draft.doc.signals).toEqual([]);
  });

  test("a quiet scope widens its dates and says so; with nothing at all, the card offers to pin anyway", async () => {
    await setSetting("views.test.pool", 30);
    for (let i = 0; i < 20; i++) {
      await addThread(
        `old${i}`,
        `Export broken old ${i}`,
        { name: "Old", email: `o${i}@customer.test` },
        "2026-09-20T09:00:00.000Z",
      );
    }
    const draft = await intelligence.views.drafting.propose(
      workspaceId,
      "show today's support requests",
    );
    expect(draft.test?.widened).toEqual({ when: "today", count: 12 });
    expect(draft.test?.tried).toBe(30);
    script.unshift((call) =>
      call.prompt.includes("from nobody")
        ? JSON.stringify({
            ...WRITTEN,
            scope: { facts: { from_any: ["nobody@nowhere.test"] }, limit: 50 },
          })
        : null,
    );
    const empty = await intelligence.views.drafting.propose(workspaceId, "mail from nobody");
    expect(empty.test?.empty).toBe(true);
    const { view } = await intelligence.views.drafting.pin(empty.id);
    expect(view.checkBar).toBe(true);
    await intelligence.views.store.remove(view.id);
  });

  test("without a TypeSafe key a View that reads mail keeps only its Fact Lanes", async () => {
    const noKey = createIntelligence({
      level: async () => "automate",
      db: db.handle.db,
      mailstore: store,
      chat: chat.chat,
      keys: async (provider) => (provider === "anthropic" ? "sk-ant-fake" : null),
      now: () => NOW,
    });
    script.unshift((call) =>
      call.prompt.includes("with files")
        ? JSON.stringify({
            ...WRITTEN,
            lanes: [
              ...WRITTEN.lanes,
              {
                id: "files",
                label: "Files",
                tone: "info",
                when: { fact: "has_attachment", is: true },
              },
            ],
          })
        : null,
    );
    const draft = await noKey.views.drafting.propose(workspaceId, "support with files");
    expect(draft.test?.needsJudge).toBe(true);
    await expect(noKey.views.drafting.pin(draft.id)).rejects.toThrow("TypeSafe key");
    const { view } = await noKey.views.drafting.pin(draft.id, { factsOnly: true });
    expect(view.doc.lanes.map((l) => l.id)).toEqual(["files"]);
    expect(view.doc.signals).toEqual([]);
  });
});
