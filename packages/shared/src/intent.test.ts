// The intent contract (slice 27, ADR 0012): the judge's reading assembled in
// code. Dates come from the caller's clock, never from the model; a set is
// a set whatever the scope answer said when an age or a kind names one; the
// confidence is the least certain answer the intent depends on; the gate
// reads the two thresholds.

import { describe, expect, test } from "bun:test";
import {
  type ChoiceReading,
  contactOptions,
  gateIntent,
  groupOptions,
  type IntentReading,
  optionKey,
  resolveIntent,
  resolveWhen,
} from "./intent.ts";

/** Wednesday 16 September 2026, 10:00 local. */
const NOW = new Date(2026, 8, 16, 10, 0);
const HOURS = { morning: 9, afternoon: 14, evening: 18 };

const choice = <K extends string>(key: K, confidence = 1): ChoiceReading<K> => ({
  choice: key,
  confidence,
  probabilities: { [key]: confidence },
});

function reading(overrides: Partial<IntentReading>): IntentReading {
  return {
    text: "typed",
    intent: choice("other"),
    person: choice("none"),
    group: choice("none"),
    section: choice("none"),
    weekday: choice("none"),
    hour: choice("none"),
    scope: 0.1,
    age: choice("none"),
    kind: choice("any"),
    model: "jev-1.13.0",
    ...overrides,
  };
}

const aoife = { name: "Aoife Brennan", email: "aoife@northlight.dev" };
const kenji = { name: "Kenji Watanabe", email: "kenji.w@meridianfund.co" };
const ctx = {
  now: NOW,
  contacts: [aoife, kenji],
  groups: [{ id: "g1", name: "Finance", sentence: "Invoices and receipts" }],
  sections: [{ id: "newsletters", name: "Newsletters" }],
  hours: HOURS,
};

describe("option keys", () => {
  test("names become keys the model can read back, and repeats get a suffix", () => {
    expect(optionKey("Aoife Brennan")).toBe("aoife_brennan");
    expect(optionKey("Zoë Müller-Østergaard")).toBe("zoe_muller_stergaard");
    expect(optionKey("   ")).toBe("item");
    expect(
      contactOptions([aoife, { name: "", email: "aoife@personal.test" }, aoife]).map((c) => c.key),
    ).toEqual(["aoife_brennan", "aoife", "aoife_brennan_2"]);
    expect(groupOptions([{ id: "x", name: "Hiring › Candidates" }])[0]?.key).toBe(
      "hiring_candidates",
    );
  });
});

describe("dates in code", () => {
  test("a bare weekday is its next occurrence, a time already past today moves to tomorrow, a part of a day reads the Setting", () => {
    expect(resolveWhen("thu", "h15", NOW, HOURS)).toEqual(new Date(2026, 8, 17, 15, 0));
    // Wednesday 15:00 is later today; Wednesday 9:00 has passed, so it is next week's.
    expect(resolveWhen("wed", "h15", NOW, HOURS)).toEqual(new Date(2026, 8, 16, 15, 0));
    expect(resolveWhen("wed", "h9", NOW, HOURS)).toEqual(new Date(2026, 8, 23, 9, 0));
    expect(resolveWhen("tomorrow", "morning", NOW, HOURS)).toEqual(new Date(2026, 8, 17, 9, 0));
    expect(resolveWhen("none", "h9", NOW, HOURS)).toEqual(new Date(2026, 8, 17, 9, 0));
    expect(resolveWhen("none", "evening", NOW, HOURS)).toEqual(new Date(2026, 8, 16, 18, 0));
    expect(resolveWhen("mon", "none", NOW, HOURS)).toEqual(new Date(2026, 8, 21, 9, 0));
    expect(resolveWhen("none", "none", NOW, HOURS)).toBeNull();
  });
});

describe("resolveIntent", () => {
  test("set up a call with Aoife Thursday 15:00: the person from the contacts, the moment from the clock", () => {
    const intent = resolveIntent(
      reading({
        text: "set up a call with Aoife Thursday 15:00",
        intent: choice("schedule_event"),
        person: choice("aoife_brennan", 0.97),
        weekday: choice("thu"),
        hour: choice("h15", 0.99),
      }),
      ctx,
    );
    expect(intent).toMatchObject({
      kind: "schedule_event",
      tier: "leaves_mailbox",
      person: aoife,
      scope: "one",
      olderThan: null,
      confidence: 0.97,
    });
    expect(intent.when).toEqual(new Date(2026, 8, 17, 15, 0));
  });

  test("archive every newsletter older than a week: the age and the kind name a set whatever the scope answer said", () => {
    const intent = resolveIntent(
      reading({
        intent: choice("archive"),
        scope: 0.32,
        age: choice("week"),
        kind: choice("newsletter"),
      }),
      ctx,
    );
    expect(intent).toMatchObject({
      kind: "archive",
      tier: "reversible",
      scope: "many",
      age: "week",
      threadKind: "newsletter",
      confidence: 1,
    });
    expect(intent.olderThan).toEqual(new Date(2026, 8, 9, 10, 0));
  });

  test("a name the contacts do not hold, or a Group that is not the user's, costs the intent its confidence", () => {
    const stranger = resolveIntent(
      reading({ intent: choice("compose"), person: choice("someone_else", 0.9) }),
      ctx,
    );
    expect(stranger.person).toBeNull();
    expect(stranger.confidence).toBe(0);
    const moved = resolveIntent(
      reading({ intent: choice("move", 0.95), group: choice("finance", 0.8) }),
      ctx,
    );
    expect(moved.group).toEqual(ctx.groups[0]);
    expect(moved.confidence).toBe(0.8);
    const opened = resolveIntent(
      reading({ intent: choice("open_section"), section: choice("newsletters") }),
      ctx,
    );
    expect(opened.section).toEqual({ id: "newsletters", name: "Newsletters" });
  });

  test("the gate: act above, confirm between, the Agent below or for anything without a Tier", () => {
    const thresholds = { actAbove: 0.9, askBelow: 0.6 };
    const at = (confidence: number, kind: "archive" | "other" = "archive") =>
      gateIntent(resolveIntent(reading({ intent: choice(kind, confidence) }), ctx), thresholds);
    expect(at(0.95)).toBe("act");
    expect(at(0.9)).toBe("act");
    expect(at(0.75)).toBe("confirm");
    expect(at(0.6)).toBe("confirm");
    expect(at(0.59)).toBe("agent");
    expect(at(1, "other")).toBe("agent");
  });
});
