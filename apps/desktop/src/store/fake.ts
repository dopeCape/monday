// The FakeStore: a real Store over an in-memory SQLite plus a fake Server that
// keeps the same rules (per-field last-writer-wins, the Changes feed, wakes).
// Tests drive it with `server.offline` and `server.write`; the browser dev
// server (the fakePlatform path) seeds it from the design fixtures.

import type {
  Actor,
  Brief,
  BriefTrigger,
  Change,
  ChangesPage,
  Draft,
  DraftIntent,
  FieldWrites,
  Id,
  Intent,
  IntentResult,
  IsoDate,
  ScheduledSend,
  ScheduleResult,
  ThreadChange,
} from "@monday/shared";
import { FIELD_GROUP_OF, resolveWrite } from "@monday/shared";
import { ApiError, type MessageHeaderResponse } from "../platform/api.ts";
import type { SqlDriver } from "./driver.ts";
import { fixtureSeed, type SeedData, seedStatements } from "./seed.ts";
import { createStore, type Store, type StoreOptions } from "./store.ts";
import type { ContentTransport, StoreTransport, WakeHandlers } from "./transport.ts";

interface ServerThread extends ThreadChange {
  writes: FieldWrites;
}

/** A server-side write outside any client intent: a Provider sync or a Workflow. */
export interface ServerWrite {
  threadId: Id;
  actor: Actor;
  at: IsoDate;
  patch: Partial<
    Pick<
      ThreadChange,
      "archived" | "starred" | "unread" | "snoozedUntil" | "group" | "subgroup" | "deleted" | "tags"
    >
  >;
}

/** A Brief the fake Server holds, with the Thread version it was computed for. */
export interface ServerBrief extends Brief {
  messageCount: number;
}

export interface FakeServer {
  /** While true every request fails like a dropped connection. */
  offline: boolean;
  threads: Map<Id, ServerThread>;
  changes: Change[];
  briefs: Map<Id, ServerBrief>;
  /** Brief requests that arrived (the reader on open, the user by hand), in order. */
  briefRequests: Array<{ threadId: Id; trigger: BriefTrigger }>;
  /**
   * What a Brief request does, in place of the brief Job: tests script it
   * (compute at once, or never). By default a request queues nothing.
   */
  onBriefRequest: ((threadId: Id, trigger: BriefTrigger) => void) | null;
  /** Stores a Brief as the Job would and records the feed row. */
  putBrief(brief: Brief, messageCount?: number): void;
  /** Marks a Brief stale, as a new Message would, and records the feed row. */
  staleBrief(threadId: Id): void;
  removeBrief(threadId: Id): void;
  /** How many intents arrived, in order, for assertions on replay order. */
  received: Intent[];
  /** Draft and send intents that arrived, in order. */
  receivedDrafts: DraftIntent[];
  drafts: Map<Id, Draft>;
  sends: Map<Id, ScheduledSend>;
  /** The undo window the fake applies to send.schedule; 30 s like the Setting. */
  delaySeconds: number;
  /** Runs every send whose run_at has passed: status sent, Draft sent, changes recorded. */
  runDueSends(now?: Date): number;
  applyIntent(intent: Intent): IntentResult;
  applyDraftIntent(intent: DraftIntent): ScheduleResult;
  /** Appends any change to the feed with the next seq and wakes the sockets. */
  record(change: Omit<Change, "seq" | "workspaceId" | "at">): number;
  /** Applies a write as the Server would from a sync or a Workflow and records the change. */
  write(write: ServerWrite): void;
  list(since: number, limit: number): ChangesPage;
  /** Drops every open wake connection, as a restart would. */
  dropConnections(): void;
  connections(): number;
  /** Open wake connections; fakeTransport adds and removes them. */
  sockets: Set<WakeHandlers>;
}

