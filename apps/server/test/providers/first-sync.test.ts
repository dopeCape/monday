// The first sync's progress (docs/spec/onboarding.md, "First sync") over the
// fake Provider: nothing counted before the first pass; the Inbox's headers
// complete against the Provider's total once its first paging finishes; the
// window's bodies count from body_state and complete after them; both latch,
// so mail arriving later never reopens the screen; a failed pass reports its
// kind in plain terms and Retry clears it; the route answers 404 for an
// unknown Account.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type Account, firstSyncComplete } from "@monday/shared";
import { randomKey } from "../../src/crypto/aead.ts";
import { createKeys } from "../../src/crypto/keys.ts";
import { createJobs } from "../../src/jobs/index.ts";
import { createMailstore, type Mailstore } from "../../src/mailstore/index.ts";
import { type CredentialStore, createCredentialStore } from "../../src/providers/credentials.ts";
import {
  createFakeProvider,
  type FakeProvider,
  fakeCredentials,
  generateFixture,
} from "../../src/providers/fake/index.ts";
import { createFirstSyncReader, type FirstSyncReader } from "../../src/providers/first-sync.ts";
import { createProviderRegistry } from "../../src/providers/index.ts";
import {
  createSyncEngine,
  defaultSyncSettings,
  type SyncEngine,
} from "../../src/providers/sync.ts";
import { ProviderError, type Provider as ProviderSeam } from "../../src/providers/types.ts";
import { accountRoutes } from "../../src/routes/accounts.ts";
import { type TestDatabase, testDatabase } from "../harness.ts";

const fixture = generateFixture();
const NOW = new Date(fixture.recordedAt);
const WINDOW_DAYS = 30;

function accountOf(id: string, address: string): Account {
  return {
    id,
    provider: "imap",
    address,
    displayName: "",
    capabilities: {
      push: false,
      labels: false,
      snooze: false,
      mute: false,
      calendar: false,
      meetingLink: null,
    },
  };
}

