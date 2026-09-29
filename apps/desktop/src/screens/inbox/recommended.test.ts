// Recommended action chips on the Device (docs/spec/actions.md): the reader's
// one row (Custom actions first, then the meeting chips, then the Recommended
// actions, never more than max_in_reader; acceptance 7), each chip an ordinary
// tool call with its Tier (a reply, a forward or a hand-off opens compose and
// sends nothing; archive and snooze apply with Undo; acceptance 4), the chip
// keys, and the row's mode.

import { describe, expect, test } from "bun:test";
import type { Person, Recommendation } from "@monday/shared";
import { defaultSettings, recommendationWords } from "@monday/shared";
import {
  createRecommendationRunner,
  followUpUntil,
  listMode,
  readerChips,
  recommendationTier,
  recommendedKeyIndex,
  shownRecommendations,
} from "./recommended.ts";

const priya: Person = { name: "Priya Raman", email: "priya@monday.test" };
const recs: Recommendation[] = [
  { kind: "reply", fit: 0.8, rank: 0.8 },
  { kind: "archive", fit: 0.9, rank: 0.9 },
  { kind: "snooze", fit: 0.85, rank: 0.85, until: "2026-10-05T07:00:00.000Z", anchor: "weekday" },
  { kind: "forward", fit: 0.88, rank: 0.88, to: priya, confidence: 0.9 },
];
const words = recommendationWords(defaultSettings());
const now = new Date("2026-09-29T10:00:00Z");

describe("the reader's chip row", () => {
  test("never more than max_in_reader; Custom actions first, then meetings, then the likeliest", () => {
    const row = readerChips({
      custom: [{ id: "file", label: "File it", tier: "reversible" }],
      meetings: [{ kind: "offer_times", label: "Offer times" }],
      meetingMax: 2,
      recommended: recs,
      max: 3,
      words,
      now,
    });
    expect(row.map((c) => c.kind)).toEqual(["custom", "meeting", "recommended"]);
    expect(row.map((c) => c.label)).toEqual(["File it", "Offer times", "Reply"]);
    for (const max of [0, 1, 2, 3, 6]) {
      const capped = readerChips({
        custom: [],
        meetings: [],
        meetingMax: 2,
        recommended: recs,
        max,
        words,
        now,
      });
      expect(capped.length).toBe(Math.min(max, recs.length));
    }
  });
  test("shown only past each threshold and above AI level off", () => {
    const settings = { ...defaultSettings(), "ai.level": "assist" as const };
    expect(
      shownRecommendations({ settings, recommendations: recs, fromDomain: null }).map(
        (r) => r.kind,
      ),
    ).toEqual(["archive", "forward", "snooze", "reply"]);
    expect(
      shownRecommendations({
        settings: { ...settings, "ai.level": "off" },
        recommendations: recs,
        fromDomain: null,
      }),
    ).toEqual([]);
    expect(listMode(settings)).toBe("hover");
    expect(listMode({ ...settings, "actions.recommended.in_list": "always" })).toBe("always");
    expect(listMode({ ...settings, "actions.recommended.max_in_list": 0 })).toBe("off");
  });
  test("each chip's Tier: compose chips ask, archive and snooze apply with Undo", () => {
    expect(recs.map(recommendationTier)).toEqual([
      "always-ask",
      "reversible",
      "reversible",
      "always-ask",
    ]);
  });
});

describe("running a chip", () => {
  const make = () => {
    const calls: string[] = [];
    const runner = createRecommendationRunner({
      reply: (t, opening) => calls.push(`reply ${t} ${opening}`),
      forward: (t, to) => calls.push(`forward ${t} ${to.email}`),
      handOff: (t, to) => calls.push(`handoff ${t} ${to.email}`),
      archive: async (t) => {
        calls.push(`archive ${t}`);
        return "undo-1";
      },
      snooze: async (t, until) => {
        calls.push(`snooze ${t} ${until.toISOString()}`);
        return "undo-2";
      },
      pickSnooze: (t) => calls.push(`picker ${t}`),
      replyLine: () => "Thursday works for me.",
    });
    return { calls, runner };
  };
  test("a forward opens compose with the person and sends nothing; a reply carries the Brief's line", async () => {
    const { calls, runner } = make();
    expect(await runner.run(recs[3] as Recommendation, "t1")).toEqual({
      ok: true,
      applied: "compose",
    });
    await runner.run(recs[0] as Recommendation, "t1");
    await runner.run({ kind: "delegate", fit: 0.9, rank: 0.9, to: priya, confidence: 0.9 }, "t1");
    expect(calls).toEqual([
      "forward t1 priya@monday.test",
      "reply t1 Thursday works for me.",
      "handoff t1 priya@monday.test",
    ]);
  });
  test("archive and a timed snooze apply with Undo; a snooze with no time opens the picker", async () => {
    const { calls, runner } = make();
    expect(await runner.run(recs[1] as Recommendation, "t1")).toMatchObject({
      applied: "archive",
      undo: "undo-1",
    });
    const until = new Date(Date.now() + 86_400_000).toISOString();
    expect(
      await runner.run({ kind: "snooze", fit: 0.9, rank: 0.9, until, anchor: "tomorrow" }, "t1"),
    ).toMatchObject({ applied: "snooze", undo: "undo-2" });
    expect(
      await runner.run({ kind: "snooze", fit: 0.9, rank: 0.9, until: null, anchor: "none" }, "t1"),
    ).toEqual({ ok: true, applied: "picker" });
    expect(calls.at(-1)).toBe("picker t1");
  });
  test("a hand-off's follow-up comes back after the days the Setting names, at the morning hour", () => {
    const at = followUpUntil(new Date(2026, 8, 29, 15, 0), 3, 8);
    expect(at?.getDate()).toBe(2);
    expect(at?.getHours()).toBe(8);
    expect(followUpUntil(now, 0, 8)).toBeNull();
  });
});

describe("the chip keys", () => {
  const keys = ["alt+1", "alt+2", "alt+3"];
  const press = (key: string, code: string, mods: { alt?: boolean; ctrl?: boolean } = {}) =>
    recommendedKeyIndex(keys, {
      key,
      code,
      altKey: mods.alt ?? false,
      ctrlKey: mods.ctrl ?? false,
      metaKey: false,
      shiftKey: false,
    });
  test("Alt+1..3 by position, by the key or the physical digit (Option+1 types ¡ on a Mac)", () => {
    expect(press("1", "Digit1", { alt: true })).toBe(0);
    expect(press("¡", "Digit1", { alt: true })).toBe(0);
    expect(press("3", "Digit3", { alt: true })).toBe(2);
    expect(press("1", "Digit1")).toBe(-1);
    expect(press("1", "Digit1", { alt: true, ctrl: true })).toBe(-1);
    expect(press("4", "Digit4", { alt: true })).toBe(-1);
  });
});
