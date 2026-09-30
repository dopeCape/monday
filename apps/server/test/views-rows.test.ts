// Many values and per-row questions, planned and folded by code (docs/spec/views.md,
// "Many values" and "Rows"): one Noul per candidate, every one above the threshold
// kept and the Unsure band marked, a cap stated; one Choice per Message; a Signal's
// own question per item or per Message, with the item or the Message in it.

import { describe, expect, test } from "bun:test";
import type { ChoiceQuestion, JudgeAnswer } from "@monday/shared";
import { type Candidate, findCandidates } from "../src/intelligence/signals/candidates.ts";
import { candidateOptions } from "../src/intelligence/signals/index.ts";
import {
  DEFAULT_ROW_WORDS,
  foldRows,
  planRows,
  type RowMessage,
  rowModeOf,
} from "../src/intelligence/signals/rows.ts";

const owner = { name: "Sam", email: "sam@monday.test" };
const shop = { name: "Shop", email: "orders@shop.test" };

const CONFIRMATION = [
  "Your 3 orders are confirmed.",
  "Order 408-1111111-1111111",
  "Kettle 1,200 INR",
  "Order Total: 1,250 INR",
  "Order 408-2222222-2222222",
  "Lamp 800 INR",
  "Order Total: 830 INR",
  "Order 408-3333333-3333333",
  "Rug 2,000 INR",
  "Order Total: 2,040 INR",
  "Grand Total: 4,120 INR",
].join("\n");

const messages: RowMessage[] = [
  { id: "m1", index: 0, date: "2026-09-01T10:00:00Z", from: shop, text: CONFIRMATION },
];

const found = (text: string, max = 30): Candidate[] =>
  findCandidates(
    "money",
    {
      messages: [{ from: shop, to: [owner], cc: [], date: "2026-09-01T10:00:00Z", text }],
      owner: owner.email,
      written: "2026-09-01T10:00:00Z",
      dateOrder: "mdy",
    },
    max,
  );

const template: ChoiceQuestion = {
  type: "choice",
  instructions: "Each order's total: what one order cost, under the words Order Total.",
  criteria: { none: "The span is not one order's total." },
};

describe("many values", () => {
  test("a Noul per candidate, with the candidate and its words in the question", () => {
    const list = found(CONFIRMATION);
    const plan = planRows(
      "x",
      template,
      { mode: "many", kind: "money" },
      { found: list, messages, listOptions: candidateOptions },
      DEFAULT_ROW_WORDS,
      30,
    );
    expect(Object.keys(plan.questions)).toEqual([
      "x#i1",
      "x#i2",
      "x#i3",
      "x#i4",
      "x#i5",
      "x#i6",
      "x#i7",
    ]);
    const q = plan.questions["x#i2"];
    expect(q?.type).toBe("noul");
    expect(JSON.stringify(q)).toContain('"candidate":"1,250 INR"');
    expect(JSON.stringify(q)).toContain("Order Total: 1,250 INR");
    expect(JSON.stringify(q)).toContain("The span is not one order's total.");
    expect(plan.capped).toBe(0);
  });

  test("every candidate above the threshold is kept; the Unsure band is marked; the cap is stated", () => {
    const list = found(CONFIRMATION);
    const plan = planRows(
      "x",
      template,
      { mode: "many", kind: "money" },
      { found: list, messages, listOptions: candidateOptions },
      DEFAULT_ROW_WORDS,
      30,
    );
    const noul = (p: number): JudgeAnswer => ({ type: "noul", noul: p });
    const answers = {
      "x#i1": noul(0.05),
      "x#i2": noul(0.95),
      "x#i3": noul(0.04),
      "x#i4": noul(0.9),
      "x#i5": noul(0.03),
      "x#i6": noul(0.5),
      "x#i7": noul(0.1),
    };
    const f = foldRows(plan, answers, { threshold: 0.7, unsureFrom: 0.3, max: 30 });
    expect(f?.items?.map((i) => [i.text, i.unsure ?? false])).toEqual([
      ["1,250 INR", false],
      ["830 INR", false],
      ["2,040 INR", true],
    ]);
    expect(f?.items?.[0]).toMatchObject({ message: "m1", at: "2026-09-01T10:00:00Z" });
    expect(f?.row).toMatchObject({ type: "choice", choice: "picked", confidence: 0.9 });
    const capped = planRows(
      "x",
      template,
      { mode: "many", kind: "money" },
      { found: list, messages, listOptions: candidateOptions },
      DEFAULT_ROW_WORDS,
      3,
    );
    expect(Object.keys(capped.questions)).toHaveLength(3);
    expect(capped.capped).toBe(4);
    // Nothing above the band: none, sure by how clearly the best one was not it.
    const none = foldRows(
      plan,
      { "x#i1": noul(0.1), "x#i2": noul(0.2) },
      {
        threshold: 0.7,
        unsureFrom: 0.3,
        max: 30,
      },
    );
    expect(none?.row).toMatchObject({ choice: "none", confidence: 0.8 });
    expect(none?.items).toEqual([]);
  });
});

