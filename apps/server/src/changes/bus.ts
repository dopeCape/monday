// The in-process side of the Changes feed wake path. Mailstore.recordChange
// runs `pg_notify` inside the writing transaction; a LISTEN connection (one per
// process that holds connections) turns each notification into a ChangeBus
// event; the WebSocket and SSE transports subscribe to the bus per Workspace and
// send `{seq}` so the client fetches from its cursor. Servers never talk to each
// other: a Cloud write reaches a Sidecar's clients through Postgres alone
// (ADR 0005). No Bun or Node APIs here.

import type { Id, WakeMessage } from "@monday/shared";
import postgres, { type Sql } from "postgres";

export const CHANGES_CHANNEL = "monday_changes";

export interface ChangeNotice extends WakeMessage {
  workspaceId: Id;
}

export type ChangeListener = (notice: ChangeNotice) => void;

export interface ChangeBus {
  /** Fan a notice out to this process's listeners for its Workspace. */
  emit(notice: ChangeNotice): void;
  /** Called for every notice in the Workspace until the returned function runs. */
  subscribe(workspaceId: Id, listener: ChangeListener): () => void;
  /** How many listeners a Workspace has; for tests and the health page. */
  listenerCount(workspaceId: Id): number;
}

export function createChangeBus(): ChangeBus {
  const listeners = new Map<Id, Set<ChangeListener>>();
  return {
    emit(notice) {
      const set = listeners.get(notice.workspaceId);
      if (!set) return;
      for (const listener of [...set]) {
        try {
          listener(notice);
        } catch (error) {
          console.error(error);
        }
      }
    },
    subscribe(workspaceId, listener) {
      let set = listeners.get(workspaceId);
      if (!set) {
        set = new Set();
        listeners.set(workspaceId, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(workspaceId);
      };
    },
    listenerCount(workspaceId) {
      return listeners.get(workspaceId)?.size ?? 0;
    },
  };
}

/** The NOTIFY payload Mailstore.recordChange sends. */
export function encodeNotice(notice: ChangeNotice): string {
  return JSON.stringify({ w: notice.workspaceId, s: notice.seq });
}

export function decodeNotice(payload: string): ChangeNotice | null {
  try {
    const parsed = JSON.parse(payload) as { w?: unknown; s?: unknown };
    if (typeof parsed.w !== "string" || typeof parsed.s !== "number") return null;
    return { workspaceId: parsed.w, seq: parsed.s };
  } catch {
    return null;
  }
}

export interface ChangeListenerHandle {
  stop(): Promise<void>;
}

/**
 * LISTENs on an unpooled connection and feeds the bus. The entry starts one of
 * these in Sidecar and container mode; serverless modes rely on the SSE route's
 * poll fallback instead.
 */
export async function listenForChanges(
  url: string,
  bus: ChangeBus,
  options: { onError?: (error: unknown) => void } = {},
): Promise<ChangeListenerHandle> {
  const sql: Sql = postgres(url, { max: 1, onnotice: () => {} });
  const handle = await sql.listen(
    CHANGES_CHANNEL,
    (payload) => {
      const notice = decodeNotice(payload);
      if (notice) bus.emit(notice);
    },
    () => {},
  );
  return {
    async stop() {
      await handle.unlisten().catch((error) => options.onError?.(error));
      await sql.end({ timeout: 2 }).catch(() => {});
    },
  };
}
