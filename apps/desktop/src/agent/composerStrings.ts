// The Settings the composer reads: every word it shows and every behavior it
// has (ADR 0004). Picked once per Settings change so the composer re-renders
// only when one of these changes.

import type { Settings } from "@monday/shared";
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
  "strings.agent.preview_send",
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
  "ai.composer.markdown",
  "ai.composer.fold_activity",
  "ai.composer.input_history",
  "ai.composer.max_rows",
] as const satisfies readonly (keyof Settings)[];

export type ComposerStrings = AgentStrings & Pick<Settings, (typeof COMPOSER_KEYS)[number]>;

export function composerStrings(settings: Settings): ComposerStrings {
  const out: Partial<Record<keyof Settings, unknown>> = {};
  for (const key of COMPOSER_KEYS) out[key] = settings[key];
  return out as ComposerStrings;
}

export const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? ""));
