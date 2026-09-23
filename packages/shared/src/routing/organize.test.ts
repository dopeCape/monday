// Section rules the user defines (CONTEXT.md "Section rule") and custom
// actions (CONTEXT.md "Custom action"): the effect order, judged rules that
// decide only once the Judge has answered, hidden and nav-only Sections
// that keep their Threads out of the others, and where an action shows.

import { describe, expect, test } from "bun:test";
import type { Thread } from "../domain.ts";
import { customActionIdFor, customActionsFor, normalizeActionArgs } from "./actions.ts";
import {
  DEFAULT_SECTION_RULES,
  orderedSectionRules,
  sectionIdFor,
  sectionInNav,
  sectionInStream,
  sectionLabel,
  sectionOf,
  sectionRuleHolds,
  sectionsToJudge,
} from "./sections.ts";

const thread = (over: Partial<Thread> = {}): Thread => ({
  id: "t1",
  workspaceId: "ws",
  subject: "Invoice 2041",
  participants: [{ name: "Hetzner", email: "billing@hetzner.test" }],
  lastActivity: "2026-09-16T09:00:00Z",
  messageCount: 1,
  unread: true,
  starred: false,
  archived: false,
  snoozedUntil: null,
  section: null,
  group: "finance",
  subgroup: null,
  tags: [],
  labels: [],
  hasAttachments: false,
  snippet: "",
  bulk: false,
  ...over,
});
const facts = { lastSender: "billing@hetzner.test", owner: "sam@monday.test" };

describe("orderedSectionRules", () => {
  test("the order Setting first, then the rest by their order number, stable", () => {
    const rules = [
      { id: "b", when: {}, order: 5 },
      { id: "a", when: {} },
      { id: "c", when: {}, order: 1 },
      { id: "d", when: {} },
    ];
    expect(orderedSectionRules(rules, ["a", "missing"]).map((r) => r.id)).toEqual([
      "a",
      "c",
      "b",
      "d",
    ]);
  });

  test("the shipped four are rows like any other, and none is a heading in the Inbox", () => {
    expect(DEFAULT_SECTION_RULES.every((r) => r.createdBy === "shipped")).toBe(true);
    expect(DEFAULT_SECTION_RULES.some((r) => sectionInStream(r))).toBe(false);
  });

  test("no placement puts a heading in the Inbox; nav placements read as written; labels", () => {
    for (const placement of ["nav", "both", "stream", undefined] as const) {
      expect(sectionInStream({ id: "x", when: {}, placement })).toBe(false);
    }
    expect(sectionInNav({ id: "x", when: {}, placement: "nav" })).toBe(true);
    expect(sectionInNav({ id: "x", when: {}, placement: "stream" })).toBe(false);
    expect(sectionLabel({ id: "needs-reply", when: {} }, "Needs your reply")).toBe(
      "Needs your reply",
    );
    expect(sectionLabel({ id: "needs-reply", when: {} })).toBe("Needs reply");
    expect(sectionLabel({ id: "x", name: "Reading", when: {} }, "ignored")).toBe("Reading");
    expect(sectionIdFor("Invoices I still owe!", ["invoices-i-still-owe"])).toBe(
      "invoices-i-still-owe-2",
    );
  });
});

describe("judged Sections", () => {
  const owe = {
    id: "owe",
    when: { groups: ["finance"] },
    judge: "The sender is asking the owner to pay something.",
    placement: "stream" as const,
  };
  const rules = [owe, ...DEFAULT_SECTION_RULES];
  const order = ["owe", "needs-reply", "waiting", "fyi", "newsletters"];

  test("a judged rule does not decide until the Judge has answered; the Thread falls through", () => {
    expect(sectionRuleHolds(owe, thread(), facts)).toBe(false);
    expect(sectionOf(thread(), facts, rules, order)).toBe("needs-reply");
    expect(sectionsToJudge(thread(), facts, rules, order)).toEqual(["owe"]);
  });

  test("an answer at or above the threshold holds; below it falls through and nothing more is asked", () => {
    const yes = { ...facts, judged: { owe: 0.9 }, judgeThreshold: 0.7 };
    expect(sectionOf(thread(), yes, rules, order)).toBe("owe");
    expect(sectionsToJudge(thread(), yes, rules, order)).toEqual([]);
    const no = { ...facts, judged: { owe: 0.2 }, judgeThreshold: 0.7 };
    expect(sectionOf(thread(), no, rules, order)).toBe("needs-reply");
    expect(sectionsToJudge(thread(), no, rules, order)).toEqual([]);
  });

  test("a Thread the conditions rule out is never asked about", () => {
    const other = thread({ group: "hiring" });
    expect(sectionsToJudge(other, facts, rules, order)).toEqual([]);
    expect(sectionOf(other, facts, rules, order)).toBe("needs-reply");
  });
});

