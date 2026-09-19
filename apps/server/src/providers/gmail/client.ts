// A small Gmail REST client over fetch: bearer auth through the token broker
// (one forced refresh on 401), quota pacing through the token bucket, the
// documented backoff on 429 and rate-limit 403s, multipart batch requests for
// messages.get (50 per batch, each counted against quota), and resumable
// uploads for large sends. Everything mail-shaped lives in index.ts.

import type { FetchLike } from "../jmap/client.ts";
import type { TokenBroker } from "../oauth/tokens.ts";
import { type OAuthAuth, ProviderError } from "../types.ts";
import { GMAIL_COST, type GmailMethod, gmailQuotaBucket, type TokenBucket } from "./quota.ts";

export const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
export const GMAIL_BATCH_URL = "https://gmail.googleapis.com/batch/gmail/v1";
export const GMAIL_UPLOAD_BASE = "https://gmail.googleapis.com/upload/gmail/v1/users/me";
export const PUBSUB_BASE = "https://pubsub.googleapis.com/v1";

/** Requests per batch; Google recommends no more than 50. */
export const BATCH_SIZE = 50;
/** Resumable upload chunks must be multiples of 256 KiB. */
export const UPLOAD_CHUNK = 8 * 256 * 1024;
export const MAX_BACKOFF_MS = 64_000;

export interface GmailClientOptions {
  auth: OAuthAuth;
  tokens: TokenBroker;
  fetch?: FetchLike;
  quota?: TokenBucket;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  maxRetries?: number;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Quota units to take before the call; a GmailMethod name or a number. */
  cost?: GmailMethod | number;
}

export class GmailApiError extends ProviderError {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
  ) {
    super(
      message,
      status === 404
        ? "not-found"
        : status === 401 || status === 403
          ? reason === "rateLimitExceeded" ||
            reason === "userRateLimitExceeded" ||
            reason === "dailyLimitExceeded"
            ? "rate-limit"
            : "auth"
          : status === 429
            ? "rate-limit"
            : status === 413
              ? "too-large"
              : "protocol",
    );
    this.name = "GmailApiError";
  }
}

function withQuery(url: string, query?: RequestOptions["query"]): string {
  if (!query) return url;
  const u = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) u.searchParams.append(key, v);
    else u.searchParams.set(key, value);
  }
  return u.toString();
}

async function errorOf(response: Response): Promise<GmailApiError> {
  let reason = "";
  let message = `${response.status}`;
  try {
    const body = (await response.json()) as {
      error?: { message?: string; errors?: { reason?: string }[]; status?: string };
    };
    reason = body.error?.errors?.[0]?.reason ?? body.error?.status ?? "";
    message = body.error?.message ?? message;
  } catch {
    // not JSON
  }
  return new GmailApiError(response.status, reason, `Gmail ${response.status}: ${message}`);
}

/** Gmail says "quota" three ways: a 429, or a 403 with one of the rate-limit reasons. */
export function isRateLimit(status: number, reason: string | null | undefined): boolean {
  if (status === 429) return true;
  return (
    status === 403 &&
    (reason === "rateLimitExceeded" ||
      reason === "userRateLimitExceeded" ||
      reason === "dailyLimitExceeded" ||
      reason === "quotaExceeded")
  );
}

/** The `reason` of a Gmail error body, or null when the body is not one. */
export function reasonOf(body: string | null | undefined): string | null {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body) as {
      error?: { errors?: Array<{ reason?: string }>; status?: string };
    };
    return parsed.error?.errors?.[0]?.reason ?? parsed.error?.status ?? null;
  } catch {
    return null;
  }
}

export function backoffMs(attempt: number, random: () => number): number {
  return Math.min(2 ** attempt * 1000 + Math.floor(random() * 1000), MAX_BACKOFF_MS);
}

export class GmailClient {
  readonly fetch: FetchLike;
  readonly quota: TokenBucket;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly maxRetries: number;

  constructor(private readonly options: GmailClientOptions) {
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.quota =
      options.quota ??
      gmailQuotaBucket({
        ...(options.now ? { now: options.now } : {}),
        ...(options.sleep ? { sleep: options.sleep } : {}),
      });
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = options.random ?? Math.random;
    this.maxRetries = options.maxRetries ?? 5;
  }

  get auth(): OAuthAuth {
    return this.options.auth;
  }

  /** A live token; pass the token a 401 rejected to get a refreshed one. */
  async token(rejected?: string): Promise<string> {
    return this.options.tokens.access(
      this.options.auth,
      rejected === undefined ? {} : { rejected },
    );
  }

