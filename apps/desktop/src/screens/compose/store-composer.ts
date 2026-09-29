// The Composer seam over the Store (ADR 0009, ADR 0010): Drafts and sends
// from live queries over the Cache, people on demand (the Cache's people
// table, then the Server's index over the whole mailbox); every write an intent the
// Store applies locally and replays through the Outbox. Uploads go straight to
// the Server in chunks (a blob is content, not an intent) and the Draft then
// references the blob id.

import type { Draft, PeopleRanking, Person, ScheduledSend } from "@monday/shared";
import { settingsSchema } from "@monday/shared";
import type { PeopleSource } from "../../people/lookup.ts";
import {
  DRAFTS_SQL,
  rowDraftStale,
  rowToDraft,
  rowToPerson,
  rowToSend,
  SENDS_SQL,
  type Store,
} from "../../store/index.ts";
import { peopleSearchQuery, RECENT_PEOPLE_SQL, rowsToPeople } from "../../store/people.ts";
import type { ContentTransport } from "../../store/transport.ts";
import type { AssistRequest, Composer, DraftSuggestion } from "./composer.ts";

export interface StoreComposer extends Composer {
  close(): void;
}

export interface StoreComposerOptions {
  address: string;
  now?: () => Date;
  /** Mints send ids; tests make them predictable. */
  id?: () => string;
  /** Agent suggestions per Draft; the browser dev server seeds the design fixture's. */
  suggestions?: Readonly<Record<string, DraftSuggestion>> | undefined;
  /** The people Settings, read on every lookup; the schema's defaults when absent. */
  people?: Partial<PeopleSettings> | undefined;
}

/** The Settings a people lookup reads (packages/shared settings schema, people.*). */
export interface PeopleSettings {
  limit: () => number;
  debounceMs: () => number;
  server: () => boolean;
  ranking: () => PeopleRanking;
  /** How many people participants() lists (intent.contacts_max bounds what the palette sends). */
  recentMax: () => number;
}

const defaultPeopleSettings: PeopleSettings = {
  limit: () => settingsSchema["people.suggestions"].default,
  debounceMs: () => settingsSchema["people.server_debounce_ms"].default,
  server: () => settingsSchema["people.search_server"].default,
  ranking: () => ({
    weights: settingsSchema["people.weights"].default,
    halfLifeDays: settingsSchema["people.recency_half_life_days"].default,
  }),
  recentMax: () => settingsSchema["intent.contacts_max"].default,
};

