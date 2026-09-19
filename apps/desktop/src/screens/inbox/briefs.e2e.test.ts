/// <reference types="bun-types" />
// Slice 13's "done when", end to end through the interfaces: the fake
// Provider delivers mail, the real sync engine stores it and reports each
// Thread to the brief policy through the Jobs table, the brief Job runs
// over the fake chat, the Changes feed carries the Brief's headers, and the
// client Store over the Server's HTTP handler warms the content into its
// Cache. The reader seam then finds the Brief without asking, or asks on
// open when the policy said on_open.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Account, Brief, BriefTrigger } from "@monday/shared";
import { createApp } from "../../../../server/src/app.ts";
import { createAuth } from "../../../../server/src/auth/index.ts";
import { randomKey } from "../../../../server/src/crypto/aead.ts";
import { createKeys, type Keys } from "../../../../server/src/crypto/keys.ts";
import { BRIEF_STEP } from "../../../../server/src/intelligence/brief.ts";
import {
  createIntelligence,
  type Intelligence,
} from "../../../../server/src/intelligence/index.ts";
import {
  createFakeChat,
  fakeKeys,
} from "../../../../server/src/intelligence/runtime/fake/index.ts";
import { createJobs, type Jobs } from "../../../../server/src/jobs/index.ts";
import { createMailstore, type Mailstore } from "../../../../server/src/mailstore/index.ts";
import { createCredentialStore } from "../../../../server/src/providers/credentials.ts";
import {
  createFakeProvider,
  type FakeProvider,
  fakeCredentials,
  generateFixture,
} from "../../../../server/src/providers/fake/index.ts";
import { createProviderRegistry } from "../../../../server/src/providers/index.ts";
import {
  createSyncEngine,
  defaultSyncSettings,
  type SyncEngine,
} from "../../../../server/src/providers/sync.ts";
import { type TestDatabase, testDatabase } from "../../../../server/test/harness.ts";
import {
  ApiError,
  type BriefRequestResult,
  type MessageHeaderResponse,
} from "../../platform/api.ts";
import { bunDriver } from "../../store/bun-driver.ts";
import { createStore, type Store } from "../../store/store.ts";
import type { ContentTransport, StoreTransport } from "../../store/transport.ts";
import { createStoreInbox, type StoreInbox } from "./store-inbox.ts";

const TOKEN = "per-launch-token";
const fixture = generateFixture();
const NOW = new Date(fixture.recordedAt);
const owner = fixture.owner;
const aoife = { name: "Aoife Byrne", email: "aoife@northwind.test" };

const words = (n: number, seed: string) =>
  Array.from({ length: n }, (_, i) => `${seed}${i % 7}`).join(" ");

const account: Account = {
  id: "acct-briefs",
  provider: "imap",
  address: fixture.address,
  displayName: owner.name,
  capabilities: {
    push: false,
    labels: false,
    snooze: false,
    mute: false,
    calendar: false,
    meetingLink: null,
  },
};

const answers = {
  reply: JSON.stringify({
    bullets: ["**Aoife** asks for a decision on the take-home by **Friday**."],
    actions: [{ kind: "reply", label: "Say yes", proposedLine: "Let's go ahead." }],
  }),
  newsletter: JSON.stringify({
    bullets: ["This week's digest: three articles on sync engines."],
    actions: [{ kind: "archive", label: "Archive" }],
  }),
  recomputed: JSON.stringify({
    bullets: ["**Aoife** moved the deadline to **Monday** after your question."],
    actions: [],
  }),
};

