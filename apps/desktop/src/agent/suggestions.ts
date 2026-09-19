// Suggestion chips (docs/spec/agent-composer.md): up to ai.suggestions.max,
// from pending approvals first (a Session's waiting call, a Workflow Run
// paused at a Step), then Threads in Needs your reply, then the evergreen
// prompts Setting. Plain sentences, no icons; every sentence is a Setting.

import type { ExternalPending, Settings, Thread, ToolCall } from "@monday/shared";
import type { Suggestion } from "@monday/ui";

/** A Workflow Run paused at a Step that asks. */
export interface PausedRunChip {
  workflowName: string;
  stepName: string;
}

export type SuggestionStrings = Pick<
  Settings,
  | "ai.suggestions.max"
  | "agent.suggestions.evergreen"
  | "strings.agent.chip.pending"
  | "strings.agent.chip.external"
  | "strings.agent.chip.paused_run"
  | "strings.agent.chip.reply_one"
  | "strings.agent.chip.reply_many"
>;

const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));

/** A tool name as a sentence reads it: "archive threads". */
const words = (tool: string) => tool.replaceAll("_", " ");

export interface SuggestionInput {
  settings: SuggestionStrings;
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
  const s = input.settings;
  const max = s["ai.suggestions.max"];
  const out: Suggestion[] = [];
  for (const call of input.waiting) {
    out.push({ label: fill(s["strings.agent.chip.pending"], { tool: words(call.tool) }) });
  }
  for (const p of input.external ?? []) {
    if (p.status !== "waiting") continue;
    out.push({
      label: fill(s["strings.agent.chip.external"], {
        tool: words(p.tool),
        credential: p.credentialName,
      }),
      session: p.sessionId ?? undefined,
    });
  }
  for (const run of input.pausedRuns ?? []) {
    out.push({
      label: fill(s["strings.agent.chip.paused_run"], {
        step: run.stepName,
        workflow: run.workflowName,
      }),
    });
  }
  const n = input.needsReply.length;
  if (n > 0)
    out.push({
      label:
        n === 1
          ? s["strings.agent.chip.reply_one"]
          : fill(s["strings.agent.chip.reply_many"], { n }),
    });
  for (const label of input.settings["agent.suggestions.evergreen"]) out.push({ label });
  const seen = new Set<string>();
  return out.filter((s) => !seen.has(s.label) && seen.add(s.label)).slice(0, max);
}
