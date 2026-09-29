// Boards in code (docs/spec/boards.md): the document validates against the
// schema and the limits; a question that asks the model to count fails
// (acceptance 7); three-valued Lanes never place a Thread in Green because
// Red could not be decided (acceptance 2); hysteresis; the code-only scope;
// Fact-only Boards; the test card's sample, moves and agreement.

import { describe, expect, test } from "bun:test";
import { DEFAULT_SIGNAL_RULES } from "../signals.ts";
import {
  type BoardContext,
  type BoardDoc,
  type BoardThread,
  boardMoves,
  boardQuestion,
  boardSignalDefs,
  boardSignalId,
  boardView,
  correctionAgreement,
  factLanesOnly,
  PAPERWORK_BOARD,
  pickShown,
  placementReasons,
  placeThread,
  SUPPORT_TODAY_BOARD,
  scopeAdmits,
  validateBoard,
  widenScope,
} from "./index.ts";

const NOW = new Date("2026-09-29T15:00:00Z");
const ctx: BoardContext = {
  rules: DEFAULT_SIGNAL_RULES,
  now: NOW,
  zone: "UTC",
  owner: "sam@acme.com",
};
const own = (id: string) => boardSignalId(SUPPORT_TODAY_BOARD.id, id);

function thread(over: Partial<BoardThread> = {}): BoardThread {
  return {
    id: "t1",
    messageCount: 1,
    lastActivity: "2026-09-29T10:00:00.000Z",
    receivedAt: "2026-09-29T10:00:00.000Z",
    unread: true,
    starred: false,
    archived: false,
    deleted: false,
    snoozed: false,
    group: null,
    subgroup: null,
    section: null,
    hasAttachments: false,
    from: "ana@customer.test",
    recipients: ["support@acme.com"],
    facts: {},
    readings: {},
    ...over,
  };
}

describe("the Board document", () => {
  test("the fixture validates; the zod shape fills the defaults", () => {
    const r = validateBoard(SUPPORT_TODAY_BOARD);
    expect(r.ok).toBe(true);
    const minimal = validateBoard({
      id: "b_x",
      name: "X",
      scope: { facts: {}, limit: 10 },
      lanes: [{ id: "a", label: "A", tone: "ok", when: { fact: "unread", is: true } }],
      unsure: { label: "Unsure" },
      layout: { component: "list" },
      nav: { icon: "folder", count: "total" },
    });
    expect(minimal.ok).toBe(true);
    if (minimal.ok) expect(minimal.doc.others).toBe("hide");
  });

  test("a question that asks the model to count fails validation; a Fact test passes", () => {
    const counting: BoardDoc = {
      ...SUPPORT_TODAY_BOARD,
      signals: [
        {
          id: "long_thread",
          kind: "noul",
          question: { type: "noul", instructions: "The thread has more than 3 replies." },
        },
      ],
      uses: [],
      lanes: [
        { id: "long", label: "Long", tone: "info", when: { signal: "long_thread", holds: true } },
      ],
      nav: { icon: "lifebuoy", count: "long" },
    };
    const r = validateBoard(counting);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join(" ")).toContain("message_count");
    const fixed = validateBoard({
      ...counting,
      signals: [],
      lanes: [
        { id: "long", label: "Long", tone: "info", when: { fact: "message_count", at_least: 4 } },
      ],
    });
    expect(fixed.ok).toBe(true);
    for (const words of [
      "invoices over $500",
      "older than two weeks",
      "How many messages are there?",
    ]) {
      const r2 = validateBoard({
        ...counting,
        signals: [{ id: "q", kind: "noul", question: { type: "noul", instructions: words } }],
        lanes: [{ id: "long", label: "Long", tone: "info", when: { signal: "q", holds: true } }],
      });
      expect(r2.ok).toBe(false);
    }
  });

  test("limits, unknown Signals, tests that do not fit, and the nav are refused with reasons", () => {
    const lanes = Array.from({ length: 7 }, (_, i) => ({
      id: `l${i}`,
      label: `L${i}`,
      tone: "ok" as const,
      when: { fact: "unread" as const, is: true },
    }));
    const r = validateBoard({ ...SUPPORT_TODAY_BOARD, lanes, nav: { icon: "nope", count: "red" } });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const text = r.errors.join("\n");
      expect(text).toContain("at most 6 Lanes");
      expect(text).toContain("nav icon");
      expect(text).toContain("counts Lane red");
    }
    const bad = validateBoard({
      ...SUPPORT_TODAY_BOARD,
      lanes: [
        { id: "a", label: "A", tone: "ok", when: { signal: "missing", holds: true } },
        { id: "b", label: "B", tone: "ok", when: { signal: "severity", holds: true } },
        { id: "c", label: "C", tone: "ok", when: { fact: "message_count", is: true } },
      ],
      nav: { icon: "lifebuoy", count: "a" },
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.some((e) => e.includes("missing"))).toBe(true);
      expect(bad.errors.some((e) => e.includes("severity is a score"))).toBe(true);
      expect(bad.errors.some((e) => e.includes("message_count takes at_least"))).toBe(true);
    }
    const scope = validateBoard(
      { ...SUPPORT_TODAY_BOARD, scope: { ...SUPPORT_TODAY_BOARD.scope, limit: 5000 } },
      { maxLanes: 6, maxSignals: 6, maxThreads: 2000 },
    );
    expect(scope.ok).toBe(false);
  });

  test("a Board Signal's question carries the corrections as Examples, so its words change", () => {
    const s = SUPPORT_TODAY_BOARD.signals[0];
    if (!s) throw new Error("fixture");
    expect(boardQuestion(s, [])).toEqual(s.question);
    const q = boardQuestion(s, [
      {
        threadId: "t9",
        holds: false,
        from: "sales@vendor.test",
        subject: "Partnership",
        at: "2026-09-29",
      },
    ]);
    expect(q.type).toBe("noul");
    expect(JSON.stringify(q.instructions)).toContain("Partnership");
    expect(q.criteria).toEqual(s.question.criteria);
    const defs = boardSignalDefs({
      ...SUPPORT_TODAY_BOARD,
      examples: { is_support_request: [{ threadId: "t9", holds: false, subject: "Partnership" }] },
    });
    expect(defs.map((d) => d.id)).toEqual([own("is_support_request"), own("severity")]);
    expect(JSON.stringify(defs[0]?.question)).toContain("Partnership");
  });
});