/** The Store's and the reader's transports over the Server's fetch handler, as the app wires them. */
function transports(app: ReturnType<typeof createApp>): {
  transport: StoreTransport;
  content: ContentTransport;
} {
  const request = async (path: string, init: RequestInit = {}) => {
    const res = await app.request(path, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    });
    if (!res.ok) throw new ApiError(res.status, await res.text());
    return res;
  };
  const get = async <T>(path: string) => (await (await request(path)).json()) as T;
  const unused = () => Promise.reject(new Error("not used by this test"));
  return {
    transport: {
      changes: (ws, since, limit) =>
        get(
          `/changes?${new URLSearchParams({ workspace: ws, since: String(since), limit: String(limit) })}`,
        ),
      intent: unused,
      draftIntent: unused,
      inviteIntent: unused,
      async brief(threadId) {
        try {
          return await get<Brief>(`/threads/${threadId}/brief`);
        } catch (error) {
          if (error instanceof ApiError && error.status === 404) return null;
          throw error;
        }
      },
      connect: () => ({ close() {} }),
    },
    content: {
      messages: async (threadId) =>
        (await get<{ messages: MessageHeaderResponse[] }>(`/threads/${threadId}/messages`))
          .messages,
      body: (messageId) => get(`/messages/${messageId}/body`),
      draft: unused,
      attachment: unused,
      uploadBlob: unused,
      requestBrief: async (ws, threadId, trigger: BriefTrigger) =>
        (await (
          await request(`/threads/${threadId}/brief`, {
            method: "POST",
            body: JSON.stringify({ workspace: ws, trigger }),
          })
        ).json()) as BriefRequestResult,
    },
  };
}

