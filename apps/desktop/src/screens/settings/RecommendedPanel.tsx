// Settings › Sorting and briefs › Recommended actions (docs/spec/actions.md):
// the chips' Settings render from the schema; this panel above them says,
// quietly, when the actions beyond Reply cannot be suggested because no
// TypeSafe key answers them (without TypeSafe only the Signals the shipped
// Sections read go to the language model, signals.llm_fallback).

import { useShell } from "../../shell/Shell.tsx";
import { useKeyState } from "./controls.tsx";
import { type PanelProps, registerPanel } from "./render.tsx";

export function RecommendedPanel(_: PanelProps) {
  const s = useShell().settings;
  const { onDevice, shared } = useKeyState();
  const typesafe =
    s["ai.judge.provider"] !== "llm" && (onDevice.has("typesafe") || shared.has("typesafe"));
  const everything = s["signals.llm_fallback"] === "all";
  if (typesafe || everything || !s["actions.recommended.enabled"]) return null;
  return (
    <div className="note" data-panel="recommended" data-needs="typesafe">
      {s["strings.actions.recommended.needs_typesafe"]}
    </div>
  );
}

registerPanel("routing", "Recommended actions", RecommendedPanel, {
  title: "strings.actions.recommended.page.title",
  description: "strings.actions.recommended.page.intro",
  searchTerms: [
    "recommended",
    "suggested actions",
    "chips",
    "reply",
    "archive",
    "snooze",
    "forward",
    "hand to",
    "thresholds",
  ],
});
