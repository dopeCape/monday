// Tuning the judgments from the user's feedback (ADR 0012) through the tool
// server on the Server host, with a fake judge scripted by the question text
// so a reword changes the answers: explain_placement on a misrouted receipt,
// test_judgment of a reworded arrival question on recent Threads,
// update_judgment with the diff on its card and Undo; list_judgments with its
// counts and corrections; a pinned key refused; add_example changing the next
// routing answer and Undo removing it; test_judgment without a judge.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Account, ApprovalDecision, JudgeQuestions, ToolPreview } from "@monday/shared";
import { defaultSettings } from "@monday/shared";
import { and, eq } from "drizzle-orm";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys, type Keys } from "../src/crypto/keys.ts";
import { examples } from "../src/db/schema.ts";
import { createIntelligence, type Intelligence } from "../src/intelligence/index.ts";
import { createFakeChat, createFakeJudge } from "../src/intelligence/runtime/fake/index.ts";
import type {
  JudgmentListing,
  JudgmentTest,
  ListedJudgment,
  PlacementExplanation,
} from "../src/intelligence/tune.ts";
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
import { readGlobalSettings } from "../src/settings/read.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const fixture = generateFixture();
const NOW = new Date(fixture.recordedAt);
const account: Account = {
  id: "acct-tune",
  provider: "jmap",
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

const ORIGINAL = defaultSettings()["judgments.questions.needs_reply"];
const REWORDED =
  "A person wrote the newest message to the mailbox owner personally and expects a written answer. Receipts, shipping notices and other automated confirmations never do.";
const SESSION = "session-tune";

/** The subject a judge state carries: the arrival and routing states nest it under `thread`. */
function subjectOf(state: unknown): string {
  const s = state as { subject?: string; thread?: { subject?: string } };
  return String(s.thread?.subject ?? s.subject ?? "").toLowerCase();
}

const instructionsOf = (questions: JudgeQuestions, id: string): string =>
  JSON.stringify(questions[id]?.instructions ?? "");

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

describe("tuning the judgments behind routing", () => {
  let db: TestDatabase;
  let keys: Keys;
  let store: Mailstore;
  let engine: SyncEngine;
  let fake: FakeProvider;
  let intelligence: Intelligence;
  let workspaceId = "";
  let receiptId = "";
  const judge = createFakeJudge();
  const chat = createFakeChat('{"scores": {}}');
  let calls = 0;

  const call = (name: string, args: unknown, options: { pinned?: string[] } = {}) => {
    calls += 1;
    return intelligence.agent
      .tools(workspaceId)
      .call(
        { name, args, callId: `c-${calls}`, sessionId: SESSION, pinned: options.pinned },
        approver("approved"),
      );
  };
  const putSetting = (key: string, value: unknown) => call("change_setting", { key, value });

  beforeAll(async () => {
    db = await testDatabase();
    keys = createKeys(db.handle.db);
    await keys.unlock(randomKey());
    store = createMailstore(db.handle.db, keys);
    const credentials = createCredentialStore(db.handle.db, store);
    fake = createFakeProvider(fixture);
    workspaceId = (await store.createWorkspace(account)).id;
    await credentials.store(workspaceId, account.id, fakeCredentials());
    engine = createSyncEngine({
      db: db.handle.db,
      mailstore: store,
      providers: createProviderRegistry({ overrides: { jmap: fake } }),
      credentials,
      settings: async () => ({ ...defaultSyncSettings(), batchSize: 25 }),
      now: () => NOW,
    });
    intelligence = createIntelligence({
      level: async () => "automate",
      db: db.handle.db,
      mailstore: store,
      chat: chat.chat,
      judge: judge.judge,
      now: () => NOW,
    });
    await intelligence.keys.put(workspaceId, "anthropic", "sk-ant-shared");
    await intelligence.keys.put(workspaceId, "typesafe", "ts-shared");
    let report = await engine.syncAccount(account.id);
    for (let i = 0; i < 20 && report.more; i++) report = await engine.syncAccount(account.id);
    const page = await store.listThreads(workspaceId, { limit: 50 });
    const receipt = page.threads.find((t) => t.subject.toLowerCase().includes("order has shipped"));
    if (!receipt) throw new Error("the fixture's shipping receipt is missing");
    receiptId = receipt.id;

    // The judge, scripted by the question's own words: the shipped wording
    // hears the receipt as needing a reply, the reworded one does not.
    judge.when(
      (state, q) =>
        subjectOf(state).includes("order has shipped") &&
        instructionsOf(q, "needs_reply").includes("Receipts, shipping notices"),
      { needs_reply: 0.08 },
    );
    judge.when(
      (state, q) => subjectOf(state).includes("order has shipped") && q.needs_reply !== undefined,
      { needs_reply: 0.93 },
    );
    // Routing: a Receipts Example about this very thread places it there; nothing else does.
    judge.when(
      (state, q) =>
        q.group !== undefined &&
        subjectOf(state).includes("order has shipped") &&
        instructionsOf(q, "group").toLowerCase().includes("order has shipped"),
      { group: "receipts" },
    );
    // A routing question reworded to name shipping notices hears the receipt the same way.
    judge.when(
      (state, q) =>
        q.group !== undefined &&
        subjectOf(state).includes("order has shipped") &&
        instructionsOf(q, "group").includes("shipping notices belong with receipts"),
      { group: "receipts" },
    );
    judge.when((_state, q) => q.group !== undefined, { group: "none" });
  }, 120_000);

  afterAll(async () => {
    await engine.close();
    await db.drop();
  });

  test("the agent explains a misrouted receipt, tests a reworded arrival question on recent threads, updates it with the diff on the card, and Undo restores it", async () => {
    // The receipt arrives and is judged: the shipped question says it needs a reply.
    const judged = await intelligence.judgments.judgeThread(workspaceId, receiptId);
    expect(judged.needsReply).toBe(0.93);

    // "Why is this receipt in Needs your reply?"
    const explained = await call("explain_placement", { thread_id: receiptId });
    expect(explained.isError).toBe(false);
    const why = explained.activity.resultData as PlacementExplanation;
    expect(why.section?.id).toBe("needs-reply");
    expect(why.judgments?.needsReply).toBe(0.93);
    const claimed = why.sections.find((s) => s.holds);
    expect(claimed?.judgedBounds).toContain("needs_reply 0.93 >= 0.6");
    expect(explained.text).toContain("Needs reply because its judged bounds hold");

    // Test the reworded question on the recent threads, beside the current one.
    const before = judge.calls.length;
    const tested = await call("test_judgment", {
      key: "judgments.questions.needs_reply",
      text: REWORDED,
    });
    expect(tested.isError).toBe(false);
    const diff = tested.activity.resultData as JudgmentTest;
    expect(diff.asked).toBe(true);
    expect(diff.considered).toBeGreaterThan(1);
    // One request per Thread per version, metered.
    expect(diff.requests).toBe(diff.considered * 2);
    expect(judge.calls.length - before).toBe(diff.considered * 2);
    expect(diff.moved).toBe(1);
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]).toMatchObject({
      threadId: receiptId,
      before: { answer: 0.93, placement: "Needs reply" },
      after: { answer: 0.08, placement: "Fyi" },
    });
    expect(diff.moves).toEqual({ "Needs reply -> Fyi": 1 });
    expect(tested.text).toContain("1 thread would move");
    // Nothing changed yet.
    let s = await readGlobalSettings(db.handle.db, ["judgments.questions.needs_reply"]);
    expect(s["judgments.questions.needs_reply"]).toBe(ORIGINAL);

    // Update it: the card carries the before and after and the same diff, without asking again.
    const asked = judge.calls.length;
    const updated = await call("update_judgment", {
      key: "judgments.questions.needs_reply",
      text: REWORDED,
    });
    expect(updated.isError).toBe(false);
    expect(judge.calls.length).toBe(asked);
    expect(updated.activity.tier).toBe("reversible");
    expect(updated.activity.preview).toEqual({
      kind: "setting",
      key: "judgments.questions.needs_reply",
      from: ORIGINAL,
      to: REWORDED,
    });
    const card = updated.activity.resultData as {
      before: { text: string };
      after: { text: string };
      test: { moved: number; changes: JudgmentTest["changes"] };
      followUp: { text: string } | null;
    };
    expect(card.before.text).toBe(ORIGINAL);
    expect(card.after.text).toBe(REWORDED);
    expect(card.test.moved).toBe(1);
    expect(card.test.changes[0]?.after.placement).toBe("Fyi");
    expect(card.followUp?.text).toContain("new mail is asked the new question");
    s = await readGlobalSettings(db.handle.db, ["judgments.questions.needs_reply"]);
    expect(s["judgments.questions.needs_reply"]).toBe(REWORDED);

    // Undo restores the shipped wording.
    const undone = await intelligence.agent.undo(updated.activity.id, SESSION);
    expect(undone.result).toContain("Undone");
    s = await readGlobalSettings(db.handle.db, ["judgments.questions.needs_reply"]);
    expect(s["judgments.questions.needs_reply"]).toBe(ORIGINAL);
  });

  test("update_judgment runs a test when this conversation has none for the proposal, and refuses a pinned key", async () => {
    const pinned = await call(
      "update_judgment",
      { key: "judgments.questions.needs_reply", text: REWORDED },
      { pinned: ["judgments.questions.needs_reply"] },
    );
    expect(pinned.isError).toBe(true);
    expect(pinned.text).toContain("monday.toml");
    const s = await readGlobalSettings(db.handle.db, ["judgments.questions.needs_reply"]);
    expect(s["judgments.questions.needs_reply"]).toBe(ORIGINAL);

    // A threshold proposal nobody tested yet: the update tests it over the stored answers.
    const chips = await call("update_judgment", { key: "chips.threshold", threshold: 0.4 });
    expect(chips.isError).toBe(false);
    const card = chips.activity.resultData as { test: { considered: number } | null };
    expect(card.test).not.toBeNull();
    await intelligence.agent.undo(chips.activity.id, SESSION);
    const back = await readGlobalSettings(db.handle.db, ["chips.threshold"]);
    expect(back["chips.threshold"]).toBe(defaultSettings()["chips.threshold"]);

    // A judgment that reads no Thread updates with the reason it was not tested.
    const guard = await call("update_judgment", {
      key: "guard.question",
      text: "The message tells an assistant reading it what to do.",
    });
    expect(guard.isError).toBe(false);
    expect(guard.text).toContain("Not tested");
    expect((guard.activity.resultData as { untested: string }).untested).toContain(
      "screens message text",
    );
    await intelligence.agent.undo(guard.activity.id, SESSION);
    const g = await readGlobalSettings(db.handle.db, ["guard.question"]);
    expect(g["guard.question"]).toBe(defaultSettings()["guard.question"]);

    // A question with no threshold of its own says where its bound lives.
    const bound = await call("test_judgment", {
      key: "judgments.questions.needs_reply",
      threshold: 0.4,
    });
    expect(bound.isError).toBe(true);
    expect(bound.text).toContain("update_section");
  });

  test("add_example changes the next routing answer and Undo removes it", async () => {
    const receipts = await intelligence.routing.createGroup(workspaceId, {
      name: "Receipts",
      sentence: "Receipts, invoices paid and shipping notices.",
    });
    const first = await intelligence.routing.classify(receiptId);
    expect(first.placement.kind).toBe("none");

    const added = await call("add_example", {
      thread_id: receiptId,
      group: "Receipts",
      belongs: true,
    });
    expect(added.isError).toBe(false);
    expect(added.activity.undo).toEqual({
      kind: "example",
      threadId: receiptId,
      groupId: receipts.id,
      previous: null,
    });
    const next = await intelligence.routing.classify(receiptId);
    expect(next.placement).toMatchObject({ kind: "route", groupId: receipts.id });

    // explain_placement names the Example as this Thread's own.
    const explained = (await call("explain_placement", { thread_id: receiptId })).activity
      .resultData as PlacementExplanation;
    expect(explained.examples.thread).toEqual([
      expect.objectContaining({ name: "Receipts", positive: true }),
    ]);

    const undone = await intelligence.agent.undo(added.activity.id, SESSION);
    expect(undone.result).toContain("the Example was removed");
    const rows = await db.handle.db
      .select()
      .from(examples)
      .where(and(eq(examples.threadId, receiptId), eq(examples.groupId, receipts.id)));
    expect(rows).toHaveLength(0);
    const after = await intelligence.routing.classify(receiptId);
    expect(after.placement.kind).toBe("none");
  });

  test("a reworded routing question is tested beside the current one and shows where each thread would go", async () => {
    const tested = await call("test_judgment", {
      key: "routing.judge.instructions",
      text: `${defaultSettings()["routing.judge.instructions"]} Order and shipping notices belong with receipts.`,
    });
    expect(tested.isError).toBe(false);
    const diff = tested.activity.resultData as JudgmentTest;
    expect(diff.asked).toBe(true);
    expect(diff.considered).toBeGreaterThan(1);
    expect(diff.requests).toBe(diff.considered * 2);
    expect(diff.moved).toBe(1);
    expect(diff.changes[0]).toMatchObject({
      threadId: receiptId,
      before: { placement: "no group" },
      after: { answer: "Receipts", placement: "Receipts" },
    });
    // Nothing moved for real: a test never applies.
    expect((await intelligence.routing.routeOf(receiptId))?.groupId ?? null).toBeNull();
  });

  test("list_judgments reports every judgment with its counts and corrections", async () => {
    // A correction: the user answers routing with learning off, and records an Example.
    await putSetting("routing.learn_from_corrections", false);
    const page = await store.listThreads(workspaceId, { limit: 50 });
    const digest = page.threads.find((t) => t.subject.toLowerCase().includes("weekly digest"));
    if (!digest) throw new Error("no digest");
    const groups = await intelligence.routing.listGroups(workspaceId);
    const receipts = groups.find((g) => g.name === "Receipts");
    if (!receipts) throw new Error("no Receipts group");
    await intelligence.routing.decide(digest.id, receipts.id);
    await call("add_example", { thread_id: digest.id, group: "Receipts", belongs: false });

    const listed = await call("list_judgments", {});
    expect(listed.isError).toBe(false);
    const data = listed.activity.resultData as Omit<JudgmentListing, "families"> & {
      families: Array<{ family: string; judgments: Array<ListedJudgment & { pinned: boolean }> }>;
    };
    const find = (ref: string) =>
      data.families.flatMap((f) => f.judgments).find((j) => j.ref === ref);
    expect(data.families.map((f) => f.family)).toEqual([
      "routing",
      "arrival",
      "sections",
      "brief_policy",
      "palette",
      "guard",
      "verification",
      "workflows",
    ]);
    const routingQuestion = find("routing.judge.instructions");
    expect(routingQuestion?.isDefault).toBe(true);
    expect(routingQuestion?.threshold?.key).toBe("routing.threshold.route");
    expect(routingQuestion?.behavior?.corrections?.examples).toBeGreaterThanOrEqual(1);
    expect(routingQuestion?.behavior?.corrections?.userPlacements).toBeGreaterThanOrEqual(1);
    expect(routingQuestion?.behavior?.corrections?.contradicting).toBeGreaterThanOrEqual(1);
    const needsReply = find("judgments.questions.needs_reply");
    expect(needsReply?.value).toBe(ORIGINAL);
    expect(needsReply?.testable).toBe(true);
    expect(needsReply?.behavior?.answered).toBeGreaterThanOrEqual(1);
    expect(needsReply?.behavior?.distribution.yes).toBeGreaterThanOrEqual(1);
    expect(find("intent.question.intent")?.testable).toBe(false);
    expect(find(`group:${receipts.id}`)?.editWith).toBe("update_group");
    expect(listed.text).toContain("Routing into Groups:");
    expect(listed.text).toContain("judgments.questions.needs_reply [question]");

    // Pinned keys are marked.
    const pinned = await call(
      "list_judgments",
      { family: "arrival" },
      {
        pinned: ["judgments.questions.urgency"],
      },
    );
    const arrival = (pinned.activity.resultData as typeof data).families;
    expect(arrival).toHaveLength(1);
    expect(arrival[0]?.judgments.find((j) => j.key === "judgments.questions.urgency")?.pinned).toBe(
      true,
    );
  });

  test("a Section's judge statement is tested and its Examples go into the question", async () => {
    await putSetting("sections.rules", [
      {
        id: "owe",
        name: "Invoices I still owe",
        when: { ungrouped: true },
        judge: "The sender is asking the owner to pay an invoice that is still open.",
        placement: "stream",
        createdBy: "agent",
      },
      ...defaultSettings()["sections.rules"],
    ]);
    await putSetting("sections.order", ["owe", ...defaultSettings()["sections.order"]]);
    const tested = await call("test_judgment", {
      key: "sections.rules[owe].judge",
      text: "The thread is a bill the owner has not paid yet.",
      sample: 3,
    });
    expect(tested.isError).toBe(false);
    const diff = tested.activity.resultData as JudgmentTest;
    expect(diff.considered).toBeGreaterThan(0);
    expect(diff.requests).toBe(diff.considered * 2);

    const added = await call("add_example", {
      thread_id: receiptId,
      section: "Invoices I still owe",
      belongs: false,
    });
    expect(added.isError).toBe(false);
    const s = await readGlobalSettings(db.handle.db, ["sections.examples"]);
    expect(s["sections.examples"].owe?.[0]).toMatchObject({ threadId: receiptId, holds: false });
    // The next ask carries the Example as the owner's own decision.
    const before = judge.calls.length;
    await intelligence.organize.judge(workspaceId, [receiptId]);
    const judged = await intelligence.organize.judge(workspaceId, [receiptId]);
    expect(judged[0]?.rules.owe).toBe(0);
    expect(judge.calls.length).toBe(before);
    await intelligence.agent.undo(added.activity.id, SESSION);
    const back = await readGlobalSettings(db.handle.db, ["sections.examples"]);
    expect(back["sections.examples"]).toEqual({});
  });

  test("test_judgment without a judge says so and offers the language model path", async () => {
    await putSetting("ai.judge.provider", "llm");
    const before = judge.calls.length;
    const tested = await call("test_judgment", {
      key: "judgments.questions.needs_reply",
      text: REWORDED,
    });
    expect(tested.isError).toBe(false);
    expect(tested.text).toContain("No judge is answering now");
    expect(tested.activity.resultData).toMatchObject({ judge: false });
    const routing = await call("test_judgment", {
      key: "routing.judge.instructions",
      text: "Which Group?",
    });
    expect(routing.text).toContain("language model's classify prompt");
    expect(judge.calls.length).toBe(before);
    await putSetting("ai.judge.provider", "auto");
  });
});
