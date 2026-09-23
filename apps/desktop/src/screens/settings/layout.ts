// What a Settings page shows, as data (docs/spec/settings.md, "Disclosure"):
// the section's groups at the AI level, each key sorted by its tier and
// dropped when a choice it depends on excludes it, the Hosted providers other
// than the chosen one folded into one row, and the Advanced keys gathered at
// the bottom of the page. Pure: no React, no DOM, so the rules are testable as
// data, and the page, the index and "Show in section" read the same answer.

import {
  type AiLevel,
  conditionsOf,
  type GroupMeta,
  groupMeta,
  groupsInSectionAt,
  keyConditions,
  type SettingKey,
  type SettingSection,
  type SettingValues,
  settingsSchema,
  unmetConditions,
} from "@monday/shared";

export interface GroupLayout {
  name: string;
  meta: GroupMeta;
  /** A registered panel shows at this level. */
  panel: boolean;
  /** Shown when the group shows. */
  primary: SettingKey[];
  /** Behind the group's "More", in place. */
  more: SettingKey[];
  /** The group's own Advanced keys (a group that keeps them); otherwise in the page's Advanced. */
  advanced: SettingKey[];
  /** Left off the page because a choice they depend on excludes them. */
  hidden: SettingKey[];
  /** Starts folded to its heading: marked so, or nothing in it is primary. */
  collapsed: boolean;
}

export type PageItem =
  | { kind: "group"; group: GroupLayout }
  | { kind: "fold"; into: string; groups: GroupLayout[] };

export interface PageLayout {
  items: PageItem[];
  /** The page's Advanced disclosure: each group's Advanced keys under its name. */
  advanced: Array<{ group: string; keys: SettingKey[] }>;
  /** Every key of the section left off by a dependency. */
  hidden: SettingKey[];
}

function holds(values: SettingValues, when: GroupMeta["visibleWhen"]): boolean {
  return unmetConditions(when, values).length === 0;
}

/**
 * The page for a section at an AI level over the resolved Settings. `hasPanel`
 * says whether a group has a panel the level allows (the registry lives in the
 * renderer).
 */
export function pageLayout(
  section: SettingSection,
  level: AiLevel,
  values: SettingValues,
  hasPanel: (group: string) => boolean,
): PageLayout {
  const items: PageItem[] = [];
  const advanced: PageLayout["advanced"] = [];
  const hiddenAll: SettingKey[] = [];
  const folds = new Map<string, Extract<PageItem, { kind: "fold" }>>();
  for (const g of groupsInSectionAt(section, level)) {
    const meta = groupMeta(section, g.name);
    const all = [...g.primary, ...g.more, ...g.advanced];
    if (!holds(values, meta.visibleWhen)) {
      hiddenAll.push(...all);
      continue;
    }
    const shown = (k: SettingKey) => unmetConditions(keyConditions(k), values).length === 0;
    const hidden = all.filter((k) => !shown(k));
    hiddenAll.push(...hidden);
    const panel = hasPanel(g.name);
    // A group whose panel renders its keys (per Account) shows none in its stack.
    const own = meta.panelRenders ? [] : null;
    const primary = own ?? g.primary.filter(shown);
    const more = own ?? g.more.filter(shown);
    const adv = g.advanced.filter(shown);
    const keepsAdvanced = meta.ownAdvanced === true || meta.fold !== undefined;
    if (!keepsAdvanced && adv.length > 0) advanced.push({ group: g.name, keys: adv });
    const layout: GroupLayout = {
      name: g.name,
      meta,
      panel,
      primary,
      more,
      advanced: keepsAdvanced ? adv : [],
      hidden,
      collapsed: meta.collapsed === true || (!panel && primary.length === 0),
    };
    const content =
      panel || layout.primary.length + layout.more.length + layout.advanced.length > 0;
    if (!content) continue;
    if (meta.fold && !holds(values, meta.fold.openWhen)) {
      const existing = folds.get(meta.fold.into);
      if (existing) existing.groups.push(layout);
      else {
        const fold = { kind: "fold" as const, into: meta.fold.into, groups: [layout] };
        folds.set(meta.fold.into, fold);
        items.push(fold);
      }
      continue;
    }
    items.push({ kind: "group", group: layout });
  }
  return { items, advanced, hidden: hiddenAll };
}

/* ------------------------------ Disclosure ids ------------------------------ */

/** The ids of a page's disclosures; the disclosure store remembers each for the session. */
export const disclosureId = {
  group: (section: SettingSection, group: string) => `${section}/group/${group}`,
  more: (section: SettingSection, group: string) => `${section}/more/${group}`,
  ownAdvanced: (section: SettingSection, group: string) => `${section}/own-advanced/${group}`,
  fold: (section: SettingSection, into: string) => `${section}/fold/${into}`,
  folded: (section: SettingSection, into: string, group: string) =>
    `${section}/fold/${into}/${group}`,
  advanced: (section: SettingSection) => `${section}/advanced`,
};

/** The index's entry for each item: its anchor name and whether it starts folded. */
export interface IndexEntry {
  name: string;
  collapsed: boolean;
}

/** The disclosures to open so a group or fold shows its heading's content. */
export function revealGroup(
  layout: PageLayout,
  section: SettingSection,
  name: string,
): string[] | null {
  for (const item of layout.items) {
    if (item.kind === "group" && item.group.name === name) {
      return item.group.collapsed ? [disclosureId.group(section, name)] : [];
    }
    if (item.kind === "fold") {
      if (item.into === name) return [disclosureId.fold(section, item.into)];
      if (item.groups.some((g) => g.name === name)) {
        return [
          disclosureId.fold(section, item.into),
          disclosureId.folded(section, item.into, name),
        ];
      }
    }
  }
  if (name === ADVANCED_ANCHOR) return [disclosureId.advanced(section)];
  if (layout.advanced.some((a) => a.group === name)) return [disclosureId.advanced(section)];
  return null;
}

/** The anchor name of the page's Advanced disclosure in the index. */
export const ADVANCED_ANCHOR = "Advanced";

/**
 * The disclosures to open so a key's card is on the page, or null when the
 * key is not on this page (hidden by a dependency, or another section's).
 */
export function revealKey(
  layout: PageLayout,
  section: SettingSection,
  key: SettingKey,
): string[] | null {
  for (const item of layout.items) {
    const groups = item.kind === "group" ? [item.group] : item.groups;
    for (const g of groups) {
      const path =
        item.kind === "fold"
          ? [disclosureId.fold(section, item.into), disclosureId.folded(section, item.into, g.name)]
          : g.collapsed
            ? [disclosureId.group(section, g.name)]
            : [];
      if (g.primary.includes(key)) return path;
      if (g.more.includes(key)) {
        // Inside a folded or collapsed group every tier shows once it opens.
        return path.length > 0 ? path : [disclosureId.more(section, g.name)];
      }
      if (g.advanced.includes(key)) return [...path, disclosureId.ownAdvanced(section, g.name)];
      // A group whose panel renders its keys: the group itself is the target.
      if (g.meta.panelRenders && settingsSchema[key].section === section) {
        const entry = settingsSchema[key] as { group?: string };
        if (entry.group === g.name) return path;
      }
    }
  }
  if (layout.advanced.some((a) => a.keys.includes(key))) return [disclosureId.advanced(section)];
  return null;
}
