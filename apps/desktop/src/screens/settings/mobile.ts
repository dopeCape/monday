// What a phone or tablet leaves off the Settings pages: the parts that are
// about this computer and have no counterpart on a mobile OS. A phone is a
// client of the Server it was paired with (ADR 0006): it has no Config file
// to watch, no background service, no keyboard to map, no command-line
// runtime (the agent runs Hosted, on the Server) and no Sidecar to prefer.
// These are facts about the device, not product behavior, so they are a
// list here rather than Settings. Search leaves them off too.

import type { SettingKey, SettingSection } from "@monday/shared";

/** Whole groups a mobile OS does not show, by section. */
const GROUPS: Partial<Record<SettingSection, readonly string[]>> = {
  appearance: ["Config file", "Layout shortcuts"],
  shortcuts: ["Keymap"],
  server: ["Background service", "Cloud"],
};

/** Single keys a mobile OS does not show; a trailing `*` takes a prefix. */
const KEYS: readonly string[] = [
  "ai.mode",
  "ai.local.*",
  "ai.keys.share_with_sidecar",
  "appearance.webview_memory_mb",
  "server.postgres_buffers_mb",
  "server.prefer",
  "server.sidecar.*",
  "search.prewarm_*",
  "settings.search_key",
];

/** Whether a group of a section is left off on a mobile OS. */
export function groupHiddenOnMobile(section: SettingSection, group: string): boolean {
  return GROUPS[section]?.includes(group) ?? false;
}

/** Whether a key is left off on a mobile OS. */
export function keyHiddenOnMobile(key: SettingKey | string): boolean {
  return KEYS.some((k) => (k.endsWith("*") ? key.startsWith(k.slice(0, -1)) : key === k));
}

/** The page layout's filter on a mobile OS. */
export const MOBILE_HIDE = {
  group: groupHiddenOnMobile,
  key: keyHiddenOnMobile,
} as const;
