// The WebSocket wake transport for the Changes feed, Bun only (Sidecar and
// container). The Hono app stays a fetch handler; this module gives Bun.serve
// the upgrade check and the websocket handlers. Browsers and webviews cannot
// set headers on a WebSocket, so the Device token rides in the query string:
//   GET /changes/ws?workspace=<id>&token=<device token>
// Each open socket gets `{seq}` on connect (so the client syncs once) and on
// every change in its Workspace.

import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { Auth } from "../src/auth/index.ts";
import { isLoopbackAddress } from "../src/auth/middleware.ts";
import type { ChangeBus } from "../src/changes/bus.ts";
import type { Mailstore } from "../src/mailstore/index.ts";

export const CHANGES_WS_PATH = "/changes/ws";

export interface SocketData {
  workspaceId: string;
  unsubscribe?: (() => void) | undefined;
}

export interface ChangesSocketOptions {
  auth: Auth;
  bus: ChangeBus;
  mailstore: Mailstore;
}

export interface ChangesSocket {
  /** Handles `/changes/ws`; returns undefined for any other path. */
  upgrade(req: Request, server: Server<SocketData>): Promise<Response | undefined>;
  websocket: WebSocketHandler<SocketData>;
}

export function createChangesSocket(options: ChangesSocketOptions): ChangesSocket {
  const { auth, bus, mailstore } = options;

  const send = (ws: ServerWebSocket<SocketData>, seq: number) => {
    try {
      ws.send(JSON.stringify({ seq }));
    } catch {
      // The socket is closing; its close handler drops the subscription.
    }
  };

  return {
    async upgrade(req, server) {
      const url = new URL(req.url);
      if (url.pathname !== CHANGES_WS_PATH) return undefined;
      const token =
        url.searchParams.get("token") ??
        /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ??
        null;
      const loopback = isLoopbackAddress(server.requestIP(req)?.address);
      const principal = token ? await auth.authenticate(token.trim(), loopback) : null;
      if (!principal) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      const workspaceId = url.searchParams.get("workspace");
      if (!workspaceId) {
        return Response.json({ error: "invalid_query" }, { status: 400 });
      }
      const data: SocketData = { workspaceId };
      if (server.upgrade(req, { data })) return new Response(null, { status: 101 });
      return Response.json({ error: "upgrade_failed" }, { status: 400 });
    },

    websocket: {
      async open(ws) {
        ws.data.unsubscribe = bus.subscribe(ws.data.workspaceId, (notice) => send(ws, notice.seq));
        send(ws, await mailstore.latestSeq(ws.data.workspaceId));
      },
      message() {
        // The client never speaks; the feed is read over HTTP.
      },
      close(ws) {
        ws.data.unsubscribe?.();
        ws.data.unsubscribe = undefined;
      },
    },
  };
}
