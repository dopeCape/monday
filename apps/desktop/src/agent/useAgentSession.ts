// The composer's state over the AgentClient seam: the current Session and
// its transcript, the turn in flight, the calls waiting for the user, the
// history list. One Session per Workspace at a time; a new one starts on the
// plus button, on /new, or after ai.session.new_after_hours of silence.

import type {
  ActivityRecord,
  AgentEvent,
  Runtime,
  RuntimeInfo,
  SessionSummary,
  ToolCall,
  TurnContext,
} from "@monday/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentClient } from "./client.ts";
import { sameRuntime } from "./runtimeLine.ts";
import { applyEvent, applyEvents, type TranscriptEvent, waitingCalls } from "./transcript.ts";

export interface AgentSessionOptions {
  client: AgentClient | null;
  workspaceId: string;
  /** What every turn carries: the pinned keys, the open Thread. */
  context: () => TurnContext;
  /** Hours of silence after which the composer starts a fresh Session. */
  newAfterHours: number;
  /**
   * The Runtime the Settings ask for. A new Session starts on it; an open
   * Session on another Runtime switches before its next turn, with the line
   * in the thread (docs/spec/agent-composer.md, Sessions).
   */
  runtime?: Runtime | null | undefined;
  /** ai.developer_mode_default: what a new Session's Developer mode starts as. */
  developerModeDefault?: boolean | undefined;
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
  /** Which Runtime and model answers now, once known. */
  runtimeInfo: RuntimeInfo | null;
  /** The Session's Developer mode switch; off by default (CONTEXT.md). */
  developerMode: boolean;
  setDeveloperMode(on: boolean): void;
  send(text: string): Promise<void>;
  /**
   * Stops the turn in flight (the composer's Stop): the stream is dropped, a
   * Local runtime's CLI ends, and the thread keeps what already arrived with a
   * Stopped line. Tools that already ran stay in the Activity log with Undo.
   */
  stop(): Promise<void>;
  /** Sends the last text again, after a turn the Server or the CLI refused; nothing when none was sent. */
  retry(): Promise<void>;
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
  runtimeInfo: null,
  developerMode: false,
  setDeveloperMode: () => {},
  send: async () => {},
  stop: async () => {},
  retry: async () => {},
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
  // The turn in flight, read synchronously: two clicks on one card in the same
  // tick must not both reach the Server (the second would apply the call twice).
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<SessionSummary[]>([]);
  const [runtimeInfo, setRuntimeInfo] = useState<RuntimeInfo | null>(null);
  const [developerMode, setDeveloperMode] = useState(options.developerModeDefault ?? false);
  const developerRef = useRef(developerMode);
  developerRef.current = developerMode;
  const runtimeRef = useRef(options.runtime ?? null);
  runtimeRef.current = options.runtime ?? null;
  const contextRef = useRef(options.context);
  contextRef.current = options.context;
  const turnContext = useCallback(
    (): TurnContext => ({ ...contextRef.current(), developerMode: developerRef.current }),
    [],
  );
  const settingsChangedRef = useRef(options.onSettingsChanged);
  settingsChangedRef.current = options.onSettingsChanged;
  const sessionRef = useRef<SessionSummary | null>(null);
  sessionRef.current = session;

