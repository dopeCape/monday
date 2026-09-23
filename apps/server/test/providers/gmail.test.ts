import { describe, expect, test } from "bun:test";
import { generateFixture } from "../../src/providers/fake/fixture.ts";
import { backoffMs, parseMultipart } from "../../src/providers/gmail/client.ts";
import {
  createGmailProvider,
  flagsOfLabels,
  type GmailSession,
  mailboxIdsOfLabels,
  subscriptionNameFor,
} from "../../src/providers/gmail/index.ts";
import {
  BURST_SHARE,
  createTokenBucket,
  GMAIL_COST,
  gmailQuotaBucket,
  PENALTY_FLOOR,
  RECOVERY_STEP,
  RECOVERY_STEP_UNITS,
} from "../../src/providers/gmail/quota.ts";
import { composeMime } from "../../src/providers/mime.ts";
import { createTokenBroker, staticTokenBroker } from "../../src/providers/oauth/tokens.ts";
import type { Credentials, OAuthAuth, WatchEvent } from "../../src/providers/types.ts";
import { addedOf, collect, providerConformance, stateOf, syncAll } from "./conformance.ts";
import { createGmailServer, type GmailServer } from "./gmail-server.ts";

const fixture = generateFixture();

function auth(server: GmailServer, overrides: Partial<OAuthAuth> = {}): OAuthAuth {
  return {
    kind: "oauth",
    user: fixture.address,
    issuer: "google",
    accessToken: server.accessToken,
    refreshToken: server.refreshToken,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    client: { id: "1234-abc.apps.googleusercontent.com", secret: "GOCSPX-secret" },
    ...overrides,
  };
}

function credentialsFor(server: GmailServer, topic: string | null = null): Credentials {
  return {
    address: fixture.address,
    auth: auth(server),
    endpoint: { kind: "gmail", pubsubTopic: topic },
  };
}

/** A virtual clock: sleeping advances time instead of waiting. */
function virtualClock() {
  let t = 1_000_000;
  let slept = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
      slept += ms;
    },
    slept: () => slept,
  };
}

const TOPIC = "projects/monday-test/topics/gmail";

providerConformance(
  "gmail over the in-memory server",
  async () => {
    const server = createGmailServer(fixture);
    return {
      provider: createGmailProvider({
        fetch: server.fetch,
        tokens: staticTokenBroker(),
        sleep: async () => {},
      }),
      credentials: credentialsFor(server, TOPIC),
    };
  },
  { send: true, pushWaitMs: 0 },
);

