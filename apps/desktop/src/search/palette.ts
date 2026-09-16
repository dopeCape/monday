// The command palette model (ADR 0011): one input at ⌘K over actions from
// the keymap, navigation, recent Threads and search. Pure and synchronous:
// the container feeds it the text, the catalogues and any search hits it has
// already fetched, and renders what comes back. Typing an operator switches
// the box into search mode, where the hits are the rows; bare text fuzzy
// matches the catalogues and offers a search. Sections reorder by how well
// their best item matches. Tab hands the text to the Agent with the parsed
// query attached.

import type { Thread } from "@monday/shared";
import { fuzzyFilter } from "./fuzzy.ts";
import type { SearchHit } from "./index.ts";
import { hasOperator, isEmpty, parseQuery, type SearchQuery } from "./query.ts";

export interface PaletteAction {
  /** A keymap action name, or a screen-level command the container understands. */
  action: string;
  label: string;
  kbd?: string | undefined;
  icon?: string | undefined;
  /** Shown before anything is typed. */
  featured?: boolean | undefined;
}

export interface PaletteNav {
  /** The navigation target: a screen, a folder, a group, a view or a settings page. */
  target: string;
  label: string;
  kbd?: string | undefined;
  icon?: string | undefined;
  featured?: boolean | undefined;
}

/** A canned line for the Agent; the composer (slice 14) supplies real ones. */
export interface PaletteSuggestion {
  key: string;
  label: string;
}

export type PaletteCommand =
  | { type: "action"; action: string }
  | { type: "navigate"; target: string }
  | { type: "open"; threadId: string; workspaceId: string | null }
  | { type: "search"; text: string; query: SearchQuery }
  | { type: "ask"; text: string; query: SearchQuery }
  | { type: "suggest"; key: string; text: string };

export interface PaletteItem {
  key: string;
  label: string;
  kbd?: string | undefined;
  icon?: string | undefined;
  /** Rendered with the monogram: it goes to the Agent. */
  ai?: boolean | undefined;
  /** Rendered as a Thread row when present. */
  thread?: Thread | undefined;
  /** The account label, in the all-accounts view. */
  account?: string | undefined;
  snippet?: string | undefined;
  command: PaletteCommand;
  score: number;
}

export type PaletteSectionKey = "ask" | "actions" | "go" | "threads" | "results";

export interface PaletteSection {
  key: PaletteSectionKey;
  label: string;
  items: PaletteItem[];
  /** The best item's score; sections order by it while something is typed. */
  strength: number;
}

export interface PaletteStrings {
  ask: string;
  actions: string;
  go: string;
  threads: string;
  results: string;
  /** "Ask monday: {text}" */
  askItem: string;
  /** "Search for {text}" */
  searchItem: string;
}

export interface PaletteInput {
  text: string;
  actions: readonly PaletteAction[];
  navigation: readonly PaletteNav[];
  threads: readonly Thread[];
  suggestions: readonly PaletteSuggestion[];
  /** Hits for the current text, when the container has them. */
  hits?: readonly SearchHit[] | undefined;
  strings: PaletteStrings;
  /** Items per section before anything is typed. */
  featured?: number | undefined;
  /** Items per section while typing. */
  limit?: number | undefined;
  /** Hits shown inline while browsing (search mode shows every hit). */
  inlineHits?: number | undefined;
  now?: Date | undefined;
}

export type PaletteMode = "browse" | "search";

export interface PaletteModel {
  mode: PaletteMode;
  query: SearchQuery;
  sections: PaletteSection[];
  /** Every item in render order, for the arrow keys. */
  flat: PaletteItem[];
}

/** What Tab dispatches: the `agent.ask` action with the parsed query attached. */
export interface AgentAsk {
  action: "agent.ask";
  text: string;
  query: SearchQuery;
}

const fill = (template: string, text: string) => template.replaceAll("{text}", text);

/** Where search hits sit next to fuzzy scores: below a good catalogue match unless pinned. */
const STRENGTH_HIT = 15;
const STRENGTH_PINNED = 200;

/** Search mode: the text names a field or a phrase. Bare words stay in the browse mode. */
export function isSearchMode(text: string, now?: Date): boolean {
  return hasOperator(parseQuery(text, now ? { now } : {}));
}

export function agentHandoff(text: string, now?: Date): AgentAsk {
  return { action: "agent.ask", text, query: parseQuery(text, now ? { now } : {}) };
}

function hitItem(h: SearchHit, index: number): PaletteItem {
  return {
    key: `hit:${h.workspaceId}:${h.thread.id}`,
    label: h.thread.subject,
    thread: h.thread,
    account: h.account,
    snippet: h.snippet,
    command: { type: "open", threadId: h.thread.id, workspaceId: h.workspaceId },
    score: (h.pinned ? STRENGTH_PINNED : STRENGTH_HIT) + h.score - index * 1e-3,
  };
}

