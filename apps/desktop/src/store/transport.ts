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
  DraftAssistRequest,
  DraftAssistResult,
  DraftIntent,
  Id,
  Intent,
  IntentResult,
  Invite,
  InviteIntent,
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
  /** An Invite's answer to its route (slice 18). */
  inviteIntent(intent: InviteIntent): Promise<IntentResult>;
  /** The titles of Events whose feed rows landed, in one call; absent on a transport without content routes. */
  eventsContent?(
    workspaceId: Id,
    ids: readonly Id[],
  ): Promise<Array<{ id: Id; title: string; description: string; location: string }>>;
  /** An Invite whole (its title is content). Null when the Server has none. */
  invite?(inviteId: Id): Promise<Invite | null>;
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
  /**
   * The judged Sections and custom actions for Threads the rules could not
   * settle alone (slice 26): cached answers, plus the Judge's for what was
   * missing. Absent on a Server without the route.
   */
  sectionJudgments?(
    workspaceId: Id,
    threadIds: readonly Id[],
  ): Promise<Array<{ threadId: Id; rules: Record<string, number> }>>;
  /** The composer's writing assist; absent on a Server without the route. */
  draftAssist?(request: DraftAssistRequest): Promise<DraftAssistResult>;
  /** Whether the assist can answer now. */
  draftAssistAvailable?(workspaceId: Id): Promise<boolean>;
  uploadBlob(
    workspaceId: Id,
    file: { name: string; mediaType: string; bytes: Uint8Array },
    onProgress?: (fraction: number) => void,
  ): Promise<{ blobId: Id }>;
}

export type Realtime = Capabilities["realtime"];

export interface ApiTransportOptions {
  /** What the Server offers; null before /capabilities answered, which reads as polling. */
  capabilities: () => Capabilities | null;
  /** Seconds between pulls when polling (the server.poll_seconds Setting). */
  pollSeconds: () => number;
  /**
   * How many connections in a row may close without ever opening before the
   * transport steps down a rung (WebSocket to SSE to polling), so a proxy that
   * refuses upgrades does not keep the Store reconnecting forever (the
   * server.wake_fallback_after Setting).
   */
  fallbackAfter: () => number;
  log?: (message: string) => void;
}

/** The rungs a wake connection can step down, best first. */
export const REALTIME_LADDER: readonly Realtime[] = ["websocket", "sse", "polling"];

/**
 * The transport picks the wake mode the Server offers, then the next rung
 * down after `fallbackAfter` connections that closed without opening. A
 * connection that opens resets the count; new capabilities reset the rung.
 */
export function apiTransport(api: Api, options: ApiTransportOptions): StoreTransport {
  const log = options.log ?? (() => {});
  let offered: Realtime | null = null;
  let rung = 0;
  let failedWithoutOpen = 0;
  return {
    changes: (workspaceId, since, limit) => api.changes.list(workspaceId, since, limit),
    intent: (intent) => api.threads.intent(intent),
    draftIntent: (workspaceId, intent) => api.drafts.intent(workspaceId, intent),
    brief: (threadId) => api.briefs.get(threadId),
    inviteIntent: (intent) => api.calendar.rsvp(intent),
    eventsContent: (workspaceId, ids) => api.calendar.eventsContent(workspaceId, ids),
    invite: (inviteId) => api.calendar.invite(inviteId),
    connect(workspaceId, handlers) {
      const realtime = options.capabilities()?.realtime ?? "polling";
      if (realtime !== offered) {
        offered = realtime;
        rung = Math.max(0, REALTIME_LADDER.indexOf(realtime));
        failedWithoutOpen = 0;
      }
      const mode = REALTIME_LADDER[rung] ?? "polling";
      let opened = false;
      const watched: WakeHandlers = {
        onOpen() {
          opened = true;
          failedWithoutOpen = 0;
          handlers.onOpen();
        },
        onWake: handlers.onWake,
        onClose() {
          if (!opened && mode !== "polling") {
            failedWithoutOpen += 1;
            if (failedWithoutOpen >= options.fallbackAfter() && rung < REALTIME_LADDER.length - 1) {
              rung += 1;
              failedWithoutOpen = 0;
              log(`wake: ${mode} never opened; falling back to ${REALTIME_LADDER[rung]}`);
            }
          }
          handlers.onClose();
        },
      };
      if (mode === "websocket") return connectWebSocket(api, workspaceId, watched);
      if (mode === "sse") return connectSse(api, workspaceId, watched);
      return connectPolling(watched, options.pollSeconds() * 1000);
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
    sectionJudgments: (workspaceId, threadIds) =>
      api.routing.sectionJudgments(workspaceId, threadIds),
    draftAssist: (request) => api.drafts.assist(request),
    draftAssistAvailable: async (workspaceId) =>
      (await api.drafts.assistAvailable(workspaceId)).available,
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

function connectPolling(handlers: WakeHandlers, intervalMs: number): WakeConnection {
  const timer = setInterval(() => handlers.onWake(-1), intervalMs);
  queueMicrotask(handlers.onOpen);
  return {
    close() {
      clearInterval(timer);
    },
  };
}
