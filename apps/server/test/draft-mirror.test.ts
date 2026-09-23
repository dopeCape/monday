// Draft mirroring into Gmail's Drafts (ADR 0010), end to end over the fake
// Gmail: the draft.mirror Job is queued for a Draft the Agent writes and for a
// Device save; the step creates the Gmail draft with valid MIME, a reply joins
// its Thread with In-Reply-To and References, a later save updates the same
// Gmail draft, the sync import pass never takes monday's own mirror for a new
// Draft, a lasting quota refusal fails the step instead of vanishing, a
// delete in monday deletes it in Gmail, a send goes through drafts.send, and
// the boot backfill queues Drafts saved before any of this worked.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Account, DraftContent } from "@monday/shared";
import { eq } from "drizzle-orm";
import { claimableNeeds } from "../src/capabilities.ts";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys } from "../src/crypto/keys.ts";
import { drafts as draftsTable, jobs as jobsTable } from "../src/db/schema.ts";
import {
  backfillDraftMirrors,
  createDrafts,
  type Drafts,
  MIRROR_DEBOUNCE_MS,
  MIRROR_STEP,
} from "../src/drafts/index.ts";
import { createJobs, type Jobs } from "../src/jobs/index.ts";
import { createMailstore, type Mailstore } from "../src/mailstore/index.ts";
import { createCredentialStore } from "../src/providers/credentials.ts";
import { generateFixture } from "../src/providers/fake/fixture.ts";
import { createGmailProvider } from "../src/providers/gmail/index.ts";
import { createProviderRegistry } from "../src/providers/index.ts";
import { staticTokenBroker } from "../src/providers/oauth/tokens.ts";
import { createSyncEngine, mirrorRows, type SyncEngine } from "../src/providers/sync.ts";
import type { Credentials } from "../src/providers/types.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";
import { createGmailServer, type GmailServer } from "./providers/gmail-server.ts";

const fixture = generateFixture();

const account: Account = {
  id: "acct-gmail-mirror",
  provider: "gmail",
  address: fixture.address,
  displayName: fixture.owner.name,
  capabilities: {
    push: false,
    labels: true,
    snooze: false,
    mute: false,
    calendar: false,
    meetingLink: null,
  },
};

const content = (over: Partial<DraftContent> = {}): DraftContent => ({
  threadId: null,
  kind: "new",
  inReplyToMessageId: null,
  to: [{ name: "Aoife", email: "aoife@northlight.dev" }],
  cc: [],
  bcc: [],
  subject: "Take-home review",
  bodyHtml: "<p>Hi Aoife,</p><p>Thanks for the <b>write-up</b>.</p>",
  bodyText: "Hi Aoife,\n\nThanks for the write-up.",
  attachments: [],
  ...over,
});

