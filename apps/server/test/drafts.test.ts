// Drafts, scheduled sends, blobs and the Voice profile (slice 8, ADR 0010)
// through the routes and the Job steps, over the fake Provider: a Draft round
// trips with change rows, a send is enqueued at now plus the delay, cancelled
// before run_at, then sent after; the MIME carries both parts and the reply
// headers; a too-large message fails with a typed error; the mirror step is
// idempotent on content; Provider drafts import on sync.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type {
  Account,
  Change,
  Draft,
  DraftContent,
  ScheduledSend,
  VoiceProfile,
} from "@monday/shared";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, createApp } from "../src/app.ts";
import { createAuth } from "../src/auth/index.ts";
import { claimableNeeds } from "../src/capabilities.ts";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys } from "../src/crypto/keys.ts";
import { activity, jobs as jobsTable } from "../src/db/schema.ts";
import {
  createDrafts,
  DELIVER_STEP,
  type Drafts,
  MIRROR_DEBOUNCE_MS,
  MIRROR_STEP,
} from "../src/drafts/index.ts";
import { createJobs, type Jobs } from "../src/jobs/index.ts";
import { createMailstore, type Mailstore } from "../src/mailstore/index.ts";
import { type CredentialStore, createCredentialStore } from "../src/providers/credentials.ts";
import {
  createFakeProvider,
  type FakeProvider,
  fakeCredentials,
  generateFixture,
} from "../src/providers/fake/index.ts";
import { createProviderRegistry } from "../src/providers/index.ts";
import { composeMime, parseMime } from "../src/providers/mime.ts";
import { createSyncEngine, mirrorRows, type SyncEngine } from "../src/providers/sync.ts";
import { type Provider, ProviderError, type Session } from "../src/providers/types.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const SIDECAR_TOKEN = "per-launch-token";
const fixture = generateFixture();

function fakeClock(start = Date.parse("2026-09-16T12:00:00Z")) {
  let t = start;
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
}