describe("the scope is code only", () => {
  test("today, the support address and the owner's own domain", () => {
    const f = SUPPORT_TODAY_BOARD.scope.facts;
    expect(scopeAdmits(f, thread(), ctx)).toBe(true);
    expect(scopeAdmits(f, thread({ receivedAt: "2026-09-28T10:00:00.000Z" }), ctx)).toBe(false);
    expect(scopeAdmits(f, thread({ recipients: ["sam@acme.com"] }), ctx)).toBe(false);
    expect(scopeAdmits(f, thread({ from: "lee@acme.com" }), ctx)).toBe(false);
    expect(scopeAdmits(f, thread({ archived: true }), ctx)).toBe(false);
    // Widened for a quiet scope: only the date part changes.
    const wide = widenScope(f, 14);
    expect(wide.received).toEqual({ last_days: 14 });
    expect(wide.to_any).toEqual(f.to_any);
    expect(scopeAdmits(wide, thread({ receivedAt: "2026-09-20T10:00:00.000Z" }), ctx)).toBe(true);
  });

  test("a Group, a Section and the Archive as folders", () => {
    expect(scopeAdmits({ folder: "group:hiring" }, thread({ subgroup: "hiring" }), ctx)).toBe(true);
    expect(scopeAdmits({ folder: "group:hiring" }, thread(), ctx)).toBe(false);
    expect(
      scopeAdmits({ folder: "section:needs-reply" }, thread({ section: "needs-reply" }), ctx),
    ).toBe(true);
    expect(scopeAdmits({ folder: "archive" }, thread({ archived: true }), ctx)).toBe(true);
    expect(scopeAdmits({ folder: "any" }, thread({ deleted: true }), ctx)).toBe(false);
  });
});

