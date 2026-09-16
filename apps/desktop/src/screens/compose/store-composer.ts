// The Composer seam over the Store (ADR 0009, ADR 0010): Drafts, sends and
// participants from live queries over the Cache; every write an intent the
// Store applies locally and replays through the Outbox. Uploads go straight to
// the Server in chunks (a blob is content, not an intent) and the Draft then
// references the blob id.

import type { Draft, Person, ScheduledSend } from "@monday/shared";
import {
  DRAFTS_SQL,
  PARTICIPANTS_SQL,
  rowDraftStale,
  rowToDraft,
  rowToPerson,
  rowToSend,
  SENDS_SQL,
  type Store,
} from "../../store/index.ts";
import type { ContentTransport } from "../../store/transport.ts";
import type { Composer, DraftSuggestion } from "./composer.ts";

export interface StoreComposer extends Composer {
  close(): void;
}

export interface StoreComposerOptions {
  address: string;
  now?: () => Date;
  /** Mints send ids; tests make them predictable. */
  id?: () => string;
  /** Agent suggestions per Draft; the browser dev server seeds the fixture's, slice 14 the real ones. */
  suggestions?: Readonly<Record<string, DraftSuggestion>> | undefined;
}

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
  const prefs = new Map<string, boolean>();

  const emit = () => {
    for (const l of [...listeners]) l();
  };

  const draftsLive = store.live<Record<string, unknown>>(DRAFTS_SQL);
  const sendsLive = store.live<Record<string, unknown>>(SENDS_SQL);
  const peopleLive = store.live<Record<string, unknown>>(PARTICIPANTS_SQL);

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
  peopleLive.subscribe((rows) => {
    people = rows.map(rowToPerson);
    emit();
  });
  await Promise.all([first(draftsLive), first(sendsLive), first(peopleLive)]);
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
    participants: () => people,
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
    close() {
      draftsLive.close();
      sendsLive.close();
      peopleLive.close();
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
