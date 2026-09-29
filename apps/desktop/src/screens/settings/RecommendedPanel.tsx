// Settings › Sorting and briefs › Recommended actions (docs/spec/actions.md):
// the chips' Settings render from the schema; this panel above them says,
// quietly, when the actions beyond Reply cannot be suggested because no
// TypeSafe key answers them (without TypeSafe only the Signals the shipped
// Sections read go to the language model, signals.llm_fallback), and shows
// per action how often its chip was shown and used since its threshold was
// last set, with the threshold learning has it at.

import type { RecommendationStat } from "@monday/shared";
import { useEffect, useState } from "react";
import { useShell } from "../../shell/Shell.tsx";
import { useKeyState } from "./controls.tsx";
import { type PanelProps, registerPanel, useSettingsScreen } from "./render.tsx";
import { fill } from "./wizard.ts";

export function RecommendedPanel(_: PanelProps) {
  const shell = useShell();
  const s = shell.settings;
  const screen = useSettingsScreen();
  const { onDevice, shared } = useKeyState();
  const [stats, setStats] = useState<RecommendationStat[] | null>(null);
  const typesafe =
    s["ai.judge.provider"] !== "llm" && (onDevice.has("typesafe") || shared.has("typesafe"));
  const everything = s["signals.llm_fallback"] === "all";
  const on = s["actions.recommended.enabled"];

  useEffect(() => {
    if (!on || !shell.api?.recommendations?.stats) return;
    let live = true;
    shell.api.recommendations
      .stats(screen.workspaceId)
      .then((r) => {
        if (live) setStats(r);
      })
      .catch(() => {
        if (live) setStats(null);
      });
    return () => {
      live = false;
    };
  }, [on, shell.api, screen.workspaceId]);

  if (!on) return null;
  const used = (stats ?? []).filter((r) => r.shown > 0);
  const name = (action: string) => {
    const key = `strings.actions.recommended.name.${action}` as keyof typeof s;
    return typeof s[key] === "string" ? String(s[key]) : action;
  };
  return (
    <div className="note" data-panel="recommended">
      {typesafe || everything ? null : (
        <div data-needs="typesafe">{s["strings.actions.recommended.needs_typesafe"]}</div>
      )}
      {used.map((r) => (
        <div key={r.action} data-stat={r.action}>
          {fill(s["strings.actions.recommended.stats"], {
            action: name(r.action),
            shown: r.shown,
            used: r.used,
            percent: r.threshold === null ? "" : `${Math.round(r.threshold * 100)}%`,
          })}
        </div>
      ))}
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
    "unsubscribe",
    "pay",
    "calendar",
    "learning",
    "thresholds",
  ],
});
