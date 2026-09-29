// Boards I (slice 39; docs/spec/boards.md): a Board is a validated, versioned,
// sealed document; its own Signals are defined for the Signal store, owned by
// the Board and asked only of the Threads its scope admits; three-valued
// Lanes on the Server's answers (acceptance 2); a Fact-only Board with no
// judge at all (acceptance 6); delete with Undo brings it back with its
// answers and asks nothing again (acceptance 8); versions, the nav order,
// the limits, and a correction on the Board.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Account, BoardChange, Change } from "@monday/shared";
import { boardSignalId, PAPERWORK_BOARD, SUPPORT_TODAY_BOARD } from "@monday/shared";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys } from "../src/crypto/keys.ts";
import { settings as settingsTable, signalDefs } from "../src/db/schema.ts";
import { createIntelligence, type Intelligence } from "../src/intelligence/index.ts";
import { createFakeChat, createFakeJudge } from "../src/intelligence/runtime/fake/index.ts";
import { createMailstore, type Mailstore } from "../src/mailstore/index.ts";
import { boardRoutes } from "../src/routes/boards.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const NOW = new Date("2026-09-29T12:00:00Z");
const owner = { name: "Sam Okafor", email: "sam@acme.com" };
const support = { name: "Acme Support", email: "support@acme.com" };
const SUPPORT = (id: string) => boardSignalId(SUPPORT_TODAY_BOARD.id, id);

