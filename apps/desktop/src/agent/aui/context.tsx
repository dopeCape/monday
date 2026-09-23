// What the tool UIs, the markdown and the thread read besides Assistant UI's
// own state: the Settings' words and behaviors, the clock, and the Session's
// actions. Approvals and Undo go through the Session (ADR 0002), never
// through Assistant UI's tool results. The actions are stable functions over
// the latest Session, so a streamed token does not re-render every card.

import { createContext, useContext, useMemo, useRef } from "react";
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
}

export interface ComposerEnv {
  strings: ComposerStrings;
  now: Date;
  actions: ComposerActions;
}

export const ComposerEnvContext = createContext<ComposerEnv | null>(null);

export function useComposerEnv(): ComposerEnv {
  const env = useContext(ComposerEnvContext);
  if (!env) throw new Error("useComposerEnv outside the Composer");
  return env;
}

export function useComposerEnvValue(
  agent: AgentSession,
  strings: ComposerStrings,
  now: Date,
  onOpenThread: ((threadId: string) => void) | undefined,
  onOpenLink: (href: string) => void,
): ComposerEnv {
  const latest = useRef({ agent, onOpenThread, onOpenLink });
  latest.current = { agent, onOpenThread, onOpenLink };
  const actions = useMemo<ComposerActions>(
    () => ({
      approve: (id) => void latest.current.agent.approve(id),
      decline: (id) => void latest.current.agent.decline(id),
      undo: (id) => void latest.current.agent.undo(id),
      retry: () => void latest.current.agent.retry(),
      openThread: (id) => latest.current.onOpenThread?.(id),
      openLink: (href) => latest.current.onOpenLink(href),
    }),
    [],
  );
  return useMemo(() => ({ strings, now, actions }), [strings, now, actions]);
}
