// HTTP client for the Server (ADR 0006). One base URL and one token; the Sidecar on
// loopback when it runs, the Cloud URL otherwise. Typed routes arrive with the generated
// client in packages/shared; until then this is the minimal fetch wrapper.

import type {
  AccountCapabilities,
  Capabilities,
  ChangesPage,
  HeaderSearchPage,
  Id,
  Intent,
  IntentResult,
  MessageBodiesPage,
  Provider,
} from "@monday/shared";

export interface ServerTarget {
  baseUrl: string;
  token: string;
}

/**
 * A failed request. `status` 0 means the request never got an answer (no
 * server configured, connection refused, offline); those are transient.
 */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
  /** A 4xx that will not change by retrying; everything else is worth another try. */
  get permanent(): boolean {
    return (
      this.status >= 400 && this.status < 500 && ![401, 408, 423, 425, 429].includes(this.status)
    );
  }
}

export function createApi(target: () => ServerTarget | null) {
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const t = target();
    if (!t) throw new ApiError(0, "No server configured");
    let res: Response;
    try {
      res = await fetch(t.baseUrl + path, {
        ...init,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${t.token}`,
          ...(init.headers ?? {}),
        },
      });
    } catch (error) {
      throw new ApiError(0, error instanceof Error ? error.message : String(error));
    }
    if (!res.ok) throw new ApiError(res.status, await res.text());
    return (await res.json()) as T;
  }
  const intentPath = (intent: Intent) => `/threads/${encodeURIComponent(intent.threadId)}`;
  return {
    health: () => request<{ ok: boolean }>("/health"),
    capabilities: () => request<Capabilities>("/capabilities"),
    /**
     * The URL for a wake transport that cannot set headers (WebSocket,
     * EventSource): the Device token rides in the query string. Null without a server.
     */
    wakeUrl(path: "/changes/ws" | "/changes/sse", workspaceId: Id): string | null {
      const t = target();
      if (!t) return null;
      const q = new URLSearchParams({ workspace: workspaceId, token: t.token });
      return `${t.baseUrl}${path}?${q}`;
    },
    changes: {
      list: (workspaceId: Id, since: number, limit = 500) =>
        request<ChangesPage>(
          `/changes?${new URLSearchParams({
            workspace: workspaceId,
            since: String(since),
            limit: String(limit),
          })}`,
        ),
    },
    threads: {
      /** One Outbox intent to its route; the Server answers 200 whether or not it applied. */
      intent: (intent: Intent) => {
        const { threadId: _threadId, kind, ...body } = intent;
        if (kind === "tags") {
          return request<IntentResult>(`${intentPath(intent)}/tags`, {
            method: "PUT",
            body: JSON.stringify(body),
          });
        }
        return request<IntentResult>(`${intentPath(intent)}/${kind}`, {
          method: "POST",
          body: JSON.stringify(body),
        });
      },
    },
    messages: {
      /** Decrypted bodies by date range, newest first, for the Cache (ADR 0011). 423 when locked. */
      bodies: (
        workspaceId: Id,
        range: { after: string | null; before: string | null; limit: number },
      ) => {
        const q = new URLSearchParams({ workspace: workspaceId, limit: String(range.limit) });
        if (range.after) q.set("after", range.after);
        if (range.before) q.set("before", range.before);
        return request<MessageBodiesPage>(`/messages/bodies?${q}`);
      },
    },
    search: {
      /** The Server's headers-only index, for the Agent's lookups while a laptop is closed. */
      headers: (workspaceId: Id, q: string, limit = 50) =>
        request<HeaderSearchPage>(
          `/search/headers?${new URLSearchParams({ workspace: workspaceId, q, limit: String(limit) })}`,
        ),
    },
    settings: {
      /** Global and per-Device buckets; device wins for device-scoped keys. */
      all: () =>
        request<{ global: Record<string, unknown>; device: Record<string, unknown> }>("/settings"),
      set: (key: string, value: unknown, scope: "global" | "device" = "global") =>
        request<unknown>(`/settings/${encodeURIComponent(key)}`, {
          method: "PUT",
          body: JSON.stringify({ value, scope }),
        }),
    },
    accounts: {
      list: () => request<{ accounts: AccountView[] }>("/accounts"),
      /** The autoconfig ladder for an address: found, needs-oauth or manual. */
      discover: (address: string) =>
        request<Discovery>("/accounts/discover", {
          method: "POST",
          body: JSON.stringify({ address }),
        }),
      add: (body: AddAccountBody) =>
        request<{ account: AccountView }>("/accounts", {
          method: "POST",
          body: JSON.stringify(body),
        }),
      remove: (id: string) =>
        request<unknown>(`/accounts/${encodeURIComponent(id)}`, { method: "DELETE" }),
    },
    oauth: {
      /** The live check the wizard runs on every paste. */
      validate: (provider: OAuthProvider, params: Record<string, string>) =>
        request<ValidationResult>(
          `/oauth/${provider}/validate?${new URLSearchParams(params).toString()}`,
        ),
      start: (provider: OAuthProvider, body: OAuthStartBody) =>
        request<{ state: string; url: string; redirectUri: string }>(`/oauth/${provider}/start`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
      /** Long-polls until the loopback listener has finished the sign-in. */
      status: (provider: OAuthProvider, state: string) =>
        request<OAuthStatus>(`/oauth/${provider}/status?${new URLSearchParams({ state })}`),
      finish: (provider: OAuthProvider, state: string, code: string) =>
        request<{ account: AccountView }>(`/oauth/${provider}/finish`, {
          method: "POST",
          body: JSON.stringify({ state, code }),
        }),
    },
  };
}

/* ------------------------------ Accounts and OAuth shapes ------------------------------ */

export type OAuthProvider = "google" | "microsoft";

export interface AccountView {
  id: Id;
  workspaceId: Id;
  provider: Provider;
  address: string;
  displayName: string;
  capabilities: AccountCapabilities;
  connected: boolean;
  lastSync: string | null;
  lastError: string | null;
}

export interface HostPort {
  host: string;
  port: number;
  tls: "tls" | "starttls" | "none";
}

export type Discovery =
  | {
      kind: "found";
      source: string;
      imap: HostPort;
      smtp: HostPort;
      username: string;
      needsOAuth: OAuthProvider | null;
    }
  | { kind: "needs-oauth"; issuer: OAuthProvider; imap: HostPort | null; smtp: HostPort | null }
  | { kind: "manual"; tried: string[] };

export type AddAccountBody =
  | {
      provider: "jmap";
      address: string;
      auth: { kind: "token"; token: string };
      endpoint: { kind: "jmap"; sessionUrl: string };
    }
  | {
      provider: "imap";
      address: string;
      auth: { kind: "password"; user: string; password: string };
      endpoint: { kind: "imap"; imap: HostPort; smtp: HostPort };
    };

export type ValidationField = "clientId" | "clientSecret" | "tenant" | "network";

export type ValidationResult =
  | { ok: true; detail: string }
  | { ok: false; field: ValidationField; reason: string };

export interface OAuthStartBody {
  clientId: string;
  clientSecret?: string;
  tenant?: string;
  path?: "api" | "imap";
  pubsubTopic?: string | null;
}

export type OAuthStatus =
  | { status: "pending" }
  | { status: "done"; account: AccountView }
  | { status: "error"; message: string };

export type Api = ReturnType<typeof createApi>;
