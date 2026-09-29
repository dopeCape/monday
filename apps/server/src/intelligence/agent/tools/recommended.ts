// recommended_actions (docs/spec/actions.md): the Agent's read-only view of
// the chips monday suggests for a Thread, the same list the reader shows,
// with each action's fit and the tool that would carry it out. It changes
// nothing: acting on one is the ordinary tool with its own approval.

import type { RecommendedActionKind } from "@monday/shared";
import { z } from "zod";
import type { ToolDefinition } from "./catalog.ts";

export interface RecommendationView {
  threadId: string;
  /** No current answers yet, or they are for an older Message: nothing is suggested until they are read again. */
  stale: boolean;
  /** What the reader shows, in its order. */
  shown: Array<{ kind: RecommendedActionKind; label: string; fit: number; tool: string }>;
  /** What the Thread allows but a threshold, a switch, a mute or the chip limit holds back. */
  held: Array<{ kind: RecommendedActionKind; label: string; fit: number; why: string }>;
}

/** How a Thread's list is left (docs/spec/actions.md, Unsubscribe). */
export interface ListExitView {
  method: "one_click" | "mailto" | "browser";
  target: string;
  subject?: string | undefined;
  body?: string | undefined;
  listId: string;
  listName: string;
  issues: number;
}

/** What the tools read through: the Recommended actions on the Server. */
export interface RecommendationsSeam {
  view(workspaceId: string, threadId: string): Promise<RecommendationView | null>;
  /** How the Thread's list is left, from its headers; null when it names no way out. */
  listExit?(workspaceId: string, threadId: string): Promise<ListExitView | null>;
  /** The RFC 8058 POST; never a GET. */
  oneClick?(url: string): Promise<{ status: number }>;
}

/** The unsubscribe card's words: the list and the exact request or address. */
export function unsubscribeLine(exit: ListExitView): string {
  if (exit.method === "one_click")
    return `Leave ${exit.listName}: POST List-Unsubscribe=One-Click to ${exit.target}`;
  if (exit.method === "mailto")
    return `Leave ${exit.listName}: send an email to ${exit.target}${exit.subject ? ` with the subject "${exit.subject}"` : ""}`;
  return `Leave ${exit.listName}: its page ${exit.target} opens in the browser`;
}

/** The tool that carries out each action, as the Agent calls it. */
export const ACTION_TOOL: Record<RecommendedActionKind, string> = {
  reply: "draft_message (a reply; the user sends)",
  archive: "archive_threads",
  snooze: "snooze_threads",
  forward: "forward_thread",
  delegate: "draft_message (a hand-off reply; the user sends)",
  rsvp: "rsvp (asks first; the user picks the answer)",
  calendar: "schedule_event (asks first; no invitees)",
  pay: "none: monday never pays; the user opens the payment page, or snooze_threads to be reminded",
  unsubscribe: "unsubscribe (asks first: it reaches the list)",
  track: "none: the carrier's page opens in the browser",
  workflow: "run_workflow (each Step keeps its own approval)",
};

export function recommendationText(v: RecommendationView): string {
  const lines: string[] = [];
  if (v.shown.length === 0) lines.push("The reader suggests nothing for this Thread.");
  else lines.push("The reader suggests, in this order:");
  for (const a of v.shown) {
    lines.push(`- ${a.label} (fit ${a.fit.toFixed(2)}): ${a.tool}`);
  }
  if (v.held.length > 0) {
    lines.push("Held back:");
    for (const a of v.held) lines.push(`- ${a.label} (fit ${a.fit.toFixed(2)}): ${a.why}`);
  }
  if (v.stale)
    lines.push(
      "Its answers are for an older version of the Thread; they are read again when the Thread is.",
    );
  lines.push("Nothing was done. Each action is its own tool call and asks as that tool does.");
  return lines.join("\n");
}

const recommendedActions: ToolDefinition<{ thread_id: string }> = {
  name: "recommended_actions",
  description:
    "The actions monday suggests for a Thread as chips (reply, archive, snooze until a time, forward or hand to a person), in the reader's order, each with how sure monday is and the tool that carries it out, plus the ones held back and why (a threshold, a mute, the limit). Changes nothing.",
  tier: "read",
  input: z.object({ thread_id: z.string().min(1) }),
  summarize: (i) => i.thread_id,
  async run(input, ctx) {
    const seam = ctx.extensions?.recommendations;
    if (!seam)
      return { kind: "refused", text: "Suggested actions are not available from this host." };
    const view = await seam.view(ctx.host.workspaceId, input.thread_id);
    if (!view) return { kind: "refused", text: "No such Thread, or the AI level is off." };
    return { kind: "result", text: recommendationText(view), data: view };
  },
};

const unsubscribe: ToolDefinition<{ thread_id: string }> = {
  name: "unsubscribe",
  description:
    "Leave the mailing list a Thread came from, by its List-Unsubscribe header: the RFC 8058 one-click request when the list offers it, else an email to the list's unsubscribe address from the user's account. A list that only offers a web page is refused: the user opens it in the browser; monday never fetches it. Always asks first with the exact request.",
  tier: "leaves_mailbox",
  input: z.object({ thread_id: z.string().min(1) }),
  summarize: (i) => i.thread_id,
  async run(input, ctx) {
    const seam = ctx.extensions?.recommendations;
    if (!seam?.listExit)
      return { kind: "refused", text: "Unsubscribing is not available from this host." };
    const exit = await seam.listExit(ctx.host.workspaceId, input.thread_id);
    if (!exit) return { kind: "refused", text: "That Thread names no way to leave its list." };
    if (exit.method === "browser") {
      return {
        kind: "refused",
        text: `This list only offers a page (${exit.target}). The user opens it in the browser; monday does not fetch it.`,
      };
    }
    return {
      kind: "action",
      preview: { kind: "text", text: unsubscribeLine(exit) },
      count: 1,
      apply: async () => {
        if (exit.method === "one_click") {
          if (!seam.oneClick) throw new Error("one-click is not available from this host");
          const { status } = await seam.oneClick(exit.target);
          if (status >= 400) throw new Error(`the list answered ${status}`);
          return {
            text: `Unsubscribed from ${exit.listName} (the list answered ${status}).`,
            data: { method: exit.method, target: exit.target, status, issues: exit.issues },
            undo: null,
          };
        }
        const bodyText = exit.body ?? "unsubscribe";
        const draft = await ctx.host.createDraft({
          threadId: null,
          kind: "new",
          inReplyToMessageId: null,
          to: [{ name: "", email: exit.target }],
          cc: [],
          bcc: [],
          subject: exit.subject ?? "unsubscribe",
          bodyHtml: `<p>${bodyText.replace(/[<>&]/g, "")}</p>`,
          bodyText,
          attachments: [],
        });
        const send = await ctx.host.scheduleSend(draft.id);
        return {
          text: `Sent the unsubscribe email to ${exit.target} for ${exit.listName}.`,
          data: {
            method: exit.method,
            target: exit.target,
            sendId: send.sendId,
            issues: exit.issues,
          },
          undo: { kind: "send", sendId: send.sendId },
        };
      },
    };
  },
};

export const RECOMMENDED_TOOLS: readonly ToolDefinition<never>[] = [
  recommendedActions as unknown as ToolDefinition<never>,
  unsubscribe as unknown as ToolDefinition<never>,
];
