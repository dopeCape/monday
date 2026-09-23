// The thread and the composer bar on Assistant UI's primitives (Mosaic's
// thread.tsx, in monday's CSS): user turns as bubbles, the agent's turns as
// streamed Markdown with the tool UIs in the order they happened, read-only
// steps folded into one line, a quiet "Working" while nothing streams, Copy
// on a finished answer, a jump to the latest turn, and the bar: a growing
// input (Enter sends, Shift-Enter is a new line, Up recalls what was sent),
// Send, and Stop while a turn runs.

import {
  ActionBarPrimitive,
  AuiIf,
  ComposerPrimitive,
  type DataMessagePartProps,
  MessagePrimitive,
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  ThreadPrimitive,
  unstable_useComposerInputHistory,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import type { SessionSummary } from "@monday/shared";
import { Btn, Chip, formatListTime, Icon, Mark, type Suggestion } from "@monday/ui";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  CopyIcon,
  StopIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { type Ref, useEffect, useRef } from "react";
import { fill } from "../composerStrings.ts";
import { runtimeLabel } from "../runtimeLine.ts";
import { useComposerEnv } from "./context.tsx";
import { AgentText } from "./Markdown.tsx";
import type { LineData } from "./messages.ts";
import { groupSteps, StepsGroup, ToolFallback } from "./tools.tsx";

/* ------------------------------ Messages ------------------------------ */

function UserMessage() {
  return (
    <MessagePrimitive.Root className="u">
      <MessagePrimitive.Parts>
        {({ part }) => (part.type === "text" ? <span className="ut">{part.text}</span> : null)}
      </MessagePrimitive.Parts>
    </MessagePrimitive.Root>
  );
}

/** A line between turns: the Runtime now answering, or where the user stopped a turn. */
function Line({ data }: { data: LineData }) {
  const { strings } = useComposerEnv();
  if (data.kind === "stopped") {
    return <div className="line stopped">{strings["strings.agent.stopped"]}</div>;
  }
  return (
    <div className="line">
      {fill(strings["strings.agent.runtime_switched"], { runtime: runtimeLabel(data.runtime) })}
    </div>
  );
}

/**
 * "Working" while the turn runs and nothing streams: before the first token,
 * and in the gap after a card before the next one. Streaming text and a
 * running card are their own feedback.
 */
function Working() {
  const { strings } = useComposerEnv();
  const show = useAuiState((s) => {
    if (s.message.status?.type !== "running") return false;
    const last = s.message.parts.at(-1);
    if (!last) return true;
    if (last.type === "text" && last.text.trim().length > 0) return false;
    return true;
  });
  if (!show) return null;
  return (
    <div className="agent-working" role="status">
      <span className="label">{strings["strings.agent.working"]}</span>
    </div>
  );
}

/** Copy under a finished answer, shown on hover and always on the last one. */
function AnswerActions() {
  const { strings } = useComposerEnv();
  return (
    <ActionBarPrimitive.Root className="agent-answer-acts" hideWhenRunning autohide="not-last">
      <ActionBarPrimitive.Copy asChild>
        <Btn icon sm title={strings["strings.agent.copy"]}>
          <AuiIf condition={(s) => s.message.isCopied}>
            <Icon icon={CheckIcon} />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <Icon icon={CopyIcon} />
          </AuiIf>
        </Btn>
      </ActionBarPrimitive.Copy>
    </ActionBarPrimitive.Root>
  );
}

function AssistantMessage() {
  const hasText = useAuiState((s) =>
    s.message.parts.some((p) => p.type === "text" && p.text.trim().length > 0),
  );
  return (
    <MessagePrimitive.Root className="a">
      <MessagePrimitive.GroupedParts groupBy={groupSteps} indicator="never">
        {({ part, children }) => {
          switch (part.type) {
            case "group-steps":
              return <StepsGroup indices={part.indices}>{children}</StepsGroup>;
            case "text":
              return <AgentText />;
            case "tool-call":
              return part.toolUI ?? <ToolFallback {...part} />;
            case "data":
              return part.name === "line" ? (
                <Line data={(part as DataMessagePartProps<LineData>).data} />
              ) : null;
            default:
              return null;
          }
        }}
      </MessagePrimitive.GroupedParts>
      <Working />
      {hasText ? <AnswerActions /> : null}
    </MessagePrimitive.Root>
  );
}

function Message() {
  const role = useAuiState((s) => s.message.role);
  return role === "user" ? <UserMessage /> : <AssistantMessage />;
}

/* ------------------------------ Thread ------------------------------ */

export interface ThreadViewProps {
  /** A card the screen shows above the thread without a Session (the palette's scheduling card). */
  card?: React.ReactNode | undefined;
  /** The error line under the thread, with Retry when a turn can be sent again. */
  error?: React.ReactNode | undefined;
}

/** The scrolling thread: the screen's card, the turns, the error line, and the jump to the latest. */
export function ThreadView({ card, error }: ThreadViewProps) {
  const { strings } = useComposerEnv();
  return (
    <ThreadPrimitive.Viewport className="agent-thread">
      {card ? <div className="a">{card}</div> : null}
      <ThreadPrimitive.Messages>{() => <Message />}</ThreadPrimitive.Messages>
      {error}
      <ThreadPrimitive.ScrollToBottom asChild>
        <Btn icon sm className="agent-latest" title={strings["strings.agent.latest"]}>
          <Icon icon={ArrowDownIcon} />
        </Btn>
      </ThreadPrimitive.ScrollToBottom>
    </ThreadPrimitive.Viewport>
  );
}

/* ------------------------------ Suggestions ------------------------------ */

/**
 * The chips of an empty Session, as Assistant UI suggestions: a click sends
 * the sentence as a turn. A chip that points at a waiting external card opens
 * that Session instead; a chip with Layout knobs is also applied by the screen.
 */
export function Suggestions({
  suggestions,
  onSuggest,
  onOpenSession,
}: {
  suggestions: readonly Suggestion[];
  onSuggest?: ((s: Suggestion) => void) | undefined;
  onOpenSession: (id: string) => void;
}) {
  if (suggestions.length === 0) return null;
  return (
    <div className="agent-suggest">
      {suggestions.map((s) =>
        s.session ? (
          <Chip
            key={s.label}
            onClick={() => {
              onSuggest?.(s);
              onOpenSession(s.session as string);
            }}
          >
            {s.label}
          </Chip>
        ) : (
          <ThreadPrimitive.Suggestion key={s.label} prompt={s.label} send asChild>
            <Chip onClick={() => onSuggest?.(s)}>{s.label}</Chip>
          </ThreadPrimitive.Suggestion>
        ),
      )}
    </div>
  );
}

/* ------------------------------ History ------------------------------ */

function HistoryRow({
  history,
  onPicked,
}: {
  history: readonly SessionSummary[];
  onPicked: () => void;
}) {
  const { strings, now } = useComposerEnv();
  const id = useAuiState((s) => s.threadListItem.remoteId ?? s.threadListItem.id);
  const session = history.find((h) => h.id === id);
  return (
    <ThreadListItemPrimitive.Trigger className="r" onClick={onPicked}>
      <b>
        <ThreadListItemPrimitive.Title fallback={strings["strings.agent.untitled_session"]} />
      </b>
      {session ? <span className="t">{formatListTime(session.lastActivity, now)}</span> : null}
    </ThreadListItemPrimitive.Trigger>
  );
}

/** Past Sessions as Assistant UI's thread list: a row resumes its Session. */
export function HistoryList({
  history,
  onPicked,
}: {
  history: readonly SessionSummary[];
  onPicked: () => void;
}) {
  const { strings } = useComposerEnv();
  return (
    <ThreadListPrimitive.Root className="agent-history">
      {history.length === 0 ? (
        <Chip>{strings["strings.agent.no_session"]}</Chip>
      ) : (
        <ThreadListPrimitive.Items>
          {() => <HistoryRow history={history} onPicked={onPicked} />}
        </ThreadListPrimitive.Items>
      )}
    </ThreadListPrimitive.Root>
  );
}

/** Starts a new Session through the thread list. */
export function useNewThread(): () => void {
  const aui = useAui();
  return () => aui.threads().switchToNewThread();
}

/* ------------------------------ Bar ------------------------------ */

/** Keeps the screen's copy of the text and the composer's in step, both ways. */
function TextBridge({
  text,
  onTextChange,
}: {
  text: string;
  onTextChange: (text: string) => void;
}) {
  const aui = useAui();
  const composerText = useAuiState((s) => s.composer.text);
  const latest = useRef({ text, onTextChange });
  latest.current = { text, onTextChange };
  useEffect(() => {
    if (aui.composer().getState().text !== text) aui.composer().setText(text);
  }, [aui, text]);
  useEffect(() => {
    if (composerText !== latest.current.text) latest.current.onTextChange(composerText);
  }, [composerText]);
  return null;
}

export interface BarProps {
  placeholder: string;
  text: string;
  onTextChange: (text: string) => void;
  onFocus?: (() => void) | undefined;
  inputRef?: Ref<HTMLTextAreaElement> | undefined;
}

export function Bar({ placeholder, text, onTextChange, onFocus, inputRef }: BarProps) {
  const { strings } = useComposerEnv();
  const history = unstable_useComposerInputHistory();
  return (
    <ComposerPrimitive.Root className="agent-bar">
      <TextBridge text={text} onTextChange={onTextChange} />
      <Mark />
      <ComposerPrimitive.Input
        ref={inputRef}
        name="ask"
        rows={1}
        maxRows={strings["ai.composer.max_rows"]}
        placeholder={placeholder}
        aria-label={placeholder}
        submitMode="enter"
        cancelOnEscape={false}
        unstable_focusOnRunStart={false}
        unstable_focusOnScrollToBottom={false}
        unstable_focusOnThreadSwitched={false}
        addAttachmentOnPaste={false}
        onFocus={onFocus}
        {...(strings["ai.composer.input_history"] ? history : {})}
      />
      <AuiIf condition={(s) => !s.thread.isRunning}>
        <ComposerPrimitive.Send asChild>
          <Btn icon className="send" title={strings["strings.agent.send"]}>
            <Icon icon={ArrowUpIcon} />
          </Btn>
        </ComposerPrimitive.Send>
      </AuiIf>
      <AuiIf condition={(s) => s.thread.isRunning}>
        <ComposerPrimitive.Cancel asChild>
          <Btn icon className="stop" title={strings["strings.agent.stop"]}>
            <Icon icon={StopIcon} weight="fill" />
          </Btn>
        </ComposerPrimitive.Cancel>
      </AuiIf>
    </ComposerPrimitive.Root>
  );
}

/* ------------------------------ Developer mode ------------------------------ */

export function DeveloperRow({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  const { strings } = useComposerEnv();
  return (
    <div className="agent-developer">
      <Chip on={on} onClick={onToggle}>
        {strings["strings.agent.developer_mode"]}
      </Chip>
      {on ? (
        <span className="warn">
          <Icon icon={WarningIcon} />
          {strings["strings.agent.developer_warning"]}
        </span>
      ) : null}
    </div>
  );
}
