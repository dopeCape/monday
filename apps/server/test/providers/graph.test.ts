import { describe, expect, test } from "bun:test";
import { generateFixture } from "../../src/providers/fake/fixture.ts";
import { semaphore } from "../../src/providers/graph/client.ts";
import {
  createGraphProvider,
  createSubscription,
  expirationFrom,
  flagsOfMessage,
  type GraphSession,
  parseNotifications,
  renewSubscription,
  SUBSCRIPTION_REQUEST_MINUTES,
} from "../../src/providers/graph/index.ts";
import { composeMime } from "../../src/providers/mime.ts";
import { createTokenBroker, staticTokenBroker } from "../../src/providers/oauth/tokens.ts";
import type { Credentials, OAuthAuth, WatchEvent } from "../../src/providers/types.ts";
import { addedOf, collect, providerConformance, stateOf, syncAll } from "./conformance.ts";
import { createGraphServer, type GraphServer } from "./graph-server.ts";

const fixture = generateFixture();

function auth(server: GraphServer): OAuthAuth {
  return {
    kind: "oauth",
    user: fixture.address,
    issuer: "microsoft",
    accessToken: server.accessToken,
    refreshToken: server.refreshToken,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    client: { id: "12345678-1234-1234-1234-123456789abc", tenant: "consumers" },
  };
}

function credentialsFor(server: GraphServer): Credentials {
  return { address: fixture.address, auth: auth(server), endpoint: { kind: "none" } };
}

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

providerConformance(
  "graph over the in-memory server",
  async () => {
    const server = createGraphServer(fixture);
    return {
      provider: createGraphProvider({
        fetch: server.fetch,
        tokens: staticTokenBroker(),
        pollMs: 10,
      }),
      credentials: credentialsFor(server),
    };
  },
  { send: true, pushWaitMs: 0 },
);