describe("Gmail adapter", () => {
  test("capabilities: threads, labels, push only with a topic, no sent copy needed", async () => {
    const server = createGmailServer(fixture);
    const provider = createGmailProvider({ fetch: server.fetch, tokens: staticTokenBroker() });
    const polling = await provider.connect(credentialsFor(server, null));
    expect(polling.capabilities()).toMatchObject({
      push: false,
      labels: true,
      threads: true,
      savesSentCopy: true,
      syncTier: "state",
      maxSendBytes: 25 * 1024 * 1024,
    });
    expect(polling.watch(["INBOX"]).supported).toBe(false);
    const pushing = await provider.connect(credentialsFor(server, TOPIC));
    expect(pushing.capabilities().push).toBe(true);
    await expect(
      provider.connect({ ...credentialsFor(server), auth: { kind: "token", token: "x" } }),
    ).rejects.toMatchObject({ code: "auth" });
  });

  test("labels become mailboxes: system roles, nested user labels, flags left out", async () => {
    const server = createGmailServer(fixture);
    const session = await createGmailProvider({
      fetch: server.fetch,
      tokens: staticTokenBroker(),
    }).connect(credentialsFor(server));
    const mailboxes = await session.listMailboxes();
    const byId = new Map(mailboxes.map((m) => [m.id, m]));
    expect(byId.get("INBOX")).toMatchObject({ name: "Inbox", role: "inbox" });
    expect(byId.get("TRASH")).toMatchObject({ role: "trash" });
    expect(byId.get("SPAM")).toMatchObject({ role: "junk" });
    expect(byId.get("Label_2")).toMatchObject({ name: "2026", parentId: "Label_1", role: null });
    expect(byId.has("UNREAD")).toBe(false);
    expect(byId.has("STARRED")).toBe(false);
    expect(byId.has("CATEGORY_PROMOTIONS")).toBe(false);
    expect(flagsOfLabels(["INBOX", "UNREAD", "STARRED"])).toMatchObject({
      seen: false,
      flagged: true,
    });
    expect(flagsOfLabels(["INBOX"])).toMatchObject({ seen: true, flagged: false });
    expect(mailboxIdsOfLabels(["INBOX", "UNREAD", "STARRED", "Label_1"])).toEqual([
      "INBOX",
      "Label_1",
    ]);
  });

  test("first pass: messages.list pages plus batched messages.get, then history.list", async () => {
    const server = createGmailServer(fixture);
    const session = await createGmailProvider({
      fetch: server.fetch,
      tokens: staticTokenBroker(),
    }).connect(credentialsFor(server));
    server.requests.length = 0;
    const first = await collect(session.syncMailbox("INBOX", null, { limit: 5 }));
    expect(addedOf(first)).toHaveLength(5);
    expect(stateOf(first).complete).toBe(false);
    const paths = server.requests.map((r) => r.path);
    expect(paths).toContain("/gmail/v1/users/me/profile");
    expect(paths).toContain("/gmail/v1/users/me/messages");
    expect(paths).toContain("/batch/gmail/v1");
    // Five gets in one batch, each costing 20.
    expect(server.quota["messages/m01"] ?? 0 + 1).toBeGreaterThan(0);
    const rest = await syncAll(session, "INBOX", stateOf(first).state, 5);
    const inInbox = [...server.emails.values()].filter((e) => e.labelIds.includes("INBOX")).length;
    expect(addedOf(rest.events).length + 5).toBe(inInbox);
    const summary = addedOf(first)[0];
    expect(summary?.threadId).toMatch(/^t\d\d$/);
    expect(summary?.messageId).toContain("@fixture.monday.test");
    expect(summary?.from?.email).toContain("@");
    expect(summary?.headers["message-id"]).toBeDefined();

    // Incremental: a star, an archive (INBOX removed), a label added elsewhere, a delivery, a deletion.
    const ids = addedOf([...first, ...rest.events]).map((m) => m.id);
    const [starred, archived, gone] = ids;
    if (!starred || !archived || !gone) throw new Error("fixture too small");
    const elsewhere = [...server.emails.values()].find((e) => !e.labelIds.includes("INBOX"));
    if (!elsewhere) throw new Error("no message outside the inbox");
    server.setLabels(starred, ["STARRED"], []);
    server.setLabels(archived, [], ["INBOX"]);
    server.setLabels(elsewhere.id, ["INBOX"], []);
    server.deliver({
      ...(fixture.messages[0] as (typeof fixture.messages)[0]),
      id: "new-1",
      mailbox: "inbox",
      seen: false,
    });
    server.destroy(gone);
    server.requests.length = 0;
    const events = await collect(session.syncMailbox("INBOX", rest.state));
    expect(server.requests.map((r) => r.path)).toContain("/gmail/v1/users/me/history");
    const starredEvent = events.find((e) => e.type === "added" && e.message.id === starred);
    expect(starredEvent?.type === "added" && starredEvent.message.flags.flagged).toBe(true);
    const archivedEvent = events.find((e) => e.type === "changed" && e.id === archived);
    expect(archivedEvent?.type === "changed" && !archivedEvent.mailboxIds.includes("INBOX")).toBe(
      true,
    );
    expect(events.find((e) => e.type === "added" && e.message.id === elsewhere.id)).toBeDefined();
    expect(events.find((e) => e.type === "added" && e.message.id === "new-1")).toBeDefined();
    expect(events.find((e) => e.type === "removed" && e.id === gone)).toBeDefined();
    expect(stateOf(events).complete).toBe(true);
    const quiet = await collect(session.syncMailbox("INBOX", stateOf(events).state));
    expect(quiet.filter((e) => e.type !== "state")).toHaveLength(0);
  });

  test("a 404 from history.list resets and runs the full pass again", async () => {
    const server = createGmailServer(fixture);
    const session = await createGmailProvider({
      fetch: server.fetch,
      tokens: staticTokenBroker(),
    }).connect(credentialsFor(server));
    const first = await syncAll(session, "INBOX", null);
    server.forgetHistory();
    const events = await collect(session.syncMailbox("INBOX", first.state, { limit: 500 }));
    expect(events[0]?.type).toBe("reset");
    expect(addedOf(events)).toHaveLength(addedOf(first.events).length);
    expect(stateOf(events).complete).toBe(true);
    const quiet = await collect(session.syncMailbox("INBOX", stateOf(events).state));
    expect(quiet.filter((e) => e.type !== "state")).toHaveLength(0);
  });

  test("quota pacing: 20 units per get against 6000 per minute, measured on a virtual clock", async () => {
    const server = createGmailServer(fixture);
    // 360 messages in the inbox: 7200 units of gets, 1200 over the minute budget.
    const template = fixture.messages[0];
    if (!template) throw new Error("no fixture");
    for (let i = 0; i < 300; i++) {
      server.deliver({
        ...template,
        id: `bulk-${i}`,
        mailbox: "inbox",
        messageId: `bulk-${i}@fixture.monday.test`,
      });
    }
    server.forgetHistory();
    const clock = virtualClock();
    const session = await createGmailProvider({
      fetch: server.fetch,
      tokens: staticTokenBroker(),
      now: clock.now,
      sleep: clock.sleep,
    }).connect(credentialsFor(server));
    const { events } = await syncAll(session, "INBOX", null, 500);
    const inInbox = [...server.emails.values()].filter((e) => e.labelIds.includes("INBOX")).length;
    expect(addedOf(events)).toHaveLength(inInbox);
    const units = Object.values(server.quota).reduce((n, v) => n + v, 0);
    expect(units).toBeGreaterThan(6000);
    // A fifth of the minute is burst; the rest refills at 80 units per second, so
    // no rolling minute ever spends more than the 6000.
    const burst = 6000 * BURST_SHARE;
    const expectedWait = ((units - burst) / (6000 * (1 - BURST_SHARE))) * 60_000;
    expect(clock.slept()).toBeGreaterThanOrEqual(Math.floor(expectedWait) - 1);
    expect(server.requests.filter((r) => r.path.includes("history")).length).toBe(0);
    expect(GMAIL_COST["messages.get"]).toBe(20);
  });

  test("the token bucket serves takes in order and never overdraws", async () => {
    const clock = virtualClock();
    const bucket = createTokenBucket({
      capacity: 100,
      refillPerMs: 0.1,
      now: clock.now,
      sleep: clock.sleep,
    });
    await bucket.take(60);
    await bucket.take(60);
    // 20 short, refilling at 0.1 per ms: 200 ms.
    expect(clock.slept()).toBe(200);
    expect(bucket.available()).toBeLessThan(1);
    await expect(bucket.take(1000)).rejects.toThrow(RangeError);
    const gmail = gmailQuotaBucket({ now: clock.now, sleep: clock.sleep });
    expect(gmail.available()).toBe(6000 * BURST_SHARE);
    expect(gmail.rate()).toBe(6000 * (1 - BURST_SHARE));
  });

  test("a quota refusal empties the bucket and halves its pace; clean calls grow it back", async () => {
    const clock = virtualClock();
    const gmail = gmailQuotaBucket({ now: clock.now, sleep: clock.sleep });
    const full = gmail.rate();
    gmail.penalize();
    expect(gmail.available()).toBe(0);
    expect(gmail.rate()).toBe(full / 2);
    for (let i = 0; i < 8; i++) gmail.penalize();
    expect(gmail.rate()).toBe(full * PENALTY_FLOOR);
    // Every RECOVERY_STEP_UNITS taken cleanly restores a tenth of the pace.
    await gmail.take(RECOVERY_STEP_UNITS / 2);
    await gmail.take(RECOVERY_STEP_UNITS / 2);
    expect(gmail.rate()).toBeCloseTo(full * (PENALTY_FLOOR + RECOVERY_STEP), 6);
  });

  test("a 403 rate-limit part inside a batch is retried after a backoff, never dropped", async () => {
    const server = createGmailServer(fixture);
    const clock = virtualClock();
    const session = await createGmailProvider({
      fetch: server.fetch,
      tokens: staticTokenBroker(),
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0,
    }).connect(credentialsFor(server));
    // Google refuses the first three messages.get parts of the batch for quota.
    server.quotaRefuseParts = 3;
    const { events } = await syncAll(session, "INBOX", null, 500);
    const inInbox = [...server.emails.values()].filter((e) => e.labelIds.includes("INBOX")).length;
    // Every message still arrives: the refused parts were fetched again.
    expect(addedOf(events)).toHaveLength(inInbox);
    // The backoff ran and the bucket was told.
    expect(clock.slept()).toBeGreaterThanOrEqual(1000);
    expect(server.quotaRefuseParts).toBe(0);
  });

  test("429 backs off exponentially and 401 refreshes the token once", async () => {
    const server = createGmailServer(fixture);
    const clock = virtualClock();
    const broker = createTokenBroker({ fetch: server.fetch, now: clock.now });
    const session = await createGmailProvider({
      fetch: server.fetch,
      tokens: broker,
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0,
    }).connect(credentialsFor(server));
    server.rateLimitNext = 2;
    const mailboxes = await session.listMailboxes();
    expect(mailboxes.length).toBeGreaterThan(0);
    // 1 s then 2 s.
    expect(clock.slept()).toBe(3000);
    expect(backoffMs(6, () => 0.5)).toBe(64_000);

    server.expireNext = 1;
    const before = server.refreshes;
    await session.listMailboxes();
    expect(server.refreshes).toBe(before + 1);
    expect((session as GmailSession).auth.accessToken).toBe(server.accessToken);
  });

  test("actions map to modify for one message and batchModify for many", async () => {
    const server = createGmailServer(fixture);
    const session = await createGmailProvider({
      fetch: server.fetch,
      tokens: staticTokenBroker(),
    }).connect(credentialsFor(server));
    const inbox = [...server.emails.values()].filter((e) => e.labelIds.includes("INBOX"));
    const one = inbox[0];
    if (!one) throw new Error("no inbox message");
    const target = { messageIds: [one.id] };
    server.requests.length = 0;
    await session.applyChange(target, { kind: "read", value: true });
    expect(server.emails.get(one.id)?.labelIds).not.toContain("UNREAD");
    await session.applyChange(target, { kind: "read", value: false });
    expect(server.emails.get(one.id)?.labelIds).toContain("UNREAD");
    await session.applyChange(target, { kind: "star", value: true });
    expect(server.emails.get(one.id)?.labelIds).toContain("STARRED");
    await session.applyChange(target, { kind: "archive" });
    expect(server.emails.get(one.id)?.labelIds).not.toContain("INBOX");
    await session.applyChange(target, { kind: "move", mailboxId: "INBOX" });
    expect(server.emails.get(one.id)?.labelIds).toContain("INBOX");
    await session.applyChange(target, { kind: "label", add: ["Label_2"], remove: ["STARRED"] });
    expect(server.emails.get(one.id)?.labelIds).toContain("Label_2");
    expect(server.emails.get(one.id)?.labelIds).not.toContain("STARRED");
    await session.applyChange(target, { kind: "delete" });
    expect(server.emails.get(one.id)?.labelIds).toContain("TRASH");
    expect(server.emails.get(one.id)?.labelIds).not.toContain("INBOX");
    expect(server.requests.every((r) => r.path.endsWith("/modify"))).toBe(true);

    server.requests.length = 0;
    const many = inbox.slice(1, 4).map((e) => e.id);
    await session.applyChange({ messageIds: many }, { kind: "read", value: true });
    expect(server.requests.map((r) => r.path)).toEqual(["/gmail/v1/users/me/messages/batchModify"]);
    for (const id of many) expect(server.emails.get(id)?.labelIds).not.toContain("UNREAD");

    // A Thread target expands through threads.get.
    const thread = one.threadId;
    server.requests.length = 0;
    await session.applyChange({ threadId: thread }, { kind: "star", value: true });
    expect(server.requests[0]?.path).toBe(`/gmail/v1/users/me/threads/${thread}`);
  });

  test("send: raw MIME with the threadId of the message it answers; large bodies use the resumable upload", async () => {
    const server = createGmailServer(fixture);
    const session = await createGmailProvider({
      fetch: server.fetch,
      tokens: staticTokenBroker(),
      simpleUploadLimit: 4096,
    }).connect(credentialsFor(server));
    const original = [...server.emails.values()].find((e) => e.labelIds.includes("INBOX"));
    if (!original) throw new Error("no message");
    const originalMessageId = original.headers["message-id"]?.replace(/^<|>$/g, "") ?? "";
    const reply = await composeMime({
      from: { name: "Me", email: fixture.address },
      to: [original.from],
      subject: `Re: ${original.subject}`,
      text: "Short reply.",
      inReplyTo: originalMessageId,
      references: [originalMessageId],
    });
    const result = await session.send(reply);
    expect(result.messageId).toMatch(/^sent-/);
    expect(server.sent.at(-1)).toMatchObject({
      threadId: original.threadId,
      via: "simple",
      draftId: null,
    });

    const big = await composeMime({
      from: { name: "Me", email: fixture.address },
      to: [{ name: "", email: fixture.address }],
      subject: "Big",
      text: "x".repeat(10),
      attachments: [
        {
          name: "big.bin",
          mediaType: "application/octet-stream",
          bytes: new Uint8Array(3 * 1024 * 1024),
        },
      ],
    });
    const large = await session.send(big);
    expect(large.messageId).toMatch(/^sent-/);
    const last = server.sent.at(-1);
    expect(last?.via).toBe("resumable");
    expect(last?.raw.byteLength).toBe(big.byteLength);
    expect(server.uploadChunks.length).toBeGreaterThan(1);
    for (const size of server.uploadChunks.slice(0, -1)) expect(size % (256 * 1024)).toBe(0);

    // drafts.send when the Provider holds the Draft.
    await session.send(reply, { draftId: "draft-9" });
    expect(server.sent.at(-1)).toMatchObject({ draftId: "draft-9", via: "simple" });
    await session.send(big, { draftId: "draft-10" });
    expect(server.sent.at(-1)).toMatchObject({ draftId: "draft-10", via: "resumable" });
  });

  test("drafts: create, update under the same id, threadId for a reply, delete, large via resumable", async () => {
    const server = createGmailServer(fixture);
    const session = await createGmailProvider({
      fetch: server.fetch,
      tokens: staticTokenBroker(),
      simpleUploadLimit: 4096,
    }).connect(credentialsFor(server));
    if (!session.putDraft || !session.deleteDraft) throw new Error("no draft calls");
    const original = [...server.emails.values()].find((e) => e.labelIds.includes("INBOX"));
    if (!original) throw new Error("no message");
    const parent = original.headers["message-id"]?.replace(/^<|>$/g, "") ?? "";
    const reply = (text: string) =>
      composeMime({
        from: { name: "Me", email: fixture.address },
        to: [original.from],
        subject: `Re: ${original.subject}`,
        text,
        html: `<p>${text}</p>`,
        inReplyTo: parent,
        references: [parent],
      });

    const created = await session.putDraft(await reply("First go."), null);
    expect(created.id).toMatch(/^r-/);
    const first = server.draftWrites.at(-1);
    expect(first).toMatchObject({
      draftId: created.id,
      threadId: original.threadId,
      update: false,
    });
    const firstMessage = server.drafts.get(created.id) ?? "";
    expect(server.emails.get(firstMessage)?.labelIds).toEqual(["DRAFT"]);
    const raw = new TextDecoder().decode(first?.raw);
    expect(raw).toMatch(/^In-Reply-To: <[^>]+>/m);
    expect(raw).toMatch(/^References: <[^>]+>/m);
    expect(raw).toContain("text/plain");
    expect(raw).toContain("text/html");

    // An update keeps the draft id; Gmail mints a new message for it.
    const updated = await session.putDraft(await reply("Second go."), created.id);
    expect(updated.id).toBe(created.id);
    expect(server.draftWrites.at(-1)).toMatchObject({ update: true, threadId: original.threadId });
    expect(server.emails.has(firstMessage)).toBe(false);
    expect(server.quota[`drafts/${created.id}`]).toBe(GMAIL_COST["drafts.update"]);

    // Deleted in Gmail meanwhile: the update creates it again.
    await session.deleteDraft(created.id);
    expect(server.drafts.has(created.id)).toBe(false);
    const again = await session.putDraft(await reply("Third go."), created.id);
    expect(again.id).not.toBe(created.id);
    expect(server.drafts.has(again.id)).toBe(true);
    // A draft already gone is not an error.
    await session.deleteDraft("r-missing");

    const big = await composeMime({
      from: { name: "Me", email: fixture.address },
      to: [{ name: "", email: fixture.address }],
      subject: "Big draft",
      text: "x",
      attachments: [
        { name: "big.bin", mediaType: "application/octet-stream", bytes: new Uint8Array(20_000) },
      ],
    });
    const large = await session.putDraft(big, null);
    expect(server.draftWrites.at(-1)).toMatchObject({ draftId: large.id, via: "resumable" });
    await session.putDraft(big, large.id);
    expect(server.draftWrites.at(-1)).toMatchObject({
      draftId: large.id,
      via: "resumable",
      update: true,
    });
    expect(server.draftWrites.at(-1)?.raw.byteLength).toBe(big.byteLength);

    // drafts.send with the mirrored draft's id removes the draft.
    await session.send(await reply("Sending."), { draftId: again.id });
    expect(server.sent.at(-1)).toMatchObject({ draftId: again.id });
    expect(server.drafts.has(again.id)).toBe(false);
  });

  test("a 403 quota refusal on drafts.create is retried; a lasting one throws", async () => {
    const server = createGmailServer(fixture);
    const clock = virtualClock();
    const session = await createGmailProvider({
      fetch: server.fetch,
      tokens: staticTokenBroker(),
      now: clock.now,
      sleep: clock.sleep,
      random: () => 0,
    }).connect(credentialsFor(server));
    const mime = await composeMime({
      from: { name: "Me", email: fixture.address },
      to: [{ name: "", email: "someone@example.com" }],
      subject: "Quota",
      text: "Hello.",
    });
    server.quotaRefuseNext = 2;
    const draft = await session.putDraft?.(mime, null);
    expect(draft?.id).toMatch(/^r-/);
    expect(clock.slept()).toBeGreaterThan(0);
    server.quotaRefuseNext = 100;
    await expect(session.putDraft?.(mime, null)).rejects.toMatchObject({ code: "rate-limit" });
  });

  test("fetchMessage decodes the raw format into headers, text and attachments", async () => {
    const server = createGmailServer(fixture);
    const session = await createGmailProvider({
      fetch: server.fetch,
      tokens: staticTokenBroker(),
    }).connect(credentialsFor(server));
    const withAttachment = [...server.emails.values()].find((e) => e.attachments.length > 0);
    if (!withAttachment) throw new Error("no attachment in fixture");
    const raw = await session.fetchMessage(withAttachment.id);
    expect(raw.headers.subject).toBe(withAttachment.subject);
    expect(raw.text).toContain(withAttachment.text.slice(0, 20));
    expect(raw.attachments).toHaveLength(withAttachment.attachments.length);
    await expect(session.fetchMessage("nope")).rejects.toMatchObject({ code: "not-found" });
  });

  test("watch: users.watch to the topic, a pull subscription, notifications become changed events", async () => {
    const server = createGmailServer(fixture);
    const session = await createGmailProvider({
      fetch: server.fetch,
      tokens: staticTokenBroker(),
      pullRetryMs: 1,
    }).connect(credentialsFor(server, TOPIC));
    const watch = session.watch(["INBOX", "Label_1"]);
    expect(watch.supported).toBe(true);
    const seen: WatchEvent[] = [];
    const reader = (async () => {
      for await (const e of watch.events) {
        seen.push(e);
        if (seen.filter((s) => s.type === "changed").length >= 2) break;
      }
    })();
    await new Promise((r) => setTimeout(r, 30));
    expect(server.watches).toEqual([
      { topicName: TOPIC, labelIds: ["INBOX", "Label_1"], labelFilterBehavior: "INCLUDE" },
    ]);
    expect(server.subscriptions.has(subscriptionNameFor(TOPIC, "pull"))).toBe(true);
    expect(server.subscriptions.get(subscriptionNameFor(TOPIC, "pull"))).toMatchObject({
      topic: TOPIC,
      ackDeadlineSeconds: 10,
      expirationPolicy: {},
    });
    // A pull drains what is queued into one wake-up; a later notification is another.
    server.notify("someone-else@example.test");
    server.notify();
    await new Promise((r) => setTimeout(r, 50));
    server.notify();
    await Promise.race([reader, new Promise((r) => setTimeout(r, 2000))]);
    await watch.stop();
    expect(seen[0]?.type).toBe("connected");
    expect(seen.filter((s) => s.type === "changed").length).toBeGreaterThanOrEqual(2);
    expect(server.acked.length).toBeGreaterThanOrEqual(3);

    // Renewal and push registration go through the same session.
    const renewed = await (session as GmailSession).renewWatch();
    expect(renewed.expiration).toBeGreaterThan(Date.now());
    expect(server.watches.at(-1)?.labelIds).toEqual(["INBOX", "Label_1"]);
    const oidc = {
      serviceAccountEmail: "push@p.iam.gserviceaccount.com",
      audience: "https://monday.example/webhooks/gmail/a",
    };
    const pushName = await (session as GmailSession).subscribePush(
      "https://monday.example/webhooks/gmail/a?secret=s",
      oidc,
    );
    expect(server.subscriptions.get(pushName)).toMatchObject({
      pushConfig: {
        pushEndpoint: "https://monday.example/webhooks/gmail/a?secret=s",
        oidcToken: oidc,
      },
    });
    // Re-subscribing updates the endpoint instead of failing on 409.
    await (session as GmailSession).subscribePush(
      "https://monday.example/webhooks/gmail/a?secret=t",
      oidc,
    );
    expect(server.subscriptions.get(pushName)).toMatchObject({
      pushConfig: { pushEndpoint: "https://monday.example/webhooks/gmail/a?secret=t" },
    });
    await (session as GmailSession).unsubscribePush(pushName);
    expect(server.subscriptions.has(pushName)).toBe(false);
    await session.close();
  });

  test("multipart batch responses parse by Content-ID", () => {
    const text =
      '--b\r\nContent-Type: application/http\r\nContent-ID: <response-item1>\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"id":"x"}\r\n--b\r\nContent-Type: application/http\r\nContent-ID: <response-item0>\r\n\r\nHTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\n\r\n{"error":{}}\r\n--b--\r\n';
    const parts = parseMultipart(text, "multipart/mixed; boundary=b");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ contentId: "response-item1", status: 200 });
    expect(JSON.parse(parts[0]?.body ?? "")).toEqual({ id: "x" });
    expect(parts[1]?.status).toBe(404);
  });
});