describe("Briefs end to end: the policy, the Job, the feed and the Cache", () => {
  let db: TestDatabase;
  let keys: Keys;
  let mailstore: Mailstore;
  let fake: FakeProvider;
  let engine: SyncEngine;
  let jobs: Jobs;
  let intelligence: Intelligence;
  let chat: ReturnType<typeof createFakeChat>;
  let store: Store;
  let inbox: StoreInbox;
  let workspaceId = "";
  let replyThreadId = "";
  let newsletterThreadId = "";
  let clock = NOW;

  /** Runs every queued Job; returns the brief Jobs that ran and how each ended. */
  const runJobs = async () => {
    const ran: Array<{ id: string; result: string }> = [];
    for (;;) {
      const job = await jobs.claim("server-a", ["needs-process"], 30_000);
      if (!job) break;
      const result = await jobs.run(job, 30_000);
      if (job.class === BRIEF_STEP) ran.push({ id: job.id, result: String(result) });
    }
    return ran;
  };

  const syncAll = async () => {
    for (let i = 0; i < 50; i++) {
      const report = await engine.syncAccount(account.id);
      if (!report.more) return;
    }
    throw new Error("sync did not finish");
  };

  const cachedBrief = async (threadId: string) =>
    (
      await store.query<{ bullets: string; stale: number; content_stale: number }>(
        "select bullets, stale, content_stale from briefs where thread_id = ?",
        [threadId],
      )
    )[0];

  beforeAll(async () => {
    db = await testDatabase();
    keys = createKeys(db.handle.db);
    await keys.unlock(randomKey());
    mailstore = createMailstore(db.handle.db, keys);
    const credentials = createCredentialStore(db.handle.db, mailstore);
    fake = createFakeProvider(fixture, { threads: true });
    workspaceId = (await mailstore.createWorkspace(account)).id;
    await credentials.store(workspaceId, account.id, fakeCredentials());
    jobs = createJobs(db.handle.db, { now: () => clock });
    engine = createSyncEngine({
      db: db.handle.db,
      mailstore,
      providers: createProviderRegistry({ overrides: { imap: fake } }),
      credentials,
      // Every body within the window, so the fixture's older Threads are readable too.
      settings: async () => ({ ...defaultSyncSettings(), bodyWindowDays: 365 }),
      now: () => clock,
    });
    chat = createFakeChat((call) => {
      if (call.prompt.includes("Subject: Take-home review")) {
        return call.prompt.includes("moved the deadline") ? answers.recomputed : answers.reply;
      }
      if (call.prompt.includes("Subject: The Weekly")) return answers.newsletter;
      return answers.reply;
    });
    intelligence = createIntelligence({
      // Slice 13 ran before the AI level existed; it assumes the full level (slice 20).
      level: async () => "automate",
      db: db.handle.db,
      mailstore,
      chat: chat.chat,
      keys: fakeKeys({ anthropic: "sk-ant-fake" }),
      now: () => clock,
    });
    intelligence.registerSteps(jobs);
    const app = createApp({
      db: db.handle.db,
      auth: createAuth({ db: db.handle.db, sidecarToken: TOKEN }),
      mode: "sidecar",
      keys,
      mailstore,
      jobs,
      sync: engine,
      intelligence,
      remoteAddress: () => "127.0.0.1",
    });

    // Two fresh Threads beside the fixture: one that needs a reply, one newsletter.
    const hourAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
    fake.deliver({
      mailbox: "inbox",
      threadKey: "brief-reply",
      from: aoife,
      to: [owner],
      cc: [],
      subject: "Take-home review",
      date: hourAgo(2),
      messageId: "reply-1@briefs.test",
      inReplyTo: null,
      references: [],
      seen: false,
      flagged: false,
      answered: false,
      headers: {},
      text: `Hi ${owner.name},\n\nThe panel scored the take-home 4 of 5. Can you give me a yes or no by Friday so the offer goes out next week? ${words(140, "detail")}\n\nAoife`,
      html: null,
      attachments: [],
    });
    fake.deliver({
      mailbox: "inbox",
      threadKey: "brief-news",
      from: { name: "The Weekly", email: "digest@theweekly.test" },
      to: [owner],
      cc: [],
      subject: "The Weekly: sync engines",
      date: hourAgo(1),
      messageId: "news-1@briefs.test",
      inReplyTo: null,
      references: [],
      seen: false,
      flagged: false,
      answered: false,
      headers: {
        "list-id": "<digest.theweekly.test>",
        "list-unsubscribe": "<https://theweekly.test/unsubscribe>",
        precedence: "bulk",
      },
      text: `Three articles on sync engines this week. ${words(200, "article")}`,
      html: null,
      attachments: [],
    });

    const { transport, content } = transports(app);
    store = await createStore({ workspaceId, driver: bunDriver(), transport, now: () => clock });
    inbox = await createStoreInbox(store, { content });
  }, 120_000);

  afterAll(async () => {
    inbox?.close();
    await store?.close();
    await engine?.close();
    await db?.drop();
  });

  test("opening a needs-reply thread shows a Brief that was computed before open", async () => {
    await syncAll();
    replyThreadId = (await mailstore.findThread(workspaceId, "brief-reply"))?.id ?? "";
    newsletterThreadId = (await mailstore.findThread(workspaceId, "brief-news"))?.id ?? "";
    expect(replyThreadId).not.toBe("");
    expect(newsletterThreadId).not.toBe("");

    // The sync engine queued one brief Job per Thread version through the Jobs table, not inline.
    expect(chat.calls).toHaveLength(0);
    const ran = await runJobs();
    const mine = ran.filter(
      (j) => j.id.includes(replyThreadId) || j.id.includes(newsletterThreadId),
    );
    expect(mine.map((j) => j.result)).toEqual(["done", "done"]);
    expect(mine.every((j) => j.id.endsWith(":sync"))).toBe(true);

    // The policy computed the needs-reply Thread and waited on the newsletter.
    expect(chat.calls.map((c) => c.prompt.split("\n")[0])).toContain("Subject: Take-home review");
    expect(chat.calls.map((c) => c.prompt.split("\n")[0])).not.toContain(
      "Subject: The Weekly: sync engines",
    );
    expect(await intelligence.briefs.get(replyThreadId)).toMatchObject({ stale: false });
    expect(await intelligence.briefs.get(newsletterThreadId)).toBeNull();

    // The feed carried the Brief's headers, and the Store warmed its content into the Cache.
    const feed = await mailstore.listChanges(workspaceId, { since: 0, limit: 1000 });
    const briefRows = feed.changes.filter((c) => c.kind === "brief");
    expect(briefRows.map((c) => c.entityId)).toContain(replyThreadId);
    expect(JSON.stringify(briefRows)).not.toContain("Aoife");
    await store.sync();
    const cached = await cachedBrief(replyThreadId);
    expect(cached?.content_stale).toBe(0);
    expect(cached?.bullets).toContain("Aoife");

    // The reader opens: the seam hands out the Cache's Brief and asks the Server for nothing.
    const asksBefore = chat.calls.length;
    const seen: Array<Brief | undefined> = [];
    const stop = inbox.watchMessages(replyThreadId, () => seen.push(inbox.brief(replyThreadId)));
    await new Promise<void>((r) => setTimeout(r, 20));
    expect(inbox.brief(replyThreadId)?.bullets[0]).toEqual([
      { b: "Aoife" },
      " asks for a decision on the take-home by ",
      { b: "Friday" },
      ".",
    ]);
    expect(inbox.brief(replyThreadId)?.actions[0]).toMatchObject({ kind: "reply" });
    await inbox.openThread(replyThreadId);
    expect(await runJobs()).toEqual([]);
    expect(chat.calls.length).toBe(asksBefore);
    stop();
  }, 60_000);

  test("a newsletter shows none until opened, then gets one", async () => {
    expect(await cachedBrief(newsletterThreadId)).toBeUndefined();
    const stop = inbox.watchMessages(newsletterThreadId, () => {});
    await new Promise<void>((r) => setTimeout(r, 20));
    expect(inbox.brief(newsletterThreadId)).toBeUndefined();

    // Opening asks under the policy; on_open computes now, through the Job.
    await inbox.openThread(newsletterThreadId);
    const ran = await runJobs();
    expect(ran).toHaveLength(1);
    expect(ran[0]?.id.endsWith(":open")).toBe(true);
    expect(chat.calls[chat.calls.length - 1]?.prompt).toContain("Subject: The Weekly");
    await store.sync();
    expect(inbox.brief(newsletterThreadId)?.bullets[0]).toEqual([
      "This week's digest: three articles on sync engines.",
    ]);
    expect(inbox.brief(newsletterThreadId)?.stale).toBe(false);

    // Opening again finds it fresh: no second ask, no second Job.
    await inbox.openThread(newsletterThreadId);
    expect(await runJobs()).toEqual([]);
    stop();
  }, 60_000);

  test("a new message marks the Brief stale and a recompute replaces it", async () => {
    clock = new Date(NOW.getTime() + 10 * 60_000);
    fake.deliver({
      mailbox: "inbox",
      threadKey: "brief-reply",
      from: aoife,
      to: [owner],
      cc: [],
      subject: "Re: Take-home review",
      date: clock.toISOString(),
      messageId: "reply-2@briefs.test",
      inReplyTo: "reply-1@briefs.test",
      references: ["reply-1@briefs.test"],
      seen: false,
      flagged: false,
      answered: false,
      headers: {},
      text: `Actually I moved the deadline to Monday after your question. ${words(130, "more")}`,
      html: null,
      attachments: [],
    });
    await syncAll();

    // Before the Job runs: the Server marked the old Brief stale and told the feed.
    expect(await intelligence.briefs.get(replyThreadId)).toMatchObject({ stale: true });
    await store.sync();
    const dimmed = await cachedBrief(replyThreadId);
    expect(dimmed?.stale).toBe(1);
    expect(dimmed?.bullets).toContain("Friday");
    const stop = inbox.watchMessages(replyThreadId, () => {});
    await new Promise<void>((r) => setTimeout(r, 20));
    expect(inbox.brief(replyThreadId)?.stale).toBe(true);

    // The recompute (one Job for the new version) replaces it, fresh.
    const ran = await runJobs();
    expect(ran).toHaveLength(1);
    expect(ran[0]?.id.includes(":2:")).toBe(true);
    const fresh = await intelligence.briefs.get(replyThreadId);
    expect(fresh?.stale).toBe(false);
    expect(fresh?.bullets[0]).toEqual([
      { b: "Aoife" },
      " moved the deadline to ",
      { b: "Monday" },
      " after your question.",
    ]);
    await store.sync();
    const replaced = await cachedBrief(replyThreadId);
    expect(replaced?.stale).toBe(0);
    expect(replaced?.content_stale).toBe(0);
    expect(replaced?.bullets).toContain("Monday");
    expect(replaced?.bullets).not.toContain("Friday");
    expect(inbox.brief(replyThreadId)?.stale).toBe(false);
    stop();
  }, 60_000);
});
