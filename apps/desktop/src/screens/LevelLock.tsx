// The locked state of a page whose feature the AI level keeps paused
// (CONTEXT.md "AI level"): Workflows and Routing need "Mail that sorts and
// acts for me". The panel says what is paused and that nothing is lost, and
// raises the level through the Shell after a short confirm, the same write
// the level cards in Settings make; a level set in the Config file is the
// user's, so the panel says where to change it instead (ADR 0001).

import type { AiLevel } from "@monday/shared";
import { levelAtLeast } from "@monday/shared";
import { LockedPanel } from "@monday/ui";
import { type ReactNode, useState } from "react";
import { useShell } from "../shell/Shell.tsx";
import { fill } from "./inbox/triage.ts";

/** The level the page's feature needs. */
export const LOCK_LEVEL: AiLevel = "automate";

/** Whether the AI level keeps the page's feature paused, and the level's name for the copy. */
export function useLevelLock(): { locked: boolean; level: AiLevel; levelName: string } {
  const { settings } = useShell();
  const level = settings["ai.level"];
  return {
    locked: !levelAtLeast(level, LOCK_LEVEL),
    level,
    levelName: settings[`strings.ai.level.${level}`],
  };
}

export interface LevelLockProps {
  title: string;
  lede: string;
  /** What is paused and kept, worded with the current level already. */
  body: string;
  benefits: readonly string[];
  illustration?: ReactNode | undefined;
  onNavigate?: ((target: string) => void) | undefined;
}

export function LevelLock({
  title,
  lede,
  body,
  benefits,
  illustration,
  onNavigate,
}: LevelLockProps) {
  const shell = useShell();
  const s = shell.settings;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const target = s[`strings.ai.level.${LOCK_LEVEL}`];
  const raise = async () => {
    setBusy(true);
    setError(null);
    const r = await shell.set("ai.level", LOCK_LEVEL);
    if (!r.ok) setError(r.message);
    setBusy(false);
  };
  return (
    <LockedPanel
      title={title}
      lede={lede}
      body={body}
      benefitsTitle={s["strings.ai.lock.gets"]}
      benefits={benefits}
      illustration={illustration}
      raiseLabel={fill(s["strings.ai.lock.raise"], { level: target })}
      confirmLabel={fill(s["strings.ai.lock.confirm"], { level: target })}
      confirmNote={s["strings.ai.lock.confirm_note"]}
      cancelLabel={s["strings.ai.lock.cancel"]}
      settingsLabel={s["strings.ai.lock.settings"]}
      pinnedNote={shell.pinned.has("ai.level") ? s["strings.ai.lock.pinned"] : undefined}
      error={error}
      busy={busy}
      onRaise={() => void raise()}
      onSettings={onNavigate ? () => onNavigate("settings:ai") : undefined}
    />
  );
}