describe("Graph adapter", () => {
  test("capabilities and folder roles from the well-known names", async () => {
    const server = createGraphServer(fixture);
    const provider = createGraphProvider({ fetch: server.fetch, tokens: staticTokenBroker() });
    const session = await provider.connect(credentialsFor(server));
    expect(session.capabilities()).toMatchObject({
      push: true,
      labels: false,
      threads: true,
      savesSentCopy: true,
      syncTier: "state",
      maxSendBytes: 35 * 1024 * 1024,
    });
    const mailboxes = await session.listMailboxes();
    const byId = new Map(mailboxes.map((m) => [m.id, m]));
    expect(byId.get("f-inbox")).toMatchObject({ role: "inbox", name: "Inbox" });
    expect(byId.get("f-sent")).toMatchObject({ role: "sent" });
    expect(byId.get("f-deleted")).toMatchObject({ role: "trash" });
    expect(byId.get("f-junk")).toMatchObject({ role: "junk" });
    expect(byId.get("f-archive")).toMatchObject({ role: "archive" });
    expect(byId.get("f-projects-2026")).toMatchObject({ role: null, parentId: "f-projects" });
    expect(byId.get("f-inbox")?.totalMessages).toBeGreaterThan(0);
    await expect(
      provider.connect({ ...credentialsFor(server), auth: { kind: "token", token: "x" } }),
    ).rejects.toMatchObject({ code: "auth" });
  });

  test("delta paging: nextLink pages with $select once, then a deltaLink; changes replay through it", async () => {
    const server = createGraphServer(fixture);
    const session = await createGraphProvider({
      fetch: server.fetch,
      tokens: staticTokenBroker(),
    }).connect(credentialsFor(server));
    const inbox = server.folderId("inbox");
    server.requests.length = 0;
    const first = await collect(session.syncMailbox(inbox, null, { limit: 5 }));
    expect(addedOf(first)).toHaveLength(5);
    expect(stateOf(first).complete).toBe(false);
    const firstRequest = server.requests.find((r) => r.path.includes("/messages/delta"));
    expect(firstRequest?.url).toContain("%24select=");
    expect(firstRequest?.headers.prefer).toBe("odata.maxpagesize=5");
    expect(JSON.parse(stateOf(first).state)).toMatchObject({ kind: "next" });
    const rest = await syncAll(session, inbox, stateOf(first).state, 5);
    // Later pages carry the token and must not repeat the query options.
    const later = server.requests.filter((r) => r.path.includes("/messages/delta")).slice(1);
    expect(later.every((r) => !r.url.includes("%24select"))).toBe(true);
    const total = [...server.messages.values()].filter((m) => m.parentFolderId === inbox).length;
    expect(addedOf(rest.events).length + 5).toBe(total);
    expect(JSON.parse(rest.state)).toMatchObject({ kind: "delta" });
    const summary = addedOf(first)[0];
    expect(summary?.threadId).toMatch(/^t\d\d$/);
    expect(summary?.mailboxIds).toEqual([inbox]);
    expect(summary?.messageId).toContain("@fixture.monday.test");

    // Incremental: read, move out, move in, deliver, delete.
    const ids = addedOf([...first, ...rest.events]).map((m) => m.id);
    const [read, movedOut, gone] = ids;
    if (!read || !movedOut || !gone) throw new Error("fixture too small");
    const outside = [...server.messages.values()].find(
      (m) => m.parentFolderId !== inbox && !m.isDraft,
    );
    if (!outside) throw new Error("no message outside inbox");
    server.setRead(read, !server.messages.get(read)?.isRead);
    server.move(movedOut, server.folderId("archive"));
    server.move(outside.id, inbox);
    server.deliver({
      ...(fixture.messages[0] as (typeof fixture.messages)[0]),
      id: "new-1",
      mailbox: "inbox",
    });
    server.destroy(gone);
    const events = await collect(session.syncMailbox(inbox, rest.state));
    expect(events.find((e) => e.type === "added" && e.message.id === read)).toBeDefined();
    expect(events.find((e) => e.type === "removed" && e.id === movedOut)).toBeDefined();
    expect(events.find((e) => e.type === "added" && e.message.id === outside.id)).toBeDefined();
    expect(events.find((e) => e.type === "added" && e.message.id === "new-1")).toBeDefined();
    expect(events.find((e) => e.type === "removed" && e.id === gone)).toBeDefined();
    expect(stateOf(events).complete).toBe(true);
    const quiet = await collect(session.syncMailbox(inbox, stateOf(events).state));
    expect(quiet.filter((e) => e.type !== "state")).toHaveLength(0);
  });

  test("410 Gone restarts with a reset and a fresh first pass", async () => {
    const server = createGraphServer(fixture);
    const session = await createGraphProvider({
      fetch: server.fetch,
      tokens: staticTokenBroker(),
    }).connect(credentialsFor(server));
    const inbox = server.folderId("inbox");
    const first = await syncAll(session, inbox, null);
    server.forgetHistory();
    const events = await collect(session.syncMailbox(inbox, first.state, { limit: 500 }));
    expect(events[0]?.type).toBe("reset");
    expect(addedOf(events)).toHaveLength(addedOf(first.events).length);
    expect(stateOf(events).complete).toBe(true);
    const quiet = await collect(session.syncMailbox(inbox, stateOf(events).state));
    expect(quiet.filter((e) => e.type !== "state")).toHaveLength(0);
  });

  test("actions: PATCH isRead and flag, move for archive, delete, move and label", async () => {
    const server = createGraphServer(fixture);
    const session = await createGraphProvider({
      fetch: server.fetch,
      tokens: staticTokenBroker(),
    }).connect(credentialsFor(server));
    const inbox = server.folderId("inbox");
    const one = [...server.messages.values()].find((m) => m.parentFolderId === inbox);
    if (!one) throw new Error("no inbox message");
    const target = { messageIds: [one.id] };
    await session.applyChange(target, { kind: "read", value: false });
    expect(server.messages.get(one.id)?.isRead).toBe(false);
    await session.applyChange(target, { kind: "star", value: true });
    expect(server.messages.get(one.id)?.flagged).toBe(true);
    expect(
      flagsOfMessage({ id: "x", isRead: false, flag: { flagStatus: "flagged" } }),
    ).toMatchObject({
      seen: false,
      flagged: true,
    });
    await session.applyChange(target, { kind: "archive" });
    expect(server.messages.get(one.id)?.parentFolderId).toBe(server.folderId("archive"));
    await session.applyChange(target, { kind: "move", mailboxId: inbox });
    expect(server.messages.get(one.id)?.parentFolderId).toBe(inbox);
    await session.applyChange(target, { kind: "label", add: ["f-projects"], remove: [] });
    expect(server.messages.get(one.id)?.parentFolderId).toBe("f-projects");
    await session.applyChange(target, { kind: "delete" });
    expect(server.messages.get(one.id)?.parentFolderId).toBe(server.folderId("deleteditems"));
    // A Thread target expands through a conversationId filter.
    server.requests.length = 0;
    await session.applyChange({ threadId: one.conversationId }, { kind: "read", value: true });
    expect(decodeURIComponent(server.requests[0]?.url ?? "").replace(/\+/g, " ")).toContain(
      "conversationId eq",
    );
  });

  test("send: base64 MIME through sendMail under 4 MB, draft plus upload session plus /send above", async () => {
    const server = createGraphServer(fixture);
    const session = await createGraphProvider({
      fetch: server.fetch,
      tokens: staticTokenBroker(),
    }).connect(credentialsFor(server));
    const small = await composeMime({
      from: { name: "Me", email: fixture.address },
      to: [{ name: "", email: fixture.address }],
      subject: "Small",
      text: "Hello",
    });
    await session.send(small, { draftId: "draft-old" });
    expect(server.sent.at(-1)?.via).toBe("sendMail");
    expect(server.sent.at(-1)?.raw?.byteLength).toBe(small.byteLength);
    const sendMail = server.requests.find((r) => r.path.endsWith("/me/sendMail"));
    expect(sendMail?.headers["content-type"]).toBe("text/plain");

    const original = [...server.messages.values()].find(
      (m) => m.parentFolderId === server.folderId("inbox"),
    );
    if (!original) throw new Error("no original");
    const big = await composeMime({
      from: { name: "Me", email: fixture.address },
      to: [original.from],
      cc: [{ name: "Copy", email: "copy@example.test" }],
      subject: `Re: ${original.subject}`,
      text: "See attached.",
      html: "<p>See attached.</p>",
      inReplyTo: original.internetMessageId.replace(/^<|>$/g, ""),
      attachments: [
        { name: "small.txt", mediaType: "text/plain", bytes: new TextEncoder().encode("tiny") },
        {
          name: "big.bin",
          mediaType: "application/octet-stream",
          bytes: new Uint8Array(5 * 1024 * 1024),
        },
      ],
    });
    const result = await session.send(big);
    const last = server.sent.at(-1);
    expect(last?.via).toBe("send");
    expect(result.messageId).toBe(last?.draftId ?? null);
    const draft = last?.message;
    expect(draft?.conversationId).toBe(original.conversationId);
    expect(draft?.html).toContain("See attached.");
    expect(draft?.to[0]?.email).toBe(original.from.email);
    expect(draft?.cc[0]?.email).toBe("copy@example.test");
    expect(draft?.attachments.map((a) => a.name).sort()).toEqual(["big.bin", "small.txt"]);
    expect(draft?.attachments.find((a) => a.name === "big.bin")?.bytes.byteLength).toBe(
      5 * 1024 * 1024,
    );
    expect(server.uploadRanges.length).toBeGreaterThan(1);
    for (const size of server.uploadRanges) expect(size).toBeLessThan(4 * 1024 * 1024);
    expect(server.requests.some((r) => r.path.endsWith("/createReply"))).toBe(true);
    await expect(session.send(new Uint8Array(36 * 1024 * 1024))).rejects.toMatchObject({
      code: "too-large",
    });
  });

  test("fetchMessage reads MIME from /$value", async () => {
    const server = createGraphServer(fixture);
    const session = await createGraphProvider({
      fetch: server.fetch,
      tokens: staticTokenBroker(),
    }).connect(credentialsFor(server));
    const withAttachment = [...server.messages.values()].find((m) => m.attachments.length > 0);
    if (!withAttachment) throw new Error("no attachment");
    const raw = await session.fetchMessage(withAttachment.id);
    expect(raw.headers.subject).toBe(withAttachment.subject);
    expect(raw.attachments).toHaveLength(withAttachment.attachments.length);
    await expect(session.fetchMessage("nope")).rejects.toMatchObject({ code: "not-found" });
  });

  test("429 waits Retry-After, 401 refreshes once, and at most four requests run at a time", async () => {
    const server = createGraphServer(fixture);
    const clock = virtualClock();
    const broker = createTokenBroker({ fetch: server.fetch, now: clock.now });
    const session = await createGraphProvider({
      fetch: server.fetch,
      tokens: broker,
      sleep: clock.sleep,
    }).connect(credentialsFor(server));
    server.throttleNext = 1;
    server.retryAfterSeconds = 7;
    await session.listMailboxes();
    expect(clock.slept()).toBe(7000);
    server.expireNext = 1;
    const before = server.refreshes;
    await session.listMailboxes();
    expect(server.refreshes).toBe(before + 1);
    expect((session as GraphSession).auth.accessToken).toBe(server.accessToken);

    const inbox = server.folderId("inbox");
    const ids = [...server.messages.values()]
      .filter((m) => m.parentFolderId === inbox)
      .map((m) => m.id);
    server.maxConcurrent = 0;
    await session.applyChange({ messageIds: ids }, { kind: "read", value: true });
    expect(server.maxConcurrent).toBeLessThanOrEqual(4);
    expect(server.maxConcurrent).toBeGreaterThan(1);
    const gate = semaphore(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        gate(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 2));
          active -= 1;
        }),
      ),
    );
    expect(peak).toBe(2);
  });

  test("watch polls the hot folders on the configured interval", async () => {
    const server = createGraphServer(fixture);
    let interval = 5;
    const session = await createGraphProvider({
      fetch: server.fetch,
      tokens: staticTokenBroker(),
      pollMs: () => interval,
    }).connect(credentialsFor(server));
    const watch = session.watch(["f-inbox", "f-sent"]);
    expect(watch.supported).toBe(true);
    const seen: WatchEvent[] = [];
    for await (const e of watch.events) {
      seen.push(e);
      if (seen.length >= 3) break;
    }
    await watch.stop();
    expect(seen[0]?.type).toBe("connected");
    expect(seen[1]).toEqual({ type: "changed", mailboxIds: ["f-inbox", "f-sent"] });
    interval = 1;
    await session.close();
  });

  test("subscriptions: create with lifecycle URL and clientState, renew before 10080 minutes", async () => {
    const server = createGraphServer(fixture);
    const validated: string[] = [];
    server.validate = async (url) => {
      validated.push(url);
      return url.startsWith("https://monday.example/webhooks/graph");
    };
    const session = (await createGraphProvider({
      fetch: server.fetch,
      tokens: staticTokenBroker(),
    }).connect(credentialsFor(server))) as GraphSession;
    const now = Date.parse("2026-09-16T12:00:00Z");
    const created = await createSubscription(session.client, {
      notificationUrl: "https://monday.example/webhooks/graph",
      lifecycleNotificationUrl: "https://monday.example/webhooks/graph/lifecycle",
      clientState: "secret-state",
      now,
    });
    expect(validated).toEqual([
      "https://monday.example/webhooks/graph",
      "https://monday.example/webhooks/graph/lifecycle",
    ]);
    expect(server.subscriptions.get(created.id)).toMatchObject({
      resource: "/me/messages",
      changeType: "created,updated,deleted",
      clientState: "secret-state",
    });
    expect(SUBSCRIPTION_REQUEST_MINUTES).toBeLessThan(10_080);
    expect(Date.parse(created.expirationDateTime) - now).toBe(
      SUBSCRIPTION_REQUEST_MINUTES * 60_000,
    );
    const renewed = await renewSubscription(session.client, created.id, now + 86_400_000);
    expect(renewed.expirationDateTime).toBe(expirationFrom(now + 86_400_000));
    await expect(
      createSubscription(session.client, {
        notificationUrl: "https://elsewhere.example/hook",
        lifecycleNotificationUrl: "https://elsewhere.example/hook/lifecycle",
        clientState: "x",
        now,
      }),
    ).rejects.toMatchObject({ code: "protocol" });
    expect(
      parseNotifications({
        value: [
          { subscriptionId: "s", clientState: "c", changeType: "created", resource: "r" },
          { nope: 1 },
        ],
      }),
    ).toHaveLength(1);
    expect(parseNotifications("garbage")).toEqual([]);
  });
});
