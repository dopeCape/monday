// The batching measurement against a fake judge (slice 28): a seeded sample
// of synthetic Threads over three Groups, 60 of them labelled, and an
// `ask` that answers every question from the Thread it points at, so the
// script's --fake mode and the tests run every arm and write every table
// without a network. `drift` makes batched requests answer worse, for tests
// of the verdict.

import type { GroupId, JsonValue, JudgeAnswer, JudgeQuestion } from "@monday/shared";
import { rng } from "../../providers/fake/fixture.ts";
import type { GroupText } from "../routing/classify.ts";
import type { EvalAsk, EvalItem, EvalStratum } from "./batching.ts";

export const FAKE_GROUPS: GroupText[] = [
  {
    id: "g-invoices",
    name: "Invoices",
    sentence: "Bills and invoices to pay.",
    prompt: "",
    predicate: {},
    examples: [],
  },
  {
    id: "g-team",
    name: "Team",
    sentence: "Mail from colleagues at work.",
    prompt: "",
    predicate: {},
    examples: [],
  },
  {
    id: "g-newsletters",
    name: "Newsletters",
    sentence: "Newsletters and digests.",
    prompt: "",
    predicate: {},
    examples: [],
  },
];

const TOPICS: Array<{ word: string; group: GroupId | null }> = [
  { word: "Invoices", group: "g-invoices" },
  { word: "Team", group: "g-team" },
  { word: "Newsletters", group: "g-newsletters" },
  { word: "Misc", group: null },
];

/** A seeded synthetic sample: 100 newest, 100 recent, 100 older, and `labelled` of them labelled. */
export function fakeSample(seed = 7, perStratum = 100, labelled = 60): EvalItem[] {
  const random = rng(seed);
  const items: EvalItem[] = [];
  const strata: EvalStratum[] = ["newest", "recent", "older"];
  const every = Math.max(1, Math.floor((perStratum * strata.length) / Math.max(1, labelled)));
  for (const stratum of strata) {
    for (let i = 0; i < perStratum; i++) {
      const topic =
        TOPICS[Math.floor(random() * TOPICS.length)] ?? (TOPICS[3] as (typeof TOPICS)[number]);
      const n = items.length + 1;
      items.push({
        id: `thread-${String(n).padStart(4, "0")}`,
        stratum,
        facts: {
          subject: `${topic.word} note ${n}`,
          from: { name: `Sender ${n % 17}`, email: `sender${n % 17}@example.test` },
          to: [{ name: "Owner", email: "owner@example.test" }],
          participants: [],
          headers: topic.word === "Newsletters" ? { "list-id": "<news.example.test>" } : {},
          snippet: `About ${topic.word.toLowerCase()} number ${n}.`,
          hasAttachments: topic.word === "Invoices",
          messageCount: 1 + (n % 3),
        },
      });
      const item = items[items.length - 1] as EvalItem;
      if ((n - 1) % every === 0 && items.filter((it) => it.label).length < labelled) {
        item.label = { groupId: topic.group };
      }
    }
  }
  return items;
}

function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

interface FakeThread {
  subject?: string;
  from?: { email?: string } | null;
}

/**
 * Answers from the Thread a question points at (`<key>__<what>`): the Group
 * whose name the subject carries, Nouls and urgency from a hash of the
 * subject. With `drift`, a request holding more than one Thread answers that
 * share of its Threads' Group Choices with `none` instead.
 */
export function fakeAsk(
  options: { drift?: (size: number) => number; model?: string } = {},
): EvalAsk {
  return async (state, questions) => {
    const threads = ((state as Record<string, JsonValue>).threads ?? {}) as Record<
      string,
      FakeThread
    >;
    const size = Object.keys(threads).length;
    const answers: Record<string, JudgeAnswer> = {};
    for (const [id, q] of Object.entries(questions) as Array<[string, JudgeQuestion]>) {
      const [key, what] = id.split("__") as [string, string];
      const t = threads[key] ?? {};
      const subject = t.subject ?? "";
      const h = hash(subject);
      if (q.type === "choice") {
        const names = Object.keys(q.criteria);
        let pick =
          names.find((n) => subject.toLowerCase().startsWith(n.replaceAll("_", " "))) ?? "none";
        const drift = size > 1 ? (options.drift?.(size) ?? 0) : 0;
        if (drift > 0 && (h % 1000) / 1000 < drift) pick = "none";
        const probabilities = Object.fromEntries(
          names.map((n) => [n, n === pick ? 0.92 : 0.08 / Math.max(1, names.length - 1)]),
        );
        answers[id] = { type: "choice", choice: pick, probabilities, confidence: 0.9 };
      } else if (q.type === "noul") {
        answers[id] = { type: "noul", noul: ((h >>> (what.length % 7)) % 100) / 100 };
      } else {
        const levels = q.criteria.length;
        const score = h % Math.max(1, levels);
        answers[id] = {
          type: "score",
          score,
          probabilities: Array.from({ length: levels }, (_, i) => (i === score ? 1 : 0)),
          confidence: 1,
        };
      }
    }
    const inputTokens =
      Math.ceil(JSON.stringify(state).length / 4) + 40 * Object.keys(questions).length;
    // Jev's price: $0.042 per million input tokens.
    return {
      answers,
      inputTokens,
      costMicros: Math.round(inputTokens * 0.042),
      model: options.model ?? "fake-jev",
    };
  };
}
