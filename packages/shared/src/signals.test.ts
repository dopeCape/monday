// Reading Signals (slice 30 and 33): the Unsure band, the confidence floor,
// stale answers shown or hidden, hysteresis in Sections, `when.signals`, and
// the upgrade of a stored copy of the shipped Waiting on you rule.

import { describe, expect, test } from "bun:test";
import type { Thread } from "./domain.ts";
import {
  DEFAULT_SECTION_RULES,
  sectionOf,
  sectionRuleHolds,
  upgradeShippedRules,
} from "./routing/sections.ts";
import {
  actionable,
  canonicalJson,
  DEFAULT_SIGNAL_RULES,
  judgmentsFromSignals,
  noulState,
  signalConditionHolds,
} from "./signals.ts";

const thread = (over: Partial<Thread> = {}): Thread => ({
  id: "t",
  workspaceId: "w",
  subject: "s",
  participants: [],
  lastActivity: "2026-09-29T00:00:00Z",
  messageCount: 2,
  unread: true,
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
  ...over,
});

describe("reading a Signal", () => {
  const rules = DEFAULT_SIGNAL_RULES;

  test("a Noul between the two thresholds is Unsure, a Choice or Score under the floor never holds", () => {
    expect(noulState(0.75, rules)).toBe("holds");
    expect(noulState(0.5, rules)).toBe("unsure");
    expect(noulState(0.2, rules)).toBe("fails");
    expect(
      signalConditionHolds({ signal: "x", at_least: 2 }, { score: 2.5, confidence: 0.9 }, rules),
    ).toBe(true);
    expect(
      signalConditionHolds({ signal: "x", at_least: 2 }, { score: 2.5, confidence: 0.3 }, rules),
    ).toBe(false);
    expect(
      signalConditionHolds(
        { signal: "x", is: "owner_pays" },
        { choice: "owner_pays", confidence: 0.8 },
        rules,
      ),
    ).toBe(true);
    expect(
      signalConditionHolds(
        { signal: "x", is: "owner_pays" },
        { choice: "unclear", confidence: 0.8 },
        rules,
      ),
    ).toBe(false);
    expect(signalConditionHolds({ signal: "x", at_least: 0.7 }, undefined, rules)).toBe(false);
  });

  test("stale answers show in lists unless hidden, and nothing that acts reads them", () => {
    const stale = { noul: 0.9, stale: true };
    expect(signalConditionHolds({ signal: "x", at_least: 0.7 }, stale, rules)).toBe(true);
    expect(
      signalConditionHolds({ signal: "x", at_least: 0.7 }, stale, {
        ...rules,
        staleAnswers: "hide",
      }),
    ).toBe(false);
    expect(actionable(stale)).toBe(false);
    expect(actionable({ noul: 0.9 })).toBe(true);
    expect(actionable({ noul: 0.9, lowTrust: "not_english" })).toBe(false);
    expect(actionable({ noul: 0.9, lowTrust: "not_english" }, { nonEnglish: "trust" })).toBe(true);
  });

  test("hysteresis: a Thread already in keeps its place until the answer is past the threshold by the margin", () => {
    const cond = { signal: "waiting_on_me", at_least: 0.7 };
    expect(signalConditionHolds(cond, { noul: 0.67 }, rules, false)).toBe(false);
    expect(signalConditionHolds(cond, { noul: 0.67 }, rules, true)).toBe(true);
    expect(signalConditionHolds(cond, { noul: 0.64 }, rules, true)).toBe(false);
    const facts = (noul: number, previous: string | null) => ({
      lastSender: "dana@client.test",
      owner: "sam@monday.test",
      signals: { waiting_on_me: { noul }, automated: { noul: 0.02 } },
      previous,
    });
    const waiting = DEFAULT_SECTION_RULES.find((r) => r.id === "waiting");
    if (!waiting) throw new Error("no waiting rule");
    expect(sectionRuleHolds(waiting, thread(), facts(0.68, null))).toBe(false);
    expect(sectionRuleHolds(waiting, thread(), facts(0.68, "waiting"))).toBe(true);
    // A judged Section statement relaxes the same way.
    const rule = { id: "owe", when: {}, judge: "A bill the owner owes." };
    const owe = (noul: number, previous: string | null) => ({
      lastSender: null,
      owner: "sam@monday.test",
      signals: { "section:owe": { noul } },
      judgeThreshold: 0.7,
      previous,
    });
    expect(sectionRuleHolds(rule, thread(), owe(0.68, null))).toBe(false);
    expect(sectionRuleHolds(rule, thread(), owe(0.68, "owe"))).toBe(true);
  });

  test("Waiting on you reads waiting_on_me and still needs someone else to have written last", () => {
    const at = (lastSender: string, noul: number) =>
      sectionOf(
        thread(),
        {
          lastSender,
          owner: "sam@monday.test",
          signals: { waiting_on_me: { noul }, automated: { noul: 0.05 } },
        },
        DEFAULT_SECTION_RULES,
        ["waiting", "needs-reply", "fyi", "newsletters"],
      );
    expect(at("dana@client.test", 0.9)).toBe("waiting");
    expect(at("sam@monday.test", 0.9)).toBe("fyi");
    expect(at("dana@client.test", 0.5)).toBe("fyi");
  });

  test("a stored copy of the old shipped Waiting rule is upgraded; an edited one is left alone", () => {
    const old = {
      id: "waiting",
      when: {
        lastFrom: "others" as const,
        minMessages: 2,
        bulk: false,
        waiting_at_least: 0.6,
        automated_at_most: 0.4,
      },
      placement: "stream" as const,
      createdBy: "shipped" as const,
    };
    const [upgraded] = upgradeShippedRules([old]);
    expect(upgraded?.when.signals?.[0]).toEqual({ signal: "waiting_on_me", at_least: 0.7 });
    const edited = { ...old, when: { ...old.when, minMessages: 3 } };
    expect(upgradeShippedRules([edited])[0]).toEqual(edited);
  });

  test("the shipped answers read back as the slice 25 Judgments; the hash input is canonical", () => {
    expect(judgmentsFromSignals("t", {})).toBeNull();
    expect(
      judgmentsFromSignals("t", {
        needs_reply: { noul: 0.8 },
        urgency: { score: 2 },
        chip_reply: { noul: 0.9 },
      }),
    ).toMatchObject({ needsReply: 0.8, urgency: 2, newsletter: 0, chips: { reply: 0.9 } });
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(
      canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }),
    );
  });
});
