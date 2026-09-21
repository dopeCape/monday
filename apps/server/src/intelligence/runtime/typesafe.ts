// The TypeSafe judge (ADR 0012): the JudgeModel under HostedRuntime.judge,
// one POST to System One per request, every question answered in parallel
// with probabilities and a confidence, never text. A small fetch client, not
// the SDK: the Server stays runtime-neutral, the bundle stays small, and the
// API is one endpoint (docs.typesafe.ai/api). Retries 429, 503 and 529 with
// backoff that honors retry-after; a typed TypeSafeError for everything else;
// the versioned model from the response goes back for the Meter row.
//
// validateTypeSafeKey is the live check a pasted key gets before it is saved
// (docs/spec/onboarding.md): one GET /v1/models, answered in plain words.

import type {
  JsonValue,
  JudgeAnswer,
  JudgeAnswers,
  JudgeErrorCode,
  JudgeQuestion,
  JudgeQuestions,
  JudgeResponse,
  KeyValidation,
} from "@monday/shared";
import type { JudgeCall, JudgeModel } from "./index.ts";

export const TYPESAFE_BASE_URL = "https://api.typesafe.ai";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface TypeSafeOptions {
  fetch?: FetchLike;
  /** Waits between retries; tests pass one that records instead of sleeping. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Retries after a 429, 503, 529 or a network failure; 3 by default. */
  retries?: number;
  /** The first backoff, doubled per retry when the response carries no retry-after; 500 ms by default. */
  backoffMs?: number;
  /** Longest wait for one response; 20 s by default (the judge answers in about a second). */
  timeoutMs?: number;
}

export type TypeSafeErrorCode = JudgeErrorCode;

/** What TypeSafe answered when it did not answer the questions. */
export class TypeSafeError extends Error {
  readonly name = "TypeSafeError";
  constructor(
    readonly code: TypeSafeErrorCode,
    /** The HTTP status, or 0 when no response came back. */
    readonly status: number,
    message: string,
    /** How long the server asked us to wait, when it said. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
  /** Whether another attempt could succeed: rate limits, overload and the network. */
  get retryable(): boolean {
    return (
      this.code === "rate_limited" ||
      this.code === "overloaded" ||
      this.code === "network" ||
      this.code === "timeout"
    );
  }
}

/* ------------------------------ The wire shapes ------------------------------ */

interface WireChoice {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}
interface WireNoul {
  type: "noul";
  noul: number;
}
interface WireScore {
  type: "score";
  score: number;
  legend?: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}
type WireAnswer = WireChoice | WireNoul | WireScore;

interface WireResponse {
  model: string;
  answers: Record<string, WireAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * One wire answer into monday's shape for its question. Choice probabilities
 * are completed with a zero per option TypeSafe left out; Score probabilities
 * come as a level-keyed map and become an array by level.
 */
export function mapAnswer(id: string, question: JudgeQuestion, raw: unknown): JudgeAnswer {
  if (!isRecord(raw) || raw.type !== question.type) {
    throw new TypeSafeError(
      "bad_response",
      200,
      `TypeSafe answered ${id} as ${isRecord(raw) ? String(raw.type) : typeof raw}, not ${question.type}`,
    );
  }
  if (question.type === "choice") {
    const names = Object.keys(question.criteria);
    const given = isRecord(raw.probabilities) ? raw.probabilities : {};
    const probabilities = Object.fromEntries(names.map((n) => [n, clamp01(num(given[n]))]));
    const choice =
      typeof raw.choice === "string" && names.includes(raw.choice)
        ? raw.choice
        : (names.reduce<string | null>(
            (best, n) =>
              best === null || (probabilities[n] ?? 0) > (probabilities[best] ?? 0) ? n : best,
            null,
          ) ?? "");
    return { type: "choice", choice, probabilities, confidence: clamp01(num(raw.confidence)) };
  }
  if (question.type === "noul") return { type: "noul", noul: clamp01(num(raw.noul)) };
  const levels = question.criteria.length;
  const given = isRecord(raw.probabilities) ? raw.probabilities : {};
  const probabilities = Array.from({ length: levels }, (_, i) => clamp01(num(given[String(i)])));
  return {
    type: "score",
    score: Math.min(Math.max(0, levels - 1), Math.max(0, num(raw.score))),
    probabilities,
    confidence: clamp01(num(raw.confidence)),
  };
}

/** The whole response into a JudgeResponse; every question must be answered. */
export function mapResponse<Q extends JudgeQuestions>(
  questions: Q,
  body: unknown,
): JudgeResponse<Q> {
  if (!isRecord(body) || !isRecord(body.answers) || typeof body.model !== "string") {
    throw new TypeSafeError("bad_response", 200, "TypeSafe answered without a model or answers");
  }
  const wire = body as unknown as WireResponse;
  const answers: Record<string, JudgeAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    answers[id] = mapAnswer(id, question, wire.answers[id]);
  }
  return {
    answers: answers as JudgeAnswers<Q>,
    model: wire.model,
    usage: { inputTokens: Math.max(0, Math.round(num(wire.usage?.input_tokens))) },
  };
}

/* ------------------------------ Errors and retries ------------------------------ */

/** retry-after as milliseconds: seconds, or an HTTP date; undefined when absent or unreadable. */
export function retryAfterMs(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.max(0, at - now);
  return undefined;
}

async function errorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as unknown;
    if (isRecord(body)) {
      for (const k of ["message", "error", "detail"]) {
        const v = body[k];
        if (typeof v === "string" && v) return v;
        if (isRecord(v) && typeof v.message === "string") return v.message;
      }
    }
  } catch {}
  return response.statusText || `HTTP ${response.status}`;
}

