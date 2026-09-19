// The Device's line to the Server for a Session a Local runtime drives
// (ADR 0002). The CLI's tool calls land on the Server over MCP, so
// the Server owns every tool card; the Device learns of them here, persists
// what the CLI said here, and answers a waiting card here. The Api
// implementation talks to the routes; tests hand an in-process Agent host.

import type { AgentEvent, ApprovalDecision, Runtime, TurnContext } from "@monday/shared";
import type { Api } from "../../platform/api.ts";

export interface SessionLink {
  /** The Server's own events for the Session as they happen: the tool cards of MCP calls. */
  live(sessionId: string, listener: (event: AgentEvent) => void): () => void;
  /** Persists what the CLI said. Deltas are never persisted. */
  append(sessionId: string, event: AgentEvent): Promise<void>;
  /** Answers a waiting card and streams the card as it moves on. */
  approve(
    sessionId: string,
    activityId: string,
    decision: ApprovalDecision,
    context: TurnContext,
    onEvent: (event: AgentEvent) => void,
  ): Promise<void>;
  /** Records the Session's move to another Runtime; returns the line the thread shows. */
  switchRuntime(sessionId: string, runtime: Runtime): Promise<AgentEvent>;
}

export function apiSessionLink(api: Api): SessionLink {
  return {
    live: (sessionId, listener) => api.agent.live(sessionId, listener),
    append: (sessionId, event) => api.agent.appendEvent(sessionId, event),
    approve: (sessionId, activityId, decision, context, onEvent) =>
      api.agent.approve(sessionId, activityId, decision, context, onEvent),
    switchRuntime: (sessionId, runtime) => api.agent.switchRuntime(sessionId, runtime),
  };
}

/** Waits for the next live event that satisfies `match`, without missing one that already arrived. */
export function createLiveWatch(link: SessionLink, sessionId: string) {
  const seen: AgentEvent[] = [];
  const waiters: Array<{ match: (e: AgentEvent) => boolean; resolve: (e: AgentEvent) => void }> =
    [];
  const listeners = new Set<(event: AgentEvent) => void>();
  const stop = link.live(sessionId, (event) => {
    seen.push(event);
    for (const l of listeners) l(event);
    for (const w of [...waiters]) {
      if (w.match(event)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(event);
      }
    }
  });
  return {
    /** Every listener sees every event, in order. */
    onEvent(listener: (event: AgentEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** The events so far, for tests and for a late reader. */
    seen,
    next(match: (e: AgentEvent) => boolean): Promise<AgentEvent> {
      return new Promise((resolve) => waiters.push({ match, resolve }));
    },
    stop,
  };
}
