// The other direction of sync (ADR 0005, docs/spec/inbox.md "Action
// semantics"): a winning intent from a Device or the Agent lands on the
// engine's mirror at once, a provider.change Job carries it to the Provider,
// and the next pass never flips the row back. Beside it: a flag the Provider
// flipped reaches the Changes feed, a Message or Thread that left the Provider
// is announced as removed, and a snooze arms the Job that brings the Thread
// back as unread at the top of its Section.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Account, Change, Thread, ThreadChange } from "@monday/shared";
import { eq } from "drizzle-orm";
import { randomKey } from "../../src/crypto/aead.ts";
import { createKeys, type Keys } from "../../src/crypto/keys.ts";
import { jobs as jobsTable } from "../../src/db/schema.ts";
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
  CHANGE_STEP,
  createSyncEngine,
  defaultSyncSettings,
  mirrorRows,
  providerChangeOf,
  type SyncEngine,
} from "../../src/providers/sync.ts";
import { createSnoozeWaker, type SnoozeWaker, UNSNOOZE_STEP } from "../../src/snooze.ts";
import { type TestDatabase, testDatabase } from "../harness.ts";

const fixture = generateFixture();
const START = new Date(fixture.recordedAt);

const account: Account = {
  id: "acct-intents",
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

describe("intents reach the Provider and the feed", () => {
  let db: TestDatabase;
  let keys: Keys;
  let store: Mailstore;
  let credentials: CredentialStore;
  let fake: FakeProvider;
  let engine: SyncEngine;
  let jobs: Jobs;
  let snooze: SnoozeWaker;
  let workspaceId = "";
  let clock = START;
  const now = () => clock;

  const inbox = async (): Promise<Thread[]> => {
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
  };
  const thread = async (id: string) => (await inbox()).find((t) => t.id === id);
  const queued = async (cls: string) =>
    (await db.handle.db.select().from(jobsTable).where(eq(jobsTable.class, cls))).filter(
      (j) => j.status === "queued",
    );
  const runAll = async (cls: string) => {
    let ran = 0;
    for (let i = 0; i < 50; i++) {
      const job = await jobs.claim("test-server", ["needs-process"], 60_000);
      if (!job) break;
      const result = await jobs.run(job, 60_000);
      if (job.class === cls) {
        ran += 1;
        expect(result).toBe("done");
      }
    }
    return ran;
  };
  const feedSince = async (since: number): Promise<Change[]> =>
    (await store.listChanges(workspaceId, { since, limit: 1000 })).changes;

  beforeAll(async () => {
    db = await testDatabase();
    keys = createKeys(db.handle.db);
    await keys.unlock(randomKey());
    store = createMailstore(db.handle.db, keys);
    credentials = createCredentialStore(db.handle.db, store);
    fake = createFakeProvider(fixture);
    workspaceId = (await store.createWorkspace(account)).id;
    await credentials.store(workspaceId, account.id, fakeCredentials());
    jobs = createJobs(db.handle.db, { now });
    engine = createSyncEngine({
      db: db.handle.db,
      mailstore: store,
      providers: createProviderRegistry({ overrides: { imap: fake } }),
      credentials,
      settings: async () => ({ ...defaultSyncSettings(), batchSize: 200 }),
      now,
    });
    engine.registerSteps(jobs);
    snooze = createSnoozeWaker({ db: db.handle.db, mailstore: store, now });
    snooze.registerSteps(jobs);
    store.setIntentObserver(async (intent, ws) => {
      await snooze.observe(intent, ws);
      await engine.recordIntent(intent, ws);
    });
    let report = await engine.syncAccount(account.id);
    for (let i = 0; i < 50 && report.more; i++) report = await engine.syncAccount(account.id);
  }, 60_000);

  afterAll(async () => {
    await engine.close();
    await db.drop();
  });

  test("providerChangeOf maps every intent to the Provider's concept, or to nothing", () => {
    expect(
      providerChangeOf({ kind: "archive", threadId: "t", at: "", actor: "user" }, "INBOX"),
    ).toEqual({ kind: "archive" });
    expect(
      providerChangeOf(
        { kind: "snooze", until: "", threadId: "t", at: "", actor: "user" },
        "INBOX",
      ),
    ).toEqual({ kind: "archive" });
    expect(
      providerChangeOf({ kind: "unarchive", threadId: "t", at: "", actor: "user" }, "INBOX"),
    ).toEqual({ kind: "move", mailboxId: "INBOX" });
    expect(
      providerChangeOf({ kind: "unsnooze", threadId: "t", at: "", actor: "user" }, null),
    ).toBeNull();
    expect(
      providerChangeOf({ kind: "read", threadId: "t", at: "", actor: "user" }, "INBOX"),
    ).toEqual({
      kind: "read",
      value: true,
    });
    expect(
      providerChangeOf({ kind: "unstar", threadId: "t", at: "", actor: "user" }, "INBOX"),
    ).toEqual({
      kind: "star",
      value: false,
    });
    expect(
      providerChangeOf({ kind: "delete", threadId: "t", at: "", actor: "user" }, "INBOX"),
    ).toEqual({
      kind: "delete",
    });
    expect(
      providerChangeOf(
        { kind: "move", group: "g", subgroup: null, threadId: "t", at: "", actor: "user" },
        "INBOX",
      ),
    ).toBeNull();
    expect(
      providerChangeOf({ kind: "tags", tags: [], threadId: "t", at: "", actor: "user" }, "INBOX"),
    ).toBeNull();
  });

  test("an archive from a Device mirrors at once, survives the next sync, and reaches the Provider through a Job", async () => {
    const target = (await inbox()).find((t) => !t.archived && t.unread && t.messageCount >= 2);
    if (!target) throw new Error("no unread inbox thread");
    const before = fake.calls.applyChange ?? 0;
    clock = new Date(START.getTime() + 60_000);

    const result = await store.applyIntent({
      kind: "archive",
      threadId: target.id,
      at: clock.toISOString(),
      actor: "user",
    });
    expect(result.applied).toBe(true);
    // The mirror already agrees: the Provider ids of this Thread left the inbox.
    const providerIds = (await mirrorRows(db.handle.db, workspaceId))
      .filter((r) => r.threadId === target.id)
      .map((r) => r.providerId);
    for (const row of (await mirrorRows(db.handle.db, workspaceId)).filter((r) =>
      providerIds.includes(r.providerId),
    )) {
      expect(row.mailboxIds).not.toContain("INBOX");
    }
    // Nothing has reached the Provider yet; a Job is queued for it.
    expect(fake.calls.applyChange ?? 0).toBe(before);
    expect(fake.snapshot().find((s) => s.id === providerIds[0])?.mailboxIds).toContain("INBOX");
    const pending = await queued(CHANGE_STEP);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.payload).toEqual({
      accountId: account.id,
      threadId: target.id,
      change: { kind: "archive" },
    });

    // A sync pass before the Job runs does not flip the Thread back into the Inbox.
    await engine.syncAccount(account.id);
    expect((await thread(target.id))?.archived).toBe(true);

    // The Job pushes it; the Provider now agrees, and so does the next pass.
    expect(await runAll(CHANGE_STEP)).toBe(1);
    expect(fake.calls.applyChange).toBe(before + 1);
    for (const entry of fake.snapshot().filter((s) => providerIds.includes(s.id))) {
      expect(entry.mailboxIds).not.toContain("INBOX");
    }
    await engine.syncAccount(account.id);
    expect((await thread(target.id))?.archived).toBe(true);

    // Read and star follow the same path; a replayed intent (same stamp) enqueues no second Job.
    await store.applyIntent({
      kind: "read",
      threadId: target.id,
      at: clock.toISOString(),
      actor: "user",
    });
    await store.applyIntent({
      kind: "star",
      threadId: target.id,
      at: clock.toISOString(),
      actor: "user",
    });
    await store.applyIntent({
      kind: "read",
      threadId: target.id,
      at: clock.toISOString(),
      actor: "user",
    });
    expect(await queued(CHANGE_STEP)).toHaveLength(2);
    expect(await runAll(CHANGE_STEP)).toBe(2);
    for (const entry of fake.snapshot().filter((s) => providerIds.includes(s.id))) {
      expect(entry.flags.seen).toBe(true);
      expect(entry.flags.flagged).toBe(true);
    }
    // A Group move or a Tag is monday's alone: nothing goes to the Provider.
    await store.applyIntent({
      kind: "move",
      group: "g1",
      subgroup: null,
      threadId: target.id,
      at: clock.toISOString(),
      actor: "user",
    });
    expect(await queued(CHANGE_STEP)).toHaveLength(0);
  });

  test("a flag the Provider flipped reaches the Changes feed as a thread row", async () => {
    const target = (await inbox()).find((t) => !t.archived && t.unread && t.messageCount === 1);
    if (!target) throw new Error("no unread single-message thread");
    const providerId = (await mirrorRows(db.handle.db, workspaceId)).find(
      (r) => r.threadId === target.id,
    )?.providerId;
    if (!providerId) throw new Error("no mirror row");
    const since = await store.latestSeq(workspaceId);
    // Read on the phone.
    fake.setFlags(providerId, { seen: true });
    await engine.syncAccount(account.id);
    const rows = (await feedSince(since)).filter(
      (c): c is Change & { kind: "thread"; payload: ThreadChange } =>
        c.kind === "thread" && c.entityId === target.id,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.at(-1)?.payload.unread).toBe(false);
    // A pass that changes nothing appends nothing for it.
    const quiet = await store.latestSeq(workspaceId);
    await engine.syncAccount(account.id);
    expect((await feedSince(quiet)).filter((c) => c.entityId === target.id)).toHaveLength(0);
  });

  test("a Message or Thread that left the Provider is announced as removed", async () => {
    const single = (await inbox()).find((t) => t.messageCount === 1 && !t.archived);
    if (!single) throw new Error("no single-message thread");
    const mirror = (await mirrorRows(db.handle.db, workspaceId)).find(
      (r) => r.threadId === single.id,
    );
    if (!mirror) throw new Error("no mirror row");
    const since = await store.latestSeq(workspaceId);
    fake.destroy(mirror.providerId);
    await engine.syncAccount(account.id);
    const feed = await feedSince(since);
    const message = feed.find((c) => c.kind === "message" && c.entityId === mirror.messageId);
    expect(message?.payload).toMatchObject({ removed: true });
    const gone = feed.find((c) => c.kind === "thread" && c.entityId === single.id);
    expect(gone?.payload).toMatchObject({ removed: true, deleted: true });
    expect(await thread(single.id)).toBeUndefined();
  });

  test("a snooze arms the wake; the wake brings the Thread back unread, on top, and tells the Provider", async () => {
    const target = (await inbox()).find((t) => !t.archived && t.messageCount >= 1);
    if (!target) throw new Error("no inbox thread");
    clock = new Date(START.getTime() + 2 * 60_000);
    const until = new Date(clock.getTime() + 3_600_000);
    await store.applyIntent({
      kind: "snooze",
      until: until.toISOString(),
      threadId: target.id,
      at: clock.toISOString(),
      actor: "user",
    });
    let t = await thread(target.id);
    expect(t?.archived).toBe(true);
    expect(t?.snoozedUntil).toBe(until.toISOString());
    // The wake Job waits for the hour; the archive goes to the Provider now.
    const armed = await queued(UNSNOOZE_STEP);
    expect(armed).toHaveLength(1);
    expect(armed[0]?.runAt.toISOString()).toBe(until.toISOString());
    expect(await runAll(CHANGE_STEP)).toBe(1);

    // Snoozed again for later: the first Job stands down, the second waits.
    const later = new Date(until.getTime() + 3_600_000);
    await store.applyIntent({
      kind: "snooze",
      until: later.toISOString(),
      threadId: target.id,
      at: new Date(clock.getTime() + 1_000).toISOString(),
      actor: "user",
    });
    expect(await queued(UNSNOOZE_STEP)).toHaveLength(2);
    expect(await runAll(CHANGE_STEP)).toBe(1);
    clock = new Date(until.getTime() + 1_000);
    expect(await snooze.wake(target.id)).toBe("asleep");
    const first = await jobs.claim("test-server", [], 60_000);
    expect(first?.class).toBe(UNSNOOZE_STEP);
    if (first) expect(await jobs.run(first, 60_000)).toBe("done");
    expect((await thread(target.id))?.snoozedUntil).toBe(later.toISOString());

    // Time passes: the wake runs, the Thread is back in the Inbox, unread, newest.
    clock = new Date(later.getTime() + 1_000);
    const since = await store.latestSeq(workspaceId);
    const wake = await jobs.claim("test-server", [], 60_000);
    expect(wake?.class).toBe(UNSNOOZE_STEP);
    if (wake) expect(await jobs.run(wake, 60_000)).toBe("done");
    t = await thread(target.id);
    expect(t?.archived).toBe(false);
    expect(t?.snoozedUntil).toBeNull();
    expect(t?.unread).toBe(true);
    expect(t?.lastActivity).toBe(clock.toISOString());
    expect(
      (await feedSince(since)).some((c) => c.kind === "thread" && c.entityId === target.id),
    ).toBe(true);
    // The Provider hears both halves: back to the inbox, and unread.
    const changes = (await queued(CHANGE_STEP)).map(
      (j) => (j.payload as { change: unknown }).change,
    );
    expect(changes).toEqual([
      { kind: "move", mailboxId: "INBOX" },
      { kind: "read", value: false },
    ]);
    expect(await runAll(CHANGE_STEP)).toBe(2);
    const providerIds = (await mirrorRows(db.handle.db, workspaceId))
      .filter((r) => r.threadId === target.id)
      .map((r) => r.providerId);
    for (const entry of fake.snapshot().filter((s) => providerIds.includes(s.id))) {
      expect(entry.mailboxIds).toContain("INBOX");
      expect(entry.flags.seen).toBe(false);
    }
    // Nothing is left to wake; arming everything again finds nothing asleep.
    expect(await snooze.wake(target.id)).toBe("gone");
    expect(await snooze.armAll()).toBe(0);
  });

  test("a user's write beats the wake: an unsnooze that lost is logged, not forced", async () => {
    const target = (await inbox()).find((t) => !t.archived && t.messageCount >= 1);
    if (!target) throw new Error("no inbox thread");
    const until = new Date(clock.getTime() + 60_000);
    await store.applyIntent({
      kind: "snooze",
      until: until.toISOString(),
      threadId: target.id,
      at: clock.toISOString(),
      actor: "user",
    });
    // The user snoozes again from a Device whose clock is ahead of the Server's.
    const ahead = new Date(until.getTime() + 10 * 60_000);
    await store.applyIntent({
      kind: "snooze",
      until: new Date(ahead.getTime() + 3_600_000).toISOString(),
      threadId: target.id,
      at: ahead.toISOString(),
      actor: "user",
    });
    clock = new Date(ahead.getTime() + 3_600_000 + 1_000);
    expect(await snooze.wake(target.id)).toBe("woken");
    expect((await thread(target.id))?.snoozedUntil).toBeNull();
  });
});
