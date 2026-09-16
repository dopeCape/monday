// HTTP client for the Server (ADR 0006). One base URL and one token; the Sidecar on
// loopback when it runs, the Cloud URL otherwise. Typed routes arrive with the generated
// client in packages/shared; until then this is the minimal fetch wrapper.

import type { Capabilities, ChangesPage, Id, Intent, IntentResult } from "@monday/shared";

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
  };
}

export type Api = ReturnType<typeof createApi>;
