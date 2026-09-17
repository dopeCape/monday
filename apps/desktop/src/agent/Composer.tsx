// The composer (docs/spec/agent-composer.md): the Session's thread of turns,
// tool cards by tier with the preview and Approve or Apply and Cancel while
// a call waits, Undo once it applied, suggestion chips when the Session is
// empty, and the history list. In bottom-bar mode it sits in the AgentDock
// above the bar the Inbox owns; in column mode it is the whole column.
// Rendering only: the state and every action come from useAgentSession.

import type { Settings, ToolCall, ToolPreview } from "@monday/shared";
import {
  AgentBar,
  AgentColumn,
  AgentDock,
  AgentPanel,
  type AgentPart,
  AgentThread,
  type AgentTurn,
  Chip,
  formatListTime,
  type Suggestion,
} from "@monday/ui";
import { type ReactNode, useMemo, useState } from "react";
import type { TranscriptEvent } from "./transcript.ts";
import { type AgentStrings, cardActions, statusLabel, toolTitle } from "./transcript.ts";
import { type AgentSession, NO_CLIENT } from "./useAgentSession.ts";

export type ComposerStrings = AgentStrings &
  Pick<
    Settings,
    | "strings.agent.working"
    | "strings.agent.new"
    | "strings.agent.history"
    | "strings.agent.collapse"
    | "strings.agent.preview_threads"
    | "strings.agent.preview_more"
    | "strings.agent.preview_send"
    | "strings.agent.preview_setting"
    | "strings.agent.no_session"
  >;

export function composerStrings(settings: Settings): ComposerStrings {
  return {
    "strings.agent.approve": settings["strings.agent.approve"],
    "strings.agent.apply": settings["strings.agent.apply"],
    "strings.agent.decline": settings["strings.agent.decline"],
    "strings.agent.undo": settings["strings.agent.undo"],
    "strings.agent.retry": settings["strings.agent.retry"],
    "strings.agent.applied": settings["strings.agent.applied"],
    "strings.agent.undone": settings["strings.agent.undone"],
    "strings.agent.declined": settings["strings.agent.declined"],
    "strings.agent.waiting": settings["strings.agent.waiting"],
    "strings.agent.running": settings["strings.agent.running"],
    "strings.agent.failed": settings["strings.agent.failed"],
    "strings.agent.working": settings["strings.agent.working"],
    "strings.agent.new": settings["strings.agent.new"],
    "strings.agent.history": settings["strings.agent.history"],
    "strings.agent.collapse": settings["strings.agent.collapse"],
    "strings.agent.preview_threads": settings["strings.agent.preview_threads"],
    "strings.agent.preview_more": settings["strings.agent.preview_more"],
    "strings.agent.preview_send": settings["strings.agent.preview_send"],
    "strings.agent.preview_setting": settings["strings.agent.preview_setting"],
    "strings.agent.no_session": settings["strings.agent.no_session"],
  };
}

const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));

/** The preview in the app's own language: thread rows, the message, the Setting line. */
export function PreviewView({
  preview,
  strings,
  now,
}: {
  preview: ToolPreview;
  strings: ComposerStrings;
  now: Date;
}): ReactNode {
  switch (preview.kind) {
    case "threads": {
      const more = preview.count - preview.threads.length;
      return (
        <div className="agent-preview">
          <div className="count">
            {fill(strings["strings.agent.preview_threads"], { n: preview.count })}
          </div>
          <div className="results">
            {preview.threads.map((t) => (
              <div key={t.id} className="r">
                <b>{t.subject}</b>
                <span>{t.from}</span>
                <span className="t">{formatListTime(t.lastActivity, now)}</span>
              </div>
            ))}
          </div>
          {more > 0 ? (
            <div className="more">{fill(strings["strings.agent.preview_more"], { n: more })}</div>
          ) : null}
        </div>
      );
    }
    case "send":
      return (
        <div className="agent-preview">
          <div className="count">
            {fill(strings["strings.agent.preview_send"], {
              to: preview.to.map((p) => p.name || p.email).join(", "),
              subject: preview.subject,
            })}
          </div>
          <div className="body">{preview.text}</div>
        </div>
      );
    case "setting":
      return (
        <div className="agent-preview">
          {fill(strings["strings.agent.preview_setting"], {
            key: preview.key,
            from: JSON.stringify(preview.from),
            to: JSON.stringify(preview.to),
          })}
        </div>
      );
    default:
      return <div className="agent-preview">{preview.text}</div>;
  }
}

export interface TurnsOptions {
  strings: ComposerStrings;
  now: Date;
  /** Shown as the last part while a turn runs and nothing has streamed yet. */
  working: boolean;
}

