// The Signals Settings (docs/spec/signals.md, ADR 0014 on ADR 0012; slices
// 28 to 33): every default a Setting (ADR 0004), every word a strings.signals.*
// Setting. Kept in their own file and spread into the schema in one line so
// the schema's other slices merge without touching these.

import { z } from "zod";
import type { SettingEntry, SettingSection } from "./schema.ts";

function setting<T extends z.ZodType>(entry: SettingEntry<T>): SettingEntry<T> {
  return entry;
}

function str(section: SettingSection, label: string, value: string) {
  return setting({
    type: z.string(),
    default: value,
    scope: "global",
    section,
    label,
    help: "A user-visible string. The Agent can change the wording on request.",
  });
}

export const signalsSettings = {
  /* Slice 28: the batching measurement. */
  "ai.judge.eval_enabled": setting({
    type: z.boolean(),
    default: false,
    scope: "global",
    section: "ai",
    group: "TypeSafe",
    tier: "advanced",
    label: "Batching measurement",
    help: "Lets the Sidecar run the batching measurement (scripts/judge-batching-eval.ts): it asks TypeSafe about a sample of your mail several ways and returns numbers and thread ids only. Off unless you are measuring.",
  }),
  "strings.meter.judge.eval": str("ai", "Meter line: batching measurement", "Batching measurement"),
  "strings.meter.judge.backlog": str("ai", "Meter line: background sorting", "Background sorting"),
} satisfies Record<string, SettingEntry>;
