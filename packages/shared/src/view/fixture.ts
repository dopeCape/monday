// The fixture Views (docs/spec/views.md): the Boards that became Views
// support requests as red, yellow and green, and a Fact-only View of
// threads with attachments and a deadline. Slice 39 writes Views from these;
// the tests and the demo read them.

import type { ViewDoc } from "./types.ts";

export const SUPPORT_TODAY_VIEW: ViewDoc = {
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
  extractions: [],
  blocks: [
    {
      id: "lanes",
      type: "lanes",
      row: { fields: ["sender", "subject", "snippet", "age"] },
      sort: "oldest_first",
    },
  ],
  actions: [],
  nav: { icon: "lifebuoy", count: "red" },
  examples: {},
};

/** A View whose Lanes read only Facts: it works with no TypeSafe key. */
export const PAPERWORK_VIEW: ViewDoc = {
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
  extractions: [],
  blocks: [{ id: "list", type: "list", row: { fields: ["sender", "subject", "age"] } }],
  actions: [],
  nav: { icon: "folder", count: "total" },
  examples: {},
};

/**
 * "All my Amazon orders with shipped and delivered lanes and total spend per
 * month" (docs/spec/views.md, acceptance 10): a status Choice for the Lanes,
 * the order total and number picked from what code found, one row per order.
 */
export const AMAZON_ORDERS_VIEW: ViewDoc = {
  id: "v_amazon_orders",
  name: "Amazon orders",
  sentence: "all my Amazon orders with shipped and delivered lanes and total spend per month",
  version: 1,
  scope: { facts: { from_domain: ["amazon.com"], folder: "any" }, limit: 1000 },
  signals: [
    {
      id: "status",
      kind: "choice",
      label: "status",
      question: {
        type: "choice",
        instructions: "Where does the newest message say this order stands?",
        criteria: {
          ordered: "The order was placed or confirmed; nothing has shipped yet.",
          shipped: "Some or all of the order is on its way.",
          delivered: "The order arrived.",
          none: "The message is not about the state of an order, such as an ad or a review request.",
        },
      },
    },
  ],
  uses: [],
  extractions: [
    {
      id: "order_total",
      label: "Total",
      find: "money",
      question: "The total the customer paid for the whole order, including tax and shipping.",
      none: "The message states no order total, such as a shipping notice without prices.",
    },
    {
      id: "order_number",
      label: "Order",
      find: "reference",
      question: "The Amazon order number this message is about.",
    },
    {
      id: "tracking_link",
      label: "Tracking",
      find: "link",
      question: "The link that shows where the package is.",
    },
  ],
  lanes: [
    {
      id: "delivered",
      label: "Delivered",
      tone: "ok",
      when: { signal: "status", is: "delivered" },
    },
    { id: "shipped", label: "Shipped", tone: "info", when: { signal: "status", is: "shipped" } },
    { id: "ordered", label: "Ordered", tone: "muted", when: { signal: "status", is: "ordered" } },
  ],
  unsure: { label: "Unsure" },
  others: "hide",
  blocks: [
    {
      id: "spend",
      type: "stat",
      title: "Spent this month",
      width: "third",
      query: {
        dedupe: "x:order_number",
        aggregate: { op: "sum", field: "x:order_total" },
        period: { field: "received_at", bucket: "month" },
      },
      compare: "previous",
    },
    {
      id: "by_month",
      type: "chart",
      chart: "bar",
      title: "Spend per month",
      width: "two_thirds",
      query: {
        dedupe: "x:order_number",
        group_by: { field: "received_at", bucket: "month" },
        aggregate: { op: "sum", field: "x:order_total" },
        sort: { by: "key", dir: "asc" },
      },
    },
    {
      id: "orders",
      type: "lanes",
      row: { fields: ["subject", "x:order_total", "age"] },
      query: { dedupe: "x:order_number" },
      actions: ["track"],
    },
  ],
  actions: [
    {
      id: "track",
      label: "Track package",
      icon: "truck",
      on: "row",
      when: { all: [{ lane: "shipped" }, { extract: "tracking_link", present: true }] },
      do: { kind: "open_link", link: "x:tracking_link" },
    },
  ],
  nav: { icon: "shopping-bag", count: "shipped" },
  examples: {},
};