const account: Account = {
  id: "acct-drafts",
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

/** A second Account whose Provider accepts only tiny messages. */
const smallAccount: Account = { ...account, id: "acct-small", provider: "jmap" };
const SMALL_LIMIT = 2_000;

/** Wraps a Provider so every Session reports a small send limit. */
/** While true, every send through the limited Provider fails like a dropped connection. */
let networkDown = false;

function withLimit(inner: Provider, maxSendBytes: number): Provider {
  return {
    kind: inner.kind,
    async connect(credentials) {
      const session = await inner.connect(credentials);
      const limited: Session = {
        ...session,
        capabilities: () => ({ ...session.capabilities(), maxSendBytes }),
        send: (mime, options) => {
          if (networkDown) throw new ProviderError("connection reset", "network");
          return session.send(mime, options);
        },
      };
      return limited;
    },
  };
}

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

describe("drafts and scheduled sends", () => {
  let db: TestDatabase;
  let store: Mailstore;
  let credentials: CredentialStore;
  let fake: FakeProvider;
  let smallFake: FakeProvider;
  let engine: SyncEngine;
  let jobs: Jobs;
  let drafts: Drafts;
  let app: Hono<AppEnv>;
  let workspaceId = "";
  let smallWorkspaceId = "";
  const clock = fakeClock();
  const T0 = "2026-09-16T12:00:00.000Z";

  const request = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${SIDECAR_TOKEN}`,
        ...(init.headers ?? {}),
      },
    });
  const send = (path: string, body: unknown, method = "POST") =>
    request(path, { method, body: JSON.stringify(body) });
  const feed = async (since = 0): Promise<Change[]> =>
    (
      (await (
        await request(`/changes?workspace=${workspaceId}&since=${since}&limit=500`)
      ).json()) as {
        changes: Change[];
      }
    ).changes;
  const draftChanges = async (id: string) =>
    (await feed()).filter((c) => c.kind === "draft" && c.entityId === id);
  const sendChanges = async (id: string) =>
    (await feed()).filter((c) => c.kind === "send" && c.entityId === id);

  /** Claims and runs every job that is due, in order. */
  const runDue = async (): Promise<string[]> => {
    const ran: string[] = [];
    for (let i = 0; i < 20; i++) {
      // A Sidecar with no Cloud alive serves every class, the send's needs-always-on included.
      const job = await jobs.claim("server-a", claimableNeeds("sidecar", false), 30_000);
      if (!job) break;
      await jobs.run(job, 30_000);
      ran.push(job.class);
    }
    return ran;
  };

  beforeAll(async () => {
    db = await testDatabase();
    const keys = createKeys(db.handle.db);
    await keys.unlock(randomKey());
    store = createMailstore(db.handle.db, keys);
    credentials = createCredentialStore(db.handle.db, store);
    fake = createFakeProvider(fixture);
    smallFake = createFakeProvider(generateFixture(3));
    workspaceId = (await store.createWorkspace(account)).id;
    smallWorkspaceId = (await store.createWorkspace(smallAccount)).id;
    await credentials.store(workspaceId, account.id, fakeCredentials());
    await credentials.store(smallWorkspaceId, smallAccount.id, fakeCredentials());
    jobs = createJobs(db.handle.db, { now: clock.now });
    engine = createSyncEngine({
      db: db.handle.db,
      mailstore: store,
      providers: createProviderRegistry({
        overrides: { imap: fake, jmap: withLimit(smallFake, SMALL_LIMIT) },
      }),
      credentials,
      now: clock.now,
    });
    engine.registerSteps(jobs);
    drafts = createDrafts({
      db: db.handle.db,
      mailstore: store,
      sync: engine,
      now: clock.now,
      settings: async () => ({ delaySeconds: 30 }),
    });
    drafts.registerSteps(jobs);
    engine.setDraftImporter(
      (found) => drafts.importProviderDraft(found).then(() => {}),
      (ws) => drafts.knownProviderDraftIds(ws),
    );
    const auth = createAuth({ db: db.handle.db, sidecarToken: SIDECAR_TOKEN });
    app = createApp({
      db: db.handle.db,
      auth,
      mode: "sidecar",
      keys,
      mailstore: store,
      drafts,
      jobs,
      sync: engine,
      remoteAddress: () => "127.0.0.1",
    });
    // Headers first so a reply has a parent Message with a Message-ID.
    let report = await engine.syncAccount(account.id, { headersOnly: true });
    for (let i = 0; i < 50 && report.more; i++) {
      report = await engine.syncAccount(account.id, { headersOnly: true });
    }
  }, 120_000);

  afterAll(async () => {
    await engine.close();
    await db.drop();
  });

  const draftId = "draft-1";

  test("a Draft round trips through PUT and GET, each save a change row", async () => {
    const put = await send(
      `/drafts/${draftId}`,
      {
        workspace: workspaceId,
        at: T0,
        updatedBy: "device-a",
        content: content(),
      },
      "PUT",
    );
    expect(put.status).toBe(200);
    const saved = (await put.json()) as { applied: boolean; draft: Draft };
    expect(saved.applied).toBe(true);
    expect(saved.draft).toMatchObject({
      id: draftId,
      workspaceId,
      subject: "Take-home review",
      bodyText: "Hi Aoife,\n\nThanks for the write-up.",
      status: "open",
      updatedBy: "device-a",
      updatedAt: T0,
    });

    const got = (await (await request(`/drafts/${draftId}`)).json()) as Draft;
    expect(got).toEqual(saved.draft);
    const listed = (await (await request(`/drafts?workspace=${workspaceId}`)).json()) as {
      drafts: Draft[];
    };
    expect(listed.drafts.map((d) => d.id)).toEqual([draftId]);

    const changes = await draftChanges(draftId);
    expect(changes).toHaveLength(1);
    expect(changes[0]?.payload).toMatchObject({
      id: draftId,
      status: "open",
      updatedBy: "device-a",
      deleted: false,
      to: [{ name: "Aoife", email: "aoife@northlight.dev" }],
    });
    // Content never rides the feed.
    expect(JSON.stringify(changes[0]?.payload)).not.toContain("Take-home");

    // Nothing in the row is plaintext content.
    const rows = await db.handle
      .sql`select subject_enc, body_enc from drafts where id = ${draftId}`;
    const raw = Buffer.concat([
      Buffer.from(rows[0]?.subject_enc as Uint8Array),
      Buffer.from(rows[0]?.body_enc as Uint8Array),
    ]).toString("latin1");
    expect(raw).not.toContain("Take-home");
    expect(raw).not.toContain("write-up");

    // A mirror Job was queued 5 s out, once.
    const mirrorJobs = await db.handle.db
      .select()
      .from(jobsTable)
      .where(eq(jobsTable.class, MIRROR_STEP));
    expect(mirrorJobs).toHaveLength(1);
    expect(mirrorJobs[0]?.runAt.getTime()).toBe(clock.now().getTime() + MIRROR_DEBOUNCE_MS);
  });

  test("a second save records another change; an older save is refused", async () => {
    const T1 = "2026-09-16T12:00:10.000Z";
    const second = (await (
      await send(
        `/drafts/${draftId}`,
        {
          workspace: workspaceId,
          at: T1,
          updatedBy: "device-b",
          content: content({ subject: "v2" }),
        },
        "PUT",
      )
    ).json()) as { applied: boolean; draft: Draft };
    expect(second.applied).toBe(true);
    expect(second.draft.subject).toBe("v2");
    expect(await draftChanges(draftId)).toHaveLength(2);

    const stale = (await (
      await send(
        `/drafts/${draftId}`,
        {
          workspace: workspaceId,
          at: T0,
          updatedBy: "device-a",
          content: content({ subject: "old" }),
        },
        "PUT",
      )
    ).json()) as { applied: boolean; reason: string; draft: Draft };
    expect(stale.applied).toBe(false);
    expect(stale.reason).toContain("device-b");
    expect(stale.draft.subject).toBe("v2");
    expect(await draftChanges(draftId)).toHaveLength(2);
    const losses = await db.handle.db
      .select()
      .from(activity)
      .where(eq(activity.tool, "draft.save"));
    expect(losses).toHaveLength(1);
  });

  test("the mirror step appends once per content change and is idempotent", async () => {
    expect(await drafts.mirror(draftId)).toBe("mirrored");
    expect(fake.calls.putDraft).toBe(1);
    expect(await drafts.mirror(draftId)).toBe("unchanged");
    expect(fake.calls.putDraft).toBe(1);
    const inDrafts = () => fake.snapshot().filter((m) => m.mailboxIds.includes("Drafts"));
    expect(inDrafts()).toHaveLength(1);

    await drafts.save({
      id: draftId,
      workspaceId,
      content: content({ subject: "v3" }),
      at: "2026-09-16T12:00:20.000Z",
    });
    expect(await drafts.mirror(draftId)).toBe("mirrored");
    expect(fake.calls.putDraft).toBe(2);
    // The previous copy was replaced, not joined.
    expect(inDrafts()).toHaveLength(1);
    const providerId = inDrafts()[0]?.id ?? "";
    const raw = await (await fake.connect(fakeCredentials())).fetchMessage(providerId);
    expect(raw.headers.subject).toBe("v3");
    expect(raw.text).toContain("Thanks for the write-up.");
    expect(raw.html).toContain("<b>write-up</b>");

    // Running the queued Job itself finds nothing new to do.
    clock.advance(MIRROR_DEBOUNCE_MS + 1);
    const ran = await runDue();
    expect(ran).toContain(MIRROR_STEP);
    expect(fake.calls.putDraft).toBe(2);
  });

  test("composeMime carries text and html alternatives, attachments and reply headers", async () => {
    const mime = Buffer.from(
      await composeMime({
        from: { name: "Sam", email: "sam@monday.test" },
        to: [{ name: "Aoife", email: "aoife@northlight.dev" }],
        subject: "Re: hello",
        text: "plain",
        html: "<p>rich</p>",
        inReplyTo: "parent@x",
        references: ["root@x", "parent@x"],
        messageId: "child@monday.test",
        attachments: [{ name: "a.txt", mediaType: "text/plain", bytes: Buffer.from("abc") }],
      }),
    ).toString("utf8");
    expect(mime).toContain("multipart/mixed");
    expect(mime).toContain("multipart/alternative");
    expect(mime).toContain("Content-Type: text/plain");
    expect(mime).toContain("Content-Type: text/html");
    expect(mime).toContain("Content-Disposition: attachment; filename=a.txt");
    expect(mime).toContain("In-Reply-To: <parent@x>");
    expect(mime).toContain("References: <root@x> <parent@x>");
    expect(mime).toContain("Message-ID: <child@monday.test>");
    const parsed = await parseMime(mime);
    expect(parsed.text?.trim()).toBe("plain");
    expect(parsed.html).toContain("<p>rich</p>");
    expect(parsed.attachments).toHaveLength(1);
  });

  test("blobs upload in chunks and attach to a Draft", async () => {
    const bytes = new Uint8Array(1024 * 1024 + 10);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff;
    const started = await send("/blobs", {
      workspace: workspaceId,
      name: "sync-model.png",
      mediaType: "image/png",
      size: bytes.length,
    });
    expect(started.status).toBe(201);
    const blob = (await started.json()) as { id: string; chunkSize: number; chunkCount: number };
    expect(blob.chunkCount).toBe(2);
    for (let i = 0; i < blob.chunkCount; i++) {
      const part = bytes.subarray(
        i * blob.chunkSize,
        Math.min((i + 1) * blob.chunkSize, bytes.length),
      );
      const res = await request(`/blobs/${blob.id}/chunks/${i}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: part,
      });
      expect(res.status).toBe(200);
      const state = (await res.json()) as { received: number; complete: boolean };
      expect(state.received).toBe(i + 1);
      expect(state.complete).toBe(i === blob.chunkCount - 1);
    }
    const stored = await store.readBlob(blob.id);
    expect(stored.name).toBe("sync-model.png");
    expect(Buffer.from(stored.bytes).equals(Buffer.from(bytes))).toBe(true);

    const wrongSize = await request(`/blobs/${blob.id}/chunks/0`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array(5),
    });
    expect(wrongSize.status).toBe(400);

    const saved = (await (
      await send(
        `/drafts/${draftId}`,
        {
          workspace: workspaceId,
          at: "2026-09-16T12:00:30.000Z",
          content: content({
            subject: "v4",
            attachments: [
              {
                blobId: blob.id,
                name: "sync-model.png",
                size: bytes.length,
                mediaType: "image/png",
              },
            ],
          }),
        },
        "PUT",
      )
    ).json()) as { draft: Draft };
    expect(saved.draft.attachmentBlobIds).toEqual([blob.id]);
    expect(saved.draft.attachments[0]?.name).toBe("sync-model.png");
  });

  test("send enqueues a Job at now plus the delay; cancel before run_at reopens the Draft", async () => {
    const res = await send(`/drafts/${draftId}/send`, { sendId: "send-1", delaySeconds: 60 });
    expect(res.status).toBe(200);
    const scheduled = (await res.json()) as { sendId: string; runAt: string; applied: boolean };
    expect(scheduled.applied).toBe(true);
    expect(scheduled.sendId).toBe("send-1");
    expect(Date.parse(scheduled.runAt)).toBe(clock.now().getTime() + 60_000);
    const job = await jobs.get("send-1");
    expect(job?.class).toBe(DELIVER_STEP);
    expect(job?.runAt.getTime()).toBe(clock.now().getTime() + 60_000);
    expect(((await (await request(`/drafts/${draftId}`)).json()) as Draft).status).toBe(
      "scheduled",
    );

    // Replaying the same intent answers the same send.
    const again = (await (
      await send(`/drafts/${draftId}/send`, { sendId: "send-1", delaySeconds: 60 })
    ).json()) as { sendId: string; runAt: string };
    expect(again).toMatchObject({ sendId: "send-1", runAt: scheduled.runAt });

    // Editing while scheduled is refused.
    const edit = (await (
      await send(
        `/drafts/${draftId}`,
        {
          workspace: workspaceId,
          at: "2026-09-16T12:00:40.000Z",
          content: content({ subject: "v5" }),
        },
        "PUT",
      )
    ).json()) as { applied: boolean; reason: string };
    expect(edit.applied).toBe(false);
    expect(edit.reason).toContain("scheduled");

    // Not due yet: the send does not run (a mirror Job from the last save may).
    clock.advance(30_000);
    expect(await runDue()).not.toContain(DELIVER_STEP);

    const cancel = await send("/sends/send-1/cancel", {});
    expect(await cancel.json()).toEqual({ applied: true });
    expect(await jobs.get("send-1")).toBeNull();
    expect(((await (await request(`/drafts/${draftId}`)).json()) as Draft).status).toBe("open");
    const sends = (await (await request(`/sends?workspace=${workspaceId}`)).json()) as {
      sends: ScheduledSend[];
    };
    expect(sends.sends).toHaveLength(1);
    expect(sends.sends[0]).toMatchObject({ id: "send-1", status: "cancelled", draftId });
    expect(sends.sends[0]?.cancelledAt).toBe(clock.now().toISOString());
    const changes = await sendChanges("send-1");
    expect(changes.map((c) => (c.payload as ScheduledSend).status)).toEqual([
      "scheduled",
      "cancelled",
    ]);
    expect(fake.calls.send ?? 0).toBe(0);
  });

  test("a reply is sent after run_at with both parts, reply headers and the attachment", async () => {
    // Make the Draft a reply to a synced Message with a Message-ID.
    const page = await store.listThreads(workspaceId, { limit: 5, includeArchived: true });
    const thread = page.threads[0];
    if (!thread) throw new Error("no threads synced");
    const parents = await store.listMessages(thread.id);
    const parent = parents[parents.length - 1];
    if (!parent) throw new Error("no parent message");
    const mirror = (await mirrorRows(db.handle.db, workspaceId)).find(
      (r) => r.messageId === parent.id,
    );
    const parentMessageId = mirror?.rfcMessageId;
    expect(parentMessageId).toBeTruthy();
    const draft = (await (await request(`/drafts/${draftId}`)).json()) as Draft;
    await drafts.save({
      id: draftId,
      workspaceId,
      at: "2026-09-16T12:01:00.000Z",
      content: content({
        subject: `Re: ${thread.subject}`,
        kind: "reply",
        threadId: thread.id,
        inReplyToMessageId: parent.id,
        attachments: draft.attachments,
      }),
    });
    await drafts.mirror(draftId);
    const mirroredId = fake.snapshot().find((m) => m.mailboxIds.includes("Drafts"))?.id;
    expect(mirroredId).toBeTruthy();

    const scheduled = (await (
      await send(`/drafts/${draftId}/send`, { sendId: "send-2", delaySeconds: 30 })
    ).json()) as { runAt: string };
    expect(Date.parse(scheduled.runAt)).toBe(clock.now().getTime() + 30_000);
    clock.advance(30_000);
    const ran = await runDue();
    expect(ran).toContain(DELIVER_STEP);
    expect(fake.calls.send).toBe(1);

    const sentRes = await request("/sends/send-2");
    const sent = (await sentRes.json()) as ScheduledSend;
    expect(sent.status).toBe("sent");
    expect(sent.sentAt).toBe(clock.now().toISOString());
    expect(sent.jobId).toBe("send-2");
    expect(((await (await request(`/drafts/${draftId}`)).json()) as Draft).status).toBe("sent");

    // The Provider holds it in Sent with both parts, the reply headers and the attachment.
    const inSent = fake
      .snapshot()
      .filter((m) => m.mailboxIds.includes("Sent") && m.id.startsWith("s"));
    const delivered = inSent[inSent.length - 1];
    if (!delivered) throw new Error("nothing in Sent");
    const raw = await (await fake.connect(fakeCredentials())).fetchMessage(delivered.id);
    expect(raw.headers.subject).toBe(`Re: ${thread.subject}`);
    expect(raw.headers["in-reply-to"]).toBe(`<${parentMessageId}>`);
    expect(raw.headers.references).toContain(`<${parentMessageId}>`);
    expect(raw.headers["message-id"]).toMatch(/^<.+@monday\.test>$/);
    expect(raw.text).toContain("Thanks for the write-up.");
    expect(raw.html).toContain("<b>write-up</b>");
    expect(raw.headers["content-type"]).toContain("multipart/mixed");

    // The mirrored Draft is gone from the Provider.
    expect(fake.snapshot().some((m) => m.id === mirroredId)).toBe(false);
    expect(fake.calls.deleteDraft ?? 0).toBeGreaterThanOrEqual(1);

    // The Activity log names the Job.
    const rows = await db.handle.db.select().from(activity).where(eq(activity.tool, DELIVER_STEP));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.summary).toContain("job send-2");
    expect(rows[0]?.summary).toContain("aoife@northlight.dev");

    // Feed: scheduled then sent; the Draft's last change says sent.
    expect((await sendChanges("send-2")).map((c) => (c.payload as ScheduledSend).status)).toEqual([
      "scheduled",
      "sent",
    ]);
    const last = (await draftChanges(draftId)).at(-1);
    expect(last?.payload).toMatchObject({ status: "sent" });

    // Cancel after the fact is refused.
    expect(await (await send("/sends/send-2/cancel", {})).json()).toEqual({
      applied: false,
      reason: "send is sent",
    });
    // Running the Job twice does not send twice.
    await drafts.deliver("send-2", "send-2");
    expect(fake.calls.send).toBe(1);
  });

  test("send later is the same Job with a later time", async () => {
    await send(
      `/drafts/later`,
      { workspace: workspaceId, at: T0, content: content({ subject: "later" }) },
      "PUT",
    );
    const at = new Date(clock.now().getTime() + 3_600_000).toISOString();
    const res = (await (await send("/drafts/later/send", { sendId: "send-later", at })).json()) as {
      runAt: string;
    };
    expect(res.runAt).toBe(at);
    expect((await jobs.get("send-later"))?.runAt.toISOString()).toBe(at);
    expect(await (await send("/sends/send-later/cancel", {})).json()).toEqual({ applied: true });
  });

  test("a Draft with no recipients cannot be scheduled; a deleted Draft is gone", async () => {
    await send(
      `/drafts/empty`,
      { workspace: workspaceId, at: T0, content: content({ to: [] }) },
      "PUT",
    );
    const res = await send("/drafts/empty/send", {});
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "no_recipients" });

    const removed = await request("/drafts/empty", { method: "DELETE" });
    expect(await removed.json()).toEqual({ applied: true });
    expect((await request("/drafts/empty")).status).toBe(404);
    const last = (await draftChanges("empty")).at(-1);
    expect(last?.payload).toMatchObject({ deleted: true });
  });

  test("a message over the Provider's limit fails with a typed error and reopens the Draft", async () => {
    const big = "x".repeat(SMALL_LIMIT * 2);
    await drafts.save({
      id: "draft-big",
      workspaceId: smallWorkspaceId,
      at: T0,
      content: content({ subject: "big", bodyText: big, bodyHtml: `<p>${big}</p>` }),
    });
    const scheduled = await drafts.schedule("draft-big", { sendId: "send-big", delaySeconds: 0 });
    expect(scheduled.applied).toBe(true);
    const ran = await runDue();
    expect(ran).toContain(DELIVER_STEP);
    const failed = await drafts.getSend("send-big");
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatchObject({ code: "too_large", limit: SMALL_LIMIT });
    expect((failed.error as { size: number }).size).toBeGreaterThan(SMALL_LIMIT);
    expect((await drafts.get("draft-big")).status).toBe("open");
    expect(smallFake.calls.send ?? 0).toBe(0);
    const listed = (await (await request(`/sends?workspace=${smallWorkspaceId}`)).json()) as {
      sends: ScheduledSend[];
    };
    expect(listed.sends[0]?.error).toMatchObject({ code: "too_large" });
  });

  test("a send whose Provider stays unreachable is marked failed once its retries are spent", async () => {
    await drafts.save({
      id: "draft-down",
      workspaceId: smallWorkspaceId,
      at: clock.now().toISOString(),
      content: content({ subject: "while the network is down" }),
    });
    const scheduled = await drafts.schedule("draft-down", { sendId: "send-down", delaySeconds: 0 });
    expect(scheduled.applied).toBe(true);
    networkDown = true;
    try {
      // Every attempt but the last rethrows, so the Job retries with backoff and the send stays scheduled.
      for (let attempt = 1; attempt < jobs.maxAttempts; attempt++) {
        expect(await runDue()).toContain(DELIVER_STEP);
        expect((await drafts.getSend("send-down")).status).toBe("scheduled");
        expect((await jobs.get("send-down"))?.status).toBe("queued");
        clock.advance(60_000);
      }
      // The last attempt records the failure instead of leaving the send scheduled forever.
      expect(await runDue()).toContain(DELIVER_STEP);
      const failed = await drafts.getSend("send-down");
      expect(failed.status).toBe("failed");
      expect(failed.error).toMatchObject({ code: "failed", message: "connection reset" });
      expect((await drafts.get("draft-down")).status).toBe("open");
      expect((await jobs.get("send-down"))?.status).toBe("done");
      // Cancel has nothing to do; a new send can be scheduled once the network is back.
      expect((await drafts.cancel("send-down")).applied).toBe(false);
    } finally {
      networkDown = false;
    }
  });

  test("a Draft the Provider holds is imported on sync and not mirrored back", async () => {
    const providerId = fake.deliver({
      mailbox: "drafts",
      threadKey: "provider-draft",
      from: fixture.owner,
      to: [{ name: "Mateus", email: "mateus@ferreira.design" }],
      cc: [],
      subject: "Written elsewhere",
      date: clock.now().toISOString(),
      messageId: "elsewhere@fixture.monday.test",
      inReplyTo: null,
      references: [],
      seen: true,
      flagged: false,
      answered: false,
      headers: {},
      text: "Started on my phone.",
      html: null,
      attachments: [],
    });
    let report = await engine.syncAccount(account.id);
    for (let i = 0; i < 50 && report.more; i++) report = await engine.syncAccount(account.id);
    const all = await drafts.list(workspaceId);
    const imported = all.find((d) => d.subject === "Written elsewhere");
    expect(imported).toBeDefined();
    expect(imported?.bodyText).toBe("Started on my phone.");
    expect(imported?.to[0]?.email).toBe("mateus@ferreira.design");
    expect(imported?.updatedBy).toBe("provider");
    expect(await drafts.knownProviderDraftIds(workspaceId)).toContain(providerId);
    const before = fake.calls.putDraft;
    expect(await drafts.mirror(imported?.id ?? "")).toBe("unchanged");
    expect(fake.calls.putDraft).toBe(before);
    // A second sync does not import it again.
    report = await engine.syncAccount(account.id);
    expect(
      (await drafts.list(workspaceId)).filter((d) => d.subject === "Written elsewhere"),
    ).toHaveLength(1);
  });

  test("the Voice profile stores a description, excerpts and the switch", async () => {
    const empty = (await (await request(`/voice?workspace=${workspaceId}`)).json()) as VoiceProfile;
    expect(empty).toEqual({
      workspaceId,
      description: "",
      excerpts: [],
      enabled: false,
      builtAt: null,
    });
    const put = await send(
      "/voice",
      {
        workspace: workspaceId,
        description: "Short, warm, no exclamation marks.",
        excerpts: ["Thanks, Sam"],
        enabled: true,
      },
      "PUT",
    );
    expect(await put.json()).toMatchObject({
      description: "Short, warm, no exclamation marks.",
      excerpts: ["Thanks, Sam"],
      enabled: true,
    });
    const patched = (await (
      await send("/voice", { workspace: workspaceId, enabled: false }, "PUT")
    ).json()) as {
      enabled: boolean;
      description: string;
    };
    expect(patched.enabled).toBe(false);
    expect(patched.description).toBe("Short, warm, no exclamation marks.");
  });

  test("thread messages carry attachment headers and body states; the body route returns display HTML", async () => {
    const page = await store.listThreads(workspaceId, { limit: 50, includeArchived: true });
    const thread = page.threads.find((t) => t.hasAttachments) ?? page.threads[0];
    if (!thread) throw new Error("no thread");
    const res = await request(`/threads/${thread.id}/messages`);
    expect(res.status).toBe(200);
    const { messages: list } = (await res.json()) as {
      messages: Array<{
        id: string;
        bodyState: string;
        attachments: unknown[];
        headers: Record<string, string>;
      }>;
    };
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((m) => ["fetched", "pending", "deferred"].includes(m.bodyState))).toBe(true);
    const first = list[0];
    if (!first) throw new Error("no message");
    const body = await request(`/messages/${first.id}/body`);
    expect(body.status).toBe(200);
    const json = (await body.json()) as {
      text: string;
      display: { html: string; quoted: boolean };
    };
    expect(json.display.html.startsWith("<p>") || json.display.html === "").toBe(true);
  });

  test("a body the sync has not fetched yet is fetched on demand by the body route", async () => {
    // A Message arrives and only its headers are synced: a reader opening the
    // Thread must not wait for the body pass to come around.
    const providerId = fake.deliver({
      mailbox: "inbox",
      threadKey: "on-demand",
      from: { name: "Aoife", email: "aoife@northlight.dev" },
      to: [fixture.owner],
      cc: [],
      subject: "Opened before the body pass",
      date: clock.now().toISOString(),
      messageId: "on-demand@fixture.monday.test",
      inReplyTo: null,
      references: [],
      seen: false,
      flagged: false,
      answered: false,
      headers: {},
      text: "The body the reader asked for.",
      html: null,
      attachments: [],
    });
    let report = await engine.syncAccount(account.id, { headersOnly: true });
    for (let i = 0; i < 50 && report.more; i++) {
      report = await engine.syncAccount(account.id, { headersOnly: true });
    }
    const pending = await db.handle.db.query.syncMessages.findFirst({
      where: (t, { eq: is }) => is(t.providerId, providerId),
    });
    if (!pending) throw new Error("the delivered message was not synced");
    expect(pending.bodyState).toBe("pending");
    const before = fake.calls.fetchMessage ?? 0;
    const body = await request(`/messages/${pending.messageId}/body`);
    expect(body.status).toBe(200);
    const json = (await body.json()) as { text: string; display: { html: string } };
    expect(json.text).toContain("The body the reader asked for.");
    expect(fake.calls.fetchMessage ?? 0).toBeGreaterThan(before);
    const after = await db.handle.db.query.syncMessages.findFirst({
      where: (t, { eq: is }) => is(t.messageId, pending.messageId),
    });
    expect(after?.bodyState).toBe("fetched");
    // Asking again fetches nothing: the body is there.
    const again = fake.calls.fetchMessage ?? 0;
    await request(`/messages/${pending.messageId}/body`);
    expect(fake.calls.fetchMessage ?? 0).toBe(again);
    const answered = (await (await request(`/messages/${pending.messageId}/body`)).json()) as {
      bodyState: string;
    };
    expect(answered.bodyState).toBe("fetched");
  });

  /** Delivers one Message and syncs its headers only; returns its Message id. */
  const headersOnly = async (threadKey: string, html: string | null, text: string) => {
    const providerId = fake.deliver({
      mailbox: "inbox",
      threadKey,
      from: { name: "Aoife", email: "aoife@northlight.dev" },
      to: [fixture.owner],
      cc: [],
      subject: threadKey,
      date: clock.now().toISOString(),
      messageId: `${threadKey}@fixture.monday.test`,
      inReplyTo: null,
      references: [],
      seen: false,
      flagged: false,
      answered: false,
      headers: {},
      text,
      html,
      attachments: [],
    });
    let report = await engine.syncAccount(account.id, { headersOnly: true });
    for (let i = 0; i < 50 && report.more; i++) {
      report = await engine.syncAccount(account.id, { headersOnly: true });
    }
    const row = await db.handle.db.query.syncMessages.findFirst({
      where: (t, { eq: is }) => is(t.providerId, providerId),
    });
    if (!row) throw new Error("the delivered message was not synced");
    return { providerId, messageId: row.messageId };
  };

  test("a body the on-demand fetch could not get answers pending, so the client does not keep the empty stand-in", async () => {
    // The user's case: the Provider refused (quota, a dropped connection) and
    // the route used to answer the header-only sync's empty body as if it
    // were the Message's, which the desktop Cache then kept for good.
    const { providerId, messageId } = await headersOnly("refused", null, "Never fetched.");
    fake.destroy(providerId);
    const res = await request(`/messages/${messageId}/body`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { text: string; bodyState: string };
    expect(json.bodyState).toBe("pending");
    expect(json.text).toBe("");
  });

  test("GET /messages/bodies marks bodies the sync has not fetched and sends the reader's sanitised html", async () => {
    const pending = await headersOnly("bulk-pending", null, "Not yet.");
    const rich = await headersOnly(
      "bulk-rich",
      `<p onclick="alert(1)">Rich <img src="https://cdn.example.com/a.png"></p><script>alert(1)</script>`,
      "Rich",
    );
    const fetched = await request(`/messages/${rich.messageId}/body`);
    expect(((await fetched.json()) as { bodyState: string }).bodyState).toBe("fetched");
    // With remote images off (the Setting's default is on) they wait for "Show images".
    const res = await request(`/messages/bodies?workspace=${workspaceId}&limit=1000&images=0`);
    expect(res.status).toBe(200);
    const page = (await res.json()) as {
      bodies: { id: string; html: string | null; text: string; bodyState: string }[];
    };
    expect(page.bodies.find((b) => b.id === pending.messageId)).toMatchObject({
      bodyState: "pending",
      text: "",
      html: null,
    });
    const body = page.bodies.find((b) => b.id === rich.messageId);
    expect(body?.bodyState).toBe("fetched");
    expect(body?.html).toBe(
      `<p>Rich <img data-src="https://cdn.example.com/a.png" data-blocked="" /></p>`,
    );
  });
});
