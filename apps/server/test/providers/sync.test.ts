import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Account, Thread } from "@monday/shared";
import { eq } from "drizzle-orm";
import { randomKey } from "../../src/crypto/aead.ts";
import { createKeys, type Keys } from "../../src/crypto/keys.ts";
import { jobs as jobsTable, syncState } from "../../src/db/schema.ts";
import { createJobs, type Jobs } from "../../src/jobs/index.ts";
import { createMailstore, type Mailstore } from "../../src/mailstore/index.ts";
import { type CredentialStore, createCredentialStore } from "../../src/providers/credentials.ts";
import {
  createFakeProvider,
  type FakeProvider,
  fakeCredentials,
  generateFixture,
} from "../../src/providers/fake/index.ts";
import { createProviderRegistry } from "../../src/providers/index.ts";
import {
  createSyncEngine,
  defaultSyncSettings,
  labelRows,
  mirrorRows,
  RECONCILE_STEP,
  SYNC_STEP,
  type SyncEngine,
  WATCH_STEP,
} from "../../src/providers/sync.ts";
import { type TestDatabase, testDatabase, waitFor } from "../harness.ts";

const fixture = generateFixture();
const NOW = new Date(fixture.recordedAt);

const account: Account = {
  id: "acct-fake",
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

describe("sync engine over the fake Provider", () => {
  let db: TestDatabase;
  let keys: Keys;
  let store: Mailstore;
  let credentials: CredentialStore;
  let fake: FakeProvider;
  let engine: SyncEngine;
  let jobs: Jobs;
  let workspaceId = "";
  const settings = { ...defaultSyncSettings(), batchSize: 25 };

  beforeAll(async () => {
    db = await testDatabase();
    keys = createKeys(db.handle.db);
    await keys.unlock(randomKey());
    store = createMailstore(db.handle.db, keys);
    credentials = createCredentialStore(db.handle.db, store);
    fake = createFakeProvider(fixture);
    const workspace = await store.createWorkspace(account);
    workspaceId = workspace.id;
    await credentials.store(workspaceId, account.id, fakeCredentials());
    jobs = createJobs(db.handle.db);
    engine = createSyncEngine({
      db: db.handle.db,
      mailstore: store,
      providers: createProviderRegistry({ overrides: { imap: fake } }),
      credentials,
      settings: async () => settings,
      now: () => NOW,
      watchDebounceMs: 50,
    });
    engine.registerSteps(jobs);
  }, 60_000);

  afterAll(async () => {
    await engine.close();
    await db.drop();
  });

  test("credentials round trip through the envelope and never sit in the clear", async () => {
    const loaded = await credentials.load(account.id);
    expect(loaded).toEqual(fakeCredentials());
    const rows = await db.handle.sql`select data_enc from account_credentials`;
    const raw = Buffer.from(rows[0]?.data_enc as Uint8Array).toString("latin1");
    expect(raw).not.toContain("password");
    expect(raw).not.toContain(fixture.address);
  });

  test("first sync: every mailbox, headers first, paced by the budget", async () => {
    // A tiny budget: the first call cannot finish.
    const partial = await engine.syncAccount(account.id, { deadline: Date.now() + 1 });
    expect(partial.more).toBe(true);
    let report = partial;
    let total = partial.added;
    for (let i = 0; i < 50 && report.more; i++) {
      report = await engine.syncAccount(account.id);
      total += report.added;
    }
    expect(report.more).toBe(false);
    expect(total).toBe(60);

    const mirror = await mirrorRows(db.handle.db, workspaceId);
    expect(mirror).toHaveLength(60);
    const threads = await allThreads(store, workspaceId);
    expect(threads).toHaveLength(24);
    expect(threads.reduce((n, t) => n + t.messageCount, 0)).toBe(60);
    // Newest activity first.
    for (let i = 1; i < threads.length; i++) {
      expect((threads[i - 1]?.lastActivity ?? "") >= (threads[i]?.lastActivity ?? "")).toBe(true);
    }
    const state = await db.handle.db.query.syncState.findFirst({
      where: eq(syncState.workspaceId, workspaceId),
    });
    expect(state?.tier).toBe("state");
    expect(Object.keys(state?.mailboxStates ?? {}).sort()).toEqual([
      "Archive",
      "INBOX",
      "Sent",
      "Trash",
    ]);
    expect(state?.pending).toEqual([]);
    expect(state?.lastFullSync).not.toBeNull();
  });

  test("labels carry the well-known roles and Threads carry their labels", async () => {
    const rows = await labelRows(db.handle.db, workspaceId);
    expect(rows.map((r) => [r.providerId, r.role]).sort()).toEqual([
      ["Archive", "archive"],
      ["INBOX", "inbox"],
      ["Sent", "sent"],
      ["Trash", "trash"],
    ]);
    const inboxLabel = rows.find((r) => r.role === "inbox")?.id ?? "";
    const archiveLabel = rows.find((r) => r.role === "archive")?.id ?? "";
    const threads = await allThreads(store, workspaceId);
    const inInbox = threads.filter((t) => t.labels.includes(inboxLabel));
    const archivedOnly = threads.filter(
      (t) => t.labels.includes(archiveLabel) && !t.labels.includes(inboxLabel),
    );
    expect(inInbox.length).toBeGreaterThan(0);
    expect(archivedOnly.length).toBe(4);
    for (const t of inInbox) expect(t.archived).toBe(false);
    for (const t of archivedOnly) expect(t.archived).toBe(true);
  });

  test("threading by References groups the fixture's conversations exactly", async () => {
    const mirror = await mirrorRows(db.handle.db, workspaceId);
    const byThread = new Map<string, Set<string>>();
    for (const row of mirror) {
      const fixtureKey = fixture.messages.find((m) => m.id === row.providerId)?.threadKey ?? "?";
      byThread.set(row.threadId, (byThread.get(row.threadId) ?? new Set()).add(fixtureKey));
    }
    for (const keys of byThread.values()) expect(keys.size).toBe(1);
    expect(byThread.size).toBe(24);
  });

  test("Thread flags derive from Messages: unread, starred", async () => {
    const mirror = await mirrorRows(db.handle.db, workspaceId);
    const threads = await allThreads(store, workspaceId);
    for (const t of threads) {
      const rows = mirror.filter((r) => r.threadId === t.id);
      expect(t.unread).toBe(rows.some((r) => !r.seen));
      expect(t.starred).toBe(rows.some((r) => r.flagged));
    }
  });

  test("bodies: fetched inside the 90 day window with attachments, deferred beyond it", async () => {
    const mirror = await mirrorRows(db.handle.db, workspaceId);
    const cutoff = NOW.getTime() - settings.bodyWindowDays * 86_400_000;
    for (const row of mirror) {
      expect(row.bodyState).toBe(row.date.getTime() >= cutoff ? "fetched" : "deferred");
    }
    expect(mirror.filter((r) => r.bodyState === "deferred").length).toBeGreaterThan(0);
    const recent = mirror.find((r) => r.bodyState === "fetched");
    if (!recent) throw new Error("nothing fetched");
    const body = await store.readMessageBody(recent.messageId);
    const source = fixture.messages.find((m) => m.id === recent.providerId);
    expect(body.text).toBe(source?.text ?? "");
    expect(body.snippet.length).toBeGreaterThan(0);
    const attachmentRows = await db.handle.sql`select count(*)::int as n from attachments`;
    expect(attachmentRows[0]?.n).toBe(3);
    // On demand for a deferred one.
    const old = mirror.find((r) => r.bodyState === "deferred");
    if (!old) throw new Error("nothing deferred");
    await engine.fetchBody(old.messageId);
    const after = (await mirrorRows(db.handle.db, workspaceId)).find(
      (r) => r.messageId === old.messageId,
    );
    expect(after?.bodyState).toBe("fetched");
    expect((await store.readMessageBody(old.messageId)).text.length).toBeGreaterThan(0);
  });

  test("a body-free header row is unreadable ciphertext in the table, never plaintext", async () => {
    const source = fixture.messages[0];
    if (!source) throw new Error("no fixture");
    const rows = await db.handle.sql`select body_enc, snippet_enc from messages`;
    for (const row of rows) {
      const enc = Buffer.from(row.body_enc as Uint8Array).toString("latin1");
      expect(enc).not.toContain(source.text.slice(0, 20));
    }
  });

  test("incremental: added, changed and removed events update the mirror and the Threads", async () => {
    const parent = fixture.messages.find((m) => m.threadKey === "t01" && m.mailbox === "inbox");
    if (!parent) throw new Error("no parent");
    const threadsBefore = await allThreads(store, workspaceId);
    const parentThread = (await mirrorRows(db.handle.db, workspaceId)).find(
      (r) => r.providerId === parent.id,
    )?.threadId;

    const delivered = fake.deliver({
      mailbox: "inbox",
      threadKey: "t01",
      from: parent.from,
      to: [fixture.owner],
      cc: [],
      subject: `Re: ${parent.subject}`,
      date: new Date(NOW.getTime() - 60_000).toISOString(),
      messageId: "reply-later@fixture.monday.test",
      inReplyTo: parent.messageId,
      references: [parent.messageId],
      seen: false,
      flagged: false,
      answered: false,
      headers: {},
      text: "A late reply.",
      html: null,
      attachments: [],
    });
    const report = await engine.syncAccount(account.id);
    expect(report.added).toBe(1);
    const mirror = await mirrorRows(db.handle.db, workspaceId);
    const row = mirror.find((r) => r.providerId === delivered);
    expect(row?.threadId).toBe(parentThread ?? "");
    expect(row?.bodyState).toBe("fetched");
    const threads = await allThreads(store, workspaceId);
    expect(threads).toHaveLength(threadsBefore.length);
    const thread = threads.find((t) => t.id === parentThread);
    expect(thread?.unread).toBe(true);
    expect(thread?.messageCount).toBe(7);
    expect(threads[0]?.id).toBe(parentThread ?? "");

    // Read elsewhere: the Thread clears within one sync.
    fake.setFlags(delivered, { seen: true });
    for (const m of fixture.messages)
      if (m.threadKey === "t01") fake.setFlags(m.id, { seen: true });
    const changed = await engine.syncAccount(account.id);
    expect(changed.changed).toBeGreaterThan(0);
    expect((await allThreads(store, workspaceId)).find((t) => t.id === parentThread)?.unread).toBe(
      false,
    );

    // Moved out of the inbox by another client: the Thread is archived here.
    for (const m of fixture.messages)
      if (m.threadKey === "t01" && m.mailbox === "inbox") fake.move(m.id, "Archive");
    fake.move(delivered, "Archive");
    await engine.syncAccount(account.id);
    expect(
      (await allThreads(store, workspaceId)).find((t) => t.id === parentThread)?.archived,
    ).toBe(true);

    // Destroyed: the Message goes, the Thread shrinks.
    fake.destroy(delivered);
    const removed = await engine.syncAccount(account.id);
    expect(removed.removed).toBe(1);
    expect(
      (await mirrorRows(db.handle.db, workspaceId)).find((r) => r.providerId === delivered),
    ).toBeUndefined();
    expect(
      (await allThreads(store, workspaceId)).find((t) => t.id === parentThread)?.messageCount,
    ).toBe(6);
  });

  test("threading: subject fallback joins a reply that lost its headers", async () => {
    const parent = fixture.messages.find((m) => m.threadKey === "t02");
    if (!parent) throw new Error("no parent");
    const parentThread = (await mirrorRows(db.handle.db, workspaceId)).find(
      (r) => r.providerId === parent.id,
    )?.threadId;
    const id = fake.deliver({
      mailbox: "inbox",
      threadKey: "t02",
      from: parent.from,
      to: [fixture.owner],
      cc: [],
      subject: `RE: ${parent.subject}`,
      date: NOW.toISOString(),
      messageId: "lost-headers@fixture.monday.test",
      inReplyTo: null,
      references: [],
      seen: false,
      flagged: false,
      answered: false,
      headers: {},
      text: "Sent from a broken client.",
      html: null,
      attachments: [],
    });
    await engine.syncAccount(account.id);
    const row = (await mirrorRows(db.handle.db, workspaceId)).find((r) => r.providerId === id);
    expect(row?.threadId).toBe(parentThread ?? "");

    // A fresh subject from a stranger starts a new Thread.
    const fresh = fake.deliver({
      mailbox: "inbox",
      threadKey: "fresh",
      from: { name: "Stranger", email: "stranger@elsewhere.test" },
      to: [fixture.owner],
      cc: [],
      subject: `Re: ${parent.subject}`,
      date: NOW.toISOString(),
      messageId: "stranger@elsewhere.test",
      inReplyTo: null,
      references: [],
      seen: false,
      flagged: false,
      answered: false,
      headers: {},
      text: "Unrelated.",
      html: null,
      attachments: [],
    });
    await engine.syncAccount(account.id);
    const strangerRow = (await mirrorRows(db.handle.db, workspaceId)).find(
      (r) => r.providerId === fresh,
    );
    expect(strangerRow?.threadId).not.toBe(parentThread ?? "");
  });

  test("a reset refetches without duplicating and drops what vanished meanwhile", async () => {
    const victim = fixture.messages.find((m) => m.threadKey === "t05");
    if (!victim) throw new Error("no victim");
    const before = await mirrorRows(db.handle.db, workspaceId);
    const messagesBefore = await db.handle.sql`select count(*)::int as n from messages`;
    fake.destroy(victim.id);
    fake.forgetHistory();
    const report = await engine.syncAccount(account.id);
    expect(report.removed).toBe(1);
    const after = await mirrorRows(db.handle.db, workspaceId);
    expect(after).toHaveLength(before.length - 1);
    expect(after.every((r) => !r.stale)).toBe(true);
    expect(after.find((r) => r.providerId === victim.id)).toBeUndefined();
    const messagesAfter = await db.handle.sql`select count(*)::int as n from messages`;
    expect(messagesAfter[0]?.n).toBe((messagesBefore[0]?.n ?? 0) - 1);
    // Bodies were kept, not refetched.
    expect(report.bodies).toBe(0);
  });

  test("applyChange maps actions to the Provider and mirrors them at once", async () => {
    const threads = await allThreads(store, workspaceId);
    const target = threads.find((t) => !t.archived && t.messageCount >= 2);
    if (!target) throw new Error("no inbox thread");
    const before = fake.calls.applyChange ?? 0;

    await engine.applyChange(account.id, { threadId: target.id }, { kind: "star", value: true });
    await engine.applyChange(account.id, { threadId: target.id }, { kind: "read", value: true });
    let now = (await allThreads(store, workspaceId)).find((t) => t.id === target.id);
    expect(now?.starred).toBe(true);
    expect(now?.unread).toBe(false);

    await engine.applyChange(account.id, { threadId: target.id }, { kind: "archive" });
    now = (await allThreads(store, workspaceId)).find((t) => t.id === target.id);
    expect(now?.archived).toBe(true);
    const providerIds = (await mirrorRows(db.handle.db, workspaceId))
      .filter((r) => r.threadId === target.id)
      .map((r) => r.providerId);
    for (const entry of fake.snapshot().filter((s) => providerIds.includes(s.id))) {
      expect(entry.mailboxIds).not.toContain("INBOX");
      expect(entry.flags.flagged).toBe(true);
      expect(entry.flags.seen).toBe(true);
    }
    expect(fake.calls.applyChange).toBe(before + 3);

    // The next sync agrees with the mirror: nothing flips back.
    await engine.syncAccount(account.id);
    now = (await allThreads(store, workspaceId)).find((t) => t.id === target.id);
    expect(now?.archived).toBe(true);
    expect(now?.starred).toBe(true);

    await engine.applyChange(account.id, { threadId: target.id }, { kind: "delete" });
    for (const entry of fake.snapshot().filter((s) => providerIds.includes(s.id))) {
      expect(entry.mailboxIds).toEqual(["Trash"]);
    }
  });

  test("Job steps: sync runs to done, watch holds a lease and wakes sync on push, reconcile sleeps", async () => {
    await engine.startAccount(jobs, account.id);
    const canServe = ["needs-process", "needs-public-url"];

    const claimed: string[] = [];
    for (let i = 0; i < 3; i++) {
      const job = await jobs.claim("test-server", canServe, 60_000);
      if (!job) break;
      claimed.push(job.class);
      const result = await jobs.run(job, 60_000);
      if (job.class === SYNC_STEP) expect(result).toBe("done");
      if (job.class === WATCH_STEP) expect(result).toEqual({ sleepMs: 30_000 });
      if (job.class === RECONCILE_STEP) {
        expect(result).toEqual({ sleepMs: settings.reconcileMinutes * 60_000 });
      }
    }
    expect(claimed.sort()).toEqual([RECONCILE_STEP, SYNC_STEP, WATCH_STEP]);

    // Push: another client delivers, the watcher enqueues a sync.
    const watching = await engine.watch(account.id);
    expect(watching).toEqual({ supported: true, running: true });
    const delivered = fake.deliver({
      mailbox: "inbox",
      threadKey: "push",
      from: { name: "Push", email: "push@example.test" },
      to: [fixture.owner],
      cc: [],
      subject: "Pushed",
      date: NOW.toISOString(),
      messageId: "pushed@example.test",
      inReplyTo: null,
      references: [],
      seen: false,
      flagged: false,
      answered: false,
      headers: {},
      text: "pushed",
      html: null,
      attachments: [],
    });
    await waitFor(async () => {
      const rows = await db.handle.db
        .select()
        .from(jobsTable)
        .where(eq(jobsTable.class, SYNC_STEP));
      return rows.some(
        (r) => r.status === "queued" && r.id.includes(account.id) && !r.id.endsWith(":initial"),
      );
    });
    const pushed = await jobs.claim("test-server", [], 60_000);
    expect(pushed?.class).toBe(SYNC_STEP);
    if (pushed) await jobs.run(pushed, 60_000);
    expect(
      (await mirrorRows(db.handle.db, workspaceId)).find((r) => r.providerId === delivered),
    ).toBeDefined();
    await engine.unwatch(account.id);
  });
});
