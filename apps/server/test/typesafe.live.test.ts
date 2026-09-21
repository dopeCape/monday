// Opt-in: the real TypeSafe judge against api.typesafe.ai. Runs only when
// TYPESAFEAI_KEY is in the environment (never read from a file, never
// hardcoded); skipped otherwise. Proves slice 24's judge end to end: the key
// validates against /v1/models, and a Judgment on the fixture Thread comes
// back from a versioned Jev with probabilities, metered under judge.route
// with provider typesafe at the input-only price.

import { describe, expect, test } from "bun:test";
import { defaultSettings } from "@monday/shared";
import { createMemoryMeter, fakeKeys } from "../src/intelligence/runtime/fake/index.ts";
import { createHostedRuntime } from "../src/intelligence/runtime/index.ts";
import { createTypeSafeJudge, validateTypeSafeKey } from "../src/intelligence/runtime/typesafe.ts";

const API_KEY = process.env.TYPESAFEAI_KEY;

describe.skipIf(!API_KEY)("the TypeSafe judge against api.typesafe.ai (TYPESAFEAI_KEY set)", () => {
  test("the key validates and lists the aliases", async () => {
    const result = await validateTypeSafeKey(API_KEY as string);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.models).toContain("jev-latest");
  }, 30_000);

  test("a wrong key is refused in plain words", async () => {
    const result = await validateTypeSafeKey("ts-not-a-key");
    expect(result).toMatchObject({ ok: false, code: "unauthorized" });
  }, 30_000);

  test("the fixture Thread routes to finance with a confidence, metered under judge.route on typesafe", async () => {
    const meter = createMemoryMeter();
    const runtime = createHostedRuntime({
      chat: async () => {
        throw new Error("no chat in this test");
      },
      judge: createTypeSafeJudge(),
      keys: fakeKeys({ typesafe: API_KEY as string }),
      settings: async () => defaultSettings(),
      meter,
    });
    const result = await runtime.judge(
      "judge.route",
      {
        from: "Kenji Watanabe <kenji@meridian-capital.test>",
        subject: "Term sheet redline v3",
        snippet:
          "Attached the redline with the board seat and liquidation preference changes we discussed. Can you turn comments by Thursday?",
      },
      {
        group: {
          type: "choice",
          instructions: "Which Group does this Thread belong to?",
          criteria: {
            hiring: "Candidates, interviews, offers and recruiting.",
            finance: "Investors, term sheets, invoices, banking and money.",
            product: "Design, engineering and the product itself.",
            none: "None of the Groups fit.",
          },
        },
        needs_reply: {
          type: "noul",
          instructions: "A person is waiting on the owner to write back.",
        },
        worth: {
          type: "score",
          instructions: "How much would a three-bullet summary of this Thread help the owner?",
          criteria: [
            "Nothing to summarize: a notification, a receipt or a one-liner.",
            "A little: short and already clear from the subject.",
            "Useful: several points or a request buried in the text.",
            "Essential: long, several people, decisions or deadlines inside.",
          ],
        },
      },
      { workspaceId: "ws-live" },
    );
    expect(result.answers.group.choice).toBe("finance");
    expect(result.answers.group.confidence).toBeGreaterThan(0.5);
    expect(result.answers.needs_reply.noul).toBeGreaterThan(0.5);
    expect(result.answers.worth.score).toBeGreaterThan(1);
    expect(result.model).toMatch(/^jev-\d+\.\d+\.\d+$/);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(meter.rows[0]).toMatchObject({
      task: "judge.route",
      provider: "typesafe",
      model: result.model,
      outputTokens: 0,
      costMicros: Math.round(result.usage.inputTokens * 0.042),
    });
  }, 60_000);
});
