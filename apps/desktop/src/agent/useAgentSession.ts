// The composer's state over the AgentClient seam: the current Session and
// its transcript, the turn in flight, the calls waiting for the user, the
// history list. One Session per Workspace at a time; a new one starts on the
// plus button, on /new, or after ai.session.new_after_hours of silence.

import type {
  ActivityRecord,
  AgentEvent,
  SessionSummary,
  ToolCall,
  TurnContext,
} from "@monday/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentClient } from "./client.ts";
import { applyEvent, applyEvents, type TranscriptEvent, waitingCalls } from "./transcript.ts";

export interface AgentSessionOptions {
  client: AgentClient | null;
  workspaceId: string;
  /** What every turn carries: the pinned keys, the open Thread. */
  context: () => TurnContext;
  /** Hours of silence after which the composer starts a fresh Session. */
  newAfterHours: number;
  now?: () => Date;
  /** Called after a tool that changed Settings finished, so the Shell re-reads them. */
  onSettingsChanged?: (() => void) | undefined;
}

export interface AgentSession {
  session: SessionSummary | null;
  events: TranscriptEvent[];
  waiting: ToolCall[];
  busy: boolean;
  /** The last transport failure, cleared by the next turn. */
  error: string | null;
  history: SessionSummary[];
  send(text: string): Promise<void>;
  approve(activityId: string): Promise<void>;
  decline(activityId: string): Promise<void>;
  undo(activityId: string): Promise<ActivityRecord | null>;
  newSession(): Promise<void>;
  openSession(id: string): Promise<void>;
  refreshHistory(): Promise<void>;
}

const SETTINGS_TOOLS = new Set(["change_setting", "change_layout", "undo"]);

/** The error a turn reports when no Server is reachable at all. */
export const NO_CLIENT = "no_client";

/** An inert Session for screens mounted without an Agent host: fixtures and tests. */
export const NULL_SESSION: AgentSession = {
  session: null,
  events: [],
  waiting: [],
  busy: false,
  error: null,
  history: [],
  send: async () => {},
  approve: async () => {},
  decline: async () => {},
  undo: async () => null,
  newSession: async () => {},
  openSession: async () => {},
  refreshHistory: async () => {},
};

export function useAgentSession(options: AgentSessionOptions): AgentSession {
  const { client, workspaceId, newAfterHours } = options;
  const nowRef = useRef(options.now ?? (() => new Date()));
  nowRef.current = options.now ?? nowRef.current;
  const now = useCallback(() => nowRef.current(), []);
  const [session, setSession] = useState<SessionSummary | null>(null);
  const [events, setEvents] = useState<TranscriptEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<SessionSummary[]>([]);
  const contextRef = useRef(options.context);
  contextRef.current = options.context;
  const settingsChangedRef = useRef(options.onSettingsChanged);
  settingsChangedRef.current = options.onSettingsChanged;
  const sessionRef = useRef<SessionSummary | null>(null);
  sessionRef.current = session;

  const onEvent = useCallback((event: AgentEvent) => {
    setEvents((current) => applyEvent(current, event));
    if (
      event.kind === "tool" &&
      event.call.status === "done" &&
      SETTINGS_TOOLS.has(event.call.tool)
    ) {
      settingsChangedRef.current?.();
    }
  }, []);

  const refreshHistory = useCallback(async () => {
    if (!client) return;
    try {
      setHistory(await client.listSessions(workspaceId));
    } catch {
      // Offline: the history keeps what it had.
    }
  }, [client, workspaceId]);

  /** The Session to send to: the current one, the latest recent one, or a new one. */
  const ensureSession = useCallback(async (): Promise<SessionSummary> => {
    if (!client) throw new Error("no agent client");
    const current = sessionRef.current;
    if (current) return current;
    const recent = (await client.listSessions(workspaceId))[0];
    const fresh =
      recent && now().getTime() - Date.parse(recent.lastActivity) < newAfterHours * 3_600_000;
    if (recent && fresh) {
      const loaded = await client.load(recent.id);
      setSession(loaded.session);
      sessionRef.current = loaded.session;
      setEvents(applyEvents([], loaded.events));
      return loaded.session;
    }
    const created = await client.createSession(workspaceId);
    setSession(created);
    sessionRef.current = created;
    setEvents([]);
    return created;
  }, [client, workspaceId, newAfterHours, now]);

  // Resume the Workspace's latest Session on mount, when one is fresh.
  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    void (async () => {
      try {
        const recent = (await client.listSessions(workspaceId))[0];
        if (cancelled || !recent) return;
        const fresh = now().getTime() - Date.parse(recent.lastActivity) < newAfterHours * 3_600_000;
        if (!fresh) return;
        const loaded = await client.load(recent.id);
        if (cancelled) return;
        setSession(loaded.session);
        setEvents(applyEvents([], loaded.events));
      } catch {
        // No Server yet; the first turn creates the Session.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, workspaceId, newAfterHours, now]);

  const run = useCallback(
    async (work: (s: SessionSummary) => Promise<void>) => {
      if (!client) {
        setError(NO_CLIENT);
        return;
      }
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        const s = await ensureSession();
        await work(s);
        void refreshHistory();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [client, busy, ensureSession, refreshHistory],
  );

  const newSession = useCallback(async () => {
    if (!client) return;
    setSession(null);
    sessionRef.current = null;
    setEvents([]);
    setError(null);
    try {
      const created = await client.createSession(workspaceId);
      setSession(created);
      sessionRef.current = created;
      void refreshHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client, workspaceId, refreshHistory]);

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return Promise.resolve();
      if (trimmed === "/new") return newSession();
      return run(
        (s) => client?.turn(s.id, trimmed, contextRef.current(), onEvent) ?? Promise.resolve(),
      );
    },
    [client, run, onEvent, newSession],
  );

  const approve = useCallback(
    (activityId: string) =>
      run(
        (s) =>
          client?.approve(s.id, activityId, "approved", contextRef.current(), onEvent) ??
          Promise.resolve(),
      ),
    [client, run, onEvent],
  );

  const decline = useCallback(
    (activityId: string) =>
      run(
        (s) =>
          client?.approve(s.id, activityId, "declined", contextRef.current(), onEvent) ??
          Promise.resolve(),
      ),
    [client, run, onEvent],
  );

  const undo = useCallback(
    async (activityId: string): Promise<ActivityRecord | null> => {
      if (!client) return null;
      try {
        const result = await client.undo(activityId, sessionRef.current?.id ?? null);
        setEvents((current) =>
          current.map((e) =>
            e.kind === "tool" && e.call.id === activityId
              ? { ...e, call: { ...e.call, undoable: false, undoneAt: result.at } }
              : e,
          ),
        );
        settingsChangedRef.current?.();
        return result;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return null;
      }
    },
    [client],
  );

  const openSession = useCallback(
    async (id: string) => {
      if (!client) return;
      try {
        const loaded = await client.load(id);
        setSession(loaded.session);
        sessionRef.current = loaded.session;
        setEvents(applyEvents([], loaded.events));
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [client],
  );

  const waiting = useMemo(() => waitingCalls(events), [events]);

  return {
    session,
    events,
    waiting,
    busy,
    error,
    history,
    send,
    approve,
    decline,
    undo,
    newSession,
    openSession,
    refreshHistory,
  };
}
