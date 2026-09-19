// Suggestion chips (docs/spec/agent-composer.md): up to ai.suggestions.max,
// from pending approvals first (a Session's waiting call, a Workflow Run
// paused at a Step), then Threads in Needs your reply, then the evergreen
// prompts Setting. Plain sentences, no icons.

import type { ExternalPending, Settings, Thread, ToolCall } from "@monday/shared";
import type { Suggestion } from "@monday/ui";

/** A Workflow Run paused at a Step that asks. */
export interface PausedRunChip {
  workflowName: string;
  stepName: string;
}

export interface SuggestionInput {
  settings: Pick<Settings, "ai.suggestions.max" | "agent.suggestions.evergreen">;
  /** Calls waiting for the user in the current Session. */
  waiting: readonly ToolCall[];
  /** Runs waiting for an approval; the chip asks the Agent, whose approve_workflow_step tool shows the card. */
  pausedRuns?: readonly PausedRunChip[] | undefined;
  /** Threads in Needs your reply. */
  needsReply: readonly Thread[];
  /** External calls parked on an approval (docs/spec/external-mcp.md); the chip opens the caller's Session, where the card waits. */
  external?: readonly ExternalPending[] | undefined;
}

export function suggestionsFor(input: SuggestionInput): Suggestion[] {
  const max = input.settings["ai.suggestions.max"];
  const out: Suggestion[] = [];
  for (const call of input.waiting) {
    out.push({ label: `Decide on the pending ${call.tool.replaceAll("_", " ")}` });
  }
  for (const p of input.external ?? []) {
    if (p.status !== "waiting") continue;
    out.push({
      label: `Decide on the ${p.tool.replaceAll("_", " ")} that ${p.credentialName} asks for`,
      session: p.sessionId ?? undefined,
    });
  }
  for (const run of input.pausedRuns ?? []) {
    out.push({ label: `Decide on the ${run.stepName} step waiting in ${run.workflowName}` });
  }
  const n = input.needsReply.length;
  if (n > 0)
    out.push({
      label:
        n === 1 ? "Reply to the thread waiting on me" : `Reply to the ${n} threads waiting on me`,
    });
  for (const label of input.settings["agent.suggestions.evergreen"]) out.push({ label });
  const seen = new Set<string>();
  return out.filter((s) => !seen.has(s.label) && seen.add(s.label)).slice(0, max);
}
