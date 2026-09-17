// A small Microsoft Graph client over fetch: bearer auth through the token
// broker (one forced refresh on 401), the Outlook service limit of four
// concurrent requests per mailbox held with a semaphore, Retry-After honoured
// on 429 (research, "Rate limits"), and typed errors that carry the OData
// code so the adapter can tell a stale delta token from anything else.

import type { FetchLike } from "../jmap/client.ts";
import type { TokenBroker } from "../oauth/tokens.ts";
import { type OAuthAuth, ProviderError } from "../types.ts";

export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
/** Outlook service limit: four concurrent requests per app and mailbox. */
export const GRAPH_CONCURRENCY = 4;
export const GRAPH_MAX_RETRIES = 5;

export interface GraphClientOptions {
  auth: OAuthAuth;
  tokens: TokenBroker;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  concurrency?: number;
  maxRetries?: number;
}

export interface GraphRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  query?: Record<string, string | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  /** Raw bytes or text body; sent as is with the given content type. */
  rawBody?: Uint8Array | string;
}

export class GraphApiError extends ProviderError {
  constructor(
    readonly status: number,
    readonly odataCode: string,
    message: string,
    readonly location: string | null = null,
  ) {
    super(
      message,
      status === 404 || odataCode === "ErrorItemNotFound"
        ? "not-found"
        : status === 401 || status === 403
          ? "auth"
          : status === 429
            ? "rate-limit"
            : status === 413
              ? "too-large"
              : "protocol",
    );
    this.name = "GraphApiError";
  }
}

async function errorOf(response: Response): Promise<GraphApiError> {
  let code = "";
  let message = `${response.status}`;
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } };
    code = body.error?.code ?? "";
    message = body.error?.message ?? message;
  } catch {
    // not JSON
  }
  return new GraphApiError(
    response.status,
    code,
    `Graph ${response.status}${code ? ` ${code}` : ""}: ${message}`,
    response.headers.get("location"),
  );
}

/** A counting semaphore. */
export function semaphore(limit: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiters: (() => void)[] = [];
  return async (fn) => {
    if (active >= limit) await new Promise<void>((resolve) => waiters.push(resolve));
    active += 1;
    try {
      return await fn();
    } finally {
      active -= 1;
      waiters.shift()?.();
    }
  };
}

export class GraphClient {
  readonly fetch: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly gate: <T>(fn: () => Promise<T>) => Promise<T>;
  private readonly maxRetries: number;

  constructor(private readonly options: GraphClientOptions) {
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.gate = semaphore(options.concurrency ?? GRAPH_CONCURRENCY);
    this.maxRetries = options.maxRetries ?? GRAPH_MAX_RETRIES;
  }

  get auth(): OAuthAuth {
    return this.options.auth;
  }

  /** A live token; pass the token a 401 rejected to get a refreshed one. */
  token(rejected?: string): Promise<string> {
    return this.options.tokens.access(
      this.options.auth,
      rejected === undefined ? {} : { rejected },
    );
  }

  /** A request against an absolute URL (nextLink, deltaLink, upload session). */
  async raw(url: string, options: GraphRequestOptions = {}): Promise<Response> {
    let target = url;
    if (options.query) {
      const u = new URL(url);
      for (const [k, v] of Object.entries(options.query))
        if (v !== undefined) u.searchParams.set(k, v);
      target = u.toString();
    }
    return this.gate(async () => {
      let refreshed = false;
      for (let attempt = 0; ; attempt++) {
        const token = await this.token();
        const hasJson = options.body !== undefined;
        const response = await this.fetch(target, {
          method: options.method ?? (hasJson || options.rawBody !== undefined ? "POST" : "GET"),
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json",
            ...(hasJson ? { "content-type": "application/json" } : {}),
            ...(options.headers ?? {}),
          },
          ...(hasJson
            ? { body: JSON.stringify(options.body) }
            : options.rawBody !== undefined
              ? { body: options.rawBody as BodyInit }
              : {}),
        });
        if (response.ok) return response;
        if (response.status === 401 && !refreshed) {
          refreshed = true;
          await this.token(token);
          continue;
        }
        if ((response.status === 429 || response.status >= 500) && attempt < this.maxRetries) {
          const retryAfter = Number(response.headers.get("retry-after") ?? "");
          await this.sleep(
            Number.isFinite(retryAfter) && retryAfter > 0
              ? retryAfter * 1000
              : Math.min(1000 * 2 ** attempt, 30_000),
          );
          continue;
        }
        throw await errorOf(response);
      }
    });
  }

  async request<T>(path: string, options: GraphRequestOptions = {}): Promise<T> {
    const url = path.startsWith("http") ? path : `${GRAPH_BASE}/${path.replace(/^\//, "")}`;
    const response = await this.raw(url, options);
    if (response.status === 202 || response.status === 204) return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}
