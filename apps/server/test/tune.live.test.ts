// Opt-in: test_judgment against the real TypeSafe judge. Runs only when
// TYPESAFEAI_KEY is in the environment (never read from a file, never
// hardcoded); skipped otherwise. The fixture mailbox is synced into the
// embedded Postgres, and a reworded arrival question is asked beside the
// shipped one on the newest Threads: every Thread costs two metered requests
// and comes back with a probability for each version.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Account, ApprovalDecision } from "@monday/shared";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys } from "../src/crypto/keys.ts";
import { createIntelligence, type Intelligence } from "../src/intelligence/index.ts";
import { createFakeChat } from "../src/intelligence/runtime/fake/index.ts";
import { createTypeSafeJudge } from "../src/intelligence/runtime/typesafe.ts";
import type { JudgmentTest } from "../src/intelligence/tune.ts";
import { createMailstore } from "../src/mailstore/index.ts";
import { createCredentialStore } from "../src/providers/credentials.ts";
import {
  createFakeProvider,
  fakeCredentials,
  generateFixture,
} from "../src/providers/fake/index.ts";
import { createProviderRegistry } from "../src/providers/index.ts";
import { createSyncEngine, defaultSyncSettings, type SyncEngine } from "../src/providers/sync.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const API_KEY = process.env.TYPESAFEAI_KEY;
const fixture = generateFixture();
const NOW = new Date(fixture.recordedAt);
const account: Account = {
  id: "acct-tune-live",
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

describe.skipIf(!API_KEY)("test_judgment against api.typesafe.ai (TYPESAFEAI_KEY set)", () => {
  let db: TestDatabase;
  let engine: SyncEngine;
  let intelligence: Intelligence;
  let workspaceId = "";

  beforeAll(async () => {
    db = await testDatabase();
    const keys = createKeys(db.handle.db);
    await keys.unlock(randomKey());
    const store = createMailstore(db.handle.db, keys);
    const credentials = createCredentialStore(db.handle.db, store);
    workspaceId = (await store.createWorkspace(account)).id;
    await credentials.store(workspaceId, account.id, fakeCredentials());
    engine = createSyncEngine({
      db: db.handle.db,
      mailstore: store,
      providers: createProviderRegistry({ overrides: { jmap: createFakeProvider(fixture) } }),
      credentials,
      settings: async () => ({ ...defaultSyncSettings(), batchSize: 25 }),
      now: () => NOW,
    });
    intelligence = createIntelligence({
      level: async () => "automate",
      db: db.handle.db,
      mailstore: store,
      chat: createFakeChat("").chat,
      judge: createTypeSafeJudge(),
      now: () => NOW,
    });
    await intelligence.keys.put(workspaceId, "typesafe", API_KEY as string);
    let report = await engine.syncAccount(account.id);
    for (let i = 0; i < 20 && report.more; i++) report = await engine.syncAccount(account.id);
  }, 120_000);

  afterAll(async () => {
    await engine?.close();
    await db?.drop();
  });

  test("a reworded needs-a-reply question is asked beside the shipped one on the newest threads", async () => {
    const outcome = await intelligence.agent.tools(workspaceId).call(
      {
        name: "test_judgment",
        args: {
          key: "judgments.questions.needs_reply",
          text: "A person wrote the newest message to the mailbox owner personally and expects a written answer. Receipts, shipping notices and other automated confirmations never do.",
          sample: 3,
        },
        callId: "live-1",
        sessionId: "live",
      },
      { ask: async (): Promise<ApprovalDecision> => "approved" },
    );
    expect(outcome.isError).toBe(false);
    const diff = outcome.activity.resultData as JudgmentTest;
    expect(diff.asked).toBe(true);
    expect(diff.considered).toBe(3);
    expect(diff.requests).toBe(6);
    expect(diff.costMicros).toBeGreaterThan(0);
    for (const c of diff.changes) {
      expect(typeof c.before.answer).toBe("number");
      expect(typeof c.after.answer).toBe("number");
    }
    const month = await intelligence.meter.month(workspaceId, NOW.toISOString().slice(0, 7));
    expect(month.lines.some((l) => l.task === "judge.section")).toBe(true);
  }, 120_000);
});
