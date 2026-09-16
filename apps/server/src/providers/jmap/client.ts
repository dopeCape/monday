// A small RFC 8620 client over fetch: session discovery, method batching with
// result references, method-level errors as typed exceptions, blob upload and
// download. Everything mail-specific (RFC 8621) is in index.ts.

import { ProviderError } from "../types.ts";

export const CORE = "urn:ietf:params:jmap:core";
export const MAIL = "urn:ietf:params:jmap:mail";
export const SUBMISSION = "urn:ietf:params:jmap:submission";

export interface JmapSession {
  apiUrl: string;
  downloadUrl: string;
  uploadUrl: string;
  eventSourceUrl: string;
  state: string;
  username: string;
  accounts: Record<string, { name: string; isPersonal: boolean; accountCapabilities: object }>;
  primaryAccounts: Record<string, string>;
  capabilities: Record<string, unknown>;
}

export interface CoreLimits {
  maxSizeUpload: number;
  maxConcurrentUpload: number;
  maxSizeRequest: number;
  maxConcurrentRequests: number;
  maxCallsInRequest: number;
  maxObjectsInGet: number;
  maxObjectsInSet: number;
}

export type MethodCall = [name: string, args: Record<string, unknown>, id: string];
export type MethodResponse = [name: string, result: Record<string, unknown>, id: string];

export class JmapMethodError extends ProviderError {
  constructor(
    readonly method: string,
    readonly type: string,
    readonly description: string | null,
  ) {
    super(`${method}: ${type}${description ? ` (${description})` : ""}`, "protocol");
    this.name = "JmapMethodError";
  }
}

export interface JmapAuth {
  /** The Authorization header value. */
  header: string;
}

export function bearer(token: string): JmapAuth {
  return { header: `Bearer ${token}` };
}

export function basic(user: string, password: string): JmapAuth {
  return { header: `Basic ${btoa(`${user}:${password}`)}` };
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface JmapClientOptions {
  fetch?: FetchLike;
  /** Extra headers on every request, such as a User-Agent. */
  headers?: Record<string, string>;
}

/** Expands an RFC 6570 level 1 template the way RFC 8620 uses them. */
export function expandTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name: string) =>
    name in vars ? encodeURIComponent(vars[name] ?? "") : whole,
  );
}

function errorFromStatus(status: number, body: string): ProviderError {
  if (status === 401 || status === 403) {
    return new ProviderError(`JMAP server refused the credentials (${status})`, "auth");
  }
  if (status === 429) return new ProviderError("JMAP server rate limit", "rate-limit");
  return new ProviderError(`JMAP request failed with ${status}: ${body.slice(0, 200)}`, "protocol");
}

export class JmapClient {
  private readonly fetchImpl: FetchLike;
  private readonly baseHeaders: Record<string, string>;
  private counter = 0;
  session: JmapSession | null = null;

