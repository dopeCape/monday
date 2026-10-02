// Jev's ranking for the picker, remembered briefly per (Thread, typed text)
// (templates.picker.rank_cache_ms): opening the picker twice on the same
// reply asks once, and a suggestion while typing that already carried a
// ranking answers the picker without a request of its own.

import type { Id, TemplateRank, TemplateSuggestResult } from "@monday/shared";

export interface RankCache {
  get(threadId: Id | null, typed: string): TemplateRank[] | null;
  set(threadId: Id | null, typed: string, ranking: TemplateRank[]): void;
  /** Keeps the ranking any suggestion result carries. */
  learn(threadId: Id | null, typed: string, result: TemplateSuggestResult | null): void;
}

/** The most rankings kept; the oldest goes first. */
const KEPT = 50;

const keyOf = (threadId: Id | null, typed: string) => `${threadId ?? ""}\n${typed.trim()}`;

export function createRankCache(ttlMs: number, now: () => number = Date.now): RankCache {
  const entries = new Map<string, { at: number; ranking: TemplateRank[] }>();
  const cache: RankCache = {
    get(threadId, typed) {
      const key = keyOf(threadId, typed);
      const hit = entries.get(key);
      if (!hit) return null;
      if (now() - hit.at > ttlMs) {
        entries.delete(key);
        return null;
      }
      return hit.ranking;
    },
    set(threadId, typed, ranking) {
      if (ttlMs <= 0) return;
      const key = keyOf(threadId, typed);
      entries.delete(key);
      entries.set(key, { at: now(), ranking });
      if (entries.size > KEPT) entries.delete(entries.keys().next().value ?? "");
    },
    learn(threadId, typed, result) {
      if (!result) return;
      if (result.status === "ranked" || result.status === "suggested" || result.status === "none") {
        if (result.ranking) cache.set(threadId, typed, result.ranking);
      }
    },
  };
  return cache;
}
