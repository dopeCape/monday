// Precedence: a key set in monday.toml wins over the same key saved in the
// database, which wins over the shipped default (ADR 0001). A key the file
// sets is Pinned: the UI control is locked and the Agent may edit it only
// after an explicit yes.

import { type Layout, PRESETS } from "../domain.ts";
import {
  defaultSettings,
  type PartialSettings,
  type SettingKey,
  type Settings,
  settingKeys,
} from "../settings/schema.ts";

export interface ResolvedSettings {
  settings: Settings;
  /** Keys the Config file set, including layout knobs a file-set preset decided. */
  pinned: Set<SettingKey>;
}

export type LayoutPreset = Settings["layout.preset"];
type NamedPreset = Exclude<LayoutPreset, "custom">;

const KNOBS = ["layout.nav", "layout.agent", "layout.list"] as const;

/** The Preset whose knobs match, or "custom". */
export function presetForLayout(layout: Layout): LayoutPreset {
  for (const [name, preset] of Object.entries(PRESETS) as [NamedPreset, Layout][]) {
    if (preset.nav === layout.nav && preset.agent === layout.agent && preset.list === layout.list) {
      return name;
    }
  }
  return "custom";
}

export function resolveSettings(
  fileValues: PartialSettings,
  dbValues: PartialSettings,
  defaults: Settings = defaultSettings(),
): ResolvedSettings {
  const settings: Record<string, unknown> = { ...defaults };
  const pinned = new Set<SettingKey>();

  for (const key of settingKeys) {
    if (key in dbValues && dbValues[key] !== undefined) settings[key] = dbValues[key];
    if (key in fileValues && fileValues[key] !== undefined) {
      settings[key] = fileValues[key];
      pinned.add(key);
    }
  }

  // The preset is derived from the three knobs. A preset set explicitly fills in
  // any knob that was not set explicitly at the same or a higher layer.
  const explicitPreset = (fileValues["layout.preset"] ?? dbValues["layout.preset"]) as
    | LayoutPreset
    | undefined;
  const presetFromFile = fileValues["layout.preset"] !== undefined;
  if (explicitPreset && explicitPreset !== "custom") {
    const preset = PRESETS[explicitPreset];
    for (const knobKey of KNOBS) {
      const knob = knobKey.slice("layout.".length) as keyof Layout;
      const fileSet = fileValues[knobKey] !== undefined;
      const dbSet = dbValues[knobKey] !== undefined;
      if (fileSet) continue;
      if (dbSet && !presetFromFile) continue;
      settings[knobKey] = preset[knob];
      if (presetFromFile) pinned.add(knobKey);
    }
  }
  const layout: Layout = {
    nav: settings["layout.nav"] as Layout["nav"],
    agent: settings["layout.agent"] as Layout["agent"],
    list: settings["layout.list"] as Layout["list"],
  };
  settings["layout.preset"] = presetForLayout(layout);

  return { settings: settings as Settings, pinned };
}
