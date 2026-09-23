// Assistant UI over monday's AgentClient seam. The state stays the Session's
// (useAgentSession over the Server's SSE turns): this adapter only projects
// it. Assistant UI's external-store runtime reads the transcript as messages
// and calls back for what the user does:
//
//   send (Enter, a suggestion)  -> onNew     -> agent.send (a turn, or /new)
//   Stop                        -> onCancel  -> agent.stop
//   the thread list             -> threadList: History is agent.history,
//                                  "new" is agent.newSession, a row is agent.openSession
//
// Approvals and Undo never pass through here: the tool UIs call the Session
// directly, so the tiers and the Activity log stay the Server's (ADR 0002).

import {
  type AppendMessage,
  type ExternalStoreThreadListAdapter,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { useMemo, useRef } from "react";
import type { AgentSession } from "../useAgentSession.ts";
import { createMessageCache } from "./messages.ts";

const identity = (message: ThreadMessageLike) => message;

/** The plain text of what the user sent. */
export function textOf(message: AppendMessage): string {
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n")
    .trim();
}

export interface MondayRuntimeOptions {
  /** Sends one user text: the screen clears its own copy first, then the Session takes it. */
  onSend: (text: string) => void;
}

export function useMondayRuntime(agent: AgentSession, options: MondayRuntimeOptions) {
  const toMessages = useMemo(() => createMessageCache(), []);
  const messages = useMemo(() => toMessages(agent.events), [toMessages, agent.events]);
  const latest = useRef({ agent, options });
  latest.current = { agent, options };

  const threadList = useMemo<ExternalStoreThreadListAdapter>(
    () => ({
      threadId: agent.session?.id,
      threads: agent.history.map((s) => ({
        status: "regular" as const,
        id: s.id,
        remoteId: s.id,
        ...(s.title ? { title: s.title } : {}),
      })),
      onSwitchToNewThread: () => latest.current.agent.newSession(),
      onSwitchToThread: (id: string) => latest.current.agent.openSession(id),
    }),
    [agent.session?.id, agent.history],
  );

  return useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    isRunning: agent.busy,
    convertMessage: identity,
    // The turn streams into the Session's state; the runtime does not wait on it.
    onNew: async (message) => {
      const text = textOf(message);
      if (text) latest.current.options.onSend(text);
    },
    onCancel: () => latest.current.agent.stop(),
    adapters: { threadList },
    unstable_capabilities: { copy: true },
  });
}
