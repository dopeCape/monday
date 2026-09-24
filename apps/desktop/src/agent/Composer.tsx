// The composer (docs/spec/agent-composer.md) on Assistant UI: the Session's
// thread of turns with streamed Markdown answers, tool cards by tier with the
// preview and Approve or Apply and Cancel while a call waits, Undo once it
// applied, read-only steps folded into one line, suggestion chips when the
// Session is empty, and History as the thread list. In bottom-bar mode it
// sits in the AgentDock and rises above the bar; in column mode it is the
// whole column. The state and every action come from useAgentSession; the
// adapter in aui/runtime.ts only projects them into Assistant UI.

import { AssistantRuntimeProvider } from "@assistant-ui/react";
import {
  AgentColumn,
  AgentDock,
  AgentPanel,
  Chip,
  Icon,
  motionMs,
  type Suggestion,
} from "@monday/ui";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { openExternal } from "../platform/open.ts";
import { ComposerEnvContext, useComposerEnvValue } from "./aui/context.tsx";
import { useMondayRuntime } from "./aui/runtime.ts";
import {
  Bar,
  DeveloperRow,
  HistoryList,
  Suggestions,
  ThreadView,
  useNewThread,
} from "./aui/Thread.tsx";
import { MondayToolUIs } from "./aui/tools.tsx";
import type { ComposerStrings } from "./composerStrings.ts";
import { type AgentSession, NO_CLIENT } from "./useAgentSession.ts";

export {
  ComposerMentionsContext,
  type MentionItem,
  mentionItems,
} from "./aui/mentions.tsx";
export { PreviewView } from "./aui/tools.tsx";
export { type ComposerStrings, composerStrings } from "./composerStrings.ts";

export interface ComposerProps {
  agent: AgentSession;
  mode: "bottom" | "left" | "right";
  /** The header line: the Runtime and the Workspace address. */
  runtime: string;
  strings: ComposerStrings;
  suggestions: readonly Suggestion[];
  now: Date;
  /** Bottom-bar mode: whether the panel is raised above the bar. */
  open?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  placeholder: string;
  /** The bar's text, owned by the screen so the palette and "Ask" can prefill it. */
  text: string;
  onTextChange: (text: string) => void;
  onOpenThread?: ((threadId: string) => void) | undefined;
  /** A chip with layout knobs is applied by the screen; every chip is also sent as a turn. */
  onSuggest?: ((suggestion: Suggestion) => void) | undefined;
  /**
   * Quick replies shown right above the input for the whole conversation, not
   * only while it is empty (the onboarding questions' chips). A click sends it.
   */
  replies?: readonly string[] | undefined;
  /** One conversation only: no new, history or Developer mode (the onboarding conversation). */
  plain?: boolean | undefined;
  /** Clicking the header's runtime line opens Settings, AI and agent. */
  onOpenRuntime?: (() => void) | undefined;
  /** A card the screen shows above the thread without a Session: the palette's scheduling card (slice 27). */
  card?: ReactNode | undefined;
  /** Opens a link from an answer; the system browser through the platform by default. */
  onOpenLink?: ((href: string) => void) | undefined;
}

const openLink = (href: string) => void openExternal(href);

