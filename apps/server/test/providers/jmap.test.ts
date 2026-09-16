import { describe, expect, test } from "bun:test";
import { generateFixture } from "../../src/providers/fake/fixture.ts";
import { expandTemplate } from "../../src/providers/jmap/client.ts";
import {
  DEFAULT_BACKOFF,
  eventSourcePump,
  nextBackoff,
  parseStateChange,
  SseParser,
} from "../../src/providers/jmap/eventsource.ts";
import { createJmapProvider, flagsOfKeywords } from "../../src/providers/jmap/index.ts";
import { composeMime } from "../../src/providers/mime.ts";
import type { Credentials, WatchEvent } from "../../src/providers/types.ts";
import { addedOf, collect, providerConformance, stateOf, syncAll } from "./conformance.ts";
import { createJmapServer } from "./jmap-server.ts";

const fixture = generateFixture();

function credentialsFor(sessionUrl: string, token = "secret-token"): Credentials {
  return {
    address: fixture.address,
    auth: { kind: "token", token },
    endpoint: { kind: "jmap", sessionUrl },
  };
}

providerConformance(
  "jmap over the in-memory server",
  async () => {
    const server = createJmapServer(fixture);
    return {
      provider: createJmapProvider({ fetch: server.fetch, sleep: async () => {} }),
      credentials: credentialsFor(server.sessionUrl),
    };
  },
  { send: true, pushWaitMs: 0 },
);