  /** The run in flight: its token and the signal Stop aborts. Events of an older run are dropped. */
  const runRef = useRef<{ id: number; controller: AbortController } | null>(null);
  const runSeq = useRef(0);

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
    const created = await client.createSession(workspaceId, runtimeRef.current ?? undefined);
    setSession(created);
    sessionRef.current = created;
    setEvents([]);
    return created;
  }, [client, workspaceId, newAfterHours, now]);

  /** Moves the Session to the Runtime the Settings ask for, when it is on another one. */
  const ensureRuntime = useCallback(
    async (s: SessionSummary): Promise<SessionSummary> => {
      const wanted = runtimeRef.current;
      if (!client || !wanted || sameRuntime(s.runtime, wanted)) return s;
      const line = await client.switchRuntime(s.id, wanted);
      const switched = { ...s, runtime: wanted };
      setSession(switched);
      sessionRef.current = switched;
      setEvents((current) => applyEvent(current, line));
      return switched;
    },
    [client],
  );

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
    async (
      work: (
        s: SessionSummary,
        onEvent: (event: AgentEvent) => void,
        signal: AbortSignal,
      ) => Promise<void>,
    ) => {
      if (!client) {
        setError(NO_CLIENT);
        return;
      }
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      const controller = new AbortController();
      const id = ++runSeq.current;
      runRef.current = { id, controller };
      const current = () => runRef.current?.id === id;
      const live = (event: AgentEvent) => {
        if (current()) onEvent(event);
      };
      try {
        const s = await ensureRuntime(await ensureSession());
        await work(s, live, controller.signal);
        if (!current()) return;
        setRuntimeInfo(client.runtimeOf(s.id));
        void refreshHistory();
      } catch (e) {
        if (controller.signal.aborted || !current()) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (current()) {
          runRef.current = null;
          busyRef.current = false;
          setBusy(false);
        }
      }
    },
    [client, ensureSession, ensureRuntime, refreshHistory, onEvent],
  );

  const stop = useCallback(async () => {
    const current = runRef.current;
    if (!current) return;
    runRef.current = null;
    current.controller.abort();
    busyRef.current = false;
    setBusy(false);
    setEvents((list) => applyEvent(list, { kind: "stopped", id: `stopped-${current.id}` }));
    void refreshHistory();
  }, [refreshHistory]);

  /** A Session switch leaves a turn in flight to finish on the Server, but its events no longer land here. */
  const detachRun = useCallback(() => {
    if (!runRef.current) return;
    runRef.current = null;
    busyRef.current = false;
    setBusy(false);
  }, []);

  const newSession = useCallback(async () => {
    if (!client) return;
    detachRun();
    setSession(null);
    sessionRef.current = null;
    setEvents([]);
    setError(null);
    try {
      const created = await client.createSession(workspaceId, runtimeRef.current ?? undefined);
      setSession(created);
      sessionRef.current = created;
      setRuntimeInfo(client.runtimeOf(created.id));
      setDeveloperMode(options.developerModeDefault ?? false);
      void refreshHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [client, workspaceId, refreshHistory, options.developerModeDefault, detachRun]);

  /** The last text sent, for Retry after a refused turn. */
  const lastTextRef = useRef<string | null>(null);
  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return Promise.resolve();
      if (trimmed === "/new") return newSession();
      lastTextRef.current = trimmed;
      return run(
        (s, live, signal) =>
          client?.turn(s.id, trimmed, turnContext(), live, signal) ?? Promise.resolve(),
      );
    },
    [client, run, newSession, turnContext],
  );
  const retry = useCallback(() => {
    const text = lastTextRef.current;
    return text ? send(text) : Promise.resolve();
  }, [send]);

  const approve = useCallback(
    (activityId: string) =>
      run(
        (s, live, signal) =>
          client?.approve(s.id, activityId, "approved", turnContext(), live, signal) ??
          Promise.resolve(),
      ),
    [client, run, turnContext],
  );

  const decline = useCallback(
    (activityId: string) =>
      run(
        (s, live, signal) =>
          client?.approve(s.id, activityId, "declined", turnContext(), live, signal) ??
          Promise.resolve(),
      ),
    [client, run, turnContext],
  );

  /** Undos in flight, so a second click on the same card is a no-op. */
  const undoing = useRef(new Set<string>());
  const undo = useCallback(
    async (activityId: string): Promise<ActivityRecord | null> => {
      if (!client || undoing.current.has(activityId)) return null;
      undoing.current.add(activityId);
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
      } finally {
        undoing.current.delete(activityId);
      }
    },
    [client],
  );

  const openSession = useCallback(
    async (id: string) => {
      if (!client) return;
      detachRun();
      try {
        const loaded = await client.load(id);
        setSession(loaded.session);
        sessionRef.current = loaded.session;
        setEvents(applyEvents([], loaded.events));
        setRuntimeInfo(client.runtimeOf(loaded.session.id));
        // Developer mode is per Session (CONTEXT.md): another Session starts from the default.
        setDeveloperMode(options.developerModeDefault ?? false);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [client, options.developerModeDefault, detachRun],
  );

  const waiting = useMemo(() => waitingCalls(events), [events]);

  // Before the first turn answers, the line shows the Session's own Runtime.
  const info = useMemo(
    () =>
      runtimeInfo ??
      (session
        ? {
            runtime: session.runtime,
            model:
              session.runtime.kind === "hosted"
                ? session.runtime.model
                : (session.runtime.model ?? null),
          }
        : null),
    [runtimeInfo, session],
  );

  return {
    session,
    events,
    waiting,
    busy,
    error,
    history,
    runtimeInfo: info,
    developerMode,
    setDeveloperMode,
    send,
    stop,
    retry,
    approve,
    decline,
    undo,
    newSession,
    openSession,
    refreshHistory,
  };
}
