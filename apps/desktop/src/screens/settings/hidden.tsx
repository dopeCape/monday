// Why a search result is not on its page (docs/spec/settings.md, "Disclosure"):
// a card a choice keeps off the page still shows in the results, with one line
// saying which choice brings it back and one click that makes that choice, or
// jumps to it when no single value satisfies it (a URL, a palette file).

import {
  describeSetting,
  isSettingKey,
  keyConditions,
  type SettingCondition,
  type SettingKey,
  satisfyingValue,
  settingsSchema,
  unmetConditions,
} from "@monday/shared";
import { useShell } from "../../shell/Shell.tsx";
import { optionLabel, useSettingsScreen } from "./render.tsx";
import { fill } from "./wizard.ts";

type Strings = ReturnType<typeof useShell>["settings"];

/** A value as the condition line says it: "on", "Hosted", "Judge or Rule". */
export function conditionValue(s: Strings, c: SettingCondition): string {
  const one = (v: unknown): string => {
    if (typeof v === "boolean")
      return v ? s["strings.settings.hidden.on"] : s["strings.settings.hidden.off"];
    return optionLabel(String(v));
  };
  if ("equals" in c) return one(c.equals);
  if (c.in && c.in.length > 0) {
    return c.in.map(one).reduce((a, b) => fill(s["strings.settings.hidden.or"], { a, b }));
  }
  if (c.truthy !== undefined) {
    const boolean = isSettingKey(c.key) && describeSetting(c.key).kind === "boolean";
    if (boolean)
      return c.truthy ? s["strings.settings.hidden.on"] : s["strings.settings.hidden.off"];
    return c.truthy ? s["strings.settings.hidden.set"] : s["strings.settings.hidden.empty"];
  }
  return s["strings.settings.hidden.custom"];
}

/**
 * The line under a result a choice keeps off its page, or nothing when the
 * card is on its page. `onShow` opens the section at the choice.
 */
export function HiddenLine({ k, onShow }: { k: SettingKey; onShow: (parent: SettingKey) => void }) {
  const s = useShell().settings;
  const screen = useSettingsScreen();
  const unmet = unmetConditions(keyConditions(k), s as never);
  const c = unmet[0];
  if (!c || !isSettingKey(c.key)) return null;
  const parent = settingsSchema[c.key].label;
  const value = conditionValue(s, c);
  const make = satisfyingValue(c);
  const key = c.key;
  return (
    <div className="hidden-line" data-hidden-by={key}>
      <span>{fill(s["strings.settings.hidden.line"], { parent, value })}</span>
      {make ? (
        <button type="button" className="link" onClick={() => void screen.change(key, make.value)}>
          {fill(s["strings.settings.hidden.change"], { parent, value })}
        </button>
      ) : (
        <button type="button" className="link" onClick={() => onShow(key)}>
          {fill(s["strings.settings.hidden.show"], { parent })}
        </button>
      )}
    </div>
  );
}