describe("three-valued Lanes", () => {
  const withReadings = (readings: BoardThread["readings"]) => thread({ readings });

  test("an undecided support request goes to Unsure, never to Green", () => {
    const t = withReadings({
      [own("is_support_request")]: { noul: 0.5 },
      [own("severity")]: { score: 0.1, confidence: 0.9 },
      frustrated: { score: 0.2, confidence: 0.9 },
    });
    const p = placeThread(SUPPORT_TODAY_BOARD, t, ctx);
    expect(p.lane).toBe("unsure");
    // Red and Yellow are false whatever it is (not severe, not frustrated); Green could not be decided.
    expect(p.decidedBy).toBe("green");
  });

  test("Red could not be decided (severity Unsure, not frustrated): Unsure, even though Green holds", () => {
    const t = withReadings({
      [own("is_support_request")]: { noul: 0.95 },
      [own("severity")]: { score: 1.8, confidence: 0.3 },
      frustrated: { score: 0.1, confidence: 0.9 },
    });
    expect(placeThread(SUPPORT_TODAY_BOARD, t, ctx).lane).toBe("unsure");
    // Frustrated settles Red on its own: any is true on any true.
    const angry = withReadings({
      [own("is_support_request")]: { noul: 0.95 },
      [own("severity")]: { score: 1.8, confidence: 0.3 },
      frustrated: { score: 2.4, confidence: 0.9 },
    });
    expect(placeThread(SUPPORT_TODAY_BOARD, angry, ctx).lane).toBe("red");
  });

  test("the Lanes in order: Red, Yellow, Green, others; not read yet is Unsure", () => {
    const base = { frustrated: { score: 0, confidence: 0.9 } };
    const at = (support: number, severity: number) =>
      placeThread(
        SUPPORT_TODAY_BOARD,
        withReadings({
          ...base,
          [own("is_support_request")]: { noul: support },
          [own("severity")]: { score: severity, confidence: 0.9 },
        }),
        ctx,
      ).lane;
    expect(at(0.9, 1.9)).toBe("red");
    expect(at(0.9, 1)).toBe("yellow");
    expect(at(0.9, 0.1)).toBe("green");
    expect(at(0.1, 0.1)).toBe("others");
    const unread = placeThread(SUPPORT_TODAY_BOARD, withReadings({}), ctx);
    expect(unread).toMatchObject({ lane: "unsure", notRead: true });
  });

  test("hysteresis keeps a Thread in its Lane until an answer is clearly past", () => {
    const t = withReadings({
      frustrated: { score: 0, confidence: 0.9 },
      [own("is_support_request")]: { noul: 0.9 },
      [own("severity")]: { score: 1.52, confidence: 0.9 },
    });
    // First placement: 1.52 is at least 1.5, Red.
    expect(placeThread(SUPPORT_TODAY_BOARD, t, ctx).lane).toBe("red");
    // In Yellow already: 1.52 is not clearly past 1.5 by 0.05, it stays.
    expect(placeThread(SUPPORT_TODAY_BOARD, t, ctx, "yellow").lane).toBe("yellow");
    // In Red: 1.47 is not clearly below, it stays in Red.
    const lower = withReadings({
      ...t.readings,
      [own("severity")]: { score: 1.47, confidence: 0.9 },
    });
    expect(placeThread(SUPPORT_TODAY_BOARD, lower, ctx, "red").lane).toBe("red");
    expect(placeThread(SUPPORT_TODAY_BOARD, lower, ctx).lane).toBe("yellow");
  });

  test("a user placement wins until the Thread changes", () => {
    const t = withReadings({ [own("is_support_request")]: { noul: 0.1 } });
    const placed = { lane: "green", messageCount: 1, at: "2026-09-29", from: "others" };
    expect(placeThread(SUPPORT_TODAY_BOARD, t, ctx, null, placed)).toMatchObject({
      lane: "green",
      byUser: true,
    });
    expect(
      placeThread(SUPPORT_TODAY_BOARD, { ...t, messageCount: 2 }, ctx, null, placed).lane,
    ).toBe("others");
  });

  test("a Fact-only Board needs no Signal; keeping only the Fact Lanes drops the rest", () => {
    const long = thread({ hasAttachments: true, messageCount: 5 });
    const short = thread({ id: "t2", hasAttachments: true, messageCount: 1 });
    const plain = thread({ id: "t3" });
    const view = boardView(PAPERWORK_BOARD, [long, short, plain], ctx);
    expect(view.counts).toMatchObject({ long: 1, files: 1, unsure: 0, others: 1 });
    expect(view.total).toBe(2);
    expect(view.navCount).toBe(2);
    const facts = factLanesOnly(SUPPORT_TODAY_BOARD);
    expect(facts).toBeNull();
    const mixed = factLanesOnly({
      ...SUPPORT_TODAY_BOARD,
      lanes: [
        ...SUPPORT_TODAY_BOARD.lanes,
        { id: "files", label: "Files", tone: "info", when: { fact: "has_attachment", is: true } },
      ],
    });
    expect(mixed?.lanes.map((l) => l.id)).toEqual(["files"]);
    expect(mixed?.signals).toEqual([]);
    expect(mixed?.nav.count).toBe("files");
  });
});