  /** A raw request against any Google URL, with auth, retries and quota. */
  async raw(url: string, options: RequestOptions = {}): Promise<Response> {
    const cost =
      typeof options.cost === "number" ? options.cost : options.cost ? GMAIL_COST[options.cost] : 0;
    if (cost > 0) await this.quota.take(cost);
    const target = withQuery(url, options.query);
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const token = await this.token();
      const isJson = options.body !== undefined && !(options.body instanceof Uint8Array);
      const response = await this.fetch(target, {
        method: options.method ?? (options.body !== undefined ? "POST" : "GET"),
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(isJson ? { "content-type": "application/json" } : {}),
          ...(options.headers ?? {}),
        },
        ...(options.body !== undefined
          ? { body: isJson ? JSON.stringify(options.body) : (options.body as Uint8Array) }
          : {}),
      });
      if (response.ok) return response;
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        await this.token(token);
        continue;
      }
      const error = await errorOf(response);
      const rateLimited = isRateLimit(response.status, error.reason);
      if (rateLimited) this.quota.penalize();
      const retryable = rateLimited || response.status >= 500;
      if (retryable && attempt < this.maxRetries) {
        await this.sleep(backoffMs(attempt, this.random));
        continue;
      }
      throw error;
    }
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.raw(`${GMAIL_API_BASE}/${path}`, options);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  /**
   * GETs many resources in multipart batches. Each part still costs its quota
   * units ("n requests, not one"). Missing ids are left out of the result.
   */
  async batchGet<T>(
    paths: { id: string; path: string }[],
    unitCost: number,
  ): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (let i = 0; i < paths.length; i += BATCH_SIZE) {
      const chunk = paths.slice(i, i + BATCH_SIZE);
      await this.quota.take(unitCost * chunk.length);
      const boundary = `monday_batch_${Math.floor(this.random() * 1e9).toString(16)}`;
      const body = chunk
        .map(
          (p, index) =>
            `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <item${index}>\r\n\r\nGET /gmail/v1/users/me/${p.path} HTTP/1.1\r\n\r\n\r\n`,
        )
        .join("");
      let refreshed = false;
      for (let attempt = 0; ; attempt++) {
        const token = await this.token();
        const response = await this.fetch(GMAIL_BATCH_URL, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": `multipart/mixed; boundary=${boundary}`,
          },
          body: `${body}--${boundary}--\r\n`,
        });
        if (response.status === 401 && !refreshed) {
          refreshed = true;
          await this.token(token);
          continue;
        }
        if (!response.ok) {
          const error = await errorOf(response);
          const rateLimited = isRateLimit(response.status, error.reason);
          if (rateLimited) this.quota.penalize();
          if ((rateLimited || response.status >= 500) && attempt < this.maxRetries) {
            await this.sleep(backoffMs(attempt, this.random));
            continue;
          }
          throw error;
        }
        const parts = parseMultipart(
          await response.text(),
          response.headers.get("content-type") ?? "",
        );
        let rateLimited = false;
        for (const part of parts) {
          const index = Number(/item(\d+)/.exec(part.contentId)?.[1] ?? -1);
          const target = chunk[index];
          if (!target) continue;
          // A part refused for quota (429, or a 403 with the rate-limit reason, which
          // Gmail sends for "Units per minute per user") is retried, never dropped.
          if (
            part.status === 429 ||
            (part.status === 403 && isRateLimit(403, reasonOf(part.body)))
          ) {
            rateLimited = true;
          }
          if (part.status >= 200 && part.status < 300 && part.body) {
            out.set(target.id, JSON.parse(part.body) as T);
          }
        }
        if (rateLimited) this.quota.penalize();
        if (rateLimited && attempt < this.maxRetries) {
          // Retry only what is still missing.
          const missing = chunk.filter((p) => !out.has(p.id));
          if (missing.length > 0) {
            await this.sleep(backoffMs(attempt, this.random));
            const more = await this.batchGet<T>(missing, unitCost);
            for (const [k, v] of more) out.set(k, v);
          }
        }
        break;
      }
    }
    return out;
  }

  /** Resumable upload: one session start, then chunks; returns the final resource. */
  async resumableUpload<T>(
    path: string,
    metadata: unknown,
    bytes: Uint8Array,
    contentType: string,
    cost: number,
  ): Promise<T> {
    await this.quota.take(cost);
    const start = await this.raw(`${GMAIL_UPLOAD_BASE}/${path}`, {
      method: "POST",
      query: { uploadType: "resumable" },
      body: metadata,
      headers: {
        "x-upload-content-type": contentType,
        "x-upload-content-length": String(bytes.byteLength),
      },
    });
    const location = start.headers.get("location");
    if (!location) throw new ProviderError("resumable upload gave no session URI", "protocol");
    let offset = 0;
    for (;;) {
      const end = Math.min(offset + UPLOAD_CHUNK, bytes.byteLength);
      const chunk = bytes.subarray(offset, end);
      const token = await this.token();
      const response = await this.fetch(location, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": contentType,
          "content-length": String(chunk.byteLength),
          "content-range": `bytes ${offset}-${end - 1}/${bytes.byteLength}`,
        },
        body: chunk,
      });
      if (response.status === 308) {
        const range = response.headers.get("range");
        const last = range ? Number(/-(\d+)$/.exec(range)?.[1] ?? end - 1) : end - 1;
        offset = last + 1;
        continue;
      }
      if (!response.ok) throw await errorOf(response);
      return (await response.json()) as T;
    }
  }
}

export interface MultipartPart {
  contentId: string;
  status: number;
  body: string;
}

/** Parses a multipart/mixed batch response of application/http parts. */
export function parseMultipart(text: string, contentType: string): MultipartPart[] {
  const boundary = /boundary="?([^";]+)"?/i.exec(contentType)?.[1];
  if (!boundary) return [];
  const parts: MultipartPart[] = [];
  for (const raw of text.split(`--${boundary}`)) {
    const part = raw.replace(/^\r?\n/, "");
    if (!part.trim() || part.trim() === "--") continue;
    const headerEnd = part.search(/\r?\n\r?\n/);
    if (headerEnd < 0) continue;
    const outerHeaders = part.slice(0, headerEnd);
    const http = part.slice(headerEnd).replace(/^\r?\n\r?\n/, "");
    const contentId = /content-id:\s*<?([^>\r\n]+)>?/i.exec(outerHeaders)?.[1] ?? "";
    const statusLine = /^HTTP\/[\d.]+\s+(\d{3})/.exec(http);
    const status = statusLine ? Number(statusLine[1]) : 0;
    const bodyStart = http.search(/\r?\n\r?\n/);
    const body =
      bodyStart < 0
        ? ""
        : http
            .slice(bodyStart)
            .replace(/^\r?\n\r?\n/, "")
            .trim();
    parts.push({ contentId, status, body });
  }
  return parts;
}