describe("hidden and nav-only Sections", () => {
  test("a hidden Section still claims its Threads, so they show under no other Section", () => {
    const rules = [
      { id: "quiet", when: { groups: ["finance"] }, hidden: true },
      ...DEFAULT_SECTION_RULES,
    ];
    expect(sectionOf(thread(), facts, rules, ["quiet", "needs-reply"])).toBe("quiet");
  });

  test("a Section placed only in the nav claims its Threads the same way", () => {
    const rules = [
      { id: "reading", when: { bulk: true }, placement: "nav" as const },
      ...DEFAULT_SECTION_RULES,
    ];
    expect(sectionOf(thread({ bulk: true }), facts, rules, ["reading", "newsletters"])).toBe(
      "reading",
    );
    // Deleting the Section never deletes the Thread: it falls to the next rule that holds.
    expect(sectionOf(thread({ bulk: true }), facts, DEFAULT_SECTION_RULES)).toBe("newsletters");
  });
});

describe("custom actions", () => {
  const forward = {
    id: "forward-to-accounting",
    label: "Forward to accounting",
    on: { group: "Finance" },
    tool: "forward_thread",
    args: { to: "accounting@monday.test" },
  };
  const judged = {
    id: "pay",
    label: "Pay",
    on: { judge: "The sender is asking to be paid." },
    tool: "tag_threads",
    args: { add: ["pay"] },
  };
  const everywhere = { id: "all", label: "All", on: {}, tool: "archive_threads", args: {} };

  test("an action shows on the Threads of its Group (by id or name), Section, or judged statement", () => {
    const names = { finance: "Finance" };
    expect(
      customActionsFor([forward, judged, everywhere], thread(), { groupNames: names }).map(
        (a) => a.id,
      ),
    ).toEqual(["forward-to-accounting", "all"]);
    expect(customActionsFor([forward], thread({ group: "hiring" }), { groupNames: names })).toEqual(
      [],
    );
    expect(
      customActionsFor([forward], thread({ group: null, subgroup: "finance" }), {
        groupNames: names,
      }).map((a) => a.id),
    ).toEqual(["forward-to-accounting"]);
    expect(
      customActionsFor([judged], thread(), { judged: { pay: 0.8 }, judgeThreshold: 0.7 }).map(
        (a) => a.id,
      ),
    ).toEqual(["pay"]);
    expect(
      customActionsFor([judged], thread(), { judged: { pay: 0.3 }, judgeThreshold: 0.7 }),
    ).toEqual([]);
    const onSection = { ...everywhere, id: "sec", on: { section: "waiting" } };
    expect(customActionsFor([onSection], thread({ section: "waiting" }))).toHaveLength(1);
    expect(customActionsFor([onSection], thread({ section: "fyi" }))).toHaveLength(0);
  });

  test("ids from labels, and recipients as lists for the send tools", () => {
    expect(customActionIdFor("Forward to accounting")).toBe("forward-to-accounting");
    expect(customActionIdFor("Forward to accounting", ["forward-to-accounting"])).toBe(
      "forward-to-accounting-2",
    );
    expect(normalizeActionArgs("forward_thread", { to: "a@b.test", note: "x" })).toEqual({
      to: ["a@b.test"],
      note: "x",
    });
    expect(normalizeActionArgs("draft_message", { to: { name: "A", email: "a@b.test" } })).toEqual({
      to: [{ name: "A", email: "a@b.test" }],
    });
    expect(normalizeActionArgs("tag_threads", { add: "x" })).toEqual({ add: "x" });
  });
});
