// The fixture Boards (docs/spec/boards.md, "The Board document"): today's
// support requests as red, yellow and green, and a Fact-only Board of
// threads with attachments and a deadline. Slice 39 writes Boards from these;
// the tests and the demo read them.

import type { BoardDoc } from "./types.ts";

export const SUPPORT_TODAY_BOARD: BoardDoc = {
  id: "b_support_today",
  name: "Support today",
  sentence: "show today's support requests as red, yellow and green",
  version: 1,
  scope: {
    facts: {
      received: { within: "today" },
      to_any: ["support@acme.com"],
      from_domain_not: ["acme.com"],
      folder: "inbox",
    },
    limit: 500,
  },
  signals: [
    {
      id: "is_support_request",
      kind: "noul",
      label: "support request",
      question: {
        type: "noul",
        instructions:
          "The newest message from someone other than the owner asks for help with a problem using the owner's product or service.",
        criteria: {
          true: "A customer or user reports something broken, asks how to do something, or asks for an account change.",
          false:
            "Sales, partnerships, newsletters, internal mail, invoices, or a thank-you with no request.",
        },
      },
    },
    {
      id: "severity",
      kind: "score",
      label: "blocked",
      question: {
        type: "score",
        instructions:
          "How badly is the person who wrote the newest message blocked by their problem?",
        criteria: [
          "Not blocked: a question or a small annoyance.",
          "Slowed down: something works badly but they can continue.",
          "Blocked: they cannot do what they need, or they are losing money or customers.",
        ],
      },
    },
  ],
  uses: ["frustrated"],
  lanes: [
    {
      id: "red",
      label: "Red",
      tone: "danger",
      when: {
        all: [
          { signal: "is_support_request", holds: true },
          {
            any: [
              { signal: "severity", at_least: 1.5 },
              { signal: "frustrated", at_least: 2 },
            ],
          },
        ],
      },
    },
    {
      id: "yellow",
      label: "Yellow",
      tone: "warning",
      when: {
        all: [
          { signal: "is_support_request", holds: true },
          { signal: "severity", at_least: 0.5 },
        ],
      },
    },
    {
      id: "green",
      label: "Green",
      tone: "ok",
      when: { signal: "is_support_request", holds: true },
    },
  ],
  unsure: { label: "Unsure" },
  others: "hide",
  layout: {
    component: "lanes",
    row: { fields: ["sender", "subject", "snippet", "age"] },
    sort: "oldest_first",
  },
  nav: { icon: "lifebuoy", count: "red" },
  examples: {},
};

/** A Board whose Lanes read only Facts: it works with no TypeSafe key. */
export const PAPERWORK_BOARD: BoardDoc = {
  id: "b_paperwork",
  name: "Paperwork",
  sentence: "threads with attachments, long ones first",
  version: 1,
  scope: { facts: { active: { last_days: 30 }, folder: "any" }, limit: 500 },
  signals: [],
  uses: [],
  lanes: [
    {
      id: "long",
      label: "Long threads",
      tone: "warning",
      when: {
        all: [
          { fact: "has_attachment", is: true },
          { fact: "message_count", at_least: 4 },
        ],
      },
    },
    { id: "files", label: "With files", tone: "info", when: { fact: "has_attachment", is: true } },
  ],
  unsure: { label: "Unsure" },
  others: "hide",
  layout: { component: "list", row: { fields: ["sender", "subject", "age"] } },
  nav: { icon: "folder", count: "total" },
  examples: {},
};
