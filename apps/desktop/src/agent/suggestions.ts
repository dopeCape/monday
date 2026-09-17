// Suggestion chips (docs/spec/agent-composer.md): up to ai.suggestions.max,
// from pending approvals first, then Threads in Needs your reply, then the
// evergreen prompts Setting. Plain sentences, no icons.

import type { Settings, Thread, ToolCall } from "@monday/shared";
import type { Suggestion } from "@monday/ui";

export interface SuggestionInput {
  settings: Pick<Settings, "ai.suggestions.max" | "agent.suggestions.evergreen">;
  /** Calls waiting for the user in the current Session. */
  waiting: readonly ToolCall[];
  /** Threads in Needs your reply. */
  needsReply: readonly Thread[];
}

export function suggestionsFor(input: SuggestionInput): Suggestion[] {
  const max = input.settings["ai.suggestions.max"];
  const out: Suggestion[] = [];
  for (const call of input.waiting) {
    out.push({ label: `Decide on the pending ${call.tool.replaceAll("_", " ")}` });
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
