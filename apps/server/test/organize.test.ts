// Organizing mail by talking (slice 26) over the seams: the judged-Section
// cache (one Noul per Thread under `judge.section`, cached by statement and
// forgotten on demand), the count a card shows, and the organization tools
// through the tool server on the Server host: update_section and
// delete_section with Undo, create_group plus organize_existing moving the
// mail already there with Undo putting it back, and the refusals.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Account, ApprovalDecision, ToolPreview } from "@monday/shared";
import { defaultSettings } from "@monday/shared";
import { eq } from "drizzle-orm";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys, type Keys } from "../src/crypto/keys.ts";
import { sectionJudgments, threads as threadsTable } from "../src/db/schema.ts";
import { createIntelligence, type Intelligence } from "../src/intelligence/index.ts";
import { createFakeChat, createFakeJudge } from "../src/intelligence/runtime/fake/index.ts";
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
  id: "acct-organize",
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

describe("organizing mail by talking", () => {
  let db: TestDatabase;
  let keys: Keys;
  let store: Mailstore;
  let engine: SyncEngine;
  let fake: FakeProvider;
  let intelligence: Intelligence;
  let workspaceId = "";
  const judge = createFakeJudge();
  const chat = createFakeChat('{"scores": {}}');
  let calls = 0;

  const call = (name: string, args: unknown, decision: ApprovalDecision = "approved") => {
    calls += 1;
    const a = approver(decision);
    return intelligence.agent
      .tools(workspaceId)
      .call({ name, args, callId: `c-${calls}`, sessionId: null }, a)
      .then((outcome) => ({ outcome, asked: a.asked }));
  };
  const settingsNow = () =>
    readGlobalSettings(db.handle.db, ["sections.rules", "sections.order", "actions.custom"]);
  const putSetting = (key: string, value: unknown) =>
    intelligence.agent
      .tools(workspaceId)
      .call(
        { name: "change_setting", args: { key, value }, callId: `s-${++calls}`, sessionId: null },
        approver("approved"),
      );

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
  }, 120_000);

  afterAll(async () => {
    await engine.close();
    await db.drop();
  });

  test("a judged Section asks one Noul per Thread the conditions let through, caches by statement, and forgets on demand", async () => {
    // "Invoices I still owe": every thread in no group, judged.
    const owe = {
      id: "owe",
      name: "Invoices I still owe",
      when: { ungrouped: true },
      judge: "The sender is asking the owner to pay an invoice that is still open.",
      placement: "stream" as const,
      createdBy: "agent" as const,
    };
    await putSetting("sections.rules", [owe, ...defaultSettings()["sections.rules"]]);
    await putSetting("sections.order", ["owe", ...defaultSettings()["sections.order"]]);
    judge.when(
      (state) =>
        String((state as { subject: string }).subject)
          .toLowerCase()
          .includes("invoice"),
      { owe: 0.92 },
    );
    judge.when(() => true, { owe: 0.05 });
    const page = await store.listThreads(workspaceId, { limit: 6 });
    const ids = page.threads.map((t) => t.id);
    const before = judge.calls.length;
    const first = await intelligence.organize.judge(workspaceId, ids);
    expect(first).toHaveLength(ids.length);
    expect(judge.calls.length - before).toBe(ids.length);
    // Headers only reach the Judge: the subject, the sender, counts and list state.
    expect(judge.calls.at(-1)?.questions).toEqual(["owe"]);
    expect(Object.keys(judge.calls.at(-1)?.state as object)).toEqual(
      expect.arrayContaining(["subject", "from", "messages", "listMail", "group"]),
    );
    const invoice = first.find((j) => j.rules.owe !== undefined && j.rules.owe > 0.7);
    expect(invoice).toBeDefined();
    // Cached: the same Threads cost nothing the second time.
    const again = await intelligence.organize.judge(workspaceId, ids);
    expect(again).toEqual(first);
    expect(judge.calls.length - before).toBe(ids.length);
    // Metered under judge.section.
    const month = await intelligence.meter.month(workspaceId, NOW.toISOString().slice(0, 7));
    expect(month.lines.some((l) => l.task === "judge.section")).toBe(true);
    // A reworded statement is asked again; the old answer never decides.
    await putSetting("sections.rules", [
      { ...owe, judge: "The thread is a bill the owner has not paid yet." },
      ...defaultSettings()["sections.rules"],
    ]);
    await intelligence.organize.judge(workspaceId, ids.slice(0, 2));
    expect(judge.calls.length - before).toBe(ids.length + 2);
    const rows = await db.handle.db
      .select()
      .from(sectionJudgments)
      .where(eq(sectionJudgments.ruleId, "owe"));
    expect(rows.length).toBe(ids.length);
    expect(await intelligence.organize.forget(workspaceId, "owe")).toBe(ids.length);
    expect(
      await db.handle.db.select().from(sectionJudgments).where(eq(sectionJudgments.ruleId, "owe")),
    ).toHaveLength(0);
  });

  test("countSection counts what the newest Threads would hold, judging only what the conditions let through", async () => {
    const news = await intelligence.organize.countSection(workspaceId, {
      id: "reading",
      when: { bulk: true },
      placement: "nav",
    });
    expect(news.considered).toBeGreaterThan(0);
    expect(news.judged).toBe(false);
    const before = judge.calls.length;
    const { rules } = await intelligence.organize.sectionRules();
    const owe = rules.find((r) => r.id === "owe");
    if (!owe) throw new Error("no owe rule");
    const count = await intelligence.organize.countSection(workspaceId, owe, 8);
    expect(count.considered).toBe(8);
    expect(count.judged).toBe(true);
    expect(count.undecided).toBe(0);
    expect(count.holds).toBeGreaterThanOrEqual(1);
    expect(judge.calls.length - before).toBe(8);
  });

  test("update_section renames, moves to the nav and hides; delete_section removes; Undo restores each", async () => {
    const changed = await call("update_section", {
      section: "Invoices I still owe",
      name: "Owed",
      placement: "nav",
      hidden: true,
      position: "bottom",
    });
    expect(changed.outcome.isError).toBe(false);
    expect(changed.outcome.activity.preview).toMatchObject({ kind: "text" });
    const text =
      changed.outcome.activity.preview?.kind === "text"
        ? changed.outcome.activity.preview.text
        : "";
    expect(text).toContain('Change section "Owed" in the nav, hidden');
    expect(text).toContain("judge says yes to");
    let s = await settingsNow();
    expect(s["sections.rules"].find((r) => r.id === "owe")).toMatchObject({
      name: "Owed",
      placement: "nav",
      hidden: true,
    });
    expect(s["sections.order"].at(-1)).toBe("owe");
    const undone = await intelligence.agent.undo(changed.outcome.activity.id, null);
    expect(undone.result).toContain("Undone");
    s = await settingsNow();
    expect(s["sections.rules"].find((r) => r.id === "owe")).toMatchObject({
      name: "Invoices I still owe",
      placement: "stream",
    });
    expect(s["sections.order"][0]).toBe("owe");

    const removed = await call("delete_section", { section: "owe" });
    expect(removed.outcome.isError).toBe(false);
    expect(removed.outcome.text).toContain("no thread was deleted");
    s = await settingsNow();
    expect(s["sections.rules"].some((r) => r.id === "owe")).toBe(false);
    expect(await db.handle.db.select().from(threadsTable)).toHaveLength(24);
    await intelligence.agent.undo(removed.outcome.activity.id, null);
    s = await settingsNow();
    expect(s["sections.rules"].some((r) => r.id === "owe")).toBe(true);

    const missing = await call("update_section", { section: "nowhere", hidden: true });
    expect(missing.outcome.isError).toBe(true);
    expect(missing.outcome.text).toContain('No section "nowhere"');
  });

  test("create_group then organize_existing moves the mail already there, with a preview above the threshold and one Undo", async () => {
    const created = await call("create_group", {
      name: "Northwind",
      sentence: "Everything from Aoife at Northwind.",
      senders: ["aoife@northwind.test"],
    });
    expect(created.outcome.isError).toBe(false);
    expect(created.outcome.activity.undo).toMatchObject({ kind: "group", previous: null });
    const groups = await intelligence.routing.listGroups(workspaceId);
    const northwind = groups.find((g) => g.name === "Northwind");
    expect(northwind).toBeDefined();

    await putSetting("actions.organize_preview_above", 0);
    const organized = await call("organize_existing", { group: "Northwind" });
    expect(organized.asked).toHaveLength(1);
    expect(organized.asked[0]?.kind === "text" && organized.asked[0].text).toMatch(
      /Move \d+ threads? of the newest \d+ into "Northwind"/,
    );
    expect(organized.outcome.isError).toBe(false);
    const moved = await db.handle.db
      .select({ id: threadsTable.id })
      .from(threadsTable)
      .where(eq(threadsTable.groupId, northwind?.id ?? ""));
    expect(moved.length).toBeGreaterThan(0);
    const undone = await intelligence.agent.undo(organized.outcome.activity.id, null);
    expect(undone.result).toContain("put back");
    expect(
      await db.handle.db
        .select({ id: threadsTable.id })
        .from(threadsTable)
        .where(eq(threadsTable.groupId, northwind?.id ?? "")),
    ).toHaveLength(0);

    const renamed = await call("update_group", { group: "Northwind", name: "Aoife" });
    expect(renamed.outcome.isError).toBe(false);
    expect((await intelligence.routing.getGroup(northwind?.id ?? ""))?.name).toBe("Aoife");
    await intelligence.agent.undo(renamed.outcome.activity.id, null);
    expect((await intelligence.routing.getGroup(northwind?.id ?? ""))?.name).toBe("Northwind");
    await intelligence.agent.undo(created.outcome.activity.id, null);
    expect(await intelligence.routing.getGroup(northwind?.id ?? "")).toBeNull();
  });

  test("organize_existing on a judged Section fills its cache and Undo forgets it; create_action refuses a tool it cannot call", async () => {
    const pass = await call("organize_existing", { section: "owe", recent: 5 });
    expect(pass.outcome.isError).toBe(false);
    expect(pass.outcome.text).toMatch(/\d+ threads? of 5 are in "Invoices I still owe"/);
    expect(
      await db.handle.db.select().from(sectionJudgments).where(eq(sectionJudgments.ruleId, "owe")),
    ).toHaveLength(5);
    const undone = await intelligence.agent.undo(pass.outcome.activity.id, null);
    expect(undone.result).toContain("5 judgments forgotten");
    const bad = await call("create_action", {
      label: "Nuke",
      tool: "delete_event",
      args: {},
    });
    expect(bad.outcome.isError).toBe(true);
    expect(bad.outcome.text).toContain("A custom action may call one of");
    const dup = await call("create_section", { name: "Invoices I still owe" });
    expect(dup.outcome.isError).toBe(true);
    expect(dup.outcome.text).toContain("already exists");
  });
});