  constructor(
    readonly sessionUrl: string,
    private readonly auth: JmapAuth,
    options: JmapClientOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.baseHeaders = options.headers ?? {};
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...this.baseHeaders, Authorization: this.auth.header, ...extra };
  }

  async connect(): Promise<JmapSession> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.sessionUrl, {
        headers: this.headers({ Accept: "application/json" }),
        redirect: "follow",
      });
    } catch (cause) {
      throw new ProviderError(`cannot reach ${this.sessionUrl}`, "network", { cause });
    }
    if (!response.ok) throw errorFromStatus(response.status, await response.text());
    const session = (await response.json()) as JmapSession;
    if (!session.apiUrl || !session.accounts) {
      throw new ProviderError("session resource is not a JMAP session", "protocol");
    }
    this.session = session;
    return session;
  }

  requireSession(): JmapSession {
    if (!this.session) throw new ProviderError("not connected", "protocol");
    return this.session;
  }

  limits(): CoreLimits {
    const core = (this.requireSession().capabilities[CORE] ?? {}) as Partial<CoreLimits>;
    return {
      maxSizeUpload: core.maxSizeUpload ?? 50_000_000,
      maxConcurrentUpload: core.maxConcurrentUpload ?? 1,
      maxSizeRequest: core.maxSizeRequest ?? 10_000_000,
      maxConcurrentRequests: core.maxConcurrentRequests ?? 1,
      maxCallsInRequest: core.maxCallsInRequest ?? 16,
      maxObjectsInGet: core.maxObjectsInGet ?? 500,
      maxObjectsInSet: core.maxObjectsInSet ?? 500,
    };
  }

  /** The account id the mail capability is primary for. */
  mailAccountId(): string {
    const session = this.requireSession();
    const id = session.primaryAccounts[MAIL] ?? Object.keys(session.accounts)[0];
    if (!id) throw new ProviderError("session lists no mail account", "protocol");
    return id;
  }

  hasCapability(uri: string): boolean {
    return uri in this.requireSession().capabilities;
  }

  nextId(): string {
    this.counter += 1;
    return `c${this.counter}`;
  }

  /** Runs one request with these calls; returns responses in order. Throws on the first method error. */
  async request(calls: MethodCall[], using: string[] = [CORE, MAIL]): Promise<MethodResponse[]> {
    const session = this.requireSession();
    let response: Response;
    try {
      response = await this.fetchImpl(session.apiUrl, {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json", Accept: "application/json" }),
        body: JSON.stringify({ using, methodCalls: calls }),
      });
    } catch (cause) {
      throw new ProviderError("JMAP request failed", "network", { cause });
    }
    if (!response.ok) throw errorFromStatus(response.status, await response.text());
    const body = (await response.json()) as {
      methodResponses: MethodResponse[];
      sessionState?: string;
    };
    if (body.sessionState && body.sessionState !== session.state) session.state = body.sessionState;
    for (const [name, result, id] of body.methodResponses) {
      if (name !== "error") continue;
      throw new JmapMethodError(
        calls.find((c) => c[2] === id)?.[0] ?? "?",
        String(result.type ?? "unknown"),
        typeof result.description === "string" ? result.description : null,
      );
    }
    return body.methodResponses;
  }

  /** One call, one result. */
  async call<T extends Record<string, unknown>>(
    name: string,
    args: Record<string, unknown>,
    using?: string[],
  ): Promise<T> {
    const id = this.nextId();
    const responses = await this.request([[name, args, id]], using);
    const match = responses.find((r) => r[2] === id && r[0] === name);
    if (!match) throw new ProviderError(`no response for ${name}`, "protocol");
    return match[1] as T;
  }

  /** Runs the calls and returns the first result named `name` for each id. */
  async batch(
    calls: MethodCall[],
    using?: string[],
  ): Promise<Map<string, Record<string, unknown>>> {
    const responses = await this.request(calls, using);
    const out = new Map<string, Record<string, unknown>>();
    for (const [, result, id] of responses) if (!out.has(id)) out.set(id, result);
    return out;
  }

  async upload(
    accountId: string,
    bytes: Uint8Array,
    type: string,
  ): Promise<{ blobId: string; size: number; type: string }> {
    const session = this.requireSession();
    const url = expandTemplate(session.uploadUrl, { accountId });
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: this.headers({ "Content-Type": type }),
        body: bytes,
      });
    } catch (cause) {
      throw new ProviderError("JMAP upload failed", "network", { cause });
    }
    if (!response.ok) throw errorFromStatus(response.status, await response.text());
    return (await response.json()) as { blobId: string; size: number; type: string };
  }

  /** Streams a blob as it arrives. */
  async *download(
    accountId: string,
    blobId: string,
    type: string,
    name: string,
  ): AsyncIterable<Uint8Array> {
    const session = this.requireSession();
    const url = expandTemplate(session.downloadUrl, { accountId, blobId, type, name });
    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers: this.headers() });
    } catch (cause) {
      throw new ProviderError("JMAP download failed", "network", { cause });
    }
    if (!response.ok) throw errorFromStatus(response.status, await response.text());
    if (!response.body) {
      yield new Uint8Array(await response.arrayBuffer());
      return;
    }
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value) yield value;
      }
    } finally {
      reader.releaseLock();
    }
  }

  async openEventSource(types: string[], pingSeconds: number): Promise<Response> {
    const session = this.requireSession();
    const url = expandTemplate(session.eventSourceUrl, {
      types: types.join(","),
      closeafter: "no",
      ping: String(pingSeconds),
    });
    return this.fetchImpl(url, { headers: this.headers({ Accept: "text/event-stream" }) });
  }
}
