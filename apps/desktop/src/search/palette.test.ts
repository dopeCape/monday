// The palette model and the fuzzy scorer, pure and through their interface.

import { describe, expect, test } from "bun:test";
import type { Thread } from "@monday/shared";
import { fuzzyFilter, fuzzyScore } from "./fuzzy.ts";
import type { SearchHit } from "./index.ts";
import {
  agentHandoff,
  buildPalette,
  isSearchMode,
  moveActive,
  type PaletteInput,
  type PaletteStrings,
} from "./palette.ts";

const NOW = new Date(2026, 8, 16, 10, 0);

const strings: PaletteStrings = {
  ask: "Ask the agent",
  actions: "Actions",
  go: "Go to",
  threads: "Recent threads",
  results: "Results",
  askItem: "Ask monday: {text}",
  searchItem: "Search for {text}",
};

const thread = (id: string, subject: string, from = "Aoife Brennan"): Thread => ({
  id,
  workspaceId: "ws",
  subject,
  participants: [{ name: from, email: `${from.toLowerCase().replace(" ", ".")}@x.test` }],
  lastActivity: "2026-09-16T09:00:00.000Z",
  messageCount: 1,
  unread: false,
  starred: false,
  archived: false,
  snoozedUntil: null,
  section: null,
  group: null,
  subgroup: null,
  tags: [],
  labels: [],
  hasAttachments: false,
  snippet: "",
});

const hit = (t: Thread, pinned = false, score = 1): SearchHit => ({
  thread: t,
  workspaceId: "ws",
  account: "a@x",
  snippet: "…",
  score,
  pinned,
});

function input(text: string, extra: Partial<PaletteInput> = {}): PaletteInput {
  return {
    text,
    actions: [
      { action: "compose.new", label: "New message", kbd: "C", featured: true },
      { action: "thread.archive", label: "Archive", kbd: "E", featured: true },
      { action: "thread.snooze", label: "Snooze", kbd: "H", featured: true },
      { action: "thread.label", label: "Label", kbd: "L", featured: true },
      { action: "thread.move", label: "Move to group", kbd: "M" },
      { action: "select.extend_down", label: "Extend selection down", kbd: "⇧J" },
      { action: "agent.focus", label: "Ask monday", kbd: "/" },
    ],
    navigation: [
      { target: "inbox", label: "Inbox", kbd: "G I", featured: true },
      { target: "group:candidates", label: "Hiring › Candidates", kbd: "G H", featured: true },
      { target: "settings", label: "Settings", kbd: "⌘ ,", featured: true },
      { target: "settings:appearance", label: "Settings: Appearance" },
      { target: "view:1", label: "View: Stream", kbd: "⌘1" },
    ],
    threads: [
      thread("e1", "Re: Senior Rust engineer role, take-home submitted"),
      thread("e2", "Term sheet redline, v3", "Kenji Watanabe"),
    ],
    suggestions: [
      { key: "missed", label: "Summarize what I missed since yesterday" },
      { key: "kenji", label: "Draft a reply to Kenji accepting the pro-rata cap" },
    ],
    strings,
    now: NOW,
    ...extra,
  };
}

describe("fuzzy scorer", () => {
  test("requires every character in order and prefers word starts, runs and prefixes", () => {
    expect(fuzzyScore("xyz", "Archive")).toBeNull();
    expect(fuzzyScore("arc", "Archive")).toBeGreaterThan(fuzzyScore("ace", "Archive") ?? 0);
    expect(fuzzyScore("mtg", "Move to group")).toBeGreaterThan(fuzzyScore("mtg", "Meeting") ?? 0);
    expect(fuzzyScore("set", "Settings")).toBeGreaterThan(
      fuzzyScore("set", "Reset the sheet") ?? 0,
    );
    expect(fuzzyScore("archive", "Archive")).toBeGreaterThan(
      fuzzyScore("archive", "Archive all") ?? 0,
    );
    expect(fuzzyScore("", "anything")).toBe(0);
    expect(fuzzyScore("ARC", "archive")).toEqual(fuzzyScore("arc", "Archive"));
  });

  test("filter returns matches best first and keeps input order on ties", () => {
    const items = ["Snooze", "Settings", "Select", "Send later", "Archive"];
    const out = fuzzyFilter("se", items, (x) => x).map((s) => s.item);
    expect(out).not.toContain("Archive");
    expect(out.slice(0, 3)).toEqual(["Settings", "Select", "Send later"]);
    expect(out).toContain("Snooze");
  });
});

