// Action chips are tool calls (docs/spec/inbox.md, "Each chip is an ordinary
// tool call with its Tier"; docs/spec/agent-composer.md). toolCallOf names
// the tool, its arguments and its Tier for a BriefAction; ActionRunner runs
// it over the InboxActions seam and the compose surface, the same seams the
// Device's ToolHost (agent/clientToolHost.ts) acts through, which keeps
// ADR 0002: a reply or forward chip opens compose and never sends, snooze and
// archive apply with Undo, a link opens outside.

import type { BriefAction, Person, Tier } from "@monday/shared";
import type { InboxActions, UndoToken } from "./actions.ts";

/** The tool call a chip stands for. Names are the tool server's. */
export type BriefToolCall =
  | { tool: "compose.reply"; tier: "always-ask"; args: { threadId: string; opening: string } }
  | { tool: "compose.forward"; tier: "always-ask"; args: { threadId: string; to: Person } }
  | {
      tool: "calendar.create_event";
      tier: "always-ask";
      args: { threadId: string; title: string; start: string };
    }
  | { tool: "thread.snooze"; tier: "reversible"; args: { threadId: string; until: string } }
  | { tool: "thread.archive"; tier: "reversible"; args: { threadId: string } }
  | { tool: "open.link"; tier: "read-only"; args: { url: string } };

export function toolCallOf(action: BriefAction, threadId: string): BriefToolCall {
  switch (action.kind) {
    case "reply":
      return {
        tool: "compose.reply",
        tier: "always-ask",
        args: { threadId, opening: action.proposedLine },
      };
    case "forward":
      return { tool: "compose.forward", tier: "always-ask", args: { threadId, to: action.to } };
    case "calendar":
      return {
        tool: "calendar.create_event",
        tier: "always-ask",
        args: { threadId, title: action.eventTitle, start: action.start },
      };
    case "snooze":
      return { tool: "thread.snooze", tier: "reversible", args: { threadId, until: action.until } };
    case "archive":
      return { tool: "thread.archive", tier: "reversible", args: { threadId } };
    case "open-link":
      return { tool: "open.link", tier: "read-only", args: { url: action.url } };
  }
}

export function tierOf(action: BriefAction): Tier {
  return toolCallOf(action, "").tier;
}

/** What running a chip came to: applied (with Undo when reversible), handed to a surface, or not possible here. */
export type ActionOutcome =
  | { ok: true; call: BriefToolCall; undo: UndoToken | null }
  | { ok: false; call: BriefToolCall; reason: "calendar_unavailable" | "unavailable" };

export interface ActionRunner {
  run(action: BriefAction, threadId: string): Promise<ActionOutcome>;
}

/** What a reply or forward chip hands the compose surface. */
export interface ComposeSeed {
  /** The proposed opening line of a reply. */
  opening?: string | undefined;
  /** The forward recipient. */
  to?: Person[] | undefined;
}

export interface ActionRunnerDeps {
  inbox: InboxActions;
  /** Opens the reply box on the Thread with the seed; the user still sends (ADR 0002). */
  compose(kind: "reply" | "forward", threadId: string, seed: ComposeSeed): void;
  openLink(url: string): void | Promise<void>;
  /** Absent on an Account with no calendar; the chip then reports calendar_unavailable. */
  calendar?:
    | ((event: { threadId: string; title: string; start: string }) => Promise<void>)
    | undefined;
}

export function createActionRunner(deps: ActionRunnerDeps): ActionRunner {
  return {
    async run(action, threadId) {
      const call = toolCallOf(action, threadId);
      switch (call.tool) {
        case "compose.reply":
          deps.compose("reply", threadId, { opening: call.args.opening });
          return { ok: true, call, undo: null };
        case "compose.forward":
          deps.compose("forward", threadId, { to: [call.args.to] });
          return { ok: true, call, undo: null };
        case "calendar.create_event":
          if (!deps.calendar) return { ok: false, call, reason: "calendar_unavailable" };
          await deps.calendar(call.args);
          return { ok: true, call, undo: null };
        case "thread.snooze": {
          const until = new Date(call.args.until);
          if (Number.isNaN(until.getTime())) return { ok: false, call, reason: "unavailable" };
          return { ok: true, call, undo: await deps.inbox.snooze([threadId], until) };
        }
        case "thread.archive":
          return { ok: true, call, undo: await deps.inbox.archive([threadId]) };
        case "open.link":
          await deps.openLink(call.args.url);
          return { ok: true, call, undo: null };
      }
    },
  };
}