describe("JMAP adapter", () => {
  test("session discovery reads limits and rejects bad tokens", async () => {
    const server = createJmapServer(fixture);
    const provider = createJmapProvider({ fetch: server.fetch });
    await expect(provider.connect(credentialsFor(server.sessionUrl, "nope"))).rejects.toMatchObject(
      { code: "auth" },
    );
    const session = await provider.connect(credentialsFor(server.sessionUrl));
    const caps = session.capabilities();
    expect(caps.syncTier).toBe("state");
    expect(caps.threads).toBe(true);
    expect(caps.push).toBe(true);
    expect(caps.savesSentCopy).toBe(true);
    expect(caps.maxSendBytes).toBe(50_000_000);
    expect(
      expandTemplate("https://x/{accountId}/{blobId}?t={type}", {
        accountId: "a 1",
        blobId: "b",
        type: "text/plain",
      }),
    ).toBe("https://x/a%201/b?t=text%2Fplain");
  });

  test("first pass pages with Email/query plus Email/get in one request, then queryChanges and changes", async () => {
    const server = createJmapServer(fixture);
    const session = await createJmapProvider({ fetch: server.fetch }).connect(
      credentialsFor(server.sessionUrl),
    );
    const inbox = server.mailboxId("inbox");
    server.requests.length = 0;
    const first = await collect(session.syncMailbox(inbox, null, { limit: 5 }));
    expect(addedOf(first)).toHaveLength(5);
    expect(stateOf(first).complete).toBe(false);
    expect(server.requests.at(-1)?.calls).toEqual(["Email/query", "Email/get"]);
    const rest = await syncAll(session, inbox, stateOf(first).state, 5);
    const inInbox = [...server.emails.values()].filter((e) => e.mailboxIds[inbox]).length;
    expect(addedOf(rest.events).length + 5).toBe(inInbox);
    const summary = addedOf(first)[0];
    expect(summary?.threadId).toMatch(/^t\d\d$/);
    expect(summary?.messageId).toContain("@fixture.monday.test");

    // Incremental: a flag, a move out, a move in, a delivery, a destroy.
    const ids = addedOf([...first, ...rest.events]).map((m) => m.id);
    const [flagged, movedOut, gone] = ids;
    if (!flagged || !movedOut || !gone) throw new Error("fixture too small");
    const archived = [...server.emails.values()].find(
      (e) => e.mailboxIds[server.mailboxId("archive")],
    );
    if (!archived) throw new Error("no archived");
    server.setKeywords(flagged, { $flagged: true });
    server.move(movedOut, server.mailboxId("archive"));
    server.move(archived.id, inbox);
    server.destroy(gone);
    server.requests.length = 0;
    const events = await collect(session.syncMailbox(inbox, rest.state));
    expect(server.requests.flatMap((r) => r.calls)).toContain("Email/queryChanges");
    expect(server.requests.flatMap((r) => r.calls)).toContain("Email/changes");
    const flaggedEvent = events.find((e) => e.type === "changed" && e.id === flagged);
    expect(flaggedEvent?.type === "changed" && flaggedEvent.flags.flagged).toBe(true);
    const movedEvent = events.find((e) => e.type === "changed" && e.id === movedOut);
    expect(movedEvent?.type === "changed" && movedEvent.mailboxIds).toEqual([
      server.mailboxId("archive"),
    ]);
    expect(events.find((e) => e.type === "added" && e.message.id === archived.id)).toBeDefined();
    expect(events.find((e) => e.type === "removed" && e.id === gone)).toBeDefined();
    expect(stateOf(events).complete).toBe(true);

    // Steady state: nothing.
    const quiet = await collect(session.syncMailbox(inbox, stateOf(events).state));
    expect(quiet.filter((e) => e.type !== "state")).toHaveLength(0);
  });

  test("cannotCalculateChanges triggers a reset and a full refetch", async () => {
    const server = createJmapServer(fixture);
    const session = await createJmapProvider({ fetch: server.fetch }).connect(
      credentialsFor(server.sessionUrl),
    );
    const inbox = server.mailboxId("inbox");
    const first = await syncAll(session, inbox, null);
    server.setKeywords(addedOf(first.events)[0]?.id ?? "", { $seen: true });
    server.forgetHistory();
    server.requests.length = 0;
    const events = await collect(session.syncMailbox(inbox, first.state));
    expect(events[0]?.type).toBe("reset");
    expect(addedOf(events)).toHaveLength(addedOf(first.events).length);
    expect(stateOf(events).complete).toBe(true);
    // Continues normally from the new state.
    const quiet = await collect(session.syncMailbox(inbox, stateOf(events).state));
    expect(quiet.filter((e) => e.type !== "state")).toHaveLength(0);
  });

  test("actions map to keywords and mailbox patches per inbox.md", async () => {
    const server = createJmapServer(fixture);
    const session = await createJmapProvider({ fetch: server.fetch }).connect(
      credentialsFor(server.sessionUrl),
    );
    const inbox = server.mailboxId("inbox");
    const target = [...server.emails.values()].find(
      (e) => e.mailboxIds[inbox] && !e.keywords.$seen,
    );
    if (!target) throw new Error("no unread");
    const ids = { messageIds: [target.id] };
    await session.applyChange(ids, { kind: "read", value: true });
    expect(server.emails.get(target.id)?.keywords.$seen).toBe(true);
    await session.applyChange(ids, { kind: "star", value: true });
    expect(server.emails.get(target.id)?.keywords.$flagged).toBe(true);
    await session.applyChange(ids, { kind: "star", value: false });
    expect(server.emails.get(target.id)?.keywords.$flagged).toBeUndefined();
    await session.applyChange(ids, { kind: "label", add: ["mb-trash"], remove: [] });
    expect(Object.keys(server.emails.get(target.id)?.mailboxIds ?? {}).sort()).toEqual([
      "mb-inbox",
      "mb-trash",
    ]);
    await session.applyChange(ids, { kind: "label", add: [], remove: ["mb-trash"] });
    await session.applyChange(ids, { kind: "archive" });
    expect(server.emails.get(target.id)?.mailboxIds).toEqual({
      [server.mailboxId("archive")]: true,
    });
    await session.applyChange(ids, { kind: "move", mailboxId: inbox });
    expect(server.emails.get(target.id)?.mailboxIds).toEqual({ [inbox]: true });
    await session.applyChange(ids, { kind: "delete" });
    expect(server.emails.get(target.id)?.mailboxIds).toEqual({ [server.mailboxId("trash")]: true });
    // Whole Thread through the Provider's Thread id.
    await session.applyChange({ threadId: target.threadId }, { kind: "read", value: false });
    for (const e of server.emails.values())
      if (e.threadId === target.threadId) expect(e.keywords.$seen).toBeUndefined();
  });

  test("send uploads, imports into Drafts and submits with onSuccessUpdateEmail moving it to Sent", async () => {
    const server = createJmapServer(fixture);
    const session = await createJmapProvider({ fetch: server.fetch }).connect(
      credentialsFor(server.sessionUrl),
    );
    const mime = await composeMime({
      from: fixture.owner,
      to: [{ name: "A", email: "a@example.test" }],
      subject: "Sent through JMAP",
      text: "hello",
    });
    server.requests.length = 0;
    const result = await session.send(mime);
    expect(result.messageId).toMatch(/^imp-/);
    const api = server.requests.filter((r) => r.url.endsWith("/api")).flatMap((r) => r.calls);
    expect(api.filter((c) => c !== "Mailbox/get")).toEqual([
      "Identity/get",
      "Email/import",
      "EmailSubmission/set",
    ]);
    expect(server.submissions).toEqual([{ emailId: result.messageId ?? "", identityId: "id1" }]);
    const sent = server.emails.get(result.messageId ?? "");
    expect(sent?.mailboxIds).toEqual({ [server.mailboxId("sent")]: true });
    expect(sent?.keywords.$draft).toBeUndefined();
    expect(sent?.keywords.$seen).toBe(true);
    expect(sent?.subject).toBe("Sent through JMAP");
  });

  test("fetchMessage returns bodies and streams attachments from the download URL", async () => {
    const server = createJmapServer(fixture);
    const session = await createJmapProvider({ fetch: server.fetch }).connect(
      credentialsFor(server.sessionUrl),
    );
    const withAttachments = fixture.messages.find((m) => m.attachments.length === 2);
    if (!withAttachments) throw new Error("no attachments");
    const raw = await session.fetchMessage(withAttachments.id);
    expect(raw.text).toBe(withAttachments.text);
    expect(raw.html).toBe(withAttachments.html);
    expect(raw.headers["message-id"]).toBe(`<${withAttachments.messageId}>`);
    expect(raw.attachments.map((a) => a.name)).toEqual(
      withAttachments.attachments.map((a) => a.name),
    );
    const chunks: Uint8Array[] = [];
    for await (const chunk of raw.attachments[0]?.content() ?? []) chunks.push(chunk);
    expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe(
      withAttachments.attachments[0]?.text ?? "",
    );
    await expect(session.fetchMessage("missing")).rejects.toMatchObject({ code: "not-found" });
  });

  test("watch: StateChange events arrive as changed, both @type and type spellings, reconnect after a drop", async () => {
    const server = createJmapServer(fixture);
    const session = await createJmapProvider({
      fetch: server.fetch,
      sleep: async () => {},
      pushIdleMs: 10_000,
    }).connect(credentialsFor(server.sessionUrl));
    const watch = session.watch([]);
    expect(watch.supported).toBe(true);
    const seen: WatchEvent[] = [];
    const reader = (async () => {
      for await (const e of watch.events) {
        seen.push(e);
        if (
          seen.filter((s) => s.type === "changed").length >= 2 &&
          seen.filter((s) => s.type === "connected").length >= 2
        )
          break;
      }
    })();
    await new Promise((r) => setTimeout(r, 20));
    expect(server.streams).toBe(1);
    expect(server.requests.at(-1)?.url).toContain("types=Email%2CEmailDelivery%2CMailbox%2CThread");
    server.push();
    await new Promise((r) => setTimeout(r, 20));
    server.dropStreams();
    await new Promise((r) => setTimeout(r, 50));
    server.useLegacyTypeField = true;
    server.push();
    await Promise.race([reader, new Promise((r) => setTimeout(r, 2_000))]);
    expect(seen.filter((s) => s.type === "connected").length).toBeGreaterThanOrEqual(2);
    expect(seen.filter((s) => s.type === "disconnected").length).toBeGreaterThanOrEqual(1);
    expect(seen.filter((s) => s.type === "changed")).toHaveLength(2);
    await watch.stop();
    await session.close();
  });
});