describe("Boards on the Server", () => {
  let db: TestDatabase;
  let store: Mailstore;
  let workspaceId: string;
  const judge = createFakeJudge();
  let intelligence: Intelligence;

  const setSetting = async (key: string, value: unknown) => {
    await db.handle.db
      .insert(settingsTable)
      .values({ scope: "global", deviceId: null, key, value })
      .onConflictDoUpdate({
        target: [settingsTable.scope, settingsTable.deviceId, settingsTable.key],
        set: { value },
      });
  };

  const subjectOf = (state: unknown) =>
    (state as { thread?: { subject?: string } }).thread?.subject ?? "";

  const addThread = async (
    key: string,
    subject: string,
    from: { name: string; email: string },
    options: {
      to?: Array<{ name: string; email: string }>;
      date?: string;
      messages?: number;
      text?: string;
    } = {},
  ) => {
    const date = options.date ?? "2026-09-29T09:00:00.000Z";
    const threadId = await store.upsertThread({
      workspaceId,
      providerThreadId: key,
      subject,
      participants: [from, owner],
      lastActivity: date,
    });
    for (let i = 0; i < (options.messages ?? 1); i++) {
      await store.upsertMessage({
        threadId,
        providerMessageId: `m-${key}-${i}`,
        from,
        to: options.to ?? [support],
        cc: [],
        date,
        headers: {},
        bodyText: options.text ?? `${subject}. Please help.`,
        bodyHtml: null,
        snippet: subject,
      });
    }
    return threadId;
  };

  beforeAll(async () => {
    db = await testDatabase();
    const keys = createKeys(db.handle.db);
    await keys.unlock(randomKey());
    store = createMailstore(db.handle.db, keys);
    const account: Account = {
      id: "acct-boards",
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
    judge.when((state) => subjectOf(state) === "The export is broken", {
      [SUPPORT("is_support_request")]: 0.95,
      [SUPPORT("severity")]: 2,
      frustrated: 1,
    });
    judge.when((state) => subjectOf(state) === "Question about seats", {
      [SUPPORT("is_support_request")]: 0.5,
      [SUPPORT("severity")]: 0,
      frustrated: 0,
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

  test("a fixture document saves as version 1, sealed, pinned last, and the feed carries headers only", async () => {
    const board = await intelligence.boards.store.create(workspaceId, SUPPORT_TODAY_BOARD);
    await intelligence.boards.changed(workspaceId);
    expect(board).toMatchObject({ id: "b_support_today", version: 1, pinned: true, position: 0 });
    expect(board.doc.name).toBe("Support today");
    const changes = (await store.listChanges(workspaceId, { since: 0, limit: 1000 }))
      .changes as Change[];
    const row = changes.find((c) => c.kind === "board");
    expect(row?.payload as BoardChange).toMatchObject({
      id: "b_support_today",
      version: 1,
      deleted: false,
    });
    expect(JSON.stringify(row)).not.toContain("support@acme.com");
    const [listed] = await intelligence.boards.store.list(workspaceId);
    expect(listed?.doc.lanes.map((l) => l.id)).toEqual(["red", "yellow", "green"]);
  });

  test("its Signals are owned by the Board and asked only of Threads its scope admits", async () => {
    const defs = await intelligence.signals.defs(workspaceId);
    const own = defs.find((d) => d.id === SUPPORT("is_support_request"));
    expect(own).toMatchObject({ active: true, owner: { kind: "board", id: "b_support_today" } });
    expect(own?.facts?.to_any).toEqual(["support@acme.com"]);
    const inScope = await addThread("broken", "The export is broken", {
      name: "Ana",
      email: "ana@customer.test",
    });
    const outOfScope = await addThread(
      "lunch",
      "Lunch Friday",
      { name: "Lee", email: "lee@friend.test" },
      { to: [owner] },
    );
    let before = judge.calls.length;
    await intelligence.signals.ask(workspaceId, inScope, { reason: "arrival" });
    expect(judge.calls.slice(before)).toHaveLength(1);
    expect(judge.calls[before]?.questions).toEqual(
      expect.arrayContaining([SUPPORT("is_support_request"), SUPPORT("severity"), "frustrated"]),
    );
    before = judge.calls.length;
    await intelligence.signals.ask(workspaceId, outOfScope, { reason: "arrival" });
    expect(judge.calls[before]?.questions).not.toContain(SUPPORT("is_support_request"));
    expect(judge.calls[before]?.questions).toContain("needs_reply");
  });

  test("the Lanes on the Server's answers: Red for the broken export, Unsure for an undecided request", async () => {
    const undecided = await addThread("seats", "Question about seats", {
      name: "Bo",
      email: "bo@customer.test",
    });
    await intelligence.signals.ask(workspaceId, undecided, { reason: "arrival" });
    const board = await intelligence.boards.store.get("b_support_today");
    if (!board) throw new Error("board");
    const placed = await intelligence.boards.place(workspaceId, board.doc);
    const lanes = Object.fromEntries(
      placed.view.lanes.map((l) => [l.id, l.rows.map((r) => r.thread.id)]),
    );
    expect(lanes.red).toHaveLength(1);
    expect(lanes.green).toEqual([]);
    expect(lanes.unsure).toEqual([undecided]);
    // The out-of-scope lunch is not on the Board at all.
    expect(placed.view.total).toBe(2);
    expect(placed.view.navCount).toBe(1);
  });

  test("a Fact-only Board works with no judge", async () => {
    const noJudge = createIntelligence({
      level: async () => "automate",
      db: db.handle.db,
      mailstore: store,
      chat: createFakeChat("{}").chat,
      keys: async () => null,
      now: () => NOW,
    });
    await addThread(
      "contract",
      "Contract redlines",
      { name: "Kim", email: "kim@law.test" },
      { to: [owner], messages: 5 },
    );
    await noJudge.boards.store.create(workspaceId, PAPERWORK_BOARD);
    const board = await noJudge.boards.store.get("b_paperwork");
    if (!board) throw new Error("board");
    const placed = await noJudge.boards.place(workspaceId, board.doc);
    // No thread has an attachment in this fixture: every one is claimed by no Lane and hidden.
    expect(placed.view.counts.unsure).toBe(0);
    expect(placed.view.total).toBe(0);
    await noJudge.boards.store.remove("b_paperwork");
  });

  test("an edit is version 2 and Undo points back at version 1; the nav order moves", async () => {
    const edited = await intelligence.boards.store.update("b_support_today", {
      ...SUPPORT_TODAY_BOARD,
      name: "Support",
    });
    expect(edited).toMatchObject({ previous: 1, board: { version: 2, doc: { name: "Support" } } });
    const back = await intelligence.boards.store.revert("b_support_today", 1);
    expect(back.doc.name).toBe("Support today");
    expect(back.version).toBe(1);
    expect((await intelligence.boards.store.version("b_support_today", 2))?.name).toBe("Support");
    const second = await intelligence.boards.store.create(workspaceId, {
      ...PAPERWORK_BOARD,
      id: "b_files",
      name: "Files",
    });
    expect(second.position).toBe(1);
    const moved = await intelligence.boards.store.move("b_files", -1);
    expect(moved.map((b) => b.id)).toEqual(["b_files", "b_support_today"]);
    await intelligence.boards.store.remove("b_files");
  });

  test("a document over a limit is refused with the reason, before anything is saved", async () => {
    await setSetting("boards.max", 1);
    await expect(
      intelligence.boards.store.create(workspaceId, { ...PAPERWORK_BOARD, id: "b_more" }),
    ).rejects.toThrow("the most there can be");
    await setSetting("boards.max", 12);
    await expect(
      intelligence.boards.store.create(workspaceId, {
        ...SUPPORT_TODAY_BOARD,
        id: "b_counting",
        signals: [
          {
            id: "many_replies",
            kind: "noul",
            question: { type: "noul", instructions: "The thread has more than 3 replies." },
          },
        ],
        uses: [],
        lanes: [
          {
            id: "long",
            label: "Long",
            tone: "info",
            when: { signal: "many_replies", holds: true },
          },
        ],
        nav: { icon: "lifebuoy", count: "long" },
      }),
    ).rejects.toThrow("message_count");
    expect(await intelligence.boards.store.get("b_counting")).toBeNull();
  });

  test("a correction on the Board keeps the Thread where the user put it and records an Example", async () => {
    const board = await intelligence.boards.store.get("b_support_today");
    const placed = await intelligence.boards.place(workspaceId, board?.doc ?? SUPPORT_TODAY_BOARD);
    const red = placed.view.lanes.find((l) => l.id === "red")?.rows[0]?.thread.id;
    if (!red) throw new Error("red");
    const moved = await intelligence.boards.moveThread("b_support_today", red, "green");
    expect(moved.placements[red]).toMatchObject({ lane: "green", from: "red", messageCount: 1 });
    const again = await intelligence.boards.place(workspaceId, moved.doc, {
      placements: moved.placements,
    });
    expect(again.view.lanesOf.get(red)).toBe("green");
    const corrections = await intelligence.boards.store.corrections("b_support_today");
    // Red and Green both require a support request: the move is no evidence against it, only a Lane choice.
    expect(corrections.is_support_request).toBeUndefined();
    expect(corrections._lanes?.[0]).toMatchObject({
      threadId: red,
      lane: "green",
      subject: "The export is broken",
    });
    // Out of every Lane (to Unsure): now it is evidence the support request does not hold.
    const out = await intelligence.boards.moveThread("b_support_today", red, "unsure");
    expect(out.placements[red]?.lane).toBe("unsure");
    expect(
      (await intelligence.boards.store.corrections("b_support_today")).is_support_request?.[0],
    ).toMatchObject({
      threadId: red,
      holds: false,
    });
    await intelligence.boards.moveThread("b_support_today", red, null);
  });

  test("delete with Undo: the Signals lose their consumer, then come back with their answers and no new request", async () => {
    await intelligence.boards.store.remove("b_support_today");
    await intelligence.boards.changed(workspaceId);
    expect(await intelligence.boards.store.list(workspaceId)).toEqual([]);
    const retired = await db.handle.db.query.signalDefs.findFirst({
      where: (t, { eq }) => eq(t.id, SUPPORT("is_support_request")),
    });
    expect(retired?.active).toBe(false);
    await intelligence.boards.store.restore("b_support_today");
    await intelligence.boards.changed(workspaceId);
    const active = await db.handle.db.select().from(signalDefs);
    expect(active.find((d) => d.id === SUPPORT("is_support_request"))).toMatchObject({
      active: true,
      version: 1,
    });
    const before = judge.calls.length;
    const board = await intelligence.boards.store.get("b_support_today");
    const placed = await intelligence.boards.place(workspaceId, board?.doc ?? SUPPORT_TODAY_BOARD);
    const onBoard = placed.view.lanes.flatMap((l) => l.rows.map((r) => r.thread.id));
    expect(onBoard).toHaveLength(2);
    for (const id of onBoard)
      await intelligence.signals.ask(workspaceId, id, { reason: "arrival" });
    expect(judge.calls.length).toBe(before);
    expect(placed.view.counts.red).toBe(1);
  });

  test("the routes: list, a refused document with its errors, and delete then restore", async () => {
    const app = boardRoutes(intelligence.boards);
    const list = await app.request(`/boards?workspace=${workspaceId}`);
    expect(((await list.json()) as { boards: unknown[] }).boards).toHaveLength(1);
    const bad = await app.request("/boards", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace: workspaceId, doc: { name: "x" } }),
    });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as { errors: string[] }).errors.length).toBeGreaterThan(0);
    const del = await app.request("/boards/b_support_today", { method: "DELETE" });
    expect(((await del.json()) as { deletedAt: string | null }).deletedAt).not.toBeNull();
    const back = await app.request("/boards/b_support_today/restore", { method: "POST" });
    expect(((await back.json()) as { deletedAt: string | null }).deletedAt).toBeNull();
  });
});