export function createFakeServer(workspaceId: Id, seed?: SeedData): FakeServer {
  const threads = new Map<Id, ServerThread>();
  const changes: Change[] = [];
  const sockets = new Set<WakeHandlers>();
  const draftsById = new Map<Id, Draft>();
  const sendsById = new Map<Id, ScheduledSend>();
  const briefsById = new Map<Id, ServerBrief>();
  let seq = 0;

  if (seed) {
    for (const t of seed.threads) threads.set(t.id, { ...t, deleted: false, writes: {} });
    for (const b of seed.briefs) {
      briefsById.set(b.threadId, {
        ...b,
        messageCount: threads.get(b.threadId)?.messageCount ?? 0,
      });
    }
  }

  const record = (change: Omit<Change, "seq" | "workspaceId" | "at">): number => {
    seq += 1;
    changes.push({ ...change, seq, workspaceId, at: new Date().toISOString() } as Change);
    for (const s of [...sockets]) s.onWake(seq);
    return seq;
  };

  const threadOf = (threadId: Id): ServerThread => {
    const existing = threads.get(threadId);
    if (existing) return existing;
    const created: ServerThread = {
      id: threadId,
      workspaceId,
      subject: "",
      participants: [],
      lastActivity: new Date(0).toISOString(),
      messageCount: 0,
      unread: false,
      starred: false,
      archived: false,
      deleted: false,
      snoozedUntil: null,
      section: null,
      group: null,
      subgroup: null,
      tags: [],
      labels: [],
      hasAttachments: false,
      snippet: "",
      writes: {},
    };
    threads.set(threadId, created);
    return created;
  };

  const project = (t: ServerThread): ThreadChange => {
    const { writes: _w, ...rest } = t;
    return rest;
  };

  const recordDraft = (d: Draft, deleted = false) =>
    record({
      kind: "draft",
      entityId: d.id,
      payload: {
        id: d.id,
        threadId: d.threadId,
        kind: d.kind,
        inReplyToMessageId: d.inReplyToMessageId,
        to: d.to,
        cc: d.cc,
        bcc: d.bcc,
        attachments: d.attachments,
        status: d.status,
        updatedAt: d.updatedAt,
        updatedBy: d.updatedBy,
        deleted,
      },
    });
  const recordSend = (sd: ScheduledSend) => record({ kind: "send", entityId: sd.id, payload: sd });
  const recordBrief = (b: ServerBrief, deleted = false) =>
    record({
      kind: "brief",
      entityId: b.threadId,
      payload: {
        threadId: b.threadId,
        computedAt: b.computedAt,
        stale: b.stale,
        messageCount: b.messageCount,
        deleted,
      },
    });

  const server: FakeServer = {
    offline: false,
    threads,
    changes,
    briefs: briefsById,
    briefRequests: [],
    onBriefRequest: null,
    received: [],
    receivedDrafts: [],
    drafts: draftsById,
    sends: sendsById,
    delaySeconds: 30,
    record,

    putBrief(brief, messageCount) {
      const stored: ServerBrief = {
        ...brief,
        messageCount: messageCount ?? threads.get(brief.threadId)?.messageCount ?? 0,
      };
      briefsById.set(brief.threadId, stored);
      recordBrief(stored);
    },

    staleBrief(threadId) {
      const existing = briefsById.get(threadId);
      if (!existing || existing.stale) return;
      const stale: ServerBrief = { ...existing, stale: true };
      briefsById.set(threadId, stale);
      recordBrief(stale);
    },

    removeBrief(threadId) {
      const existing = briefsById.get(threadId);
      if (!existing) return;
      briefsById.delete(threadId);
      recordBrief({ ...existing, computedAt: new Date().toISOString() }, true);
    },

    applyDraftIntent(intent) {
      server.receivedDrafts.push(intent);
      const existing = draftsById.get(intent.draftId);
      switch (intent.kind) {
        case "draft.save": {
          if (existing && Date.parse(existing.updatedAt) > Date.parse(intent.at)) {
            return { applied: false, reason: `draft written at ${existing.updatedAt}` };
          }
          if (existing && existing.status !== "open") {
            return { applied: false, reason: `draft is ${existing.status}` };
          }
          const c = intent.content;
          const draft: Draft = {
            id: intent.draftId,
            workspaceId,
            threadId: c.threadId,
            kind: c.kind,
            inReplyToMessageId: c.inReplyToMessageId,
            to: c.to,
            cc: c.cc,
            bcc: c.bcc,
            subject: c.subject,
            bodyHtml: c.bodyHtml,
            bodyText: c.bodyText,
            attachments: c.attachments,
            attachmentBlobIds: c.attachments.map((a) => a.blobId),
            status: "open",
            updatedAt: intent.at,
            updatedBy: "device",
          };
          draftsById.set(draft.id, draft);
          recordDraft(draft);
          return { applied: true };
        }
        case "draft.delete": {
          if (!existing) return { applied: false, reason: "no such draft" };
          draftsById.delete(existing.id);
          recordDraft({ ...existing, updatedAt: intent.at }, true);
          return { applied: true };
        }
        case "send.schedule": {
          if (!existing) return { applied: false, reason: "no such draft" };
          const same = sendsById.get(intent.sendId);
          if (same) return { applied: true, sendId: same.id, runAt: same.runAt };
          const delay = intent.delaySeconds ?? server.delaySeconds;
          const runAt =
            intent.runAt ?? new Date(Date.parse(intent.at) + delay * 1000).toISOString();
          const send: ScheduledSend = {
            id: intent.sendId,
            workspaceId,
            draftId: existing.id,
            runAt,
            status: "scheduled",
            cancelledAt: null,
            sentAt: null,
            jobId: intent.sendId,
            error: null,
            createdAt: intent.at,
          };
          sendsById.set(send.id, send);
          const scheduled: Draft = { ...existing, status: "scheduled", updatedAt: intent.at };
          draftsById.set(scheduled.id, scheduled);
          recordDraft(scheduled);
          recordSend(send);
          return { applied: true, sendId: send.id, runAt };
        }
        case "send.cancel": {
          const send = sendsById.get(intent.sendId);
          if (!send) return { applied: false, reason: "no such send" };
          if (send.status !== "scheduled") {
            return { applied: false, reason: `send is ${send.status}` };
          }
          const cancelled: ScheduledSend = { ...send, status: "cancelled", cancelledAt: intent.at };
          sendsById.set(cancelled.id, cancelled);
          const draft = draftsById.get(send.draftId);
          if (draft) {
            const reopened: Draft = { ...draft, status: "open", updatedAt: intent.at };
            draftsById.set(reopened.id, reopened);
            recordDraft(reopened);
          }
          recordSend(cancelled);
          return { applied: true };
        }
      }
    },

    runDueSends(now = new Date()) {
      let ran = 0;
      for (const send of [...sendsById.values()]) {
        if (send.status !== "scheduled" || Date.parse(send.runAt) > now.getTime()) continue;
        const sent: ScheduledSend = { ...send, status: "sent", sentAt: now.toISOString() };
        sendsById.set(sent.id, sent);
        const draft = draftsById.get(send.draftId);
        if (draft) {
          const done: Draft = { ...draft, status: "sent", updatedAt: now.toISOString() };
          draftsById.set(done.id, done);
          recordDraft(done);
        }
        recordSend(sent);
        ran += 1;
      }
      return ran;
    },

    applyIntent(intent) {
      server.received.push(intent);
      const t = threadOf(intent.threadId);
      const group = FIELD_GROUP_OF[intent.kind];
      const resolution = resolveWrite(intent, t.writes[group]);
      if (!resolution.wins) return { applied: false, reason: resolution.reason };
      t.writes[group] = { at: intent.at, by: intent.actor };
      switch (intent.kind) {
        case "archive":
          t.archived = true;
          break;
        case "unarchive":
          t.archived = false;
          break;
        case "star":
          t.starred = true;
          break;
        case "unstar":
          t.starred = false;
          break;
        case "read":
          t.unread = false;
          break;
        case "unread":
          t.unread = true;
          break;
        case "snooze":
          t.snoozedUntil = intent.until;
          t.archived = true;
          break;
        case "unsnooze":
          t.snoozedUntil = null;
          t.archived = false;
          break;
        case "move":
          t.group = intent.group;
          t.subgroup = intent.subgroup;
          break;
        case "delete":
          t.deleted = true;
          break;
        case "undelete":
          t.deleted = false;
          break;
        case "tags":
          t.tags = [...new Set(intent.tags)];
          record({
            kind: "thread_tags",
            entityId: t.id,
            payload: { threadId: t.id, ids: t.tags },
          });
          return { applied: true };
      }
      record({ kind: "thread", entityId: t.id, payload: project(t) });
      return { applied: true };
    },

    write({ threadId, actor, at, patch }) {
      const t = threadOf(threadId);
      const stamp = { at, by: actor };
      if (patch.archived !== undefined) {
        t.archived = patch.archived;
        t.writes.archived = stamp;
      }
      if (patch.starred !== undefined) {
        t.starred = patch.starred;
        t.writes.starred = stamp;
      }
      if (patch.unread !== undefined) {
        t.unread = patch.unread;
        t.writes.unread = stamp;
      }
      if (patch.snoozedUntil !== undefined) {
        t.snoozedUntil = patch.snoozedUntil;
        t.writes.snoozed = stamp;
      }
      if (patch.group !== undefined || patch.subgroup !== undefined) {
        t.group = patch.group ?? t.group;
        t.subgroup = patch.subgroup ?? t.subgroup;
        t.writes.placement = stamp;
      }
      if (patch.deleted !== undefined) {
        t.deleted = patch.deleted;
        t.writes.deleted = stamp;
      }
      if (patch.tags !== undefined) {
        t.tags = [...patch.tags];
        t.writes.tags = stamp;
      }
      record({ kind: "thread", entityId: t.id, payload: project(t) });
    },

    list(since, limit) {
      const page = changes.filter((c) => c.seq > since).slice(0, limit);
      const last = page[page.length - 1];
      return { changes: page, cursor: last ? last.seq : since };
    },

    dropConnections() {
      for (const s of [...sockets]) {
        sockets.delete(s);
        s.onClose();
      }
    },

    connections: () => sockets.size,
    sockets,
  };
  return server;
}