export function Composer(props: ComposerProps) {
  const { agent, strings, now, text, onTextChange, onOpenThread } = props;
  const onSend = (value: string) => {
    if (!value.trim()) return;
    onTextChange("");
    void agent.send(value);
  };
  const runtime = useMondayRuntime(agent, { onSend });
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const env = useComposerEnvValue(agent, strings, now, onOpenThread, props.onOpenLink ?? openLink, {
    // Edit and resend: the turn's words go back in the bar, focused at their end.
    recall: (value) => {
      onTextChange(value);
      requestAnimationFrame(() => {
        const input = inputRef.current;
        if (!input) return;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      });
    },
    // Continue: a turn of its own that leaves the bar's draft alone.
    send: (value) => void agent.send(value),
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <MondayToolUIs />
      <ComposerEnvContext.Provider value={env}>
        <ComposerBody {...props} text={text} inputRef={inputRef} />
      </ComposerEnvContext.Provider>
    </AssistantRuntimeProvider>
  );
}

function ComposerBody({
  inputRef,
  agent,
  mode,
  runtime,
  strings,
  suggestions,
  replies,
  open = true,
  onOpenChange,
  placeholder,
  text,
  onTextChange,
  onSuggest,
  plain = false,
  onOpenRuntime,
  card,
}: ComposerProps & { inputRef: RefObject<HTMLTextAreaElement | null> }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const newThread = useNewThread();
  // Bottom bar: a collapsing panel stays mounted for one sink (--t-med), then goes.
  const [shown, setShown] = useState(open);
  const leaving = shown && !open;
  useEffect(() => {
    if (open) {
      setShown(true);
      return;
    }
    const ms = motionMs("--t-med");
    if (ms <= 0) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(false), ms);
    return () => clearTimeout(timer);
  }, [open]);
  // Raised from elsewhere (/, Ask, the palette): the input takes the typing.
  const wasOpen = useRef(open);
  useEffect(() => {
    if (mode === "bottom" && open && !wasOpen.current) {
      const input = inputRef.current;
      if (input && document.activeElement !== input) input.focus();
    }
    wasOpen.current = open;
  }, [open, mode, inputRef]);

  const onNew = () => {
    setHistoryOpen(false);
    newThread();
  };
  const toggleHistory = () => {
    setHistoryOpen((o) => !o);
    if (!historyOpen) void agent.refreshHistory();
  };
  const openSession = (id: string) => {
    onOpenChange?.(true);
    void agent.openSession(id);
  };

  const local = agent.runtimeInfo?.runtime.kind === "local";
  const error = agent.error ? (
    <div className="agent-error" role="alert">
      <Icon icon={WarningCircleIcon} />
      <span>{agent.error === NO_CLIENT ? strings["strings.agent.no_session"] : agent.error}</span>
      {agent.error !== NO_CLIENT ? (
        <Chip onClick={() => void agent.retry()}>{strings["strings.agent.retry"]}</Chip>
      ) : null}
    </div>
  ) : null;
  const thread = (
    <>
      {local && !plain ? (
        <DeveloperRow
          on={agent.developerMode}
          onToggle={() => agent.setDeveloperMode(!agent.developerMode)}
        />
      ) : null}
      <ThreadView card={card} error={error} />
    </>
  );
  const body = historyOpen ? (
    <HistoryList history={agent.history} onPicked={() => setHistoryOpen(false)} />
  ) : (
    thread
  );
  const chips =
    replies && replies.length > 0 && !historyOpen ? (
      <Suggestions
        suggestions={replies.map((label) => ({ label }))}
        onSuggest={onSuggest}
        onOpenSession={openSession}
      />
    ) : agent.events.length === 0 && !historyOpen && !card ? (
      <Suggestions suggestions={suggestions} onSuggest={onSuggest} onOpenSession={openSession} />
    ) : null;
  const labels = {
    new: strings["strings.agent.new"],
    history: strings["strings.agent.history"],
    collapse: strings["strings.agent.collapse"],
    runtime: strings["strings.agent.open_runtime"],
  };

  if (mode === "bottom") {
    return (
      <AgentDock>
        {open || shown ? (
          <AgentPanel
            runtime={runtime}
            onRuntime={onOpenRuntime}
            onNew={onNew}
            onHistory={toggleHistory}
            onClose={() => onOpenChange?.(false)}
            labels={labels}
            className={leaving ? "leaving" : undefined}
          >
            {body}
            {chips}
          </AgentPanel>
        ) : null}
        <Bar
          placeholder={placeholder}
          text={text}
          onTextChange={onTextChange}
          onFocus={() => onOpenChange?.(true)}
          inputRef={inputRef}
          commands={!plain}
        />
      </AgentDock>
    );
  }

  return (
    <AgentColumn
      side={mode}
      runtime={runtime}
      onRuntime={onOpenRuntime}
      onNew={onNew}
      onHistory={toggleHistory}
      labels={labels}
      bare={plain}
    >
      {body}
      {chips}
      <Bar
        placeholder={placeholder}
        text={text}
        onTextChange={onTextChange}
        inputRef={inputRef}
        commands={!plain}
      />
    </AgentColumn>
  );
}
