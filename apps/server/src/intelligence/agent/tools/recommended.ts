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

/** What the tool reads through: the Recommended actions on the Server. */
export interface RecommendationsSeam {
  view(workspaceId: string, threadId: string): Promise<RecommendationView | null>;
}

/** The tool that carries out each action, as the Agent calls it. */
export const ACTION_TOOL: Record<RecommendedActionKind, string> = {
  reply: "draft_message (a reply; the user sends)",
  archive: "archive_threads",
  snooze: "snooze_threads",
  forward: "forward_thread",
  delegate: "draft_message (a hand-off reply; the user sends)",
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

export const RECOMMENDED_TOOLS: readonly ToolDefinition<never>[] = [
  recommendedActions as unknown as ToolDefinition<never>,
];
