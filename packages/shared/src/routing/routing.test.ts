// The model-free half of routing: Predicates over headers, the placement
// rule over Confidences, and the Section rules over Thread state.

import { describe, expect, test } from "bun:test";
import type { Thread } from "../domain.ts";
import { isBulk, matchesPredicate, mergePredicates, type PredicateFacts } from "./predicate.ts";
import {
  DEFAULT_SECTION_RULES,
  hasJudgedWhen,
  judgedMatches,
  type SectionJudgments,
  sectionOf,
} from "./sections.ts";
import { clampConfidence, place } from "./thresholds.ts";

const facts = (over: Partial<PredicateFacts> = {}): PredicateFacts => ({
  from: { name: "Hetzner", email: "billing@hetzner.com" },
  participants: [{ name: "Me", email: "me@example.test" }],
  subject: "invoice 2026-09 for project monday-sync",
  hasAttachments: true,
  headers: {},
  ...over,
});

describe("Predicates", () => {
  test("an empty Predicate matches nothing", () => {
    expect(matchesPredicate({}, facts())).toBe(false);
  });

  test("senders and domains look at the sender and the participants, subdomains included", () => {
    expect(matchesPredicate({ senders: ["Billing@Hetzner.com"] }, facts())).toBe(true);
    expect(matchesPredicate({ senders: ["nobody@hetzner.com"] }, facts())).toBe(false);
    expect(matchesPredicate({ domains: ["hetzner.com"] }, facts())).toBe(true);
    expect(matchesPredicate({ domains: ["@example.test"] }, facts())).toBe(true);
    expect(
      matchesPredicate(
        { domains: ["northwind.test"] },
        facts({ from: { name: "A", email: "a@mail.northwind.test" } }),
      ),
    ).toBe(true);
    expect(matchesPredicate({ domains: ["hetz.com"] }, facts())).toBe(false);
  });

  test("subject patterns are substrings or /regex/; list ids match by domain; identities are alternatives, modifiers must hold", () => {
    expect(matchesPredicate({ subjectPatterns: ["Invoice"] }, facts())).toBe(true);
    expect(matchesPredicate({ subjectPatterns: ["/^invoice \\d{4}/"] }, facts())).toBe(true);
    expect(matchesPredicate({ subjectPatterns: ["receipt"] }, facts())).toBe(false);
    const list = facts({ headers: { "list-id": "<digest.theweekly.test>" } });
    expect(matchesPredicate({ listIds: ["theweekly.test"] }, list)).toBe(true);
    expect(matchesPredicate({ listIds: ["theweekly.test"] }, facts())).toBe(false);
    expect(matchesPredicate({ domains: ["hetzner.com"], hasAttachment: false }, facts())).toBe(
      false,
    );
    expect(
      matchesPredicate({ domains: ["nowhere.test"], subjectPatterns: ["invoice"] }, facts()),
    ).toBe(true);
    expect(
      matchesPredicate({ domains: ["nowhere.test"], subjectPatterns: ["receipt"] }, facts()),
    ).toBe(false);
    expect(
      matchesPredicate(
        { headers: { precedence: "bulk" } },
        facts({ headers: { precedence: "Bulk" } }),
      ),
    ).toBe(true);
  });

  test("isBulk and mergePredicates", () => {
    expect(isBulk({ "list-unsubscribe": "<https://x>" })).toBe(true);
    expect(isBulk({ precedence: "bulk" })).toBe(true);
    expect(isBulk({})).toBe(false);
    expect(
      mergePredicates(
        { domains: ["a.test"], senders: ["x@a.test"] },
        { domains: ["b.test", "a.test"], hasAttachment: true },
      ),
    ).toEqual({ senders: ["x@a.test"], domains: ["a.test", "b.test"], hasAttachment: true });
  });
});