describe("first sync progress", () => {
  let db: TestDatabase;
  let store: Mailstore;
  let credentials: CredentialStore;
  let fake: FakeProvider;
  let engine: SyncEngine;
  let reader: FirstSyncReader;
  /** Flipped by a test: every connect then fails as a revoked sign-in would. */
  let refuse: ProviderError | null = null;
  const settings = { ...defaultSyncSettings(), batchSize: 10, bodyWindowDays: WINDOW_DAYS };
  const ok = accountOf("acct-first", fixture.address);
  const broken = accountOf("acct-broken", "broken@monday.test");

  beforeAll(async () => {
    db = await testDatabase();
    const keys = createKeys(db.handle.db);
    await keys.unlock(randomKey());
    store = createMailstore(db.handle.db, keys);
    credentials = createCredentialStore(db.handle.db, store);
    fake = createFakeProvider(fixture);
    const gate: ProviderSeam = {
      kind: "fake",
      connect: async (creds) => {
        if (refuse && creds.address === broken.address) throw refuse;
        return fake.connect(creds);
      },
    };
    for (const a of [ok, broken]) {
      const ws = await store.createWorkspace(a);
      await credentials.store(ws.id, a.id, fakeCredentials(a.address));
    }
    engine = createSyncEngine({
      db: db.handle.db,
      mailstore: store,
      providers: createProviderRegistry({ overrides: { imap: gate } }),
      credentials,
      settings: async () => settings,
      now: () => NOW,
    });
    engine.registerSteps(createJobs(db.handle.db));
    reader = createFirstSyncReader({
      db: db.handle.db,
      sync: engine,
      bodyWindowDays: async () => WINDOW_DAYS,
      now: () => NOW,
    });
  }, 60_000);

  afterAll(async () => {
    await engine.close();
    await db.drop();
  });

  const inboxIds = () => fake.snapshot().filter((m) => m.mailboxIds.includes("INBOX"));

  test("before the first pass nothing is counted and nothing is complete", async () => {
    const p = await reader.read(ok.id);
    expect(p).not.toBeNull();
    expect(p?.headers).toEqual({ done: 0, total: null, complete: false });
    expect(p?.bodies.complete).toBe(false);
    expect(p?.error).toBeNull();
    expect(p?.pacing).toBe(false);
    expect(p?.address).toBe(fixture.address);
    if (p) expect(firstSyncComplete(p, "headers")).toBe(false);
  });

  test("headers complete against the Provider's Inbox total once the Inbox finished paging", async () => {
    const inbox = inboxIds().length;
    expect(inbox).toBeGreaterThan(0);
    let seen = -1;
    for (let i = 0; i < 50; i++) {
      const report = await engine.syncAccount(ok.id, { headersOnly: true });
      const p = await reader.read(ok.id);
      // Counts only go up while the pass pages.
      expect(p?.headers.done ?? 0).toBeGreaterThanOrEqual(seen);
      seen = p?.headers.done ?? 0;
      if (!report.more) break;
    }
    const p = await reader.read(ok.id);
    expect(p?.headers).toEqual({ done: inbox, total: inbox, complete: true });
    // Headers only: the window's bodies are all still to fetch.
    expect(p?.bodies.total).toBeGreaterThan(0);
    expect(p?.bodies.done).toBe(0);
    expect(p?.bodies.complete).toBe(false);
    if (p) {
      expect(firstSyncComplete(p, "headers")).toBe(true);
      expect(firstSyncComplete(p, "inbox_bodies")).toBe(false);
    }
  });

  test("the window's Inbox bodies complete from body_state", async () => {
    for (let i = 0; i < 50; i++) {
      const report = await engine.syncAccount(ok.id);
      if (!report.more) break;
    }
    const p = await reader.read(ok.id);
    expect(p?.bodies.complete).toBe(true);
    expect(p?.bodies.done).toBe(p?.bodies.total ?? -1);
    if (p) expect(firstSyncComplete(p, "inbox_bodies")).toBe(true);
  });

  test("completion latches: new Inbox mail never reopens the screen", async () => {
    fake.deliver({
      mailbox: "inbox",
      threadKey: "late",
      from: { name: "Late", email: "late@monday.test" },
      to: [fixture.owner],
      cc: [],
      subject: "Arrived after",
      date: NOW.toISOString(),
      messageId: "late@fixture.monday.test",
      inReplyTo: null,
      references: [],
      seen: false,
      flagged: false,
      answered: false,
      headers: {},
      text: "hello",
      html: null,
      attachments: [],
    });
    await engine.syncAccount(ok.id, { headersOnly: true });
    const p = await reader.read(ok.id);
    expect(p?.headers.complete).toBe(true);
    expect(p?.bodies.complete).toBe(true);
  });

  test("a failed pass reports its kind; Retry clears it", async () => {
    refuse = new ProviderError("token revoked", "auth");
    await expect(engine.syncAccount(broken.id)).rejects.toThrow("token revoked");
    const failed = await reader.read(broken.id);
    expect(failed?.error).toEqual({ kind: "auth", message: "token revoked" });
    expect(failed?.headers.complete).toBe(false);

    refuse = new ProviderError("connect ECONNREFUSED", "network");
    await expect(engine.syncAccount(broken.id)).rejects.toThrow();
    expect((await reader.read(broken.id))?.error?.kind).toBe("network");

    refuse = null;
    expect(await reader.retry(broken.id)).toBe(true);
    expect((await reader.read(broken.id))?.error).toBeNull();
    expect(await reader.retry("nobody")).toBe(false);
  });

  test("the route serves the progress and 404s an unknown Account", async () => {
    const app = accountRoutes({
      accounts: { list: async () => [], add: async () => ({}) as never, remove: async () => false },
      firstSync: reader,
    });
    const res = await app.request(`/accounts/${ok.id}/sync`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { progress: { headers: { complete: boolean } } };
    expect(body.progress.headers.complete).toBe(true);
    expect((await app.request("/accounts/nobody/sync")).status).toBe(404);
    expect((await app.request(`/accounts/${ok.id}/sync`, { method: "POST" })).status).toBe(202);
  });
});