describe("EventSource framing", () => {
  test("parser handles split chunks, comments, CRLF and multi-line data", () => {
    const parser = new SseParser();
    const a = parser.push('event: state\r\ndata: {"a":');
    expect(a).toEqual([]);
    const b = parser.push("1}\r\n\r\n: comment\n\nevent: ping\ndata: x\ndata: y\n\n");
    expect(b).toEqual([
      { event: "state", data: '{"a":1}', id: null },
      { event: "ping", data: "x\ny", id: null },
    ]);
  });

  test("StateChange accepts both spellings and rejects other types", () => {
    expect(parseStateChange('{"@type":"StateChange","changed":{"a":{"Email":"1"}}}')).toEqual({
      changed: { a: { Email: "1" } },
    });
    expect(parseStateChange('{"type":"StateChange","changed":{"a":{"Email":"1"}}}')).toEqual({
      changed: { a: { Email: "1" } },
    });
    expect(parseStateChange('{"@type":"Other","changed":{}}')).toBeNull();
    expect(parseStateChange("garbage")).toBeNull();
  });

  test("backoff doubles to the cap and resets after a good connection", async () => {
    expect(nextBackoff(0)).toBe(DEFAULT_BACKOFF.initialMs);
    expect(nextBackoff(1_000)).toBe(2_000);
    expect(nextBackoff(50_000)).toBe(DEFAULT_BACKOFF.maxMs);
    const sleeps: number[] = [];
    let attempts = 0;
    const pump = eventSourcePump({
      open: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("down");
        return {
          chunks: (async function* () {
            yield 'event: state\ndata: {"@type":"StateChange","changed":{"a":{"Email":"2"}}}\n\n';
          })(),
          close() {},
        };
      },
      onChange: () => ({ type: "changed", mailboxIds: [] }),
      idleTimeoutMs: 1_000,
      backoff: { initialMs: 10, maxMs: 40 },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const events: WatchEvent[] = [];
    for await (const e of pump.events) {
      events.push(e);
      if (e.type === "changed") pump.stop();
    }
    expect(sleeps.slice(0, 2)).toEqual([10, 20]);
    expect(events.map((e) => e.type)).toEqual([
      "disconnected",
      "disconnected",
      "connected",
      "changed",
    ]);
  });

  test("flagsOfKeywords separates the fixed keywords from custom ones", () => {
    expect(flagsOfKeywords({ $seen: true, $flagged: true, work: true, $draft: false })).toEqual({
      seen: true,
      flagged: true,
      answered: false,
      draft: false,
      keywords: ["work"],
    });
  });
});
