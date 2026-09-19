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
  formatSpan,
  motionMs,
  type Suggestion,
} from "@monday/ui";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { runtimeLabel } from "./runtimeLine.ts";
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
    | "strings.agent.preview_event.schedule"
    | "strings.agent.preview_event.update"
    | "strings.agent.preview_event.cancel"
    | "strings.agent.preview_event.rsvp"
    | "strings.agent.preview_event.link"
    | "strings.agent.preview_event.by_provider"
    | "strings.agent.preview_event.by_monday"
    | "strings.agent.preview_event.conflicts"
    | "strings.agent.no_session"
    | "strings.agent.runtime_switched"
    | "strings.agent.builtin_tool"
    | "strings.agent.developer_mode"
    | "strings.agent.developer_warning"
    | "strings.agent.untitled_session"
    | "strings.agent.open_runtime"
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
    "strings.agent.preview_event.schedule": settings["strings.agent.preview_event.schedule"],
    "strings.agent.preview_event.update": settings["strings.agent.preview_event.update"],
    "strings.agent.preview_event.cancel": settings["strings.agent.preview_event.cancel"],
    "strings.agent.preview_event.rsvp": settings["strings.agent.preview_event.rsvp"],
    "strings.agent.preview_event.link": settings["strings.agent.preview_event.link"],
    "strings.agent.preview_event.by_provider": settings["strings.agent.preview_event.by_provider"],
    "strings.agent.preview_event.by_monday": settings["strings.agent.preview_event.by_monday"],
    "strings.agent.preview_event.conflicts": settings["strings.agent.preview_event.conflicts"],
    "strings.agent.no_session": settings["strings.agent.no_session"],
    "strings.agent.runtime_switched": settings["strings.agent.runtime_switched"],
    "strings.agent.builtin_tool": settings["strings.agent.builtin_tool"],
    "strings.agent.developer_mode": settings["strings.agent.developer_mode"],
    "strings.agent.developer_warning": settings["strings.agent.developer_warning"],
    "strings.agent.untitled_session": settings["strings.agent.untitled_session"],
    "strings.agent.open_runtime": settings["strings.agent.open_runtime"],
  };
}

const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));

const LINK_LABELS: Record<string, string> = {
  "google-meet": "Google Meet",
  teams: "Microsoft Teams",
  jitsi: "Jitsi",
  custom: "your custom URL",
};

/** A link kind reads as its product name; a URL reads as its host. */
function linkLabel(link: string): string {
  if (LINK_LABELS[link]) return LINK_LABELS[link] as string;
  try {
    return new URL(link).host;
  } catch {
    return link;
  }
}

