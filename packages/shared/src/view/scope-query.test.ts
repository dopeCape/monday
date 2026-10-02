// A View's scope by a full search (docs/spec/views.md, "Scope by a search"):
// what a query may hold, how it joins the other facts, the members' key, and
// the words inspect_view_thread uses for what it matched.

import { describe, expect, test } from "bun:test";
import { explainMatch } from "../search-match.ts";
import {
  memberFacts,
  memberKey,
  scopeAdmits,
  scopeReasons,
  scopeWithoutQuery,
  type ViewThread,
} from "./core.ts";
import { AMAZON_ORDERS_VIEW } from "./fixture.ts";
import { parseScopeQuery, scopeQueryErrors } from "./scope-query.ts";
import { validateView } from "./validate.ts";

const ctx = { now: new Date("2026-09-30T12:00:00Z"), zone: "UTC" };

const thread = (over: Partial<ViewThread> = {}): ViewThread => ({
  id: "t1",
  messageCount: 1,
  lastActivity: "2026-09-29T10:00:00.000Z",
  receivedAt: "2026-09-29T10:00:00.000Z",
  unread: false,
  starred: false,
  archived: true,
  deleted: false,
  snoozed: false,
  group: null,
  subgroup: null,
  section: null,
  hasAttachments: false,
  from: "support@shop.test",
  recipients: [],
  facts: null,
  readings: {},
  ...over,
});

describe("a View's scope by a full search", () => {
  test("a query holds what the mail says: words, phrases, from:, to:, subject:, has:attachment", () => {
    expect(scopeQueryErrors('"refund approved" -cancelled from:shop has:attachment')).toEqual([]);
    expect(scopeQueryErrors("subject:invoice to:billing@acme.com")).toEqual([]);
    expect(scopeQueryErrors("refund older_than:7d")[0]).toContain(
      "dates go in the scope's received or active",
    );
    expect(scopeQueryErrors("refund after:2026-01-01").length).toBe(1);
    expect(scopeQueryErrors("is:unread refund")[0]).toContain("is:, in:, tag: and label:");
    expect(scopeQueryErrors("in:hiring tag:x label:y refund").length).toBe(1);
    expect(scopeQueryErrors("-newsletter")[0]).toContain("needs a word");
  });

  test("validation refuses a query that cannot be a scope and keeps one that can", () => {
    const withQuery = (query: string) => ({
      ...AMAZON_ORDERS_VIEW,
      scope: { facts: { ...AMAZON_ORDERS_VIEW.scope.facts, query }, limit: 100 },
    });
    const ok = validateView(withQuery('"order confirmation"'));
    expect(ok.ok).toBe(true);
    const bad = validateView(withQuery("is:starred order"));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join(" ")).toContain("scope.facts.query");
  });

  test("the query joins the other facts with AND; a reader that has not run it does not refuse", () => {
    const facts = { query: "refund", from_domain: ["shop.test"], folder: "any" as const };
    expect(scopeAdmits(facts, thread({ inQuery: true }), ctx)).toBe(true);
    expect(scopeAdmits(facts, thread({ inQuery: false }), ctx)).toBe(false);
    expect(scopeAdmits(facts, thread(), ctx)).toBe(true);
    expect(scopeAdmits(facts, thread({ inQuery: true, from: "a@other.test" }), ctx)).toBe(false);
    expect(scopeWithoutQuery(facts)).toEqual({ from_domain: ["shop.test"], folder: "any" });
  });

  test("members are found within every fact but the folder, under a key of the query and those facts", () => {
    const facts = { query: "refund", from_domain: ["shop.test"], folder: "inbox" as const };
    expect(memberFacts(facts)).toEqual({ from_domain: ["shop.test"], folder: "any" });
    expect(memberKey({ folder: "any" })).toBeNull();
    // Moving the folder keeps the members; a new query or sender finds them again.
    expect(memberKey({ ...facts, folder: "archive" })).toBe(memberKey(facts));
    expect(memberKey({ ...facts, query: "refunds" })).not.toBe(memberKey(facts));
    expect(memberKey({ ...facts, from_domain: ["b.test"] })).not.toBe(memberKey(facts));
  });

  test("inspect's words: what the search matched, or that it did not", () => {
    const q = parseScopeQuery('"refund approved" from:shop');
    const terms = explainMatch(q, {
      subject: "Update on your request",
      participants: "Shop support@shop.test",
      messages: [
        {
          sender: "Shop support@shop.test",
          recipients: "Sam sam@monday.test",
          body: "Good news: your refund approved today.",
        },
      ],
    });
    // Cheapest first, as the matcher reads them: the sender before the text.
    expect(terms).toEqual(["shop in the sender", "refund approved in a message's text"]);
    const facts = { query: '"refund approved"', folder: "any" as const };
    expect(
      scopeReasons(facts, thread({ inQuery: true, queryTerms: terms }), ctx).reasons.at(-1),
    ).toBe(
      `the search ""refund approved"" matches it: shop in the sender; refund approved in a message's text`,
    );
    expect(scopeReasons(facts, thread({ inQuery: false }), ctx).reasons.at(-1)).toBe(
      `the search ""refund approved"" does not match it`,
    );
  });
});