export async function createStoreComposer(
  store: Store,
  content: ContentTransport,
  options: StoreComposerOptions,
): Promise<StoreComposer> {
  const now = options.now ?? (() => new Date());
  const mint = options.id ?? (() => crypto.randomUUID());
  const listeners = new Set<() => void>();
  let drafts: readonly Draft[] = [];
  const stale = new Set<string>();
  let sends: readonly ScheduledSend[] = [];
  let people: readonly Person[] = [];
  /** participants() reads again on its next call: never read yet, or the Cache's Messages changed. */
  let peopleStale = true;
  let peopleLoading = false;
  const ps: PeopleSettings = { ...defaultPeopleSettings, ...options.people };
  const prefs = new Map<string, boolean>();

  const emit = () => {
    for (const l of [...listeners]) l();
  };

  const draftsLive = store.live<Record<string, unknown>>(DRAFTS_SQL);
  const sendsLive = store.live<Record<string, unknown>>(SENDS_SQL);

  const first = (live: { subscribe(l: (rows: Record<string, unknown>[]) => void): () => void }) =>
    new Promise<void>((resolve) => {
      let done = false;
      live.subscribe(() => {
        if (!done) {
          done = true;
          resolve();
        }
      });
    });

  draftsLive.subscribe((rows) => {
    stale.clear();
    drafts = rows.map((r) => {
      if (rowDraftStale(r)) stale.add(String(r.id));
      return rowToDraft(r, store.workspaceId);
    });
    emit();
  });
  sendsLive.subscribe((rows) => {
    const all = rows.map((r) => rowToSend(r, store.workspaceId));
    sends = [
      ...all.filter((s) => s.status === "scheduled").sort((a, b) => a.runAt.localeCompare(b.runAt)),
      ...all.filter((s) => s.status !== "scheduled"),
    ];
    emit();
  });
  const offWrite = store.onWrite((tables) => {
    if (tables.has("messages")) peopleStale = true;
  });
  const loadPeople = () => {
    if (peopleLoading) return;
    peopleLoading = true;
    peopleStale = false;
    store
      .query<Record<string, unknown>>(RECENT_PEOPLE_SQL, [
        options.address.trim().toLowerCase(),
        Math.max(1, ps.recentMax()),
      ])
      .then(
        (rows) => {
          people = rows.map(rowToPerson);
          emit();
        },
        () => {
          peopleStale = true;
        },
      )
      .finally(() => {
        peopleLoading = false;
      });
  };
  const peopleSource: PeopleSource = {
    async local(q, limit) {
      const query = peopleSearchQuery(q, options.address, limit);
      if (!query) return [];
      const rows = await store.query<Record<string, unknown>>(query.sql, query.params);
      return rowsToPeople(rows, q, ps.ranking(), now(), limit);
    },
    ...(content.people
      ? {
          remote: async (q: string, limit: number, signal: AbortSignal) =>
            ps.server()
              ? ((await content.people?.(store.workspaceId, q, limit, signal)) ?? null)
              : null,
        }
      : {}),
    limit: ps.limit,
    debounceMs: ps.debounceMs,
  };
  await Promise.all([first(draftsLive), first(sendsLive)]);
  for (const [threadId, replyAll] of await loadReplyPrefs(store)) prefs.set(threadId, replyAll);

  return {
    workspaceId: store.workspaceId,
    address: options.address,
    drafts: () => drafts,
    draft: (id) => drafts.find((d) => d.id === id),
    sends: () => sends,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    save: (id, draftContent) =>
      store.intent({ kind: "draft.save", draftId: id, content: draftContent }),
    discard: (id) => store.intent({ kind: "draft.delete", draftId: id }),
    async send(id, sendOptions = {}) {
      const sendId = mint();
      const at = now().toISOString();
      const runAt =
        sendOptions.runAt ??
        new Date(Date.parse(at) + (sendOptions.delaySeconds ?? 0) * 1000).toISOString();
      await store.intent({
        kind: "send.schedule",
        draftId: id,
        sendId,
        at,
        ...(sendOptions.delaySeconds !== undefined
          ? { delaySeconds: sendOptions.delaySeconds }
          : {}),
        ...(sendOptions.runAt ? { runAt: sendOptions.runAt } : {}),
      });
      return { sendId, runAt };
    },
    async cancel(sendId) {
      const send = sends.find((s) => s.id === sendId);
      if (!send) return;
      await store.intent({ kind: "send.cancel", draftId: send.draftId, sendId });
    },
    async upload(file, onProgress) {
      const { blobId } = await content.uploadBlob(store.workspaceId, file, onProgress);
      return { blobId, name: file.name, size: file.bytes.length, mediaType: file.mediaType };
    },
    participants() {
      if (peopleStale) loadPeople();
      return people;
    },
    people: peopleSource,
    replyAllFor: (threadId) => prefs.get(threadId) ?? null,
    async setReplyAllFor(threadId, replyAll) {
      prefs.set(threadId, replyAll);
      await store.setReplyAll(threadId, replyAll);
    },
    async ensureContent(id) {
      const local = drafts.find((d) => d.id === id);
      if (local && !stale.has(id)) return local;
      try {
        const fresh = await content.draft(id);
        await store.cacheDraft(fresh);
        return fresh;
      } catch {
        return local;
      }
    },
    suggestion: (id) => options.suggestions?.[id] ?? null,
    ...(content.draftAssist
      ? {
          assist: (request: AssistRequest) =>
            (content.draftAssist as NonNullable<ContentTransport["draftAssist"]>)({
              ...request,
              workspace: store.workspaceId,
            }),
          // Asked once per window; a Server without the probe answers by trying.
          assistAvailable: () =>
            content.draftAssistAvailable?.(store.workspaceId) ?? Promise.resolve(true),
        }
      : {}),
    close() {
      draftsLive.close();
      sendsLive.close();
      offWrite();
      listeners.clear();
    },
  };
}

/** Reads the remembered reply-all choices once, so a reopened Thread keeps its toggle. */
export async function loadReplyPrefs(store: Store): Promise<Map<string, boolean>> {
  const rows = await store.query<{ thread_id: string; reply_all: number }>(
    "select thread_id, reply_all from reply_prefs",
  );
  return new Map(rows.map((r) => [r.thread_id, r.reply_all === 1]));
}
