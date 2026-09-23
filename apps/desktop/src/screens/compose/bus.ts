// The compose surfaces' doorway for everything outside the Inbox screen's
// props: the reader says which Thread it shows (so a saved reply Draft opens
// as the inline reply), and the Agent panel asks for a Draft to open (its
// "Open draft" action and the open_draft tool). The one mounted compose
// controller listens; with none mounted a request waits for the next one.
// The controller also reports the Draft that is open, which the Agent panel
// sends as the turn context's draftId so "make this shorter" acts on it.

import { useEffect } from "react";

export interface OpenDraftRequest {
  draftId: string;
  /** The Thread a reply or forward belongs to, when the caller knows it. */
  threadId?: string | null | undefined;
}

type Listener = {
  showThread(threadId: string | null): void;
  openDraft(request: OpenDraftRequest): void;
};

let listener: Listener | null = null;
let shownThread: string | null = null;
let queued: OpenDraftRequest | null = null;
let openDraftId: string | null = null;
const openListeners = new Set<(draftId: string | null) => void>();

export const composeBus = {
  /** The compose controller subscribes; returns the unsubscribe. */
  listen(next: Listener): () => void {
    listener = next;
    next.showThread(shownThread);
    if (queued) {
      const request = queued;
      queued = null;
      next.openDraft(request);
    }
    return () => {
      if (listener === next) listener = null;
    };
  },
  /** The reader shows this Thread now (null: no Thread). */
  showThread(threadId: string | null): void {
    shownThread = threadId;
    listener?.showThread(threadId);
  },
  shownThread(): string | null {
    return shownThread;
  },
  /** Opens a Draft in the composer: the Agent's "Open draft" and open_draft. */
  requestOpen(request: OpenDraftRequest): void {
    if (listener) listener.openDraft(request);
    else queued = request;
  },
  /** Whether a compose controller is mounted to take a request right now. */
  listening(): boolean {
    return listener !== null;
  },
  /** The controller reports the Draft in the open window or inline reply. */
  setOpenDraft(draftId: string | null): void {
    if (draftId === openDraftId) return;
    openDraftId = draftId;
    for (const l of [...openListeners]) l(draftId);
  },
  /** The Draft open in the composer now, for the Agent's turn context. */
  openDraft(): string | null {
    return openDraftId;
  },
  subscribeOpenDraft(l: (draftId: string | null) => void): () => void {
    openListeners.add(l);
    return () => {
      openListeners.delete(l);
    };
  },
  /** Tests start clean. */
  reset(): void {
    listener = null;
    shownThread = null;
    queued = null;
    openDraftId = null;
    openListeners.clear();
  },
};

/** The reader calls this with the Thread it shows. */
export function useShownThread(threadId: string | null): void {
  useEffect(() => {
    composeBus.showThread(threadId);
    return () => {
      if (composeBus.shownThread() === threadId) composeBus.showThread(null);
    };
  }, [threadId]);
}

/** Opens a Draft in the composer: the new message window, or its Thread's inline reply. */
export function openDraftInComposer(draftId: string, threadId?: string | null): void {
  composeBus.requestOpen({ draftId, threadId: threadId ?? null });
}