describe("placement", () => {
  const t = { route: 0.8, ask: 0.5, tieMargin: 0.1 };

  test("above the route threshold places; in the ask band asks; below leaves alone", () => {
    expect(place([{ groupId: "g1", confidence: 0.9 }], t)).toEqual({
      kind: "route",
      groupId: "g1",
      confidence: 0.9,
    });
    expect(place([{ groupId: "g1", confidence: 0.6 }], t)).toEqual({
      kind: "ask",
      candidates: [{ groupId: "g1", confidence: 0.6 }],
    });
    expect(place([{ groupId: "g1", confidence: 0.2 }], t)).toEqual({
      kind: "none",
      best: { groupId: "g1", confidence: 0.2 },
    });
    expect(place([], t)).toEqual({ kind: "none", best: null });
  });

  test("a tie within the margin asks with both candidates, best first", () => {
    expect(
      place(
        [
          { groupId: "finance", confidence: 0.85 },
          { groupId: "hiring", confidence: 0.9 },
          { groupId: "press", confidence: 0.1 },
        ],
        t,
      ),
    ).toEqual({
      kind: "ask",
      candidates: [
        { groupId: "hiring", confidence: 0.9 },
        { groupId: "finance", confidence: 0.85 },
      ],
    });
  });

  test("a Group's own threshold beats the Setting; confidences clamp", () => {
    expect(place([{ groupId: "g1", confidence: 0.7 }], t, () => 0.6).kind).toBe("route");
    expect(place([{ groupId: "g1", confidence: 0.85 }], t, () => 0.95).kind).toBe("ask");
    expect(clampConfidence(94)).toBe(0.94);
    expect(clampConfidence("0.5")).toBe(0.5);
    expect(clampConfidence(1.7)).toBe(1);
    expect(clampConfidence("nope")).toBe(0);
  });
});