/** Which Provider a card's link kind implies, for the "goes out from" line. */
function sourceOf(e: { link: string | null }): string {
  if (e.link === "google-meet" || (e.link ?? "").includes("meet.google.com")) return "google";
  if (e.link === "teams" || (e.link ?? "").includes("teams.microsoft.com")) return "graph";
  return "calendar";
}

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
    case "event": {
      const e = preview.event;
      const verb =
        e.action === "rsvp"
          ? fill(strings["strings.agent.preview_event.rsvp"], { response: e.response ?? "" })
          : strings[`strings.agent.preview_event.${e.action}`];
      const source = { google: "Google", graph: "Microsoft", caldav: "CalDAV", jmap: "Fastmail" };
      return (
        <div className="agent-preview agent-event">
          <div className="count">{verb}</div>
          <div className="ev-title">{e.title}</div>
          <div className="ev-when">{formatSpan(e.start, e.end, e.allDay)}</div>
          {e.attendees.length > 0 ? (
            <div className="ev-who">{e.attendees.map((p) => p.name || p.email).join(", ")}</div>
          ) : null}
          {e.link ? (
            <div className="ev-link">
              {fill(strings["strings.agent.preview_event.link"], { link: linkLabel(e.link) })}
            </div>
          ) : null}
          {e.conflicts.length > 0 ? (
            <div className="ev-conflict">
              {fill(strings["strings.agent.preview_event.conflicts"], {
                titles: e.conflicts.join(", "),
              })}
            </div>
          ) : null}
          {e.invitesBy === "provider" ? (
            <div className="more">
              {fill(strings["strings.agent.preview_event.by_provider"], {
                source: (source as Record<string, string>)[sourceOf(e)] ?? "calendar",
              })}
            </div>
          ) : e.invitesBy === "monday" ? (
            <div className="more">{strings["strings.agent.preview_event.by_monday"]}</div>
          ) : null}
        </div>
      );
    }
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
      case "runtime":
        // The switch line sits between the two runtimes' turns.
        parts = null;
        agentTurn().push({
          kind: "line",
          text: fill(strings["strings.agent.runtime_switched"], {
            runtime: runtimeLabel(event.runtime),
          }),
        });
        break;
      case "tool":
        agentTurn().push({
          kind: "tool",
          call: event.call,
          title: event.call.builtin
            ? fill(strings["strings.agent.builtin_tool"], { tool: event.call.tool })
            : toolTitle(event.call),
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
  /** One conversation only: no new, history or Developer mode (the onboarding conversation). */
  plain?: boolean | undefined;
  /** Clicking the header's runtime line opens Settings, AI and agent. */
  onOpenRuntime?: (() => void) | undefined;
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
  plain = false,
  onOpenRuntime,
}: ComposerProps) {
  const [historyOpen, setHistoryOpen] = useState(false);
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
  const turns = useMemo(
    () => turnsOf(agent.events, { strings, now, working: agent.busy }),
    [agent.events, agent.busy, strings, now],
  );

  const submit = (value: string) => {
    if (!value.trim()) return;
    onTextChange("");
    void agent.send(value);
  };

  const onToolAction = (action: string, call: ToolCall) => {
    if (call.tool === "error") {
      void agent.retry();
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
    if (s.session) {
      // An external caller's card waits in its own Session: open it, the card carries the caller's name.
      onOpenChange?.(true);
      void agent.openSession(s.session);
      return;
    }
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
            <b>{s.title || strings["strings.agent.untitled_session"]}</b>
            <span className="t">{formatListTime(s.lastActivity, now)}</span>
          </button>
        ))
      )}
    </div>
  ) : null;

  const local = agent.runtimeInfo?.runtime.kind === "local";
  const thread = (
    <>
      {local && !plain ? (
        <div className="agent-developer">
          <Chip
            on={agent.developerMode}
            onClick={() => agent.setDeveloperMode(!agent.developerMode)}
          >
            {strings["strings.agent.developer_mode"]}
          </Chip>
          {agent.developerMode ? (
            <span className="warn">{strings["strings.agent.developer_warning"]}</span>
          ) : null}
        </div>
      ) : null}
      <AgentThread
        turns={turns}
        now={now}
        onToolAction={onToolAction}
        onOpenThread={onOpenThread}
      />
      {agent.error ? (
        <div className="agent-error" role="alert">
          <span>
            {agent.error === NO_CLIENT ? strings["strings.agent.no_session"] : agent.error}
          </span>
          {agent.error !== NO_CLIENT ? (
            <Chip onClick={() => void agent.retry()}>{strings["strings.agent.retry"]}</Chip>
          ) : null}
        </div>
      ) : null}
    </>
  );
  const chips = agent.events.length === 0 && !historyOpen ? suggestions : undefined;
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
            suggestions={chips}
            onSuggest={onSuggestion}
            onNew={onNew}
            onHistory={toggleHistory}
            onClose={() => onOpenChange?.(false)}
            labels={labels}
            className={leaving ? "leaving" : undefined}
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
      onRuntime={onOpenRuntime}
      onNew={onNew}
      onHistory={toggleHistory}
      labels={labels}
      bare={plain}
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
