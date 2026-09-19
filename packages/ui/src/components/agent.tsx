// The Agent surfaces: a Tool call card, a results list, the bar, the thread
// of turns, the panel that rises from the bar, and the column layouts.
import type { Layout, Thread, ToolCall } from "@monday/shared";
import {
  CaretDownIcon,
  CheckIcon,
  CircleNotchIcon,
  ClockCounterClockwiseIcon,
  PlusIcon,
  WarningCircleIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import type { ChangeEvent, FormEvent, ReactNode } from "react";
import { cx, formatListTime, humanize } from "../format.ts";
import { Icon } from "./icon.tsx";
import { Btn, Chip, ColHead, Kbd, Mark } from "./primitives.tsx";

/* ------------------------------ ToolCard ------------------------------ */

const STATUS_CLASS: Record<ToolCall["status"], string> = {
  done: "ok",
  running: "run",
  waiting: "wait",
  failed: "fail",
};

const STATUS_LABEL: Record<ToolCall["status"], string> = {
  done: "Done",
  running: "Running",
  waiting: "Needs approval",
  failed: "Failed",
};

export interface ToolCardProps {
  call: ToolCall;
  /** Overrides the humanized tool name, such as "Searched mail". */
  title?: string | undefined;
  /** Overrides the status text. Defaults to the result when done. */
  statusLabel?: string | undefined;
  /** What the tool is about to do, shown while it waits for approval: a line, or rows in the app's own language. */
  preview?: ReactNode | undefined;
  /** Buttons under the card; the first is primary. "Send", "Edit", "Cancel". */
  actions?: readonly string[] | undefined;
  onAction?: ((action: string, call: ToolCall) => void) | undefined;
  className?: string | undefined;
}

export function ToolCard({
  call,
  title,
  statusLabel,
  preview,
  actions,
  onAction,
  className,
}: ToolCardProps) {
  const status =
    statusLabel ??
    (call.status === "done" && call.result ? call.result : STATUS_LABEL[call.status]);
  return (
    <div
      className={cx("tool", STATUS_CLASS[call.status], className)}
      data-tier={call.tier}
      data-builtin={call.builtin ? "true" : undefined}
    >
      <span className="t">
        {call.builtin ? <Icon icon={WarningIcon} /> : null}
        {title ?? humanize(call.tool)}
      </span>
      <span className="st">
        {call.status === "done" ? <Icon icon={CheckIcon} /> : null}
        {call.status === "running" ? <Icon icon={CircleNotchIcon} /> : null}
        {call.status === "failed" ? <Icon icon={WarningCircleIcon} /> : null} {status}
      </span>
      <span className="d">{call.inputSummary}</span>
      {preview ? <div className="preview">{preview}</div> : null}
      {actions?.length ? (
        <div className="acts">
          {actions.map((a, i) => (
            <Btn key={a} sm primary={i === 0} onClick={() => onAction?.(a, call)}>
              {a}
            </Btn>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------ ResultsList ------------------------------ */

export interface ResultsListProps {
  threads: readonly Thread[];
  now?: Date | undefined;
  onOpen?: ((threadId: string) => void) | undefined;
  className?: string | undefined;
}

/** Threads a search turned up, inside an Agent turn. */
export function ResultsList({ threads, now, onOpen, className }: ResultsListProps) {
  return (
    <div className={cx("results", className)}>
      {threads.map((t) => (
        <button key={t.id} type="button" className="r" onClick={() => onOpen?.(t.id)}>
          <b>{t.subject}</b>
          <span>{t.snippet}</span>
          <span className="t">{formatListTime(t.lastActivity, now)}</span>
        </button>
      ))}
    </div>
  );
}

/* ------------------------------ AgentBar ------------------------------ */

export interface AgentBarProps {
  placeholder?: string | undefined;
  value?: string | undefined;
  onChange?: ((value: string) => void) | undefined;
  onSubmit?: ((value: string) => void) | undefined;
  onFocus?: (() => void) | undefined;
  autoFocus?: boolean | undefined;
  className?: string | undefined;
}

export function AgentBar({
  placeholder = "Ask or tell monday",
  value,
  onChange,
  onSubmit,
  onFocus,
  autoFocus,
  className,
}: AgentBarProps) {
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const input = e.currentTarget.elements.namedItem("ask");
    onSubmit?.(input instanceof HTMLInputElement ? input.value : (value ?? ""));
  };
  return (
    <form className={cx("agent-bar", className)} onSubmit={submit}>
      <Mark />
      <input
        name="ask"
        placeholder={placeholder}
        aria-label="Ask or tell monday"
        // biome-ignore lint/a11y/noAutofocus: the Shell opens the panel to take typing
        autoFocus={autoFocus}
        onFocus={onFocus}
        {...(onChange
          ? {
              value: value ?? "",
              onChange: (e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value),
            }
          : { defaultValue: value })}
      />
      <Kbd>↵</Kbd>
    </form>
  );
}

/* ------------------------------ AgentThread ------------------------------ */

export type AgentPart =
  | { kind: "text"; text: string }
  /** A one-line note in the thread: a Runtime switch, the Developer mode warning. */
  | { kind: "line"; text: string; warning?: boolean | undefined }
  | {
      kind: "tool";
      call: ToolCall;
      title?: string;
      statusLabel?: string;
      preview?: ReactNode;
      actions?: readonly string[];
    }
  | { kind: "results"; threads: readonly Thread[] };

export type AgentTurn =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "agent"; parts: readonly AgentPart[] };

export interface AgentThreadProps {
  turns: readonly AgentTurn[];
  now?: Date | undefined;
  onToolAction?: ((action: string, call: ToolCall) => void) | undefined;
  onOpenThread?: ((threadId: string) => void) | undefined;
  className?: string | undefined;
}

function partKey(part: AgentPart, i: number): string {
  if (part.kind === "tool") return part.call.id;
  return `${part.kind}-${i}`;
}

export function AgentThread({
  turns,
  now,
  onToolAction,
  onOpenThread,
  className,
}: AgentThreadProps) {
  return (
    <div className={cx("agent-thread", className)}>
      {turns.map((turn) =>
        turn.role === "user" ? (
          <div key={turn.id} className="u">
            {turn.text}
          </div>
        ) : (
          <div key={turn.id} className="a">
            {turn.parts.map((part, i) => {
              const key = partKey(part, i);
              if (part.kind === "text") return <p key={key}>{part.text}</p>;
              if (part.kind === "line")
                return (
                  <div key={key} className={cx("line", part.warning && "warn")}>
                    {part.warning ? <Icon icon={WarningIcon} /> : null}
                    <span>{part.text}</span>
                  </div>
                );
              if (part.kind === "results")
                return (
                  <ResultsList key={key} threads={part.threads} now={now} onOpen={onOpenThread} />
                );
              return (
                <ToolCard
                  key={key}
                  call={part.call}
                  title={part.title}
                  statusLabel={part.statusLabel}
                  preview={part.preview}
                  actions={part.actions}
                  onAction={onToolAction}
                />
              );
            })}
          </div>
        ),
      )}
    </div>
  );
}

/* ------------------------------ AgentPanel ------------------------------ */

export interface Suggestion {
  label: string;
  /** Layout knobs the suggestion sets when picked. */
  layout?: Partial<Layout> | undefined;
  /** A Session to open instead of sending the label: where an external caller's card waits (slice 19). */
  session?: string | undefined;
}

export interface AgentPanelProps {
  /** The runtime line after the title, such as "Claude Code · tejas@genai-labs.io". */
  runtime?: string | undefined;
  /** Clicking the runtime line opens Settings, AI and agent (docs/spec/agent-composer.md, Surface). */
  onRuntime?: (() => void) | undefined;
  suggestions?: readonly Suggestion[] | undefined;
  onSuggest?: ((suggestion: Suggestion) => void) | undefined;
  /** Shows the plus button that starts a new Session. */
  onNew?: (() => void) | undefined;
  onHistory?: (() => void) | undefined;
  onClose?: (() => void) | undefined;
  /** Button titles; the Settings strings in the app, the mock's words by default. */
  labels?: { new?: string; history?: string; collapse?: string; runtime?: string } | undefined;
  /** The AgentThread. */
  children?: ReactNode | undefined;
  className?: string | undefined;
}

/** The runtime line, a button when the header opens Settings. */
function runtimeLine(
  runtime: string | undefined,
  onRuntime: (() => void) | undefined,
  title: string | undefined,
): ReactNode {
  if (runtime === undefined) return undefined;
  if (!onRuntime) return runtime;
  return (
    <button type="button" className="runtime" onClick={onRuntime} title={title}>
      {runtime}
    </button>
  );
}

/** The panel that rises above the bar when the Agent is open (agent: bottom). */
export function AgentPanel({
  runtime,
  onRuntime,
  suggestions,
  onSuggest,
  onNew,
  onHistory,
  onClose,
  labels,
  children,
  className,
}: AgentPanelProps) {
  return (
    <div className={cx("agent-panel", className)}>
      <ColHead title="monday" count={runtimeLine(runtime, onRuntime, labels?.runtime)}>
        {onNew ? (
          <Btn icon title={labels?.new ?? "New conversation"} onClick={onNew}>
            <Icon icon={PlusIcon} />
          </Btn>
        ) : null}
        <Btn icon title={labels?.history ?? "History"} onClick={onHistory}>
          <Icon icon={ClockCounterClockwiseIcon} />
        </Btn>
        <Btn icon title={labels?.collapse ?? "Collapse (Esc)"} onClick={onClose}>
          <Icon icon={CaretDownIcon} />
        </Btn>
      </ColHead>
      {children}
      {suggestions?.length ? (
        <div className="agent-suggest">
          {suggestions.map((s) => (
            <Chip key={s.label} onClick={() => onSuggest?.(s)}>
              {s.label}
            </Chip>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------ AgentDock ------------------------------ */

export interface AgentDockProps {
  children?: ReactNode | undefined;
  className?: string | undefined;
}

/** Positions the panel and bar over the main pane (agent: bottom). */
export function AgentDock({ children, className }: AgentDockProps) {
  return <div className={cx("agent-dock", className)}>{children}</div>;
}

/* ------------------------------ AgentColumn ------------------------------ */

export interface AgentColumnProps {
  side: "left" | "right";
  runtime?: string | undefined;
  onRuntime?: (() => void) | undefined;
  onNew?: (() => void) | undefined;
  onHistory?: (() => void) | undefined;
  labels?: { new?: string; history?: string; runtime?: string } | undefined;
  /** The AgentThread, then the AgentBar. */
  children?: ReactNode | undefined;
  className?: string | undefined;
  /** One conversation only, no new or history buttons (the onboarding conversation). */
  bare?: boolean | undefined;
}

/** The Agent as a permanent column (agent: left or right). */
export function AgentColumn({
  side,
  runtime,
  onRuntime,
  onNew,
  onHistory,
  labels,
  children,
  className,
  bare,
}: AgentColumnProps) {
  return (
    <section className={cx("agent-col", side, className)}>
      <ColHead title="monday" count={runtimeLine(runtime, onRuntime, labels?.runtime)}>
        {bare ? null : (
          <>
            <Btn icon title={labels?.new ?? "New conversation"} onClick={onNew}>
              <Icon icon={PlusIcon} />
            </Btn>
            <Btn icon title={labels?.history ?? "History"} onClick={onHistory}>
              <Icon icon={ClockCounterClockwiseIcon} />
            </Btn>
          </>
        )}
      </ColHead>
      {children}
    </section>
  );
}
