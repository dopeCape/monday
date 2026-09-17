// What the Store needs from the network, and the implementation over the API
// client. The wake side is one connection at a time: the Store owns reconnect
// and backoff, the transport only reports open, wake and close. The transport
// follows /capabilities: WebSocket for the Sidecar and the container, SSE for
// Vercel, a timer for polling (docs/spec/architecture.md, "Deployment modes").

import type {
  Brief,
  BriefTrigger,
  Capabilities,
  ChangesPage,
  Draft,
  DraftIntent,
  Id,
  Intent,
  IntentResult,
} from "@monday/shared";
import type {
  Api,
  BodyResponse,
  BriefRequestResult,
  MessageHeaderResponse,
} from "../platform/api.ts";

export interface WakeHandlers {
  onOpen(): void;
  onWake(seq: number): void;
  /** The connection dropped; the Store decides when to connect again. */
  onClose(): void;
}

export interface WakeConnection {
  close(): void;
}

export interface StoreTransport {
  changes(workspaceId: Id, since: number, limit: number): Promise<ChangesPage>;
  intent(intent: Intent): Promise<IntentResult>;
  /** A Draft or send intent to its route (ADR 0010). */
  draftIntent(workspaceId: Id, intent: DraftIntent): Promise<IntentResult>;
  /**
   * A Brief's content, once its feed row said one exists, so the Cache holds
   * it before the reader opens (slice 13). Null when the Server has none.
   * Absent on a transport with no content routes; those rows stay unwarmed.
   */
  brief?(threadId: Id): Promise<Brief | null>;
  connect(workspaceId: Id, handlers: WakeHandlers): WakeConnection;
}

/**
 * The content reads the reader and the compose surface make on open: Message
 * headers with attachments, one body, one Draft. Separate from the feed so a
 * locked or offline Server fails these without stalling sync.
 */
export interface ContentTransport {
  messages(threadId: Id): Promise<MessageHeaderResponse[]>;
  body(messageId: Id, options?: { images?: boolean }): Promise<BodyResponse>;
  draft(draftId: Id): Promise<Draft>;
  attachment(attachmentId: Id): Promise<{ bytes: Uint8Array; mediaType: string }>;
  /**
   * Asks the Server for a Brief under the brief policy: the reader on open
   * (the Cache has none, or a stale one), or the user by hand. The Brief
   * itself arrives through the feed. Rejects with 409 when the Server holds
   * no key for the brief Task.
   */
  requestBrief(workspaceId: Id, threadId: Id, trigger: BriefTrigger): Promise<BriefRequestResult>;
  uploadBlob(
    workspaceId: Id,
    file: { name: string; mediaType: string; bytes: Uint8Array },
    onProgress?: (fraction: number) => void,
  ): Promise<{ blobId: Id }>;
}

/** How often a polling deployment is asked for changes; a Setting once slice 7 lands. */
export const POLL_INTERVAL_MS = 30_000;

export function apiTransport(api: Api, capabilities: () => Capabilities | null): StoreTransport {
  return {
    changes: (workspaceId, since, limit) => api.changes.list(workspaceId, since, limit),
    intent: (intent) => api.threads.intent(intent),
    draftIntent: (workspaceId, intent) => api.drafts.intent(workspaceId, intent),
    brief: (threadId) => api.briefs.get(threadId),
    connect(workspaceId, handlers) {
      const realtime = capabilities()?.realtime ?? "polling";
      if (realtime === "websocket") return connectWebSocket(api, workspaceId, handlers);
      if (realtime === "sse") return connectSse(api, workspaceId, handlers);
      return connectPolling(handlers);
    },
  };
}

export function apiContent(api: Api): ContentTransport {
  return {
    messages: async (threadId) => (await api.threads.messages(threadId)).messages,
    body: (messageId, options) => api.messages.body(messageId, options),
    draft: (draftId) => api.drafts.get(draftId),
    attachment: (attachmentId) => api.attachments.bytes(attachmentId),
    requestBrief: (workspaceId, threadId, trigger) =>
      api.briefs.compute(workspaceId, threadId, trigger),
    async uploadBlob(workspaceId, file, onProgress) {
      const started = await api.blobs.start(workspaceId, {
        name: file.name,
        mediaType: file.mediaType,
        size: file.bytes.length,
      });
      onProgress?.(0);
      for (let i = 0; i < started.chunkCount; i++) {
        const part = file.bytes.subarray(
          i * started.chunkSize,
          Math.min((i + 1) * started.chunkSize, file.bytes.length),
        );
        await api.blobs.chunk(started.id, i, part);
        onProgress?.((i + 1) / started.chunkCount);
      }
      return { blobId: started.id };
    },
  };
}

function parseWake(data: unknown): number | null {
  if (typeof data !== "string") return null;
  try {
    const parsed = JSON.parse(data) as { seq?: unknown };
    return typeof parsed.seq === "number" ? parsed.seq : null;
  } catch {
    return null;
  }
}

function connectWebSocket(api: Api, workspaceId: Id, handlers: WakeHandlers): WakeConnection {
  const url = api.wakeUrl("/changes/ws", workspaceId);
  if (!url || typeof WebSocket === "undefined") {
    queueMicrotask(handlers.onClose);
    return { close() {} };
  }
  let closed = false;
  const socket = new WebSocket(url.replace(/^http/, "ws"));
  socket.onopen = () => handlers.onOpen();
  socket.onmessage = (event) => {
    const seq = parseWake(event.data);
    if (seq !== null) handlers.onWake(seq);
  };
  socket.onclose = () => {
    if (!closed) handlers.onClose();
  };
  socket.onerror = () => {
    // onclose follows; nothing to do here.
  };
  return {
    close() {
      closed = true;
      socket.close();
    },
  };
}

function connectSse(api: Api, workspaceId: Id, handlers: WakeHandlers): WakeConnection {
  const url = api.wakeUrl("/changes/sse", workspaceId);
  if (!url || typeof EventSource === "undefined") {
    queueMicrotask(handlers.onClose);
    return { close() {} };
  }
  let closed = false;
  const source = new EventSource(url);
  source.onopen = () => handlers.onOpen();
  source.addEventListener("wake", (event) => {
    const seq = parseWake((event as MessageEvent).data);
    if (seq !== null) handlers.onWake(seq);
  });
  source.onerror = () => {
    // EventSource reconnects on its own; the Store's backoff only takes over once we close it.
    if (source.readyState === EventSource.CLOSED && !closed) handlers.onClose();
  };
  return {
    close() {
      closed = true;
      source.close();
    },
  };
}

function connectPolling(handlers: WakeHandlers, intervalMs = POLL_INTERVAL_MS): WakeConnection {
  const timer = setInterval(() => handlers.onWake(-1), intervalMs);
  queueMicrotask(handlers.onOpen);
  return {
    close() {
      clearInterval(timer);
    },
  };
}
