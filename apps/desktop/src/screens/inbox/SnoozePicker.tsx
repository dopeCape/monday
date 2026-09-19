// The snooze picker: the presets from Settings with their wake times, and
// "pick a time" as a datetime input. Wording comes from the strings Settings.

import type { Settings } from "@monday/shared";
import { Btn } from "@monday/ui";
import { useRef, useState } from "react";
import { Picker, type PickerItem } from "./Picker.tsx";
import { formatWake, type SnoozePreset, snoozeKnobs, snoozeUntil, toLocalInput } from "./snooze.ts";

export interface SnoozePickerProps {
  settings: Settings;
  now: Date;
  onSnooze: (until: Date) => void;
  onClose: () => void;
  leaving?: boolean | undefined;
  onLeft?: (() => void) | undefined;
}

const STRING_KEY: Record<SnoozePreset, keyof Settings> = {
  "later-today": "strings.inbox.snooze.later_today",
  "tomorrow-morning": "strings.inbox.snooze.tomorrow_morning",
  "next-week": "strings.inbox.snooze.next_week",
  "pick-a-time": "strings.inbox.snooze.pick_a_time",
};

export function SnoozePicker({
  settings,
  now,
  onSnooze,
  onClose,
  leaving,
  onLeft,
}: SnoozePickerProps) {
  const [picking, setPicking] = useState(false);
  const knobs = snoozeKnobs(settings);
  const presets = settings["inbox.snooze_presets"];
  const field = useRef<HTMLInputElement>(null);
  const initial = toLocalInput(snoozeUntil("tomorrow-morning", now, knobs) ?? now);

  const items: PickerItem[] = presets.map((p) => {
    const until = snoozeUntil(p, now, knobs);
    return {
      key: p,
      label: String(settings[STRING_KEY[p]]),
      detail: until ? formatWake(until, now) : undefined,
    };
  });

  const pick = (key: string) => {
    const preset = key as SnoozePreset;
    const until = snoozeUntil(preset, now, knobs);
    if (until) onSnooze(until);
    else setPicking(true);
  };

  const confirm = () => {
    const d = new Date(field.current?.value ?? "");
    if (!Number.isNaN(d.getTime())) onSnooze(d);
  };

  return (
    <Picker
      label={settings["strings.inbox.snooze.title"]}
      title={settings["strings.inbox.snooze.title"]}
      items={items}
      onPick={pick}
      onClose={onClose}
      leaving={leaving}
      onLeft={onLeft}
    >
      {picking ? (
        <div className="pop-pick">
          <input
            className="input"
            ref={field}
            type="datetime-local"
            defaultValue={initial}
            aria-label={settings["strings.inbox.snooze.pick_a_time"]}
            // biome-ignore lint/a11y/noAutofocus: the field opens to take the time
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") confirm();
            }}
          />
          <Btn sm primary onClick={confirm}>
            {settings["strings.inbox.snooze.confirm"]}
          </Btn>
        </div>
      ) : null}
    </Picker>
  );
}