describe("the view, the test card and moves", () => {
  const readings = (support: number, severity: number): BoardThread["readings"] => ({
    frustrated: { score: 0, confidence: 0.9 },
    [own("is_support_request")]: { noul: support },
    [own("severity")]: { score: severity, confidence: 0.9 },
  });

  test("Lanes then Unsure, sorted oldest first; the nav counts Red", () => {
    const threads = [
      thread({ id: "a", lastActivity: "2026-09-29T11:00:00.000Z", readings: readings(0.9, 2) }),
      thread({ id: "b", lastActivity: "2026-09-29T09:00:00.000Z", readings: readings(0.9, 1.9) }),
      thread({ id: "c", readings: readings(0.5, 0) }),
      thread({ id: "d", readings: readings(0.9, 0) }),
    ];
    const view = boardView(SUPPORT_TODAY_BOARD, threads, ctx);
    expect(view.lanes.map((l) => l.id)).toEqual(["red", "yellow", "green", "unsure"]);
    expect(view.lanes[0]?.rows.map((r) => r.thread.id)).toEqual(["b", "a"]);
    expect(view.navCount).toBe(2);
    expect(view.counts.unsure).toBe(1);
    const red = view.lanes[0]?.rows[0];
    if (!red) throw new Error("red");
    expect(placementReasons(SUPPORT_TODAY_BOARD, red.thread, red.placement)).toEqual([
      "support request 90%",
      "blocked 1.9 of 2",
      "frustrated 0.0 of 3",
    ]);
  });

  test("the card shows the least confident and spreads across the Lanes", () => {
    const tried = Array.from({ length: 30 }, (_, i) => ({
      id: `t${i}`,
      lane: i < 20 ? "green" : i < 27 ? "yellow" : i < 29 ? "red" : "unsure",
      certainty: i === 5 ? 0.05 : 0.9,
    }));
    const shown = pickShown(tried, 10, ["red", "yellow", "green", "unsure"]);
    expect(shown).toHaveLength(10);
    expect(shown.map((t) => t.id)).toContain("t5");
    expect(new Set(shown.map((t) => t.lane))).toEqual(
      new Set(["red", "yellow", "green", "unsure"]),
    );
    expect(shown[0]?.lane).toBe("red");
  });

  test("moves are grouped, and the agreement line counts the corrections kept", () => {
    const before = new Map([
      ["a", "yellow"],
      ["b", "yellow"],
      ["c", "green"],
      ["d", "red"],
    ]);
    const after = new Map([
      ["a", "green"],
      ["b", "green"],
      ["c", "unsure"],
      ["d", "red"],
    ]);
    expect(boardMoves(before, after)).toEqual([
      { from: "yellow", to: "green", threadIds: ["a", "b"] },
      { from: "green", to: "unsure", threadIds: ["c"] },
    ]);
    const doc: BoardDoc = {
      ...SUPPORT_TODAY_BOARD,
      examples: {
        is_support_request: [
          { threadId: "a", holds: false },
          { threadId: "b", holds: false },
        ],
        _lanes: [{ threadId: "c", lane: "unsure" }],
      },
    };
    const threads = new Map([
      ["a", thread({ id: "a", readings: { [own("is_support_request")]: { noul: 0.1 } } })],
      ["b", thread({ id: "b", readings: { [own("is_support_request")]: { noul: 0.8 } } })],
      ["c", thread({ id: "c" })],
    ]);
    expect(correctionAgreement(doc, threads, after, DEFAULT_SIGNAL_RULES)).toEqual({
      agree: 2,
      total: 3,
    });
  });
});
