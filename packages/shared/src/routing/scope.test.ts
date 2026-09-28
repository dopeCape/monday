import { describe, expect, test } from "bun:test";
import { defaultSettings, validateSetting } from "../settings/index.ts";
import {
  describeSortScope,
  formatSortScope,
  inSortScope,
  parseSortScope,
  type SortScope,
  scopeLimit,
  scopeStart,
  scopeWordsFrom,
  sortScopeOr,
} from "./scope.ts";

describe("SortScope", () => {
  test("parses every kind the way a person says it", () => {
    const cases: Array<[string, SortScope | null]> = [
      ["latest 50", { kind: "latest", count: 50 }],
      ["newest 200 threads", { kind: "latest", count: 200 }],
      ["50", { kind: "latest", count: 50 }],
      ["latest 1,000", { kind: "latest", count: 1000 }],
      ["last 3 months", { kind: "last", amount: 3, unit: "months" }],
      ["Last 6 mo", { kind: "last", amount: 6, unit: "months" }],
      ["last month", { kind: "last", amount: 1, unit: "months" }],
      ["2 weeks", { kind: "last", amount: 2, unit: "weeks" }],
      ["last 10 days", { kind: "last", amount: 10, unit: "days" }],
      ["last 2 years", { kind: "last", amount: 2, unit: "years" }],
      ["last year", { kind: "last", amount: 1, unit: "years" }],
      ["3months", { kind: "last", amount: 3, unit: "months" }],
      ["since 2026-01-01", { kind: "since", date: "2026-01-01" }],
      ["2025-06-30", { kind: "since", date: "2025-06-30" }],
      ["all", { kind: "all" }],
      ["everything", { kind: "all" }],
      ["All my mail", { kind: "all" }],
      ["", null],
      ["latest", null],
      ["latest 0", null],
      ["last -3 months", null],
      ["since 2026-02-30", null],
      ["since yesterday", null],
      ["last 3 fortnights", null],
      ["banana", null],
    ];
    for (const [text, want] of cases) expect([text, parseSortScope(text)]).toEqual([text, want]);
  });

  test("formats the canonical sentence, which parses back to the same scope", () => {
    const scopes: SortScope[] = [
      { kind: "latest", count: 50 },
      { kind: "last", amount: 3, unit: "months" },
      { kind: "since", date: "2026-01-01" },
      { kind: "all" },
    ];
    expect(scopes.map(formatSortScope)).toEqual([
      "latest 50",
      "last 3 months",
      "since 2026-01-01",
      "all",
    ]);
    for (const s of scopes) expect(parseSortScope(formatSortScope(s))).toEqual(s);
    expect(sortScopeOr("nonsense", { kind: "all" })).toEqual({ kind: "all" });
  });

  test("a date scope starts on the calendar; a count scope stops at its count", () => {
    const now = new Date("2026-03-31T12:00:00Z");
    expect(scopeStart({ kind: "last", amount: 1, unit: "months" }, now)?.toISOString()).toBe(
      "2026-02-28T12:00:00.000Z",
    );
    expect(scopeStart({ kind: "last", amount: 1, unit: "years" }, now)?.toISOString()).toBe(
      "2025-03-31T12:00:00.000Z",
    );
    expect(scopeStart({ kind: "last", amount: 2, unit: "weeks" }, now)?.toISOString()).toBe(
      "2026-03-17T12:00:00.000Z",
    );
    expect(scopeStart({ kind: "last", amount: 10, unit: "days" }, now)?.toISOString()).toBe(
      "2026-03-21T12:00:00.000Z",
    );
    expect(scopeStart({ kind: "since", date: "2026-01-01" }, now)?.toISOString()).toBe(
      "2026-01-01T00:00:00.000Z",
    );
    expect(scopeStart({ kind: "latest", count: 5 }, now)).toBeNull();
    expect(scopeStart({ kind: "all" }, now)).toBeNull();
    expect(scopeLimit({ kind: "latest", count: 5 })).toBe(5);
    expect(scopeLimit({ kind: "all" })).toBeNull();
    const last3 = { kind: "last", amount: 3, unit: "months" } as const;
    expect(inSortScope(last3, new Date("2026-01-15T00:00:00Z"), now)).toBe(true);
    expect(inSortScope(last3, new Date("2025-12-15T00:00:00Z"), now)).toBe(false);
  });

  test("describes a scope in the words the Settings hold", () => {
    const words = scopeWordsFrom(defaultSettings());
    const say = (text: string) =>
      describeSortScope(parseSortScope(text) as SortScope, words, {
        group: (n) => n.toLocaleString("en-US"),
      });
    expect(say("latest 5000")).toBe("the newest 5,000 threads");
    expect(say("latest 1")).toBe("the newest thread");
    expect(say("last 3 months")).toBe("the last 3 months");
    expect(say("last month")).toBe("the last month");
    expect(say("since 2026-01-01")).toBe("mail since 2026-01-01");
    expect(say("all")).toBe("all your mail");
    const renamed = scopeWordsFrom({
      ...defaultSettings(),
      "strings.routing.scope.last": "{n} {unit} back",
    });
    expect(describeSortScope({ kind: "last", amount: 2, unit: "years" }, renamed)).toBe(
      "2 years back",
    );
  });

  test("the scope Settings take a sentence and refuse anything else", () => {
    const d = defaultSettings();
    expect(d["routing.rerun.scope"]).toBe("latest 50");
    expect(d["routing.backfill.scope"]).toBe("last 3 months");
    expect(validateSetting("routing.backfill.scope", "last 6 months").ok).toBe(true);
    expect(validateSetting("routing.backfill.scope", "all").ok).toBe(true);
    expect(validateSetting("routing.backfill.scope", "some of it").ok).toBe(false);
    expect(d["routing.backfill.request_tokens"]).toBe(64_000);
    expect(d["routing.backfill.state_tokens"]).toBe(32_000);
  });
});
