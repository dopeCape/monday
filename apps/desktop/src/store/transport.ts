// What the Store needs from the network, and the implementation over the API
// client. The wake side is one connection at a time: the Store owns reconnect
// and backoff, the transport only reports open, wake and close. The transport
// follows /capabilities: WebSocket for the Sidecar and the container, SSE for
// Vercel, a timer for polling (docs/spec/architecture.md, "Deployment modes").

import type { Capabilities, ChangesPage, Id, Intent, IntentResult } from "@monday/shared";
import type { Api } from "../platform/api.ts";

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
  connect(workspaceId: Id, handlers: WakeHandlers): WakeConnection;
}

/** How often a polling deployment is asked for changes; a Setting once slice 7 lands. */
export const POLL_INTERVAL_MS = 30_000;

export function apiTransport(api: Api, capabilities: () => Capabilities | null): StoreTransport {
  return {
    changes: (workspaceId, since, limit) => api.changes.list(workspaceId, since, limit),
    intent: (intent) => api.threads.intent(intent),
    connect(workspaceId, handlers) {
      const realtime = capabilities()?.realtime ?? "polling";
      if (realtime === "websocket") return connectWebSocket(api, workspaceId, handlers);
      if (realtime === "sse") return connectSse(api, workspaceId, handlers);
      return connectPolling(handlers);
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
