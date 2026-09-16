// The fake Provider: the seam every later slice tests against. An in-memory
// mailbox loaded from a fixture, a change log that gives it JMAP-like state
// tokens (with cannotCalculateChanges when history is forgotten), a scripted
// push stream, and control methods that play the part of another client:
// deliver, setFlags, move, destroy.

import type { Person } from "@monday/shared";
import { parseMime, rawMessageOf, snippetOf, summaryOf } from "../mime.ts";
import { asyncQueue } from "../queue.ts";
import {
  type Change,
  type ChangeTarget,
  type Credentials,
  EMPTY_FLAGS,
  type Flags,
  type Mailbox,
  type MessageSummary,
  type Provider,
  type ProviderCapabilities,
  ProviderError,
  type RawAttachment,
  type RawMessage,
  type SendOptions,
  type SendResult,
  type Session,
  type SyncEvent,
  type SyncOptions,
  type Watch,
  type WatchEvent,
} from "../types.ts";
import type { Fixture, FixtureAttachment, FixtureMessage } from "./fixture.ts";

export { FIXTURE_MESSAGE_COUNT, type Fixture, generateFixture } from "./fixture.ts";

interface Stored {
  summary: Omit<MessageSummary, "flags" | "mailboxIds">;
  flags: Flags;
  mailboxIds: string[];
  text: string;
  html: string | null;
  attachments: FixtureAttachment[];
  allHeaders: Record<string, string>;
}

interface LogEntry {
  seq: number;
  id: string;
  kind: "created" | "updated" | "destroyed";
  mailboxIds: string[];
}

interface FakeState {
  seq: number;
  position?: number;
}

export interface FakeProviderOptions {
  /** True to hand out Thread ids like JMAP; false to leave threading to the engine like IMAP. */
  threads?: boolean;
  /** False to report no push. */
  push?: boolean;
  pageSize?: number;
}

export interface FakeProvider extends Provider {
  /** Another client delivered a Message. Returns its id. */
  deliver(message: Omit<FixtureMessage, "id"> & { id?: string }): string;
  setFlags(id: string, patch: Partial<Omit<Flags, "keywords">>): void;
  move(id: string, mailboxId: string): void;
  destroy(id: string): void;
  /** Drops the change log so any stored state becomes uncontinuable. */
  forgetHistory(): void;
  /** Pushes one event to every open watch. */
  push(event: WatchEvent): void;
  /** What the mailbox holds now, for assertions. */
  snapshot(): { id: string; mailboxIds: string[]; flags: Flags }[];
  /** How many times each Session method ran, for pacing assertions. */
  calls: Record<string, number>;
}

const encoder = new TextEncoder();

