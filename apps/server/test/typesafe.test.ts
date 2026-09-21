// The TypeSafe judge (slice 24, ADR 0012) over a fake fetch that answers with
// the response shapes docs.typesafe.ai/api documents: the request body, the
// answer mapping per primitive, the versioned model and the input tokens for
// the Meter, retries on 429, 503 and 529 honoring retry-after, the typed error
// for a wrong key and a malformed request, and the live key validation's
// plain-word answers. The runtime over it meters the call under judge.route
// with provider typesafe.

import { describe, expect, test } from "bun:test";
import type { JudgeQuestions } from "@monday/shared";
import { defaultSettings } from "@monday/shared";
import { createMemoryMeter, fakeKeys } from "../src/intelligence/runtime/fake/index.ts";
import { createHostedRuntime } from "../src/intelligence/runtime/index.ts";
import {
  createTypeSafeJudge,
  type FetchLike,
  mapAnswer,
  retryAfterMs,
  TypeSafeError,
  validateTypeSafeKey,
} from "../src/intelligence/runtime/typesafe.ts";

/** What Jev answered the fixture's six questions with, as the API returns them. */
const RECORDED = {
  model: "jev-1.13.0",
  answers: {
    group: {
      type: "choice",
      choice: "finance",
      probabilities: { hiring: 0.02, finance: 0.96, product: 0.02 },
      confidence: 0.94,
    },
    needs_reply: { type: "noul", noul: 0.58 },
    worth: {
      type: "score",
      score: 1.9,
      legend: { "0": "nothing", "1": "a little", "2": "useful", "3": "essential" },
      probabilities: { "0": 0.05, "1": 0.15, "2": 0.65, "3": 0.15 },
      confidence: 0.71,
    },
  },
  usage: { input_tokens: 1030, output_tokens: 26 },
};

const QUESTIONS = {
  group: {
    type: "choice",
    instructions: "Which Group does this Thread belong to?",
    criteria: { hiring: "candidates", finance: "money", product: "the product" },
  },
  needs_reply: { type: "noul", instructions: "A person is waiting on the owner to write back." },
  worth: {
    type: "score",
    instructions: "How much would a three-bullet summary help?",
    criteria: ["nothing", "a little", "useful", "essential"],
  },
} satisfies JudgeQuestions;

type Seen = { url: string; init: RequestInit | undefined };

/** A fetch that answers from a script of responses and records what it saw. */
function scriptedFetch(...responses: Array<Response | (() => Response)>) {
  const seen: Seen[] = [];
  const queue = [...responses];
  const fetchImpl: FetchLike = async (url, init) => {
    seen.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error("no scripted response left");
    return typeof next === "function" ? next() : next;
  };
  return { fetchImpl, seen };
}

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const noSleep = () => {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
};