/** A non-2xx response as the typed error. */
export async function errorFor(response: Response, now: number): Promise<TypeSafeError> {
  const status = response.status;
  const detail = await errorMessage(response);
  const after = retryAfterMs(response.headers.get("retry-after"), now);
  if (status === 401 || status === 403)
    return new TypeSafeError("unauthorized", status, `TypeSafe did not accept the key: ${detail}`);
  if (status === 422 || status === 400)
    return new TypeSafeError("invalid_request", status, `TypeSafe refused the request: ${detail}`);
  if (status === 429)
    return new TypeSafeError("rate_limited", status, `TypeSafe rate limit: ${detail}`, after);
  if (status === 503 || status === 529 || status === 502 || status === 504)
    return new TypeSafeError("overloaded", status, `TypeSafe is overloaded: ${detail}`, after);
  return new TypeSafeError("http", status, `TypeSafe answered ${status}: ${detail}`, after);
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new TypeSafeError("timeout", 0, "TypeSafe did not answer in time")),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function asTypeSafeError(error: unknown): TypeSafeError {
  if (error instanceof TypeSafeError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new TypeSafeError("network", 0, `could not reach TypeSafe: ${message}`);
}

/* ------------------------------ The judge ------------------------------ */

const base = (url: string | undefined) => (url ?? TYPESAFE_BASE_URL).replace(/\/+$/, "");

export function createTypeSafeJudge(options: TypeSafeOptions = {}): JudgeModel {
  const fetchImpl = options.fetch ?? ((u, i) => fetch(u, i));
  const sleep = options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? (() => Date.now());
  const retries = options.retries ?? 3;
  const backoffMs = options.backoffMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 20_000;

  return async <Q extends JudgeQuestions>(call: JudgeCall<Q>): Promise<JudgeResponse<Q>> => {
    const body = JSON.stringify({
      state: call.state as JsonValue,
      model: call.model,
      questions: call.questions,
    });
    let last: TypeSafeError | null = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0 && last) {
        const wait = last.retryAfterMs ?? backoffMs * 2 ** (attempt - 1);
        await sleep(wait);
      }
      try {
        const response = await withTimeout(
          fetchImpl(`${base(call.baseUrl)}/v1/systemone`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${call.key}`,
              "content-type": "application/json",
              accept: "application/json",
            },
            body,
          }),
          timeoutMs,
        );
        if (!response.ok) throw await errorFor(response, now());
        let parsed: unknown;
        try {
          parsed = await response.json();
        } catch {
          throw new TypeSafeError(
            "bad_response",
            response.status,
            "TypeSafe answered with no JSON",
          );
        }
        return mapResponse(call.questions, parsed);
      } catch (error) {
        last = asTypeSafeError(error);
        if (!last.retryable) throw last;
      }
    }
    throw last ?? new TypeSafeError("network", 0, "could not reach TypeSafe");
  };
}

/* ------------------------------ Key validation ------------------------------ */

export type { KeyValidation };

/**
 * The live check for a pasted key: GET /v1/models with it. A 401 is a wrong
 * key, a network failure says so, anything else is reported as it came, all
 * in plain words for the paste box. The key itself never appears in the answer.
 */
export async function validateTypeSafeKey(
  key: string,
  options: TypeSafeOptions & { baseUrl?: string } = {},
): Promise<KeyValidation> {
  const fetchImpl = options.fetch ?? ((u, i) => fetch(u, i));
  const now = options.now ?? (() => Date.now());
  const timeoutMs = options.timeoutMs ?? 10_000;
  const trimmed = key.trim();
  if (!trimmed) return { ok: false, code: "unauthorized", reason: "Paste the key first." };
  try {
    const response = await withTimeout(
      fetchImpl(`${base(options.baseUrl)}/v1/models`, {
        method: "GET",
        headers: { authorization: `Bearer ${trimmed}`, accept: "application/json" },
      }),
      timeoutMs,
    );
    if (!response.ok) throw await errorFor(response, now());
    const body = (await response.json()) as unknown;
    const list = isRecord(body) && Array.isArray(body.models) ? body.models : [];
    const models = list
      .map((m) => (isRecord(m) && typeof m.name === "string" ? m.name : null))
      .filter((m): m is string => m !== null);
    return { ok: true, models };
  } catch (error) {
    const e = asTypeSafeError(error);
    const reason =
      e.code === "unauthorized"
        ? "TypeSafe does not know this key. Check it on typesafe.ai and paste it again."
        : e.code === "network" || e.code === "timeout"
          ? "Could not reach TypeSafe. Check the connection and try again."
          : e.code === "rate_limited"
            ? "TypeSafe is rate limiting this key right now. Try again in a moment."
            : e.code === "overloaded"
              ? "TypeSafe is overloaded right now. Try again in a moment."
              : `TypeSafe answered with an error: ${e.message}`;
    return { ok: false, code: e.code, reason };
  }
}