describe("Section rules", () => {
  const thread = (over: Partial<Thread> = {}): Thread => ({
    id: "t",
    workspaceId: "w",
    subject: "s",
    participants: [],
    lastActivity: "2026-09-17T00:00:00Z",
    messageCount: 1,
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
  const me = "me@example.test";
  const order = ["needs-reply", "waiting", "fyi", "newsletters"];

  test("the shipped defaults fill the mock's four Sections from Thread state", () => {
    const at = (t: Thread, lastSender: string | null) =>
      sectionOf(t, { lastSender, owner: me }, DEFAULT_SECTION_RULES, order);
    // Before the judge answers nothing is put in Needs your reply by guesswork: an unread
    // Thread someone else wrote last (a shipment notice, a one-time code) is For your information.
    expect(at(thread(), "aoife@northwind.test")).toBe("fyi");
    expect(at(thread({ unread: false }), "mateus@x.test")).toBe("fyi");
    // An ongoing exchange someone else wrote last is Waiting on you by the headers.
    expect(at(thread({ unread: false, messageCount: 5 }), "mateus@x.test")).toBe("waiting");
    // Before the judge answers, Waiting on you catches the ongoing exchanges it is ordered ahead of.
    expect(
      sectionOf(
        thread({ unread: false, messageCount: 5 }),
        { lastSender: "mateus@x.test", owner: me },
        DEFAULT_SECTION_RULES,
        ["waiting", "needs-reply", "fyi", "newsletters"],
      ),
    ).toBe("waiting");
    expect(at(thread({ unread: true }), me)).toBe("fyi");
    expect(at(thread({ unread: false }), me)).toBe("fyi");
    expect(at(thread({ bulk: true }), "digest@theweekly.test")).toBe("newsletters");
    expect(at(thread({ unread: true }), null)).toBe("fyi");
  });

  test("automated and transactional mail never lands in Needs your reply; an unjudged Thread waits outside it", () => {
    const at = (t: Thread, judgments: SectionJudgments | null) =>
      sectionOf(
        t,
        { lastSender: "ship-confirm@amazon.test", owner: me, judgments },
        DEFAULT_SECTION_RULES,
        order,
      );
    // A shipment notice, a one-time code, "your payment failed": unread, someone else wrote
    // last, no list headers. Unjudged, the header guess would call it a reply; it is not.
    const notice = thread({ unread: true, bulk: false, messageCount: 1 });
    expect(at(notice, null)).not.toBe("needs-reply");
    expect(at(notice, null)).toBe("fyi");
    // Judged automated, even when the model leans toward "needs a reply", it stays out.
    const automated = {
      needsReply: 0.8,
      waitingOnOthers: 0.7,
      newsletter: 0.1,
      automated: 0.93,
      urgency: 2,
    };
    expect(at(notice, automated)).toBe("fyi");
    expect(at(thread({ messageCount: 3 }), automated)).toBe("fyi");
    // A newsletter the model thinks wants an answer is not a reply either.
    expect(
      at(notice, { ...automated, automated: 0.2, newsletter: 0.7, waitingOnOthers: 0.1 }),
    ).toBe("newsletters");
    // A person asking something, judged: Needs your reply.
    expect(at(notice, { ...automated, automated: 0.05, newsletter: 0.05 })).toBe("needs-reply");
    // The `judged` condition on its own: holds only with (or only without) Judgments.
    const rule = [{ id: "j", when: { judged: true } }];
    const facts = { lastSender: null, owner: me };
    expect(sectionOf(notice, facts, rule)).toBeNull();
    expect(sectionOf(notice, { ...facts, judgments: automated }, rule)).toBe("j");
    expect(sectionOf(notice, facts, [{ id: "u", when: { judged: false } }])).toBe("u");
  });

  test("a judged Thread lands by its Judgments, an unjudged one by the header rules, and Group conditions always apply", () => {
    const judged = (over: Partial<SectionJudgments> = {}): SectionJudgments => ({
      needsReply: 0.1,
      waitingOnOthers: 0.1,
      newsletter: 0.1,
      automated: 0.1,
      urgency: 0,
      ...over,
    });
    const at = (t: Thread, lastSender: string | null, judgments: SectionJudgments | null) =>
      sectionOf(t, { lastSender, owner: me, judgments }, DEFAULT_SECTION_RULES, order);
    // Read, someone else wrote last: For your information until judged; the judge puts it in
    // Needs your reply or leaves it where it is.
    const read = thread({ unread: false });
    expect(at(read, "aoife@northwind.test", null)).toBe("fyi");
    expect(at(read, "aoife@northwind.test", judged({ needsReply: 0.64 }))).toBe("needs-reply");
    expect(at(read, "aoife@northwind.test", judged({ needsReply: 0.58 }))).toBe("fyi");
    // The owner wrote last: For your information by the headers, Needs your reply once judged.
    expect(at(read, me, null)).toBe("fyi");
    expect(at(read, me, judged({ needsReply: 0.7 }))).toBe("needs-reply");
    // The owner wrote last and waits: the headers say fyi, the judge says waiting.
    expect(at(thread({ messageCount: 3 }), me, judged({ waitingOnOthers: 0.8 }))).toBe("waiting");
    // List headers put a Thread in Newsletters; so does the judge without them, and a
    // judged non-newsletter with list headers is For your information.
    expect(at(thread({ bulk: true }), "digest@theweekly.test", null)).toBe("newsletters");
    expect(at(thread(), "bytes@ui.dev", judged({ newsletter: 0.92 }))).toBe("newsletters");
    expect(at(thread({ bulk: true }), "digest@x.test", judged({ newsletter: 0.2 }))).toBe("fyi");
    // A rule with Group and judged conditions needs both.
    const rules = [{ id: "urgent-money", when: { groups: ["Finance"], urgency_at_least: 2 } }];
    const facts = { lastSender: null, owner: me, groupNames: { g1: "Finance" } };
    expect(
      sectionOf(thread({ group: "g1" }), { ...facts, judgments: judged({ urgency: 2.2 }) }, rules),
    ).toBe("urgent-money");
    expect(
      sectionOf(thread({ group: "g1" }), { ...facts, judgments: judged({ urgency: 1.8 }) }, rules),
    ).toBeNull();
    expect(
      sectionOf(thread({ group: "g2" }), { ...facts, judgments: judged({ urgency: 2.5 }) }, rules),
    ).toBeNull();
    // Unjudged, the rule falls back to its header conditions: here only the Group.
    expect(sectionOf(thread({ group: "g1" }), facts, rules)).toBe("urgent-money");
    expect(hasJudgedWhen({ bulk: true })).toBe(false);
    expect(hasJudgedWhen({ automated_at_most: 0.3 })).toBe(true);
    expect(judgedMatches({ automated_at_most: 0.3 }, judged({ automated: 0.3 }))).toBe(true);
    expect(judgedMatches({ automated_at_most: 0.3 }, judged({ automated: 0.31 }))).toBe(false);
  });

  test("rules may name Groups by id or name; order decides; nothing matching is null", () => {
    const rules = [
      { id: "money", when: { groups: ["Finance"] } },
      { id: "rest", when: { ungrouped: true } },
    ];
    const facts = { lastSender: null, owner: me, groupNames: { g1: "Finance" } };
    expect(sectionOf(thread({ group: "g1" }), facts, rules, ["rest", "money"])).toBe("money");
    expect(sectionOf(thread(), facts, rules)).toBe("rest");
    expect(sectionOf(thread({ group: "g2" }), facts, rules)).toBeNull();
  });
});
