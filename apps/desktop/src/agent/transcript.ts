// The transcript as the composer keeps it: a list of events where a tool
// card appears once, in its latest state, and streaming text grows in place
// until the answer lands. Pure functions, so the reduction is tested apart
// from the DOM.

import type { AgentEvent, Settings, ToolCall } from "@monday/shared";

export type TranscriptEvent = Exclude<AgentEvent, { kind: "delta" } | { kind: "done" }>;

function replaceAt<T>(list: readonly T[], at: number, item: T): T[] {
  const out = [...list];
  out[at] = item;
  return out;
}

/** Folds one streamed event into the transcript. */
export function applyEvent(
  events: readonly TranscriptEvent[],
  event: AgentEvent,
): TranscriptEvent[] {
  switch (event.kind) {
    case "done":
      return [...events];
    case "delta": {
      const at = events.findIndex((e) => e.kind === "text" && e.id === event.id);
      if (at >= 0) {
        const current = events[at];
        if (current?.kind !== "text") return [...events];
        return replaceAt(events, at, { ...current, text: current.text + event.text });
      }
      return [...events, { kind: "text", id: event.id, text: event.text }];
    }
    case "text": {
      const at = events.findIndex((e) => e.kind === "text" && e.id === event.id);
      return at >= 0 ? replaceAt(events, at, event) : [...events, event];
    }
    case "tool": {
      const at = events.findIndex((e) => e.kind === "tool" && e.call.id === event.call.id);
      return at >= 0 ? replaceAt(events, at, event) : [...events, event];
    }
    default:
      return [...events, event];
  }
}

export function applyEvents(
  events: readonly TranscriptEvent[],
  incoming: readonly AgentEvent[],
): TranscriptEvent[] {
  let out: TranscriptEvent[] = [...events];
  for (const event of incoming) out = applyEvent(out, event);
  return out;
}

/** The calls still waiting for the user, oldest first. */
export function waitingCalls(events: readonly TranscriptEvent[]): ToolCall[] {
  return events.flatMap((e) => (e.kind === "tool" && e.call.status === "waiting" ? [e.call] : []));
}

/** Titles for the cards, from the tool name, as the mock words them. */
export function toolTitle(call: ToolCall): string {
  const done = call.status === "done" || call.status === "failed";
  switch (call.tool) {
    case "search_threads":
      return done ? "Searched mail" : "Searching mail";
    case "read_thread":
      return done ? "Read thread" : "Reading thread";
    case "list_groups_and_sections":
      return "Listed groups and sections";
    case "archive_threads":
      return done ? "Archived" : "Archive";
    case "snooze_threads":
      return done ? "Snoozed" : "Snooze";
    case "tag_threads":
      return done ? "Tagged" : "Tag";
    case "move_threads":
      return done ? "Moved" : "Move";
    case "trash_threads":
      return done ? "Trashed" : "Trash";
    case "draft_message":
      return done ? "Drafted" : "Draft";
    case "send_draft":
      return done ? "Sent" : "Send";
    case "forward_thread":
      return done ? "Forwarded" : "Forward";
    case "change_setting":
      return done ? "Changed setting" : "Change setting";
    case "change_layout":
      return done ? "Changed layout" : "Change layout";
    case "undo":
      return "Undid";
    default:
      return call.tool.replaceAll("_", " ");
  }
}

export type AgentStrings = Pick<
  Settings,
  | "strings.agent.approve"
  | "strings.agent.apply"
  | "strings.agent.decline"
  | "strings.agent.undo"
  | "strings.agent.retry"
  | "strings.agent.applied"
  | "strings.agent.undone"
  | "strings.agent.declined"
  | "strings.agent.waiting"
  | "strings.agent.running"
  | "strings.agent.failed"
>;

/** The status line of a card: the state first, the one-line result for a read tool. */
export function statusLabel(call: ToolCall, s: AgentStrings): string {
  if (call.status === "waiting") return s["strings.agent.waiting"];
  if (call.status === "running") return s["strings.agent.running"];
  if (call.status === "failed") return s["strings.agent.failed"];
  if (call.declined) return s["strings.agent.declined"];
  if (call.undoneAt) return s["strings.agent.undone"];
  if (call.tier === "read-only") return call.result ?? s["strings.agent.applied"];
  return s["strings.agent.applied"];
}

/** The buttons under a card, the first primary. */
export function cardActions(call: ToolCall, s: AgentStrings): string[] {
  if (call.status === "waiting") {
    const primary =
      call.tier === "reversible" ? s["strings.agent.apply"] : s["strings.agent.approve"];
    return [primary, s["strings.agent.decline"]];
  }
  if (call.status === "done" && call.undoable && !call.undoneAt) return [s["strings.agent.undo"]];
  return [];
}