/** "Invoices I owe as a table with amount, due date and vendor, sorted by due date" (acceptance 11). */
export const INVOICES_OWED_VIEW: ViewDoc = {
  id: "v_invoices_owed",
  name: "Invoices I owe",
  sentence: "invoices I owe as a table with amount, due date and vendor, sorted by due date",
  version: 1,
  scope: { facts: { folder: "any", received: { last_days: 120 } }, limit: 500 },
  signals: [],
  uses: ["money_direction"],
  extractions: [
    {
      id: "amount_due",
      label: "Amount",
      find: "money",
      question: "The amount the owner is asked to pay on this invoice.",
    },
    {
      id: "due_date",
      label: "Due",
      find: "date",
      question: "The date by which the invoice must be paid.",
    },
    {
      id: "vendor",
      label: "Vendor",
      find: "company",
      question: "The company that sent the invoice and is owed the money.",
    },
  ],
  lanes: [],
  unsure: { label: "Unsure" },
  others: "hide",
  blocks: [
    {
      id: "invoices",
      type: "table",
      columns: [
        { label: "Vendor", field: "x:vendor" },
        { label: "Amount", field: "x:amount_due", format: "money" },
        { label: "Due", field: "x:due_date", format: "date" },
      ],
      query: {
        where: { signal: "money_direction", is: "owner_pays" },
        sort: { by: "x:due_date", dir: "asc" },
      },
    },
  ],
  actions: [],
  nav: { icon: "receipt", count: "total" },
  examples: {},
};

/** "Who emails me most this quarter" (acceptance 12): counted by code, no question at all. */
export const WHO_EMAILS_VIEW: ViewDoc = {
  id: "v_who_emails",
  name: "Who emails me most",
  sentence: "who emails me most this quarter",
  version: 1,
  scope: { facts: { folder: "any", received: { last_days: 90 } }, limit: 2000 },
  signals: [],
  uses: [],
  extractions: [],
  lanes: [],
  unsure: { label: "Unsure" },
  others: "hide",
  blocks: [
    { id: "people", type: "people", by: "person", title: "Most mail from", width: "half" },
    {
      id: "chart",
      type: "chart",
      chart: "bar",
      title: "Threads by company",
      width: "half",
      query: { group_by: { field: "company" }, aggregate: { op: "count" }, limit: 8 },
    },
  ],
  actions: [],
  nav: { icon: "users", count: "total" },
  examples: {},
};

/** "My travel bookings on a calendar" (acceptance 13). */
export const TRAVEL_VIEW: ViewDoc = {
  id: "v_travel",
  name: "Travel",
  sentence: "my travel bookings on a calendar",
  version: 1,
  scope: { facts: { folder: "any", received: { last_days: 365 } }, limit: 500 },
  signals: [
    {
      id: "is_booking",
      kind: "noul",
      label: "travel booking",
      question: {
        type: "noul",
        instructions:
          "The thread confirms a booking the owner made for travel: a flight, a train, a hotel, a rental car.",
        criteria: {
          true: "A confirmation, an itinerary or a change to a booked trip.",
          false: "Offers, newsletters, loyalty statements, or a trip someone else booked.",
        },
      },
    },
  ],
  uses: [],
  extractions: [
    {
      id: "travel_date",
      label: "Date",
      find: "date",
      question: "The day the trip, the flight or the stay starts.",
    },
    {
      id: "booking_ref",
      label: "Booking",
      find: "reference",
      question: "The booking or confirmation code of this trip.",
    },
  ],
  lanes: [],
  unsure: { label: "Unsure" },
  others: "hide",
  blocks: [
    {
      id: "calendar",
      type: "calendar",
      date: "x:travel_date",
      query: { where: { signal: "is_booking", holds: true }, dedupe: "x:booking_ref" },
    },
  ],
  actions: [],
  nav: { icon: "calendar", count: "total" },
  examples: {},
};
