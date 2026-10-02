/// <reference types="bun-types" />
// Jev's order in the picker: the Suggested first under their floor and
// count, the rest in the picker's own order; and the brief memory of a
// ranking per (Thread, typed text), fed by the picker and by suggestions.

import { describe, expect, test } from "bun:test";
import { BUILTIN_TEMPLATES } from "@monday/shared";
import { filterTemplates, rankTemplates } from "./picker.ts";
import { createRankCache } from "./rank.ts";

const ids = (list: ReadonlyArray<{ id: string }>) => list.map((t) => t.id);

describe("rankTemplates", () => {
  const all = filterTemplates(BUILTIN_TEMPLATES, "");

  test("with no ranking the list is the picker's own, nothing marked", () => {
    const r = rankTemplates(all, null, { max: 3, floor: 0.15 });
    expect(ids(r.items)).toEqual(ids(all));
    expect(r.suggested).toBe(0);
  });

  test("at most max, at least floor, likeliest first; the rest keep their order", () => {
    const r = rankTemplates(
      all,
      [
        { templateId: "t_decline", p: 0.2 },
        { templateId: "t_offer_times", p: 0.5 },
        { templateId: "t_reschedule", p: 0.16 },
        { templateId: "t_need_more_time", p: 0.1 },
      ],
      { max: 2, floor: 0.15 },
    );
    expect(r.suggested).toBe(2);
    expect(ids(r.items).slice(0, 2)).toEqual(["t_offer_times", "t_decline"]);
    const rest = ids(all).filter((id) => id !== "t_offer_times" && id !== "t_decline");
    expect(ids(r.items).slice(2)).toEqual(rest);
    expect(r.p.get("t_offer_times")).toBe(0.5);
  });

  test("only Templates the filter kept can be Suggested", () => {
    const filtered = filterTemplates(BUILTIN_TEMPLATES, "invoice");
    const r = rankTemplates(filtered, [{ templateId: "t_offer_times", p: 0.9 }], {
      max: 3,
      floor: 0.15,
    });
    expect(r.suggested).toBe(0);
    expect(ids(r.items)).toEqual(ids(filtered));
  });
});

describe("the ranking memory", () => {
  test("a ranking is reused for the same Thread and typed text until it expires", () => {
    let now = 1_000;
    const cache = createRankCache(60_000, () => now);
    const ranking = [{ templateId: "t_offer_times", p: 0.5 }];
    cache.set("t1", "can we do another time? ", ranking);
    expect(cache.get("t1", "can we do another time?")).toEqual(ranking);
    expect(cache.get("t2", "can we do another time?")).toBeNull();
    expect(cache.get("t1", "something else")).toBeNull();
    now += 60_001;
    expect(cache.get("t1", "can we do another time?")).toBeNull();
  });

  test("a suggestion's ranking answers the picker; a zero memory keeps nothing", () => {
    const cache = createRankCache(60_000, () => 0);
    cache.learn("t1", "Thanks for", {
      status: "none",
      reason: "floor",
      gate: 0.6,
      ranking: [{ templateId: "t_thanks_received", p: 0.57 }],
    });
    expect(cache.get("t1", "Thanks for")).toEqual([{ templateId: "t_thanks_received", p: 0.57 }]);
    cache.learn("t1", "x", { status: "unavailable", reason: "no judge" });
    expect(cache.get("t1", "x")).toBeNull();
    const off = createRankCache(0, () => 0);
    off.set("t1", "a", [{ templateId: "t_thank_you", p: 1 }]);
    expect(off.get("t1", "a")).toBeNull();
  });
});