/** The transcript as the thread renders it: user turns, and agent turns of text and cards. */
export function turnsOf(events: readonly TranscriptEvent[], options: TurnsOptions): AgentTurn[] {
  const { strings, now } = options;
  const turns: AgentTurn[] = [];
  let parts: AgentPart[] | null = null;
  let seq = 0;
  const agentTurn = (): AgentPart[] => {
    if (!parts) {
      parts = [];
      turns.push({ id: `a-${++seq}`, role: "agent", parts });
    }
    return parts;
  };
  for (const event of events) {
    switch (event.kind) {
      case "user":
        parts = null;
        turns.push({ id: event.id, role: "user", text: event.text });
        break;
      case "text":
        if (event.text) agentTurn().push({ kind: "text", text: event.text });
        break;
      case "tool":
        agentTurn().push({
          kind: "tool",
          call: event.call,
          title: toolTitle(event.call),
          statusLabel: statusLabel(event.call, strings),
          preview: event.preview ? (
            <PreviewView preview={event.preview} strings={strings} now={now} />
          ) : undefined,
          actions: cardActions(event.call, strings),
        });
        break;
      case "error":
        agentTurn().push({
          kind: "tool",
          call: {
            id: event.id,
            sessionId: null,
            runId: null,
            tool: "error",
            tier: "read-only",
            inputSummary: event.message,
            status: "failed",
            approvedBy: null,
            undoable: false,
          },
          title: strings["strings.agent.failed"],
          statusLabel: strings["strings.agent.failed"],
          actions: [strings["strings.agent.retry"]],
        });
        break;
    }
  }
  const last = turns.at(-1);
  if (options.working && (!last || last.role === "user")) {
    turns.push({
      id: "working",
      role: "agent",
      parts: [{ kind: "text", text: strings["strings.agent.working"] }],
    });
  }
  return turns;
}

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
}

export function Composer({
  agent,
  mode,
  runtime,
  strings,
  suggestions,
  now,
  open = true,
  onOpenChange,
  placeholder,
  text,
  onTextChange,
  onOpenThread,
  onSuggest,
}: ComposerProps) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const turns = useMemo(
    () => turnsOf(agent.events, { strings, now, working: agent.busy }),
    [agent.events, agent.busy, strings, now],
  );
  const lastUserText = [...agent.events].reverse().find((e) => e.kind === "user");

  const submit = (value: string) => {
    if (!value.trim()) return;
    onTextChange("");
    void agent.send(value);
  };

  const onToolAction = (action: string, call: ToolCall) => {
    if (call.tool === "error") {
      if (lastUserText?.kind === "user") void agent.send(lastUserText.text);
      return;
    }
    if (action === strings["strings.agent.approve"] || action === strings["strings.agent.apply"]) {
      void agent.approve(call.id);
    } else if (action === strings["strings.agent.decline"]) {
      void agent.decline(call.id);
    } else if (action === strings["strings.agent.undo"]) {
      void agent.undo(call.id);
    }
  };

  const onSuggestion = (s: Suggestion) => {
    onSuggest?.(s);
    submit(s.label);
  };

  const onNew = () => {
    setHistoryOpen(false);
    void agent.newSession();
  };

  const toggleHistory = () => {
    setHistoryOpen((o) => !o);
    if (!historyOpen) void agent.refreshHistory();
  };

  const history = historyOpen ? (
    <div className="agent-history">
      {agent.history.length === 0 ? (
        <Chip>{strings["strings.agent.no_session"]}</Chip>
      ) : (
        agent.history.map((s) => (
          <button
            key={s.id}
            type="button"
            className="r"
            onClick={() => {
              setHistoryOpen(false);
              void agent.openSession(s.id);
            }}
          >
            <b>{s.title || "New conversation"}</b>
            <span className="t">{formatListTime(s.lastActivity, now)}</span>
          </button>
        ))
      )}
    </div>
  ) : null;

  const thread = (
    <>
      <AgentThread
        turns={turns}
        now={now}
        onToolAction={onToolAction}
        onOpenThread={onOpenThread}
      />
      {agent.error ? (
        <div className="agent-error">
          {agent.error === NO_CLIENT ? strings["strings.agent.no_session"] : agent.error}
        </div>
      ) : null}
    </>
  );
  const chips = agent.events.length === 0 ? suggestions : undefined;
  const labels = {
    new: strings["strings.agent.new"],
    history: strings["strings.agent.history"],
    collapse: strings["strings.agent.collapse"],
  };

  if (mode === "bottom") {
    return (
      <AgentDock>
        {open ? (
          <AgentPanel
            runtime={runtime}
            suggestions={chips}
            onSuggest={onSuggestion}
            onNew={onNew}
            onHistory={toggleHistory}
            onClose={() => onOpenChange?.(false)}
            labels={labels}
          >
            {history ?? thread}
          </AgentPanel>
        ) : null}
        <AgentBar
          placeholder={placeholder}
          value={text}
          onChange={onTextChange}
          onSubmit={submit}
          onFocus={() => onOpenChange?.(true)}
        />
      </AgentDock>
    );
  }

  return (
    <AgentColumn
      side={mode}
      runtime={runtime}
      onNew={onNew}
      onHistory={toggleHistory}
      labels={labels}
    >
      {history ?? thread}
      {chips?.length ? (
        <div className="agent-suggest">
          {chips.map((s) => (
            <Chip key={s.label} onClick={() => onSuggestion(s)}>
              {s.label}
            </Chip>
          ))}
        </div>
      ) : null}
      <AgentBar placeholder={placeholder} value={text} onChange={onTextChange} onSubmit={submit} />
    </AgentColumn>
  );
}
