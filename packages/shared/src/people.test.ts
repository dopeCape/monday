import { describe, expect, test } from "bun:test";
import {
  mergePeople,
  peopleQueryWords,
  personMatches,
  personScore,
  personTerms,
} from "./people.ts";

const NOW = new Date("2026-09-29T00:00:00.000Z");
const ranking = { weights: [3, 1, 2] as const, halfLifeDays: 90 };

describe("people", () => {
  test("terms are the name's words, the address, its local part, domain and pieces", () => {
    expect(
      personTerms({ name: "Kenji Watanabe", email: "Kenji.W@meridianfund.co" }).sort(),
    ).toEqual(
      [
        "co",
        "kenji",
        "kenji.w",
        "kenji.w@meridianfund.co",
        "meridianfund",
        "meridianfund.co",
        "w",
        "watanabe",
      ].sort(),
    );
  });

  test("every typed word must prefix a term; punctuated words also match piece by piece", () => {
    const k = { name: "Kenji Watanabe", email: "kenji.w@meridianfund.co" };
    const m = (q: string) => personMatches(k, peopleQueryWords(q));
    expect(m("wat")).toBe(true);
    expect(m("kenji wat")).toBe(true);
    expect(m("kenji.w@meri")).toBe(true);
    expect(m("watanabe.kenji")).toBe(true);
    expect(m("ridian")).toBe(false);
    expect(m("")).toBe(false);
  });

  test("sending weighs most, then being written to, then recency that halves", () => {
    const sentOften = personScore(
      { sent: 6, received: 1, lastAt: "2026-08-01T00:00:00.000Z" },
      NOW,
      ranking,
    );
    const newsletter = personScore(
      { sent: 0, received: 40, lastAt: "2026-09-28T00:00:00.000Z" },
      NOW,
      ranking,
    );
    expect(sentOften).toBeGreaterThan(newsletter);
    const fresh = personScore({ sent: 0, received: 0, lastAt: NOW.toISOString() }, NOW, ranking);
    const halfLife = personScore(
      { sent: 0, received: 0, lastAt: "2026-07-01T00:00:00.000Z" },
      NOW,
      ranking,
    );
    expect(fresh).toBeCloseTo(2, 6);
    expect(halfLife).toBeCloseTo(1, 6);
    expect(
      personScore({ sent: 0, received: 0, lastAt: "1990-01-01" }, NOW, ranking),
    ).toBeGreaterThan(0);
  });

  test("merging keeps one row per address, the Server's winning, the excluded left out", () => {
    const hit = (email: string, name: string, score: number) => ({
      email,
      name,
      sent: 0,
      received: 0,
      lastAt: null,
      score,
    });
    const merged = mergePeople(
      [hit("a@x.io", "Ann", 1), hit("b@x.io", "Bo", 2), hit("me@x.io", "Me", 9)],
      [hit("A@x.io", "", 5), hit("c@x.io", "Cy", 3)],
      ["ME@x.io"],
      10,
    );
    expect(merged.map((p) => [p.email, p.name, p.score])).toEqual([
      ["A@x.io", "Ann", 5],
      ["c@x.io", "Cy", 3],
      ["b@x.io", "Bo", 2],
    ]);
    expect(mergePeople([hit("a@x.io", "A", 1)], null, [], 0)).toEqual([]);
  });
});
