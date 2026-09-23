// The transcript as Assistant UI's messages. A user event is a user message;
// the agent's text, tool cards, errors and lines that follow it are the parts
// of one assistant message, in order. A tool card is a tool-call part named by
// its tool, carrying the whole ToolCall (and its preview) as the artifact, so
// the tool UIs render from monday's own types. A Runtime switch or a Stopped
// turn is a data part the thread shows as a line.
//
// Pure, and cached: an unchanged message keeps its object across events, so
// streaming one answer re-renders only that answer.

import type { ThreadMessageLike } from "@assistant-ui/react";
import type { Runtime, ToolCall, ToolPreview } from "@monday/shared";
import type { TranscriptEvent } from "../transcript.ts";

/** What a tool-call part carries: the call in its latest state and its preview. */
export interface ToolArtifact {
  call: ToolCall;
  preview: ToolPreview | null;
}

/** A data part's payload: a line between turns. */
export type LineData = { kind: "runtime"; runtime: Runtime } | { kind: "stopped" };

/** The tool name an error event renders under; its UI offers Retry. */
export const ERROR_TOOL = "error";

type Part = Exclude<ThreadMessageLike["content"], string>[number];

interface Draft {
  id: string;
  role: "user" | "assistant";
  sources: TranscriptEvent[];
}

/** The events grouped into messages, in order. */
function draftsOf(events: readonly TranscriptEvent[]): Draft[] {
  const drafts: Draft[] = [];
  let agent: Draft | null = null;
  const agentDraft = (first: TranscriptEvent): Draft => {
    if (!agent) {
      agent = { id: `a-${sourceId(first)}`, role: "assistant", sources: [] };
      drafts.push(agent);
    }
    return agent;
  };
  for (const event of events) {
    switch (event.kind) {
      case "user":
        agent = null;
        drafts.push({ id: event.id, role: "user", sources: [event] });
        break;
      case "runtime":
        // The switch line starts the next runtime's answer.
        agent = null;
        agentDraft(event).sources.push(event);
        break;
      case "text":
        if (event.text) agentDraft(event).sources.push(event);
        break;
      default:
        agentDraft(event).sources.push(event);
    }
  }
  return drafts;
}

function sourceId(event: TranscriptEvent): string {
  return event.kind === "tool" ? event.call.id : event.id;
}

/** An error event as a failed card, so it renders with the other cards and offers Retry. */
export function errorCall(id: string, message: string): ToolCall {
  return {
    id,
    sessionId: null,
    runId: null,
    tool: ERROR_TOOL,
    tier: "read-only",
    inputSummary: message,
    status: "failed",
    approvedBy: null,
    undoable: false,
  };
}

function partOf(event: TranscriptEvent): Part | null {
  switch (event.kind) {
    case "user":
    case "text":
      return { type: "text", text: event.text };
    case "tool": {
      const { call } = event;
      const finished = call.status === "done" || call.status === "failed";
      const artifact: ToolArtifact = { call, preview: event.preview };
      return {
        type: "tool-call",
        toolCallId: call.id,
        toolName: call.tool,
        args: { summary: call.inputSummary },
        artifact,
        result: finished ? (call.result ?? call.status) : undefined,
        isError: call.status === "failed",
      };
    }
    case "error": {
      const artifact: ToolArtifact = { call: errorCall(event.id, event.message), preview: null };
      return {
        type: "tool-call",
        toolCallId: event.id,
        toolName: ERROR_TOOL,
        args: { summary: event.message },
        artifact,
        result: event.message,
        isError: true,
      };
    }
    case "runtime": {
      const data: LineData = { kind: "runtime", runtime: event.runtime };
      return { type: "data", name: "line", data };
    }
    case "stopped": {
      const data: LineData = { kind: "stopped" };
      return { type: "data", name: "line", data };
    }
    default:
      return null;
  }
}

function build(draft: Draft): ThreadMessageLike {
  const content = draft.sources.flatMap((e) => {
    const part = partOf(e);
    return part ? [part] : [];
  });
  return { id: draft.id, role: draft.role, content };
}

const sameSources = (a: readonly TranscriptEvent[], b: readonly TranscriptEvent[]) =>
  a.length === b.length && a.every((e, i) => e === b[i]);

/** The messages for a transcript, uncached. */
export function messagesOf(events: readonly TranscriptEvent[]): ThreadMessageLike[] {
  return draftsOf(events).map(build);
}

/**
 * A converter that keeps each message's object while the events it came from
 * are the same objects: the transcript reducer replaces only what changed.
 */
export function createMessageCache(): (events: readonly TranscriptEvent[]) => ThreadMessageLike[] {
  let previous = new Map<string, { sources: TranscriptEvent[]; message: ThreadMessageLike }>();
  return (events) => {
    const next = new Map<string, { sources: TranscriptEvent[]; message: ThreadMessageLike }>();
    const out = draftsOf(events).map((draft) => {
      const prev = previous.get(draft.id);
      const entry =
        prev && sameSources(prev.sources, draft.sources)
          ? prev
          : { sources: draft.sources, message: build(draft) };
      next.set(draft.id, entry);
      return entry.message;
    });
    previous = next;
    return out;
  };
}

/** A step folds into the turn's activity line: a read, or a Developer mode tool, never a card that asks. */
export function isStep(call: ToolCall): boolean {
  if (call.tool === ERROR_TOOL || call.status === "waiting") return false;
  return call.tier === "read-only" || call.builtin === true;
}
