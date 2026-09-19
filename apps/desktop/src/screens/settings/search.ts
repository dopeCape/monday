// The settings search (docs/spec/settings.md): an index built once from the
// schema plus what the panels say they are searchable by, and a ranker over
// it. Pure: no DOM, no React, so the index shape and the ranking are testable
// as data. Every word typed must match somewhere on an entry; the score is
// the best place the first word matched, so a label prefix beats a label
// word, which beats the help text, which beats the key, the option labels and
// the section or group names. Ties go to the current section, then to schema
// order.

import {
  type AiLevel,
  describeSetting,
  groupsInSection,
  levelAtLeast,
  SETTING_SECTIONS,
  type SettingKey,
  type SettingSection,
  settingLevel,
  settingsSchema,
} from "@monday/shared";

export type SearchEntry =
  | {
      kind: "setting";
      key: SettingKey;
      section: SettingSection;
      group: string;
      label: string;
      help: string;
      /** Option labels and the section and group names; the key itself is matched last. */
      terms: readonly string[];
      /** The lowest AI level the entry shows at. */
      level: AiLevel;
      /** Schema order, for stable ties. */
      order: number;
    }
  | {
      kind: "panel";
      section: SettingSection;
      group: string;
      label: string;
      help: string;
      terms: readonly string[];
      level: AiLevel;
      order: number;
    };

/** What the index needs from a panel registration. */
export interface PanelIndexEntry {
  section: SettingSection;
  group: string;
  label: string;
  help: string;
  terms: readonly string[];
  level: AiLevel;
}

/** "google-meet" as "Google meet", "on_open" as "On open". */
function optionLabel(option: string): string {
  const text = option.replaceAll(/[-_]/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Builds the index from the schema: every key a page renders (not strings,
 * not hidden, not rendered by another key), with its option labels and key
 * pieces as terms, plus the panels. Section names come from the strings
 * Settings so a renamed section is still findable by its name.
 */
export function buildSearchIndex(
  sectionNames: Readonly<Record<SettingSection, string>>,
  panels: readonly PanelIndexEntry[],
): SearchEntry[] {
  const out: SearchEntry[] = [];
  let order = 0;
  for (const section of SETTING_SECTIONS) {
    const sectionName = sectionNames[section];
    for (const group of groupsInSection(section)) {
      const panel = panels.find((p) => p.section === section && p.group === group.name);
      if (panel) {
        out.push({
          kind: "panel",
          section,
          group: group.name,
          label: panel.label,
          help: panel.help,
          terms: [...panel.terms, sectionName, group.name],
          level: panel.level,
          order: order++,
        });
      }
      for (const key of [...group.keys, ...group.advanced]) {
        const entry = settingsSchema[key];
        const shape = describeSetting(key);
        const options =
          shape.kind === "enum"
            ? shape.options.flatMap((o) => [o, optionLabel(o)])
            : shape.kind === "list" && shape.item.kind === "enum"
              ? shape.item.options.flatMap((o) => [o, optionLabel(o)])
              : [];
        out.push({
          kind: "setting",
          key,
          section,
          group: group.name,
          label: entry.label,
          help: entry.help,
          terms: [...options, sectionName, group.name],
          level: settingLevel(key),
          order: order++,
        });
      }
    }
  }
  return out;
}

/** Where a word matched, best first. */
const SCORE = {
  labelPrefix: 100,
  labelWord: 80,
  labelPart: 60,
  helpWord: 40,
  helpPart: 30,
  term: 25,
  key: 20,
} as const;

function wordStart(haystack: string, needle: string): boolean {
  if (haystack.startsWith(needle)) return true;
  return haystack.includes(` ${needle}`) || haystack.includes(`-${needle}`);
}

/** The score of one word against one entry, or 0 when it matches nowhere. */
export function scoreWord(entry: SearchEntry, word: string): number {
  const label = entry.label.toLowerCase();
  const help = entry.help.toLowerCase();
  if (label.startsWith(word)) return SCORE.labelPrefix;
  if (wordStart(label, word)) return SCORE.labelWord;
  if (label.includes(word)) return SCORE.labelPart;
  if (wordStart(help, word)) return SCORE.helpWord;
  if (help.includes(word)) return SCORE.helpPart;
  if (entry.terms.some((t) => t.toLowerCase().includes(word))) return SCORE.term;
  if (entry.kind === "setting" && entry.key.toLowerCase().includes(word)) return SCORE.key;
  return 0;
}

export interface SearchHit {
  entry: SearchEntry;
  score: number;
}

/** The words of a query, lowercased, empty for blank input. */
export function queryWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0);
}

/**
 * Ranks the index for a query at an AI level: every word must match the
 * entry somewhere; the score is the first word's best place plus a little
 * for each further word, and ties prefer the current section, then schema
 * order. At most `limit` hits.
 */
export function searchSettings(
  index: readonly SearchEntry[],
  query: string,
  options: { level: AiLevel; current: SettingSection; limit: number },
): SearchHit[] {
  const words = queryWords(query);
  if (words.length === 0) return [];
  const hits: SearchHit[] = [];
  for (const entry of index) {
    if (!levelAtLeast(options.level, entry.level)) continue;
    let score = 0;
    let all = true;
    for (const [i, w] of words.entries()) {
      const s = scoreWord(entry, w);
      if (s === 0) {
        all = false;
        break;
      }
      score += i === 0 ? s : s / 10;
    }
    if (!all) continue;
    hits.push({ entry, score });
  }
  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ac = a.entry.section === options.current ? 0 : 1;
    const bc = b.entry.section === options.current ? 0 : 1;
    if (ac !== bc) return ac - bc;
    return a.entry.order - b.entry.order;
  });
  return hits.slice(0, options.limit);
}

/**
 * Hits grouped by section for the results page: sections ordered by their
 * best hit, the current section first on a tie, then SETTING_SECTIONS order;
 * hits inside a section keep their rank.
 */
export function groupHits(
  hits: readonly SearchHit[],
  current: SettingSection,
): Array<{ section: SettingSection; hits: SearchHit[] }> {
  const by = new Map<SettingSection, SearchHit[]>();
  for (const h of hits) {
    const list = by.get(h.entry.section) ?? [];
    list.push(h);
    by.set(h.entry.section, list);
  }
  const best = (section: SettingSection) => by.get(section)?.[0]?.score ?? 0;
  return SETTING_SECTIONS.filter((s) => by.has(s))
    .sort((a, b) => {
      if (best(b) !== best(a)) return best(b) - best(a);
      if (a === current) return -1;
      if (b === current) return 1;
      return SETTING_SECTIONS.indexOf(a) - SETTING_SECTIONS.indexOf(b);
    })
    .map((section) => ({ section, hits: by.get(section) ?? [] }));
}
