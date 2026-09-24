// The thread and the composer bar on Assistant UI's primitives (Mosaic's
// thread.tsx, in monday's CSS): user turns as bubbles with their mentions as
// chips, the agent's turns as streamed Markdown with the tool UIs in the
// order they happened, read-only steps folded into one line, a quiet
// "Working" (with the time once a turn runs long) while nothing streams, an
// action bar per turn (Copy and Edit and resend on the user's, Copy and Ask
// again on the last answer), the time on hover, Continue after a Stop, a
// jump to the latest turn, and the bar: a growing input (Enter sends,
// Shift-Enter is a new line, Up recalls what was sent), the / and @ menus,
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
  ArrowClockwiseIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  CopyIcon,
  PencilSimpleIcon,
  StopIcon,
  WarningIcon,
  XIcon,
} from "@phosphor-icons/react";
import { type Ref, useEffect, useRef } from "react";
import { fill } from "../composerStrings.ts";
import { runtimeLabel } from "../runtimeLine.ts";
import { useComposerEnv, useElapsedSeconds, workingLabel } from "./context.tsx";
import { AgentText } from "./Markdown.tsx";
import { MENTION_ICONS, MentionText } from "./mentions.tsx";
import { type LineData, messageTime } from "./messages.ts";
import { groupSteps, StepsGroup, ToolFallback } from "./tools.tsx";
import { Mentions, SlashCommands } from "./triggers.tsx";

/* ------------------------------ Messages ------------------------------ */

/** When the turn was sent or the answer began, shown on hover; the full date in its title. */
function TurnTime() {
  const { strings, now } = useComposerEnv();
  const at = useAuiState((s) => messageTime(s.message.metadata));
  if (!at || !strings["ai.composer.timestamps"]) return null;
  return (
    <time className="agent-time" dateTime={at} title={new Date(at).toLocaleString()}>
      {formatListTime(at, now)}
    </time>
  );
}

/** Copy, flipping to a check once copied. */
function CopyAction() {
  const { strings } = useComposerEnv();
  return (
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
  );
}

/**
 * Edit and resend: the turn goes back into the bar, focused, to change and
 * send as a new turn. The Server's transcript is linear, so nothing already
 * answered is thrown away.
 */
function EditAction() {
  const { strings, actions } = useComposerEnv();
  const aui = useAui();
  const text = useAuiState((s) =>
    s.message.parts
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("\n")
      .trim(),
  );
  const edit = () => {
    aui.thread().composer().setText(text);
    actions.recall(text);
  };
  return (
    <Btn icon sm title={strings["strings.agent.edit"]} onClick={edit}>
      <Icon icon={PencilSimpleIcon} />
    </Btn>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="u-turn">
      <div className="u">
        <MessagePrimitive.Parts>
          {({ part }) =>
            part.type === "text" ? (
              <span className="ut">
                <MentionText text={part.text} />
              </span>
            ) : null
          }
        </MessagePrimitive.Parts>
      </div>
      <div className="agent-meta">
        <TurnTime />
        <ActionBarPrimitive.Root className="agent-msg-acts" hideWhenRunning>
          <CopyAction />
          <EditAction />
        </ActionBarPrimitive.Root>
      </div>
    </MessagePrimitive.Root>
  );
}

/** Continue after a Stop: one tap sends the Setting's words as the next turn. */
function ContinueAction() {
  const { strings, actions } = useComposerEnv();
  const show = useAuiState((s) => s.message.isLast && !s.thread.isRunning);
  if (!show) return null;
  return (
    <Chip onClick={() => actions.send(strings["strings.agent.continue_prompt"])}>
      {strings["strings.agent.continue"]}
    </Chip>
  );
}

/** A line between turns: the Runtime now answering, or where the user stopped a turn. */
function Line({ data }: { data: LineData }) {
  const { strings } = useComposerEnv();
  if (data.kind === "stopped") {
    return (
      <div className="line stopped">
        <span>{strings["strings.agent.stopped"]}</span>
        <ContinueAction />
      </div>
    );
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
 * running card are their own feedback. A long turn counts its time.
 */
function Working() {
  const show = useAuiState((s) => {
    if (s.message.status?.type !== "running") return false;
    const last = s.message.parts.at(-1);
    if (!last) return true;
    if (last.type === "text" && last.text.trim().length > 0) return false;
    return true;
  });
  if (!show) return null;
  return <WorkingLine />;
}

function WorkingLine() {
  const { strings, runStartedAt } = useComposerEnv();
  const seconds = useElapsedSeconds(runStartedAt);
  return (
    <div className="agent-working" role="status">
      <span className="label">{workingLabel(strings, seconds)}</span>
    </div>
  );
}

/** Under a finished answer: Copy, Ask again on the last one, and its time. Shown on hover, always on the last. */
function AnswerActions() {
  const { strings } = useComposerEnv();
  return (
    <ActionBarPrimitive.Root className="agent-answer-acts" hideWhenRunning autohide="not-last">
      <CopyAction />
      <AuiIf condition={(s) => s.message.isLast}>
        <ActionBarPrimitive.Reload asChild>
          <Btn icon sm title={strings["strings.agent.reload"]}>
            <Icon icon={ArrowClockwiseIcon} />
          </Btn>
        </ActionBarPrimitive.Reload>
      </AuiIf>
      <TurnTime />
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
  /** The / menu; off in a one-conversation composer (onboarding), where /new has no place. */
  commands?: boolean | undefined;
  /** Threads dropped in, shown above the input until the turn is sent. */
  attached?: readonly { id: string; type: string; label: string }[] | undefined;
  onDetach?: ((id: string) => void) | undefined;
}

export function Bar({
  placeholder,
  text,
  onTextChange,
  onFocus,
  inputRef,
  commands = true,
  attached = [],
  onDetach,
}: BarProps) {
  const { strings } = useComposerEnv();
  const history = unstable_useComposerInputHistory();
  return (
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <ComposerPrimitive.Root className="agent-bar" data-attached={attached.length || undefined}>
        {attached.length ? (
          <div className="agent-attached">
            {attached.map((a) => (
              <span
                key={`${a.type}:${a.id}`}
                className="agent-mention agent-attached-chip"
                data-type={a.type}
              >
                <Icon
                  icon={MENTION_ICONS[a.type as keyof typeof MENTION_ICONS] ?? MENTION_ICONS.thread}
                />
                <span className="label" title={a.label}>
                  {a.label}
                </span>
                <button
                  type="button"
                  className="x"
                  aria-label={fill(strings["strings.agent.detach"], { name: a.label })}
                  title={fill(strings["strings.agent.detach"], { name: a.label })}
                  onClick={() => onDetach?.(a.id)}
                >
                  <Icon icon={XIcon} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <TextBridge text={text} onTextChange={onTextChange} />
        {commands ? <SlashCommands /> : null}
        <Mentions />
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
    </ComposerPrimitive.Unstable_TriggerPopoverRoot>
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