describe("rows that are Messages, and questions per row", () => {
  const advisories: RowMessage[] = [
    {
      id: "a1",
      index: 0,
      date: "2026-07-01T10:00:00Z",
      from: shop,
      text: "lodash: prototype pollution. Fixed in 4.17.21.",
    },
    { id: "a2", index: 1, date: "2026-08-01T10:00:00Z", from: shop, text: "Thanks, merged." },
    {
      id: "a3",
      index: 2,
      date: "2026-09-01T10:00:00Z",
      from: shop,
      text: "axios: SSRF. Upgrade to 1.7.4.",
    },
  ];
  const perMessage = (m: RowMessage) =>
    m.text.includes(":")
      ? [
          {
            key: m.text.split(":")[0] as string,
            span: m.text.split(":")[0] as string,
            line: m.text,
            value: m.text.split(":")[0] as string,
          },
        ]
      : [];

  test("one Choice per Message that holds a candidate, with the Message in the question", () => {
    const plan = planRows(
      "p",
      {
        type: "choice",
        instructions: "The package this advisory is about.",
        criteria: { none: "None." },
      },
      { mode: "message", kind: "item" },
      { found: [], messages: advisories, perMessage, listOptions: candidateOptions },
      DEFAULT_ROW_WORDS,
      20,
    );
    expect(Object.keys(plan.questions)).toEqual(["p#m0", "p#m2"]);
    expect(JSON.stringify(plan.questions["p#m2"])).toContain("axios: SSRF");
    const f = foldRows(
      plan,
      {
        "p#m0": {
          type: "choice",
          choice: "lodash",
          probabilities: { lodash: 0.9, none: 0.1 },
          confidence: 0.9,
        },
        "p#m2": { type: "choice", choice: "none", probabilities: { none: 1 }, confidence: 1 },
      },
      { threshold: 0.7, unsureFrom: 0.3, max: 30 },
    );
    expect(f?.items).toEqual([
      {
        key: "0:lodash",
        text: "lodash",
        value: "lodash",
        confidence: 0.9,
        message: "a1",
        at: "2026-07-01T10:00:00Z",
      },
    ]);
  });

  test("a Signal per Message and per item: its own question, with the row in it", () => {
    const severity = {
      type: "choice" as const,
      instructions: "How severe is this advisory?",
      criteria: { critical: "Critical.", low: "Low.", none: "Not an advisory." },
    };
    const perMsg = planRows(
      "s",
      severity,
      { mode: "each_message" },
      { found: [], messages: advisories, listOptions: candidateOptions },
      DEFAULT_ROW_WORDS,
      20,
    );
    expect(Object.keys(perMsg.questions)).toEqual(["s#m0", "s#m1", "s#m2"]);
    expect(JSON.stringify(perMsg.questions["s#m1"])).toContain(DEFAULT_ROW_WORDS.messageNote);
    const f = foldRows(
      perMsg,
      {
        "s#m0": { type: "choice", choice: "critical", probabilities: {}, confidence: 0.9 },
        "s#m1": { type: "choice", choice: "none", probabilities: {}, confidence: 0.95 },
      },
      { threshold: 0.7, unsureFrom: 0.3, max: 30 },
    );
    expect(f?.answers).toEqual({
      a1: { choice: "critical", confidence: 0.9, message: "a1", at: "2026-07-01T10:00:00Z" },
      a2: { choice: "none", confidence: 0.95, message: "a2", at: "2026-08-01T10:00:00Z" },
    });
    expect(f?.choice).toBe("each");
    const items: Candidate[] = [
      { key: "lodash", span: "lodash", line: "- lodash (critical)", value: "lodash" },
      { key: "axios", span: "axios", line: "- axios (high)", value: "axios" },
    ];
    const perItem = planRows(
      "s",
      severity,
      { mode: "each_item", kind: "item" },
      { found: items, messages: advisories, listOptions: candidateOptions },
      DEFAULT_ROW_WORDS,
      20,
    );
    expect(Object.keys(perItem.questions)).toEqual(["s#i1", "s#i2"]);
    expect(JSON.stringify(perItem.questions["s#i2"])).toContain('"item":"axios"');
  });

  test("an option source names its per-row mode", () => {
    expect(rowModeOf("extract_many:money")).toEqual({ mode: "many", kind: "money" });
    expect(rowModeOf("extract_message:item")).toEqual({ mode: "message", kind: "item" });
    expect(rowModeOf("each_item:item")).toEqual({ mode: "each_item", kind: "item" });
    expect(rowModeOf("each_message")).toEqual({ mode: "each_message" });
    expect(rowModeOf("extract:money")).toBeNull();
    expect(rowModeOf("amounts")).toBeNull();
  });
});
