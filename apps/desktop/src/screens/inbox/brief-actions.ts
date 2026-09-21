// Action chips are tool calls (docs/spec/inbox.md, "Each chip is an ordinary
// tool call with its Tier"; docs/spec/agent-composer.md). toolCallOf names
// the tool, its arguments and its Tier for a BriefAction; ActionRunner runs
// it over the InboxActions seam and the compose surface, the same seams the
// Device's ToolHost (agent/clientToolHost.ts) acts through, which keeps
// ADR 0002: a reply or forward chip opens compose and never sends, snooze and
// archive apply with Undo, a link opens outside. The judged chips (slice 25:
// call, open the attachment, pay or file) map the same way: a call or a
// pay-or-file hands the agent bar a sentence and sends nothing; an
// attachment opens through the opener.

import type { BriefAction, ChipName, Person, ThreadJudgments, Tier } from "@monday/shared";
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
  | { tool: "open.link"; tier: "read-only"; args: { url: string } }
  | { tool: "open.attachment"; tier: "read-only"; args: { attachmentId: string } }
  | {
      tool: "agent.ask";
      tier: "read-only";
      args: { threadId: string; intent: "call" | "pay-or-file" };
    };

/**
 * The chips a Thread's Judgments earn before its Brief exists: every chip at
 * or above the threshold, likeliest first, at most `max`. A chip that needs
 * something the Thread lacks (a link, an attachment, a snooze time) is
 * skipped; the labels are the strings Settings.
 */
export function judgedChips(
  judgments: ThreadJudgments,
  facts: {
    threshold: number;
    max: number;
    labels: Record<ChipName, string>;
    /** The first link in the newest Message, for review_link. */
    link: string | null;
    /** The first attachment on the Thread, for open_attachment. */
    attachmentId: string | null;
    /** When a snooze chip would put the Thread aside until. */
    snoozeUntil: string | null;
  },
): BriefAction[] {
  const ranked = (Object.entries(judgments.chips) as [ChipName, number][])
    .filter(([, p]) => p >= facts.threshold)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const out: BriefAction[] = [];
  for (const [chip] of ranked) {
    if (out.length >= facts.max) break;
    const label = facts.labels[chip];
    if (!label) continue;
    switch (chip) {
      case "reply":
        out.push({ kind: "reply", label, proposedLine: "" });
        break;
      case "call":
        out.push({ kind: "call", label });
        break;
      case "review_link":
        if (facts.link) out.push({ kind: "open-link", label, url: facts.link });
        break;
      case "open_attachment":
        if (facts.attachmentId) {
          out.push({ kind: "open-attachment", label, attachmentId: facts.attachmentId });
        }
        break;
      case "pay_or_file":
        out.push({ kind: "pay-or-file", label });
        break;
      case "snooze":
        if (facts.snoozeUntil) out.push({ kind: "snooze", label, until: facts.snoozeUntil });
        break;
    }
  }
  return out;
}

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
    case "open-attachment":
      return {
        tool: "open.attachment",
        tier: "read-only",
        args: { attachmentId: action.attachmentId },
      };
    case "call":
      return { tool: "agent.ask", tier: "read-only", args: { threadId, intent: "call" } };
    case "pay-or-file":
      return { tool: "agent.ask", tier: "read-only", args: { threadId, intent: "pay-or-file" } };
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
  /** Opens an attachment through the opener; absent means the chip reports unavailable. */
  openAttachment?: ((attachmentId: string) => void | Promise<void>) | undefined;
  /** Hands the agent bar a sentence about the Thread (a call, paying or filing); nothing is sent. */
  ask?: ((threadId: string, intent: "call" | "pay-or-file") => void) | undefined;
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
        case "open.attachment":
          if (!deps.openAttachment) return { ok: false, call, reason: "unavailable" };
          await deps.openAttachment(call.args.attachmentId);
          return { ok: true, call, undo: null };
        case "agent.ask":
          if (!deps.ask) return { ok: false, call, reason: "unavailable" };
          deps.ask(call.args.threadId, call.args.intent);
          return { ok: true, call, undo: null };
      }
    },
  };
}
