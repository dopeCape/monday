// The Provider interface conformance suite. Runs against the fake in every
// test run and against real servers in the nightly contract tests
// (test/contract/), so the fake and the adapters are held to one contract.
//
// Assumptions about the account: it has an inbox with at least one Message,
// and a Sent mailbox. The suite writes flags on one Message and restores them;
// it sends one message to the account's own address when `send` is allowed.

import { describe, expect, test } from "bun:test";
import { composeMime } from "../../src/providers/mime.ts";
import type {
  Credentials,
  MessageSummary,
  Provider,
  Session,
  SyncEvent,
} from "../../src/providers/types.ts";

export interface ConformanceOptions {
  /** Whether the suite may send one message to the account's own address. */
  send?: boolean;
  /** Milliseconds to wait for a push event after a change; 0 skips the push test. */
  pushWaitMs?: number;
  timeoutMs?: number;
}

export async function collect(events: AsyncIterable<SyncEvent>): Promise<SyncEvent[]> {
  const out: SyncEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

export function addedOf(events: SyncEvent[]): MessageSummary[] {
  return events.flatMap((e) => (e.type === "added" ? [e.message] : []));
}

export function stateOf(events: SyncEvent[]): { state: string; complete: boolean } {
  const last = [...events].reverse().find((e) => e.type === "state");
  if (last?.type !== "state") throw new Error("no state event");
  return { state: last.state, complete: last.complete };
}

/** Runs syncMailbox until complete, returning every event and the final state. */
export async function syncAll(
  session: Session,
  mailboxId: string,
  state: string | null,
  limit?: number,
): Promise<{ events: SyncEvent[]; state: string }> {
  const events: SyncEvent[] = [];
  let token = state;
  for (let i = 0; i < 1000; i++) {
    const page = await collect(
      session.syncMailbox(mailboxId, token, limit !== undefined ? { limit } : {}),
    );
    events.push(...page);
    const s = stateOf(page);
    token = s.state;
    if (s.complete) break;
  }
  if (token === null) throw new Error("no state");
  return { events, state: token };
}

export function providerConformance(
  name: string,
  connect: () => Promise<{ provider: Provider; credentials: Credentials }>,
  options: ConformanceOptions = {},
): void {
  const timeout = options.timeoutMs ?? 60_000;

  describe(`Provider conformance: ${name}`, () => {
    let session: Session;
    let inboxId = "";
    let sentId: string | null = null;
    let first: MessageSummary | null = null;
    let inboxState = "";

    test(
      "connect and report capabilities",
      async () => {
        const { provider, credentials } = await connect();
        session = await provider.connect(credentials);
        const caps = session.capabilities();
        expect(["qresync", "condstore", "full-scan", "state"]).toContain(caps.syncTier);
        expect(typeof caps.push).toBe("boolean");
        expect(typeof caps.threads).toBe("boolean");
        expect(typeof caps.savesSentCopy).toBe("boolean");
      },
      timeout,
    );

    test(
      "list mailboxes with an inbox",
      async () => {
        const mailboxes = await session.listMailboxes();
        const inbox = mailboxes.find((m) => m.role === "inbox");
        expect(inbox).toBeDefined();
        inboxId = inbox?.id ?? "";
        sentId = mailboxes.find((m) => m.role === "sent")?.id ?? null;
        for (const m of mailboxes) {
          expect(m.id.length).toBeGreaterThan(0);
          expect(m.name.length).toBeGreaterThan(0);
        }
      },
      timeout,
    );

    test(
      "first sync yields added events newest first and a complete state",
      async () => {
        const { events, state } = await syncAll(session, inboxId, null, 5);
        const added = addedOf(events);
        expect(added.length).toBeGreaterThan(0);
        for (let i = 1; i < added.length; i++) {
          const prev = added[i - 1];
          const cur = added[i];
          if (!prev || !cur) continue;
          // Pages arrive newest first; within the whole run order is non-increasing.
          expect(Date.parse(prev.receivedAt) >= Date.parse(cur.receivedAt) - 1000).toBe(true);
        }
        for (const m of added) {
          expect(m.mailboxIds).toContain(inboxId);
          expect(typeof m.subject).toBe("string");
          expect(Number.isNaN(Date.parse(m.date))).toBe(false);
          expect(m.flags).toHaveProperty("seen");
          if (session.capabilities().threads) expect(m.threadId).not.toBeNull();
        }
        // Ids are unique.
        expect(new Set(added.map((m) => m.id)).size).toBe(added.length);
        first = added[0] ?? null;
        inboxState = state;
      },
      timeout,
    );

    test(
      "a second sync with the state yields nothing new",
      async () => {
        const events = await collect(session.syncMailbox(inboxId, inboxState));
        expect(addedOf(events)).toHaveLength(0);
        expect(events.filter((e) => e.type === "removed")).toHaveLength(0);
        const s = stateOf(events);
        expect(s.complete).toBe(true);
        inboxState = s.state;
      },
      timeout,
    );

    test(
      "fetchMessage returns headers, a body and attachment streams",
      async () => {
        if (!first) throw new Error("no message");
        const raw = await session.fetchMessage(first.id);
        expect(raw.id).toBe(first.id);
        expect(typeof raw.text).toBe("string");
        expect(Object.keys(raw.headers).every((h) => h === h.toLowerCase())).toBe(true);
        for (const a of raw.attachments) {
          let size = 0;
          for await (const chunk of a.content()) size += chunk.byteLength;
          expect(size).toBe(a.size);
        }
      },
      timeout,
    );

    test(
      "read and star round trip through applyChange and the next sync",
      async () => {
        if (!first) throw new Error("no message");
        const target = { messageIds: [first.id] };
        const wasSeen = first.flags.seen;
        const wasFlagged = first.flags.flagged;
        await session.applyChange(target, { kind: "read", value: !wasSeen });
        await session.applyChange(target, { kind: "star", value: !wasFlagged });
        const events = await collect(session.syncMailbox(inboxId, inboxState));
        const changed = events.find(
          (e) =>
            (e.type === "changed" || e.type === "added") &&
            (e.type === "changed" ? e.id : e.message.id) === first?.id,
        );
        expect(changed).toBeDefined();
        const flags =
          changed?.type === "changed"
            ? changed.flags
            : changed?.type === "added"
              ? changed.message.flags
              : null;
        expect(flags?.seen).toBe(!wasSeen);
        expect(flags?.flagged).toBe(!wasFlagged);
        inboxState = stateOf(events).state;
        // Restore.
        await session.applyChange(target, { kind: "read", value: wasSeen });
        await session.applyChange(target, { kind: "star", value: wasFlagged });
        inboxState = stateOf(await collect(session.syncMailbox(inboxId, inboxState))).state;
      },
      timeout,
    );

    test(
      "watch reports whether push is supported",
      async () => {
        const watch = session.watch([inboxId]);
        expect(typeof watch.supported).toBe("boolean");
        expect(watch.supported).toBe(session.capabilities().push);
        if (watch.supported && (options.pushWaitMs ?? 0) > 0 && first) {
          const seen: string[] = [];
          const reader = (async () => {
            for await (const e of watch.events) {
              seen.push(e.type);
              if (e.type === "changed") break;
            }
          })();
          await new Promise((r) => setTimeout(r, 500));
          await session.applyChange({ messageIds: [first.id] }, { kind: "star", value: true });
          await Promise.race([reader, new Promise((r) => setTimeout(r, options.pushWaitMs))]);
          await session.applyChange(
            { messageIds: [first.id] },
            { kind: "star", value: first.flags.flagged },
          );
          expect(seen).toContain("changed");
        }
        await watch.stop();
      },
      timeout,
    );

    test(
      "send delivers to Sent when allowed",
      async () => {
        if (!options.send) return;
        if (!sentId) throw new Error("no Sent mailbox");
        const before = await syncAll(session, sentId, null);
        const { credentials } = await connect();
        const mime = await composeMime({
          from: { name: "monday conformance", email: credentials.address },
          to: [{ name: "", email: credentials.address }],
          subject: `monday conformance ${new Date().toISOString()}`,
          text: "Sent by the Provider conformance suite.",
        });
        const result = await session.send(mime);
        expect(result).toHaveProperty("messageId");
        const after = await collect(session.syncMailbox(sentId, before.state));
        expect(addedOf(after).length).toBeGreaterThan(0);
      },
      timeout,
    );

    test(
      "close",
      async () => {
        await session.close();
      },
      timeout,
    );
  });
}