async function* once(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

export function createFakeProvider(
  fixture: Fixture,
  options: FakeProviderOptions = {},
): FakeProvider {
  const threads = options.threads ?? false;
  const page = options.pageSize ?? 200;
  const store = new Map<string, Stored>();
  let log: LogEntry[] = [];
  let seq = 0;
  let counter = 0;
  const watches = new Set<ReturnType<typeof asyncQueue<WatchEvent>>>();
  const calls: Record<string, number> = {};
  const count = (name: string) => {
    calls[name] = (calls[name] ?? 0) + 1;
  };

  const mailboxes: Mailbox[] = fixture.mailboxes.map((m) => ({
    id: m.id,
    name: m.name,
    role: m.role,
    parentId: null,
    totalMessages: null,
    unreadMessages: null,
  }));
  const mailboxOfRole = (role: string) => mailboxes.find((m) => m.role === role)?.id ?? null;
  const roleToId = (role: FixtureMessage["mailbox"]) => {
    const id = mailboxOfRole(role);
    if (!id) throw new RangeError(`fixture has no ${role} mailbox`);
    return id;
  };

  const record = (id: string, kind: LogEntry["kind"], mailboxIds: string[]) => {
    seq += 1;
    log.push({ seq, id, kind, mailboxIds: [...mailboxIds] });
    for (const w of watches) w.push({ type: "changed", mailboxIds: [...mailboxIds] });
  };

  const load = (message: FixtureMessage, mailboxIds: string[]) => {
    const headers: Record<string, string> = {
      ...message.headers,
      "message-id": `<${message.messageId}>`,
      from: `${message.from.name} <${message.from.email}>`,
      to: message.to.map((p) => `${p.name} <${p.email}>`).join(", "),
      subject: message.subject,
      date: new Date(message.date).toUTCString(),
    };
    if (message.inReplyTo) headers["in-reply-to"] = `<${message.inReplyTo}>`;
    if (message.references.length > 0) {
      headers.references = message.references.map((r) => `<${r}>`).join(" ");
    }
    const size =
      encoder.encode(message.text).length +
      message.attachments.reduce((n, a) => n + encoder.encode(a.text).length, 0) +
      512;
    store.set(message.id, {
      summary: {
        id: message.id,
        threadId: threads ? message.threadKey : null,
        from: message.from,
        to: message.to,
        cc: message.cc,
        subject: message.subject,
        date: message.date,
        receivedAt: message.date,
        messageId: message.messageId,
        inReplyTo: message.inReplyTo,
        references: message.references,
        headers: { ...message.headers },
        size,
        hasAttachments: message.attachments.length > 0,
        preview: snippetOf(message.text),
      },
      flags: {
        ...EMPTY_FLAGS,
        seen: message.seen,
        flagged: message.flagged,
        answered: message.answered,
        keywords: [],
      },
      mailboxIds,
      text: message.text,
      html: message.html,
      attachments: message.attachments,
      allHeaders: headers,
    });
  };

  for (const message of fixture.messages) {
    load(message, [roleToId(message.mailbox)]);
    counter += 1;
    record(message.id, "created", [roleToId(message.mailbox)]);
  }

  const summaryOfStored = (s: Stored): MessageSummary => ({
    ...s.summary,
    flags: { ...s.flags, keywords: [...s.flags.keywords] },
    mailboxIds: [...s.mailboxIds],
  });

  const require = (id: string): Stored => {
    const s = store.get(id);
    if (!s) throw new ProviderError(`message ${id} not found`, "not-found");
    return s;
  };

  /** Mailbox membership as of a log position. */
  const mailboxIdsAt = (id: string, at: number): string[] | null => {
    let found: LogEntry | null = null;
    for (const entry of log) {
      if (entry.seq > at) break;
      if (entry.id === id) found = entry;
    }
    if (!found || found.kind === "destroyed") return null;
    return found.mailboxIds;
  };

  const capabilities: ProviderCapabilities = {
    push: options.push ?? true,
    labels: true,
    snooze: false,
    mute: false,
    calendar: false,
    meetingLink: null,
    syncTier: "state",
    threads,
    savesSentCopy: true,
    maxSendBytes: 25 * 1024 * 1024,
  };

  const session: Session = {
    capabilities() {
      count("capabilities");
      return { ...capabilities };
    },

    async listMailboxes() {
      count("listMailboxes");
      return mailboxes.map((m) => ({
        ...m,
        totalMessages: [...store.values()].filter((s) => s.mailboxIds.includes(m.id)).length,
        unreadMessages: [...store.values()].filter(
          (s) => s.mailboxIds.includes(m.id) && !s.flags.seen,
        ).length,
      }));
    },

    async *syncMailbox(mailboxId, state, syncOptions: SyncOptions = {}) {
      count("syncMailbox");
      const limit = syncOptions.limit ?? page;
      let stored: FakeState | null = null;
      try {
        stored = state ? (JSON.parse(state) as FakeState) : null;
      } catch {
        stored = null;
      }
      const oldest = log[0]?.seq ?? seq + 1;
      const inMailbox = () =>
        [...store.values()]
          .filter((s) => s.mailboxIds.includes(mailboxId))
          .sort((a, b) => b.summary.receivedAt.localeCompare(a.summary.receivedAt));

      const full = async function* (resume: FakeState | null): AsyncIterable<SyncEvent> {
        const position = resume?.position ?? 0;
        const all = inMailbox();
        const slice = all.slice(position, position + limit);
        for (const s of slice) yield { type: "added", message: summaryOfStored(s) };
        const more = position + slice.length < all.length;
        const next: FakeState = {
          seq: resume?.seq ?? seq,
          ...(more ? { position: position + slice.length } : {}),
        };
        yield { type: "state", state: JSON.stringify(next), complete: !more };
      };

      if (!stored) {
        yield* full(null);
        return;
      }
      if (stored.position !== undefined) {
        yield* full(stored);
        return;
      }
      if (stored.seq < oldest - 1) {
        // cannotCalculateChanges
        yield { type: "reset" };
        yield* full(null);
        return;
      }
      const touched = new Set<string>();
      for (const entry of log) if (entry.seq > stored.seq) touched.add(entry.id);
      for (const id of touched) {
        const before = mailboxIdsAt(id, stored.seq);
        const wasIn = before?.includes(mailboxId) ?? false;
        const now = store.get(id);
        if (!now) {
          if (wasIn) yield { type: "removed", id };
          continue;
        }
        const nowIn = now.mailboxIds.includes(mailboxId);
        if (!wasIn && nowIn) yield { type: "added", message: summaryOfStored(now) };
        else if (wasIn) {
          yield {
            type: "changed",
            id,
            flags: { ...now.flags, keywords: [...now.flags.keywords] },
            mailboxIds: [...now.mailboxIds],
          };
        }
      }
      yield { type: "state", state: JSON.stringify({ seq } satisfies FakeState), complete: true };
    },

    async fetchMessage(id) {
      count("fetchMessage");
      const s = require(id);
      const attachments: RawAttachment[] = s.attachments.map((a) => {
        const bytes = encoder.encode(a.text);
        return {
          name: a.name,
          mediaType: a.mediaType,
          size: bytes.length,
          contentId: null,
          inline: false,
          content: () => once(bytes),
        };
      });
      const raw: RawMessage = {
        id,
        headers: { ...s.allHeaders },
        text: s.text,
        html: s.html,
        attachments,
      };
      return raw;
    },

    async applyChange(target: ChangeTarget, change: Change) {
      count("applyChange");
      const ids =
        "messageIds" in target
          ? target.messageIds
          : [...store.entries()]
              .filter(([, s]) => s.summary.threadId === target.threadId)
              .map(([id]) => id);
      for (const id of ids) {
        const s = require(id);
        switch (change.kind) {
          case "read":
            s.flags = { ...s.flags, seen: change.value };
            break;
          case "star":
            s.flags = { ...s.flags, flagged: change.value };
            break;
          case "archive": {
            const inbox = mailboxOfRole("inbox");
            const archive = mailboxOfRole("archive");
            const remaining = s.mailboxIds.filter((m) => m !== inbox);
            s.mailboxIds = remaining.length > 0 ? remaining : archive ? [archive] : remaining;
            break;
          }
          case "delete": {
            const trash = mailboxOfRole("trash");
            if (!trash) throw new ProviderError("no Trash mailbox", "unsupported");
            s.mailboxIds = [trash];
            break;
          }
          case "move":
            s.mailboxIds = [change.mailboxId];
            break;
          case "label":
            s.mailboxIds = [
              ...new Set([
                ...s.mailboxIds.filter((m) => !change.remove.includes(m)),
                ...change.add,
              ]),
            ];
            break;
        }
        record(id, "updated", s.mailboxIds);
      }
    },

    async send(mime: Uint8Array, _options: SendOptions = {}): Promise<SendResult> {
      count("send");
      if (mime.byteLength > (capabilities.maxSendBytes ?? Number.POSITIVE_INFINITY)) {
        throw new ProviderError("message too large", "too-large");
      }
      const parsed = await parseMime(mime);
      const sent = mailboxOfRole("sent");
      if (!sent) throw new ProviderError("no Sent mailbox", "unsupported");
      counter += 1;
      const id = `s${String(counter).padStart(2, "0")}`;
      const now = new Date();
      const summary = summaryOf(
        id,
        parsed,
        [sent],
        { ...EMPTY_FLAGS, seen: true },
        now,
        mime.byteLength,
      );
      const raw = rawMessageOf(id, parsed);
      store.set(id, {
        summary: { ...summary, threadId: threads ? `sent-${id}` : null },
        flags: summary.flags,
        mailboxIds: [sent],
        text: raw.text,
        html: raw.html,
        attachments: [],
        allHeaders: raw.headers,
      });
      record(id, "created", [sent]);
      return { messageId: id };
    },

    async putDraft(mime: Uint8Array, previousId: string | null) {
      count("putDraft");
      const draftsBox = mailboxOfRole("drafts");
      if (!draftsBox) throw new ProviderError("no Drafts mailbox", "unsupported");
      if (previousId && store.has(previousId)) {
        const s = require(previousId);
        store.delete(previousId);
        record(previousId, "destroyed", s.mailboxIds);
      }
      const parsed = await parseMime(mime);
      counter += 1;
      const id = `dr${String(counter).padStart(2, "0")}`;
      const summary = summaryOf(
        id,
        parsed,
        [draftsBox],
        { ...EMPTY_FLAGS, seen: true, draft: true },
        new Date(),
        mime.byteLength,
      );
      const raw = rawMessageOf(id, parsed);
      store.set(id, {
        summary: { ...summary, threadId: threads ? `draft-${id}` : null },
        flags: summary.flags,
        mailboxIds: [draftsBox],
        text: raw.text,
        html: raw.html,
        attachments: [],
        allHeaders: raw.headers,
      });
      record(id, "created", [draftsBox]);
      return { id };
    },

    async deleteDraft(id: string) {
      count("deleteDraft");
      const s = store.get(id);
      if (!s) return;
      store.delete(id);
      record(id, "destroyed", s.mailboxIds);
    },

    watch(_mailboxIds: string[]): Watch {
      count("watch");
      if (!capabilities.push) {
        return { supported: false, events: (async function* () {})(), stop: async () => {} };
      }
      const queue = asyncQueue<WatchEvent>();
      watches.add(queue);
      queue.push({ type: "connected" });
      return {
        supported: true,
        events: queue,
        stop: async () => {
          watches.delete(queue);
          queue.close();
        },
      };
    },

    async close() {
      count("close");
      for (const w of watches) w.close();
      watches.clear();
    },
  };

  const provider: FakeProvider = {
    kind: "fake",
    calls,
    async connect(credentials: Credentials) {
      count("connect");
      if (credentials.auth.kind === "password" && credentials.auth.password === "wrong") {
        throw new ProviderError("bad password", "auth");
      }
      return session;
    },
    deliver(message) {
      counter += 1;
      const id = message.id ?? `d${String(counter).padStart(2, "0")}`;
      const mailboxId = roleToId(message.mailbox);
      load({ ...message, id }, [mailboxId]);
      record(id, "created", [mailboxId]);
      return id;
    },
    setFlags(id, patch) {
      const s = require(id);
      s.flags = { ...s.flags, ...patch };
      record(id, "updated", s.mailboxIds);
    },
    move(id, mailboxId) {
      const s = require(id);
      s.mailboxIds = [mailboxId];
      record(id, "updated", s.mailboxIds);
    },
    destroy(id) {
      const s = require(id);
      store.delete(id);
      record(id, "destroyed", s.mailboxIds);
    },
    forgetHistory() {
      log = [];
      // A state at the current seq stays continuable; anything older resets.
      seq += 1;
      log.push({ seq, id: "", kind: "updated", mailboxIds: [] });
    },
    push(event) {
      for (const w of watches) w.push(event);
    },
    snapshot() {
      return [...store.entries()].map(([id, s]) => ({
        id,
        mailboxIds: [...s.mailboxIds],
        flags: { ...s.flags },
      }));
    },
  };
  return provider;
}

/** The Credentials the fake accepts; any password but "wrong". */
export function fakeCredentials(address = "sam@monday.test"): Credentials {
  return {
    address,
    auth: { kind: "password", user: address, password: "ok" },
    endpoint: { kind: "none" },
  };
}

export type { Person };