export function buildPalette(input: PaletteInput): PaletteModel {
  const text = input.text.trim();
  const query = parseQuery(input.text, input.now ? { now: input.now } : {});
  const featured = input.featured ?? 5;
  const limit = input.limit ?? 6;
  const inline = input.inlineHits ?? 3;
  const s = input.strings;
  const sections: PaletteSection[] = [];

  if (hasOperator(query)) {
    const items = (input.hits ?? []).map(hitItem);
    sections.push({
      key: "results",
      label: s.results,
      items,
      strength: items[0]?.score ?? 0,
    });
    const flat = sections.flatMap((sec) => sec.items);
    return { mode: "search", query, sections, flat };
  }

  if (text === "") {
    const ask = input.suggestions.slice(0, featured).map<PaletteItem>((g) => ({
      key: `ask:${g.key}`,
      label: g.label,
      ai: true,
      command: { type: "suggest", key: g.key, text: g.label },
      score: 0,
    }));
    const actions = input.actions
      .filter((a) => a.featured)
      .slice(0, featured)
      .map<PaletteItem>((a) => ({
        key: `action:${a.action}`,
        label: a.label,
        kbd: a.kbd,
        icon: a.icon,
        command: { type: "action", action: a.action },
        score: 0,
      }));
    const go = input.navigation
      .filter((n) => n.featured)
      .slice(0, featured)
      .map<PaletteItem>((n) => ({
        key: `go:${n.target}`,
        label: n.label,
        kbd: n.kbd,
        icon: n.icon,
        command: { type: "navigate", target: n.target },
        score: 0,
      }));
    if (ask.length) sections.push({ key: "ask", label: s.ask, items: ask, strength: 0 });
    if (actions.length)
      sections.push({ key: "actions", label: s.actions, items: actions, strength: 0 });
    if (go.length) sections.push({ key: "go", label: s.go, items: go, strength: 0 });
    return { mode: "browse", query, sections, flat: sections.flatMap((sec) => sec.items) };
  }

  const actions = fuzzyFilter(text, input.actions, (a) => a.label)
    .slice(0, limit)
    .map<PaletteItem>(({ item: a, score }) => ({
      key: `action:${a.action}`,
      label: a.label,
      kbd: a.kbd,
      icon: a.icon,
      command: { type: "action", action: a.action },
      score,
    }));
  const go = fuzzyFilter(text, input.navigation, (n) => n.label)
    .slice(0, limit)
    .map<PaletteItem>(({ item: n, score }) => ({
      key: `go:${n.target}`,
      label: n.label,
      kbd: n.kbd,
      icon: n.icon,
      command: { type: "navigate", target: n.target },
      score,
    }));
  const threads = fuzzyFilter(
    text,
    input.threads,
    (t) => `${t.subject} ${t.participants[0]?.name ?? ""}`,
  )
    .slice(0, limit)
    .map<PaletteItem>(({ item: t, score }) => ({
      key: `thread:${t.id}`,
      label: t.subject,
      thread: t,
      command: { type: "open", threadId: t.id, workspaceId: null },
      score,
    }));
  const hits = (input.hits ?? [])
    .filter((h) => !threads.some((t) => t.thread?.id === h.thread.id))
    .slice(0, inline)
    .map(hitItem);
  const searchItem: PaletteItem = {
    key: "search",
    label: fill(s.searchItem, text),
    icon: "search",
    command: { type: "search", text: input.text, query },
    score: 1,
  };
  const askItem: PaletteItem = {
    key: "ask",
    label: fill(s.askItem, text),
    ai: true,
    command: { type: "ask", text: input.text, query },
    score: 0,
  };

  const strength = (items: PaletteItem[]) => items[0]?.score ?? Number.NEGATIVE_INFINITY;
  if (actions.length) {
    sections.push({
      key: "actions",
      label: s.actions,
      items: actions,
      strength: strength(actions),
    });
  }
  if (go.length) sections.push({ key: "go", label: s.go, items: go, strength: strength(go) });
  if (threads.length) {
    sections.push({
      key: "threads",
      label: s.threads,
      items: threads,
      strength: strength(threads),
    });
  }
  sections.push({
    key: "results",
    label: s.results,
    items: [...hits, searchItem],
    strength: isEmpty(query)
      ? Number.NEGATIVE_INFINITY
      : strength(hits.length ? hits : [searchItem]),
  });
  sections.push({ key: "ask", label: s.ask, items: [askItem], strength: Number.NEGATIVE_INFINITY });
  sections.sort((a, b) => b.strength - a.strength);
  return { mode: "browse", query, sections, flat: sections.flatMap((sec) => sec.items) };
}

/** The key `delta` rows from `active` in `flat`, wrapping; the first when nothing is active. */
export function moveActive(
  flat: readonly PaletteItem[],
  active: string | null,
  delta: number,
): string | null {
  if (flat.length === 0) return null;
  const at = active === null ? -1 : flat.findIndex((i) => i.key === active);
  if (at === -1) return (delta >= 0 ? flat[0] : flat[flat.length - 1])?.key ?? null;
  const next = (at + delta + flat.length) % flat.length;
  return flat[next]?.key ?? null;
}
