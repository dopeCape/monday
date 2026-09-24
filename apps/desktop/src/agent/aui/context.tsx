// What the tool UIs, the markdown and the thread read besides Assistant UI's
// own state: the Settings' words and behaviors, the clock, and the Session's
// actions. Approvals and Undo go through the Session (ADR 0002), never
// through Assistant UI's tool results. The actions are stable functions over
// the latest Session, so a streamed token does not re-render every card.

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ComposerStrings } from "../composerStrings.ts";
import type { AgentSession } from "../useAgentSession.ts";

export interface ComposerActions {
  approve(activityId: string): void;
  decline(activityId: string): void;
  undo(activityId: string): void;
  retry(): void;
  openThread(threadId: string): void;
  /** Opens a link from an answer outside the app. */
  openLink(href: string): void;
  /** Puts a sent turn back in the bar to edit and send again. */
  recall(text: string): void;
  /** Sends a turn as if typed: Continue after a Stop. */
  send(text: string): void;
  /** Starts a new Session: /new. */
  newSession(): void;
}

export interface ComposerEnv {
  strings: ComposerStrings;
  now: Date;
  actions: ComposerActions;
  /** When the turn in flight started (ms since the epoch), for the Working line's time; null when idle. */
  runStartedAt: number | null;
}

export const ComposerEnvContext = createContext<ComposerEnv | null>(null);

export function useComposerEnv(): ComposerEnv {
  const env = useContext(ComposerEnvContext);
  if (!env) throw new Error("useComposerEnv outside the Composer");
  return env;
}

export interface BarActions {
  recall(text: string): void;
  send(text: string): void;
}

export function useComposerEnvValue(
  agent: AgentSession,
  strings: ComposerStrings,
  now: Date,
  onOpenThread: ((threadId: string) => void) | undefined,
  onOpenLink: (href: string) => void,
  bar: BarActions,
): ComposerEnv {
  const latest = useRef({ agent, onOpenThread, onOpenLink, bar });
  latest.current = { agent, onOpenThread, onOpenLink, bar };
  const actions = useMemo<ComposerActions>(
    () => ({
      approve: (id) => void latest.current.agent.approve(id),
      decline: (id) => void latest.current.agent.decline(id),
      undo: (id) => void latest.current.agent.undo(id),
      retry: () => void latest.current.agent.retry(),
      openThread: (id) => latest.current.onOpenThread?.(id),
      openLink: (href) => latest.current.onOpenLink(href),
      recall: (text) => latest.current.bar.recall(text),
      send: (text) => latest.current.bar.send(text),
      newSession: () => void latest.current.agent.newSession(),
    }),
    [],
  );
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  useEffect(() => {
    setRunStartedAt(agent.busy ? Date.now() : null);
  }, [agent.busy]);
  return useMemo(
    () => ({ strings, now, actions, runStartedAt }),
    [strings, now, actions, runStartedAt],
  );
}

/** Whole seconds since `since`, ticking once a second; 0 without a start. */
export function useElapsedSeconds(since: number | null): number {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    setClock(Date.now());
    const timer = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return since === null ? 0 : Math.max(0, Math.floor((clock - since) / 1000));
}

/**
 * "Working", or "Working for 12s" once a turn has run
 * ai.composer.elapsed_after_seconds; 0 never counts.
 */
export function workingLabel(strings: ComposerStrings, seconds: number): string {
  const after = strings["ai.composer.elapsed_after_seconds"];
  if (after <= 0 || seconds < after) return strings["strings.agent.working"];
  return strings["strings.agent.working_for"].replace("{seconds}", String(seconds));
}
