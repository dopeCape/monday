// The Settings the composer reads: every word it shows and every behavior it
// has (ADR 0004). Picked once per Settings change so the composer re-renders
// only when one of these changes.

import type { Settings } from "@monday/shared";
import { type FlowStrings, flowStrings } from "../screens/workflows/flow.ts";
import type { AgentStrings } from "./transcript.ts";

const COMPOSER_KEYS = [
  "strings.agent.approve",
  "strings.agent.apply",
  "strings.agent.decline",
  "strings.agent.undo",
  "strings.agent.retry",
  "strings.agent.applied",
  "strings.agent.undone",
  "strings.agent.declined",
  "strings.agent.waiting",
  "strings.agent.running",
  "strings.agent.failed",
  "strings.agent.working",
  "strings.agent.new",
  "strings.agent.history",
  "strings.agent.collapse",
  "strings.agent.preview_threads",
  "strings.agent.preview_more",
  "strings.agent.preview_groups.title",
  "strings.agent.preview_groups.moves",
  "strings.agent.preview_groups.none",
  "strings.agent.preview_groups.note",
  "strings.agent.preview_send",
  "strings.agent.preview_workflow.create",
  "strings.agent.preview_workflow.update",
  "strings.agent.preview_workflow.enable",
  "strings.agent.preview_workflow.disable",
  "strings.agent.preview_workflow.renamed",
  "strings.agent.preview_workflow.trigger",
  "strings.agent.preview_setting",
  "strings.agent.preview_event.schedule",
  "strings.agent.preview_event.update",
  "strings.agent.preview_event.cancel",
  "strings.agent.preview_event.rsvp",
  "strings.agent.preview_event.link",
  "strings.agent.preview_event.by_provider",
  "strings.agent.preview_event.by_monday",
  "strings.agent.preview_event.conflicts",
  "strings.agent.no_session",
  "strings.agent.runtime_switched",
  "strings.agent.builtin_tool",
  "strings.agent.developer_mode",
  "strings.agent.developer_warning",
  "strings.agent.untitled_session",
  "strings.agent.open_runtime",
  "strings.agent.send",
  "strings.agent.stop",
  "strings.agent.stopped",
  "strings.agent.steps_one",
  "strings.agent.steps_many",
  "strings.agent.copy",
  "strings.agent.copied",
  "strings.agent.copy_code",
  "strings.agent.copy_table",
  "strings.agent.latest",
  "strings.agent.drop_untitled",
  "strings.agent.detach",
  "strings.agent.edit",
  "strings.agent.reload",
  "strings.agent.working_for",
  "strings.agent.continue",
  "strings.agent.continue_prompt",
  "strings.agent.command_new",
  "strings.agent.mention.threads",
  "strings.agent.mention.groups",
  "strings.agent.mention.sections",
  "strings.agent.mention.people",
  "strings.agent.mention.back",
  "strings.agent.asks.always",
  "strings.agent.asks.reversible",
  "ai.composer.markdown",
  "ai.composer.fold_activity",
  "ai.composer.input_history",
  "ai.composer.max_rows",
  "ai.composer.commands",
  "ai.composer.mentions",
  "ai.composer.timestamps",
  "ai.composer.elapsed_after_seconds",
] as const satisfies readonly (keyof Settings)[];

/** The composer's Settings, and the words of the Workflow card's flow. */
export type ComposerStrings = AgentStrings &
  Pick<Settings, (typeof COMPOSER_KEYS)[number]> &
  FlowStrings;

export function composerStrings(settings: Settings): ComposerStrings {
  const out: Partial<Record<keyof Settings, unknown>> = {};
  for (const key of COMPOSER_KEYS) out[key] = settings[key];
  return { ...flowStrings(settings), ...out } as ComposerStrings;
}

export const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));