export function fakeTransport(server: FakeServer): StoreTransport {
  const { sockets } = server;
  const offline = () => new ApiError(0, "connection refused");
  return {
    async changes(_workspaceId, since, limit) {
      if (server.offline) throw offline();
      return server.list(since, limit);
    },
    async intent(intent) {
      if (server.offline) throw offline();
      return server.applyIntent(intent);
    },
    async draftIntent(_workspaceId, intent) {
      if (server.offline) throw offline();
      return server.applyDraftIntent(intent);
    },
    async brief(threadId) {
      if (server.offline) throw offline();
      const b = server.briefs.get(threadId);
      if (!b) return null;
      const { messageCount: _v, ...brief } = b;
      return brief;
    },
    connect(_workspaceId, handlers) {
      if (server.offline) {
        queueMicrotask(handlers.onClose);
        return { close() {} };
      }
      sockets.add(handlers);
      queueMicrotask(() => {
        if (sockets.has(handlers)) handlers.onOpen();
      });
      return {
        close() {
          sockets.delete(handlers);
        },
      };
    },
  };
}

/**
 * Content reads over the seed: bodies come from the fixture Messages, uploads
 * land in memory. The browser dev server and the tests share it.
 */
export function fakeContent(server: FakeServer, seed: SeedData | null): ContentTransport {
  const messages = seed?.messages ?? [];
  const blobs = new Map<Id, { name: string; mediaType: string; bytes: Uint8Array }>();
  const offline = () => new ApiError(0, "connection refused");
  return {
    async messages(threadId) {
      if (server.offline) throw offline();
      return messages
        .filter((m) => m.threadId === threadId)
        .map<MessageHeaderResponse>((m) => ({
          id: m.id,
          threadId: m.threadId,
          from: m.from,
          to: m.to,
          cc: m.cc,
          date: m.date,
          headers: {},
          hasAttachments: m.attachments.length > 0,
          attachments: m.attachments.map((a) => ({
            id: a.id,
            messageId: m.id,
            name: a.name,
            size: a.size,
            mediaType: a.mediaType,
            contentId: null,
            inline: false,
          })),
          bodyState: "fetched",
        }));
    },
    async body(messageId) {
      if (server.offline) throw offline();
      const m = messages.find((x) => x.id === messageId);
      if (!m) throw new ApiError(404, "not found");
      return {
        text: m.bodyText ?? "",
        html: m.bodyHtml ?? null,
        snippet: (m.bodyText ?? "").slice(0, 200),
        display: { html: m.bodyHtml ?? "", quoted: false, blockedImages: 0 },
      };
    },
    async draft(draftId) {
      if (server.offline) throw offline();
      const d = server.drafts.get(draftId);
      if (!d) throw new ApiError(404, "not found");
      return d;
    },
    async requestBrief(_workspaceId, threadId, trigger) {
      if (server.offline) throw offline();
      const existing = server.briefs.get(threadId);
      const version = server.threads.get(threadId)?.messageCount ?? 0;
      if (trigger === "open" && existing && !existing.stale && existing.messageCount === version) {
        return { fresh: true };
      }
      server.briefRequests.push({ threadId, trigger });
      server.onBriefRequest?.(threadId, trigger);
      return { jobId: `job-${server.briefRequests.length}` };
    },
    async attachment(attachmentId) {
      if (server.offline) throw offline();
      for (const m of messages) {
        const a = m.attachments.find((x) => x.id === attachmentId);
        if (a) {
          return {
            bytes: new TextEncoder().encode(a.text ?? a.name),
            mediaType: a.mediaType,
          };
        }
      }
      const blob = blobs.get(attachmentId);
      if (blob) return { bytes: blob.bytes, mediaType: blob.mediaType };
      throw new ApiError(404, "not found");
    },
    async uploadBlob(_workspaceId, file, onProgress) {
      if (server.offline) throw offline();
      const chunk = 1024 * 1024;
      const count = Math.max(1, Math.ceil(file.bytes.length / chunk));
      for (let i = 0; i < count; i++) onProgress?.((i + 1) / count);
      const blobId = `blob-${blobs.size + 1}`;
      blobs.set(blobId, file);
      return { blobId };
    },
  };
}

export interface FakeStoreOptions extends Partial<Omit<StoreOptions, "driver" | "transport">> {
  workspaceId?: Id;
  driver: SqlDriver;
  /** Fixture data for the Cache and the fake Server; the design fixtures by default, `null` for empty. */
  seed?: SeedData | null;
}

export interface FakeStore {
  store: Store;
  server: FakeServer;
  content: ContentTransport;
}

/** A Store over `driver` whose Server is in memory, seeded on both sides. */
export async function createFakeStore(options: FakeStoreOptions): Promise<FakeStore> {
  const { driver, seed: seedOption, workspaceId = "ws-genai", ...rest } = options;
  const seed = seedOption === undefined ? fixtureSeed() : seedOption;
  const server = createFakeServer(workspaceId, seed ?? undefined);
  const store = await createStore({
    ...rest,
    workspaceId,
    driver,
    transport: fakeTransport(server),
  });
  if (seed) {
    const [row] = await store.query<{ n: number }>("select count(*) as n from threads");
    if ((row?.n ?? 0) === 0) await driver.batch(seedStatements(seed));
  }
  return { store, server, content: fakeContent(server, seed) };
}
