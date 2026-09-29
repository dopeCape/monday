// Choosing and wording the Recommended actions (docs/spec/actions.md): the
// thresholds by risk, the recipient floor (acceptance 4), the switches, the
// per-sender mutes, one chip per person, the words, and what a user's own
// action makes of a chip it showed.

import { describe, expect, test } from "bun:test";
import {
  chooseRecommended,
  formatWhen,
  outcomeOf,
  type Recommendation,
  recommendationLabel,
  recommendationRules,
  recommendationWords,
  senderMuted,
} from "./actions.ts";
import { defaultSettings } from "./settings/index.ts";

const rules = (over: Record<string, unknown> = {}) =>
  recommendationRules({ ...defaultSettings(), ...over });
const priya = { name: "Priya Raman", email: "priya@monday.test" };

describe("choosing the chips", () => {
  const recs: Recommendation[] = [
    { kind: "reply", fit: 0.72, rank: 0.72 },
    { kind: "archive", fit: 0.84, rank: 0.84 },
    { kind: "snooze", fit: 0.8, rank: 0.8, until: "2026-10-05T08:00:00.000Z", anchor: "weekday" },
    { kind: "forward", fit: 0.9, rank: 0.9, to: priya, confidence: 0.8 },
  ];
  test("each action past its own threshold, likeliest first", () => {
    const shown = chooseRecommended(recs, rules(), { fromDomain: "stripe.com" });
    // Archive needs 0.85 (it hides mail); reply 0.7, snooze 0.75, forward 0.8.
    expect(shown.map((r) => r.kind)).toEqual(["forward", "snooze", "reply"]);
  });
  test("a forward shows only when the person is picked at 0.8 or more (acceptance 4)", () => {
    const unsure = recs.map((r) => (r.kind === "forward" ? { ...r, confidence: 0.79 } : r));
    expect(chooseRecommended(unsure, rules(), { fromDomain: null }).map((r) => r.kind)).toEqual([
      "snooze",
      "reply",
    ]);
  });
  test("switched off, muted for the sender, dismissed here, or covered by a Custom action: not shown", () => {
    const ctx = { fromDomain: "billing.stripe.com" };
    expect(chooseRecommended(recs, rules({ "actions.recommended.enabled": false }), ctx)).toEqual(
      [],
    );
    expect(
      chooseRecommended(recs, rules({ "actions.recommended.snooze.enabled": false }), ctx).map(
        (r) => r.kind,
      ),
    ).toEqual(["forward", "reply"]);
    expect(
      chooseRecommended(
        recs,
        rules({ "actions.recommended.forward.muted_senders": ["stripe.com"] }),
        ctx,
      ).map((r) => r.kind),
    ).toEqual(["snooze", "reply"]);
    expect(
      chooseRecommended(recs, rules(), { ...ctx, dismissed: new Set(["reply"] as const) }).map(
        (r) => r.kind,
      ),
    ).toEqual(["forward", "snooze"]);
    const archiving = [...recs, { kind: "archive", fit: 0.95, rank: 0.95 } as Recommendation];
    expect(
      chooseRecommended(archiving, rules(), { ...ctx, customArchives: true }).map((r) => r.kind),
    ).not.toContain("archive");
  });
  test("a forward and a hand-off to the same person: the likelier one", () => {
    const both: Recommendation[] = [
      { kind: "forward", fit: 0.86, rank: 0.86, to: priya, confidence: 0.9 },
      { kind: "delegate", fit: 0.9, rank: 0.9, to: priya, confidence: 0.9 },
    ];
    expect(chooseRecommended(both, rules(), { fromDomain: null }).map((r) => r.kind)).toEqual([
      "delegate",
    ]);
  });
  test("a sender's domain is muted with the domains under it", () => {
    expect(senderMuted("billing.stripe.com", ["stripe.com"])).toBe(true);
    expect(senderMuted("notstripe.com", ["stripe.com"])).toBe(false);
    expect(senderMuted(null, ["stripe.com"])).toBe(false);
  });
});

describe("the chips' words", () => {
  const words = recommendationWords(defaultSettings());
  const now = new Date("2026-09-29T10:00:00Z");
  test("from the strings Settings, dates in the zone given", () => {
    expect(recommendationLabel({ kind: "reply" }, words, now, "UTC")).toBe("Reply");
    expect(
      recommendationLabel(
        { kind: "snooze", until: "2026-10-05T09:00:00.000Z", anchor: "weekday" },
        words,
        now,
        "UTC",
      ),
    ).toBe("Snooze until Mon 09:00");
    expect(
      recommendationLabel({ kind: "snooze", until: null, anchor: "none" }, words, now, "UTC"),
    ).toBe("Snooze");
    expect(
      recommendationLabel({ kind: "forward", to: priya, confidence: 0.9 }, words, now, "UTC"),
    ).toBe("Forward to Priya");
    expect(
      recommendationLabel({ kind: "delegate", to: priya, confidence: 0.9 }, words, now, "UTC"),
    ).toBe("Hand to Priya");
    expect(formatWhen("2026-10-20T09:00:00.000Z", now, { zone: "UTC" })).toBe("Oct 20 09:00");
    expect(formatWhen("2026-10-01T15:00:00.000Z", now, { zone: "UTC", time: false })).toBe("Thu");
  });
  test("no em-dash in any default word", () => {
    const d = defaultSettings() as unknown as Record<string, unknown>;
    for (const [k, v] of Object.entries(d)) {
      if (k.startsWith("strings.actions.recommended.")) expect(String(v)).not.toContain("—");
    }
  });
});

describe("what became of a chip", () => {
  test("the same action and arguments is used; other arguments other_used; anything else ignored", () => {
    const snooze = {
      kind: "snooze",
      until: "2026-10-05T08:00:00.000Z",
      anchor: "weekday",
    } as const;
    expect(outcomeOf(snooze, { ...snooze, until: "2026-10-05T08:20:00.000Z" })).toBe("used");
    expect(outcomeOf(snooze, { ...snooze, until: "2026-10-09T08:00:00.000Z" })).toBe("other_used");
    expect(outcomeOf(snooze, { kind: "archive" })).toBe("ignored");
    const forward = { kind: "forward", to: priya, confidence: 0.9 } as const;
    expect(
      outcomeOf(forward, {
        kind: "forward",
        to: { name: "", email: "PRIYA@monday.test" },
        confidence: 1,
      }),
    ).toBe("used");
    expect(
      outcomeOf(forward, {
        kind: "forward",
        to: { name: "", email: "accounts@monday.test" },
        confidence: 1,
      }),
    ).toBe("other_used");
  });
});