describe("the TypeSafe judge over a fake fetch", () => {
  test("posts state, model and questions to /v1/systemone with the key as a bearer and maps every primitive", async () => {
    const { fetchImpl, seen } = scriptedFetch(jsonResponse(RECORDED));
    const judge = createTypeSafeJudge({ fetch: fetchImpl });
    const result = await judge({
      model: "jev-1.13.0",
      key: "ts-secret",
      state: { subject: "Term sheet redline v3", from: "kenji@fund.test" },
      questions: QUESTIONS,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(seen[0]?.init?.method).toBe("POST");
    const headers = seen[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer ts-secret");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({
      state: { subject: "Term sheet redline v3", from: "kenji@fund.test" },
      model: "jev-1.13.0",
      questions: QUESTIONS,
    });
    expect(result.model).toBe("jev-1.13.0");
    expect(result.usage).toEqual({ inputTokens: 1030 });
    expect(result.answers.group).toEqual({
      type: "choice",
      choice: "finance",
      probabilities: { hiring: 0.02, finance: 0.96, product: 0.02 },
      confidence: 0.94,
    });
    expect(result.answers.needs_reply).toEqual({ type: "noul", noul: 0.58 });
    // Score probabilities come keyed by level and become an array by level; the legend is dropped.
    expect(result.answers.worth).toEqual({
      type: "score",
      score: 1.9,
      probabilities: [0.05, 0.15, 0.65, 0.15],
      confidence: 0.71,
    });
  });

  test("the base URL from Settings replaces the default, trailing slash or not", async () => {
    const { fetchImpl, seen } = scriptedFetch(jsonResponse(RECORDED));
    const judge = createTypeSafeJudge({ fetch: fetchImpl });
    await judge({
      model: "jev-1.13.0",
      key: "k",
      state: "x",
      questions: QUESTIONS,
      baseUrl: "https://proxy.example.test/typesafe/",
    });
    expect(seen[0]?.url).toBe("https://proxy.example.test/typesafe/v1/systemone");
  });

  test("a Choice missing an option gets it at zero, and a choice outside the options falls to the best probability", () => {
    const answer = mapAnswer("group", QUESTIONS.group, {
      type: "choice",
      choice: "other",
      probabilities: { finance: 0.7, hiring: 0.3 },
      confidence: 0.5,
    });
    expect(answer).toEqual({
      type: "choice",
      choice: "finance",
      probabilities: { hiring: 0.3, finance: 0.7, product: 0 },
      confidence: 0.5,
    });
    // An answer of the wrong primitive is a bad response, not a silent default.
    expect(() => mapAnswer("needs_reply", QUESTIONS.needs_reply, { type: "choice" })).toThrow(
      TypeSafeError,
    );
  });

  test("429 and 503 are retried with backoff that honors retry-after; 529 backs off exponentially", async () => {
    const { waits, sleep } = noSleep();
    const { fetchImpl, seen } = scriptedFetch(
      jsonResponse({ error: "rate limit" }, 429, { "retry-after": "2" }),
      jsonResponse({ error: "unavailable" }, 503),
      jsonResponse({ error: "overloaded" }, 529),
      jsonResponse(RECORDED),
    );
    const judge = createTypeSafeJudge({ fetch: fetchImpl, sleep, backoffMs: 500, retries: 3 });
    const result = await judge({ model: "jev-latest", key: "k", state: "x", questions: QUESTIONS });
    expect(result.model).toBe("jev-1.13.0");
    expect(seen).toHaveLength(4);
    // retry-after 2 s, then 500 ms doubled per attempt when the server says nothing.
    expect(waits).toEqual([2000, 1000, 2000]);
  });

  test("past the retry budget the last retryable error is thrown with its status and code", async () => {
    const { sleep } = noSleep();
    const { fetchImpl } = scriptedFetch(
      jsonResponse({ error: "busy" }, 429),
      jsonResponse({ error: "busy" }, 429),
    );
    const judge = createTypeSafeJudge({ fetch: fetchImpl, sleep, retries: 1 });
    const error = await judge({ model: "m", key: "k", state: "x", questions: QUESTIONS }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(TypeSafeError);
    expect(error as TypeSafeError).toMatchObject({ code: "rate_limited", status: 429 });
    expect((error as TypeSafeError).retryable).toBe(true);
  });

  test("a wrong key is 401 unauthorized and a malformed request 422 invalid_request, neither retried", async () => {
    const { waits, sleep } = noSleep();
    const bad = scriptedFetch(jsonResponse({ message: "Invalid API key" }, 401));
    const judge = createTypeSafeJudge({ fetch: bad.fetchImpl, sleep });
    const unauthorized = await judge({
      model: "m",
      key: "nope",
      state: "x",
      questions: QUESTIONS,
    }).catch((e: unknown) => e as TypeSafeError);
    expect(unauthorized).toMatchObject({
      name: "TypeSafeError",
      code: "unauthorized",
      status: 401,
    });
    expect((unauthorized as TypeSafeError).message).toContain("Invalid API key");
    expect((unauthorized as TypeSafeError).retryable).toBe(false);
    const malformed = scriptedFetch(
      jsonResponse({ detail: "questions.group.criteria: expected map" }, 422),
    );
    const judge2 = createTypeSafeJudge({ fetch: malformed.fetchImpl, sleep });
    const invalid = await judge2({ model: "m", key: "k", state: "x", questions: QUESTIONS }).catch(
      (e: unknown) => e as TypeSafeError,
    );
    expect(invalid).toMatchObject({ code: "invalid_request", status: 422 });
    expect(waits).toEqual([]);
    expect(bad.seen).toHaveLength(1);
    expect(malformed.seen).toHaveLength(1);
  });

  test("a network failure is retried and then reported as such; a non-JSON body is a bad response", async () => {
    const { waits, sleep } = noSleep();
    const { fetchImpl } = scriptedFetch(() => {
      throw new Error("ECONNRESET");
    }, jsonResponse(RECORDED));
    const judge = createTypeSafeJudge({ fetch: fetchImpl, sleep, backoffMs: 250 });
    const result = await judge({ model: "m", key: "k", state: "x", questions: QUESTIONS });
    expect(result.model).toBe("jev-1.13.0");
    expect(waits).toEqual([250]);

    const html = scriptedFetch(new Response("<html>gateway</html>", { status: 200 }));
    const judge2 = createTypeSafeJudge({ fetch: html.fetchImpl, sleep });
    const error = await judge2({ model: "m", key: "k", state: "x", questions: QUESTIONS }).catch(
      (e: unknown) => e as TypeSafeError,
    );
    expect(error).toMatchObject({ code: "bad_response" });
  });

  test("retry-after reads seconds or an HTTP date", () => {
    const now = Date.parse("2026-09-21T10:00:00Z");
    expect(retryAfterMs("3", now)).toBe(3000);
    expect(retryAfterMs("0.5", now)).toBe(500);
    expect(retryAfterMs("Mon, 21 Sep 2026 10:00:05 GMT", now)).toBe(5000);
    expect(retryAfterMs(null, now)).toBeUndefined();
    expect(retryAfterMs("soon", now)).toBeUndefined();
  });

  test("through the runtime a judgment meters under judge.route with provider typesafe, the versioned model and input tokens only", async () => {
    const { fetchImpl } = scriptedFetch(jsonResponse(RECORDED));
    const meter = createMemoryMeter();
    const runtime = createHostedRuntime({
      chat: async () => {
        throw new Error("no chat in this test");
      },
      judge: createTypeSafeJudge({ fetch: fetchImpl }),
      keys: fakeKeys({ typesafe: "ts-secret" }),
      settings: async () => defaultSettings(),
      meter,
    });
    expect(await runtime.judgeAvailable()).toBe(true);
    const result = await runtime.judge("judge.route", { subject: "Term sheet" }, QUESTIONS, {
      workspaceId: "ws-1",
    });
    expect(result.answers.group.choice).toBe("finance");
    expect(meter.rows).toHaveLength(1);
    expect(meter.rows[0]).toMatchObject({
      task: "judge.route",
      provider: "typesafe",
      model: "jev-1.13.0",
      inputTokens: 1030,
      outputTokens: 0,
      costMicros: Math.round(1030 * 0.042),
    });
  });
});

describe("validateTypeSafeKey", () => {
  test("a good key lists the models it can send", async () => {
    const { fetchImpl, seen } = scriptedFetch(
      jsonResponse({
        models: [
          { name: "jev-latest", description: "Latest", release_date: "2026-08-01" },
          { name: "jev-preview", description: "Preview", release_date: "2026-08-01" },
        ],
      }),
    );
    const result = await validateTypeSafeKey("ts-good", { fetch: fetchImpl });
    expect(result).toEqual({ ok: true, models: ["jev-latest", "jev-preview"] });
    expect(seen[0]?.url).toBe("https://api.typesafe.ai/v1/models");
    expect(seen[0]?.init?.method).toBe("GET");
    const headers = (seen[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe("Bearer ts-good");
  });

  test("a wrong key, no network, and another error each answer in plain words without the key", async () => {
    const wrong = await validateTypeSafeKey("ts-wrong", {
      fetch: scriptedFetch(jsonResponse({ message: "Invalid API key" }, 401)).fetchImpl,
    });
    expect(wrong).toMatchObject({ ok: false, code: "unauthorized" });
    expect((wrong as { reason: string }).reason).toContain("does not know this key");
    expect(JSON.stringify(wrong)).not.toContain("ts-wrong");

    const offline = await validateTypeSafeKey("ts-any", {
      fetch: scriptedFetch(() => {
        throw new Error("getaddrinfo ENOTFOUND api.typesafe.ai");
      }).fetchImpl,
    });
    expect(offline).toMatchObject({ ok: false, code: "network" });
    expect((offline as { reason: string }).reason).toContain("Could not reach TypeSafe");

    const other = await validateTypeSafeKey("ts-any", {
      fetch: scriptedFetch(jsonResponse({ error: "teapot" }, 418)).fetchImpl,
    });
    expect(other).toMatchObject({ ok: false, code: "http" });
    expect((other as { reason: string }).reason).toContain("418");

    expect(await validateTypeSafeKey("   ", { fetch: scriptedFetch().fetchImpl })).toMatchObject({
      ok: false,
      reason: "Paste the key first.",
    });
  });
});