describe("Draft mirrors in Gmail's Drafts", () => {
  let db: TestDatabase;
  let store: Mailstore;
  let gmail: GmailServer;
  let engine: SyncEngine;
  let jobs: Jobs;
  let drafts: Drafts;
  let workspaceId = "";
  const logged: string[] = [];
  let virtual = 1_000_000;
  let t = Date.parse("2026-09-19T21:46:00Z");
  const now = () => new Date(t);
  const advance = (ms: number) => {
    t += ms;
  };

  /** Claims and runs every job that is due, in order. */
  const runDue = async (): Promise<Array<{ cls: string; outcome: unknown }>> => {
    const ran: Array<{ cls: string; outcome: unknown }> = [];
    for (let i = 0; i < 20; i++) {
      const job = await jobs.claim("server-a", claimableNeeds("sidecar", false), 30_000);
      if (!job) break;
      ran.push({ cls: job.class, outcome: await jobs.run(job, 30_000) });
    }
    return ran;
  };

  const mirrorJobs = async () =>
    db.handle.db.select().from(jobsTable).where(eq(jobsTable.class, MIRROR_STEP));

  const row = async (id: string) =>
    db.handle.db.query.drafts.findFirst({ where: eq(draftsTable.id, id) });

  const syncAll = async (headersOnly = false) => {
    let report = await engine.syncAccount(account.id, { headersOnly });
    for (let i = 0; i < 50 && report.more; i++) {
      report = await engine.syncAccount(account.id, { headersOnly });
    }
  };

  beforeAll(async () => {
    db = await testDatabase();
    const keys = createKeys(db.handle.db);
    await keys.unlock(randomKey());
    store = createMailstore(db.handle.db, keys);
    const credentials = createCredentialStore(db.handle.db, store);
    gmail = createGmailServer(fixture);
    workspaceId = (await store.createWorkspace(account)).id;
    const creds: Credentials = {
      address: fixture.address,
      auth: {
        kind: "oauth",
        user: fixture.address,
        issuer: "google",
        accessToken: gmail.accessToken,
        refreshToken: gmail.refreshToken,
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        client: { id: "1234-abc.apps.googleusercontent.com", secret: "GOCSPX-secret" },
      },
      endpoint: { kind: "gmail", pubsubTopic: null },
    };
    await credentials.store(workspaceId, account.id, creds);
    jobs = createJobs(db.handle.db, { now });
    engine = createSyncEngine({
      db: db.handle.db,
      mailstore: store,
      providers: createProviderRegistry({
        overrides: {
          gmail: createGmailProvider({
            fetch: gmail.fetch,
            tokens: staticTokenBroker(),
            // A virtual clock for the quota bucket and backoff: pacing costs no wall time.
            now: () => virtual,
            sleep: async (ms) => {
              virtual += ms;
            },
            random: () => 0,
          }),
        },
      }),
      credentials,
      now,
    });
    engine.registerSteps(jobs);
    drafts = createDrafts({
      db: db.handle.db,
      mailstore: store,
      sync: engine,
      now,
      settings: async () => ({ delaySeconds: 30 }),
      log: (m) => logged.push(m),
    });
    drafts.registerSteps(jobs);
    engine.setDraftImporter(
      (found) => drafts.importProviderDraft(found).then(() => {}),
      (ws) => drafts.knownProviderDraftIds(ws),
    );
    // Headers first, so a reply has a parent Message with a Message-ID.
    await syncAll(true);
  }, 120_000);

  afterAll(async () => {
    await engine.close();
    await db.drop();
  });

  test("a Draft the Agent writes queues the mirror Job, which creates the Gmail draft", async () => {
    const saved = await drafts.save({
      id: "agent-draft",
      workspaceId,
      content: content(),
      updatedBy: "agent",
      actor: "automation",
    });
    expect(saved.applied).toBe(true);
    const queued = (await mirrorJobs()).filter(
      (j) => (j.payload as { draftId: string }).draftId === "agent-draft",
    );
    expect(queued).toHaveLength(1);

    // Not before the debounce.
    expect(await runDue()).toEqual([]);
    advance(MIRROR_DEBOUNCE_MS + 1);
    const ran = await runDue();
    expect(ran.map((r) => r.cls)).toEqual([MIRROR_STEP]);

    const stored = await row("agent-draft");
    expect(stored?.providerDraftId).toMatch(/^r-/);
    expect(stored?.mirroredHash).toBeTruthy();
    const write = gmail.draftWrites.at(-1);
    expect(write).toMatchObject({
      draftId: stored?.providerDraftId,
      update: false,
      threadId: null,
    });
    const raw = new TextDecoder().decode(write?.raw);
    expect(raw).toContain(`From: `);
    expect(raw).toContain(fixture.address);
    expect(raw).toMatch(/^To: .*aoife@northlight\.dev/m);
    expect(raw).toMatch(/^Subject: Take-home review/m);
    expect(raw).toContain("text/plain");
    expect(raw).toContain("text/html");
    // monday's own mark, never a random id.
    expect(raw).toMatch(/^Message-ID: <monday-draft\.agent-draft@/m);
    // The Gmail message sits under DRAFT.
    const messageId = gmail.drafts.get(stored?.providerDraftId ?? "") ?? "";
    expect(gmail.emails.get(messageId)?.labelIds).toEqual(["DRAFT"]);
  });

  test("a Device save updates the same Gmail draft", async () => {
    const before = await row("agent-draft");
    advance(1_000);
    await drafts.save({
      id: "agent-draft",
      workspaceId,
      content: content({ bodyText: "Hi Aoife,\n\nEdited.", bodyHtml: "<p>Edited.</p>" }),
      updatedBy: "device-a",
      at: now().toISOString(),
    });
    advance(MIRROR_DEBOUNCE_MS + 1);
    await runDue();
    const after = await row("agent-draft");
    expect(after?.providerDraftId).toBe(before?.providerDraftId ?? "missing");
    expect(after?.mirroredHash).not.toBe(before?.mirroredHash ?? "");
    expect(gmail.draftWrites.at(-1)).toMatchObject({
      draftId: before?.providerDraftId,
      update: true,
    });
    expect([...gmail.drafts.keys()]).toEqual([before?.providerDraftId ?? ""]);
  });

  test("a reply joins its Gmail Thread with In-Reply-To and References", async () => {
    const page = await store.listThreads(workspaceId, { limit: 5, includeArchived: true });
    const thread = page.threads[0];
    if (!thread) throw new Error("no threads synced");
    const parents = await store.listMessages(thread.id);
    const parent = parents[parents.length - 1];
    if (!parent) throw new Error("no parent message");
    const parentRow = (await mirrorRows(db.handle.db, workspaceId)).find(
      (r) => r.messageId === parent.id,
    );
    const rfc = parentRow?.rfcMessageId ?? "";
    expect(rfc).toBeTruthy();
    const gmailParent = [...gmail.emails.values()].find(
      (e) => e.headers["message-id"] === `<${rfc}>`,
    );
    expect(gmailParent).toBeDefined();

    await drafts.save({
      id: "reply-draft",
      workspaceId,
      content: content({
        kind: "reply",
        threadId: thread.id,
        inReplyToMessageId: parent.id,
        subject: `Re: ${thread.subject}`,
      }),
      updatedBy: "device-a",
      at: now().toISOString(),
    });
    expect(await drafts.mirror("reply-draft")).toBe("mirrored");
    const write = gmail.draftWrites.at(-1);
    expect(write?.threadId).toBe(gmailParent?.threadId ?? "missing");
    const raw = new TextDecoder().decode(write?.raw);
    expect(raw).toContain(`In-Reply-To: <${rfc}>`);
    expect(raw).toMatch(
      new RegExp(`^References: .*<${rfc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}>`, "m"),
    );
  });

  test("the sync import pass does not take monday's own mirrors for new Drafts", async () => {
    const before = (await drafts.list(workspaceId)).length;
    await syncAll(false);
    await syncAll(false);
    const after = await drafts.list(workspaceId);
    expect(after).toHaveLength(before);
    expect(after.filter((d) => d.updatedBy === "provider")).toHaveLength(0);
  }, 120_000);

  test("a lasting 403 quota refusal fails the mirror instead of vanishing", async () => {
    await drafts.save({
      id: "quota-draft",
      workspaceId,
      content: content({ subject: "Quota" }),
      updatedBy: "device-a",
      at: now().toISOString(),
    });
    gmail.quotaRefuseNext = 1_000;
    try {
      await expect(drafts.mirror("quota-draft")).rejects.toMatchObject({ code: "rate-limit" });
      expect((await row("quota-draft"))?.providerDraftId).toBeNull();
    } finally {
      gmail.quotaRefuseNext = 0;
    }
    // A short refusal is retried inside the client and the draft lands.
    gmail.quotaRefuseNext = 2;
    expect(await drafts.mirror("quota-draft")).toBe("mirrored");
    expect((await row("quota-draft"))?.providerDraftId).toMatch(/^r-/);
  });

  test("a Draft deleted in monday is deleted in Gmail", async () => {
    const providerId = (await row("quota-draft"))?.providerDraftId ?? "";
    expect(gmail.drafts.has(providerId)).toBe(true);
    advance(1_000);
    expect((await drafts.remove("quota-draft")).applied).toBe(true);
    advance(MIRROR_DEBOUNCE_MS + 1);
    await runDue();
    expect(gmail.drafts.has(providerId)).toBe(false);
    expect((await row("quota-draft"))?.providerDraftId).toBeNull();
  });

  test("a send after the mirror goes through drafts.send with the Gmail draft id", async () => {
    const providerId = (await row("agent-draft"))?.providerDraftId ?? "";
    expect(providerId).toMatch(/^r-/);
    const scheduled = await drafts.schedule("agent-draft", { delaySeconds: 0 });
    await drafts.deliver(scheduled.sendId, null);
    const sent = gmail.sent.at(-1);
    expect(sent?.draftId).toBe(providerId);
    // The real send carries a fresh Message-ID, not the mirror's mark.
    expect(new TextDecoder().decode(sent?.raw)).not.toContain("monday-draft.");
    expect(gmail.drafts.has(providerId)).toBe(false);
  }, 60_000);

  test("the boot backfill queues every open Draft Gmail does not hold yet", async () => {
    // Saved while mirroring could not work: a row with no provider id and no hash.
    await drafts.save({
      id: "old-draft",
      workspaceId,
      content: content({ subject: "Written days ago" }),
      updatedBy: "agent",
      at: now().toISOString(),
    });
    await db.handle.db.delete(jobsTable).where(eq(jobsTable.class, MIRROR_STEP));
    const queued = await backfillDraftMirrors(db.handle.db, jobs, now);
    // old-draft only: the others are mirrored, sent or deleted.
    expect(queued).toBe(1);
    expect(await drafts.backfillMirrors()).toBe(1);
    expect(await mirrorJobs()).toHaveLength(1);
    await runDue();
    expect((await row("old-draft"))?.providerDraftId).toMatch(/^r-/);
    expect(await backfillDraftMirrors(db.handle.db, jobs, now)).toBe(0);
  });
});
