// The Reply chip named by the on-open suggestion (docs/spec/templates.md, "On
// open"): the Recommended Reply chip reads "Reply with Confirm the time";
// only the reply chip changes.

import { describe, expect, test } from "bun:test";
import type { Recommendation } from "@monday/shared";
import { recommendationWords } from "@monday/shared";
import { readerChips } from "../screens/inbox/recommended.ts";

describe("the Reply chip named by a Template", () => {
  const recs: Recommendation[] = [
    { kind: "reply", fit: 0.9, rank: 0.9 },
    { kind: "archive", fit: 0.88, rank: 0.88 },
  ];
  const base = {
    custom: [],
    meetings: [],
    meetingMax: 2,
    recommended: recs,
    max: 3,
    words: recommendationWords({}),
    now: new Date("2026-09-29T10:00:00Z"),
    replyWith: "Reply with {name}",
  };
  test("names the Reply chip with the Template, leaves the rest", () => {
    const named = readerChips({ ...base, replyTemplate: "Confirm the time" });
    expect(named.map((c) => c.label)).toEqual(["Reply with Confirm the time", "Archive"]);
    expect(readerChips({ ...base, replyTemplate: null }).map((c) => c.label)).toEqual([
      "Reply",
      "Archive",
    ]);
  });
});