describe("palette: browse mode", () => {
  test("empty text shows the featured items in the mock's order", () => {
    const m = buildPalette(input(""));
    expect(m.mode).toBe("browse");
    expect(m.sections.map((s) => s.key)).toEqual(["ask", "actions", "go"]);
    expect(m.sections[1]?.items.map((i) => i.label)).toEqual([
      "New message",
      "Archive",
      "Snooze",
      "Label",
    ]);
    expect(m.sections[2]?.items.map((i) => i.kbd)).toEqual(["G I", "G H", "⌘ ,"]);
    expect(m.sections[0]?.items.every((i) => i.ai)).toBe(true);
    expect(m.flat.length).toBe(9);
  });

  test("typing fuzzy matches every action, navigation target and recent Thread", () => {
    const m = buildPalette(input("ext"));
    const actions = m.sections.find((s) => s.key === "actions");
    expect(actions?.items.map((i) => i.label)).toEqual(["Extend selection down"]);
    expect(actions?.items[0]?.kbd).toBe("⇧J");
    const go = buildPalette(input("appear")).sections.find((s) => s.key === "go");
    expect(go?.items[0]?.command).toEqual({ type: "navigate", target: "settings:appearance" });
    const threads = buildPalette(input("term sheet")).sections.find((s) => s.key === "threads");
    expect(threads?.items[0]?.thread?.id).toBe("e2");
    expect(threads?.items[0]?.command).toEqual({ type: "open", threadId: "e2", workspaceId: null });
  });

  test("sections reorder by match strength", () => {
    const byKey = (text: string) => buildPalette(input(text)).sections.map((s) => s.key);
    expect(byKey("archive")[0]).toBe("actions");
    expect(byKey("settings")[0]).toBe("go");
    expect(byKey("rust engineer")[0]).toBe("threads");
    // A pinned hit outranks everything.
    const t = thread("x", "Archive policy");
    const withPinned = buildPalette(input("archive", { hits: [hit(t, true)] }));
    expect(withPinned.sections[0]?.key).toBe("results");
    expect(withPinned.sections[0]?.items[0]?.thread?.id).toBe("x");
  });

  test("bare words always end with a search item and an ask item", () => {
    const m = buildPalette(input("zebra"));
    const results = m.sections.find((s) => s.key === "results");
    expect(results?.items[results.items.length - 1]?.command).toEqual({
      type: "search",
      text: "zebra",
      query: m.query,
    });
    expect(results?.items[results.items.length - 1]?.label).toBe("Search for zebra");
    const ask = m.sections[m.sections.length - 1];
    expect(ask?.key).toBe("ask");
    expect(ask?.items[0]?.label).toBe("Ask monday: zebra");
    expect(ask?.items[0]?.ai).toBe(true);
  });

  test("inline hits are capped and never duplicate a recent Thread", () => {
    const hits = [
      hit(thread("e2", "Term sheet redline, v3")),
      hit(thread("h1", "a")),
      hit(thread("h2", "b")),
      hit(thread("h3", "c")),
      hit(thread("h4", "d")),
    ];
    const m = buildPalette(input("term", { hits, inlineHits: 2 }));
    const results = m.sections.find((s) => s.key === "results");
    expect(results?.items.map((i) => i.key)).toEqual(["hit:ws:h1", "hit:ws:h2", "search"]);
  });
});

describe("palette: search mode", () => {
  test("an operator switches to search mode with the hits as the only section", () => {
    expect(isSearchMode("from:kenji", NOW)).toBe(true);
    expect(isSearchMode('"pro rata"', NOW)).toBe(true);
    expect(isSearchMode("kenji", NOW)).toBe(false);
    expect(isSearchMode("", NOW)).toBe(false);
    const hits = [hit(thread("e2", "Term sheet")), hit(thread("e3", "Board seat"))];
    const m = buildPalette(input("from:kenji", { hits }));
    expect(m.mode).toBe("search");
    expect(m.sections.map((s) => s.key)).toEqual(["results"]);
    expect(m.flat.map((i) => i.thread?.id)).toEqual(["e2", "e3"]);
    expect(m.flat[0]?.command).toEqual({ type: "open", threadId: "e2", workspaceId: "ws" });
    expect(m.query.from).toEqual([{ text: "kenji", negated: false }]);
  });

  test("search mode with no hits yet renders an empty results section", () => {
    const m = buildPalette(input("is:unread"));
    expect(m.mode).toBe("search");
    expect(m.flat).toEqual([]);
  });
});

describe("palette: keys and handoff", () => {
  test("arrow keys wrap through the flat list", () => {
    const { flat } = buildPalette(input(""));
    const first = flat[0]?.key ?? null;
    const last = flat[flat.length - 1]?.key ?? null;
    expect(moveActive(flat, null, 1)).toBe(first);
    expect(moveActive(flat, first, -1)).toBe(last);
    expect(moveActive(flat, last, 1)).toBe(first);
    expect(moveActive(flat, first, 1)).toBe(flat[1]?.key ?? null);
    expect(moveActive([], null, 1)).toBeNull();
  });

  test("Tab hands the text to the agent with the parsed query attached", () => {
    const h = agentHandoff("from:kenji pro-rata after:2026-09-01", NOW);
    expect(h.action).toBe("agent.ask");
    expect(h.text).toBe("from:kenji pro-rata after:2026-09-01");
    expect(h.query.from).toEqual([{ text: "kenji", negated: false }]);
    expect(h.query.words).toEqual([{ text: "pro-rata", negated: false }]);
    expect(h.query.after).toBe(new Date(2026, 8, 1).toISOString());
    expect(agentHandoff("", NOW).query.words).toEqual([]);
  });
});
