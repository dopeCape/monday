// HTTP client for the Server (ADR 0006). One base URL and one token; the Sidecar on
// loopback when it runs, the Cloud URL otherwise. Typed routes arrive with the generated
// client in packages/shared; until then this is the minimal fetch wrapper.

import type { Capabilities } from "@monday/shared";

export interface ServerTarget {
  baseUrl: string;
  token: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createApi(target: () => ServerTarget | null) {
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const t = target();
    if (!t) throw new ApiError(0, "No server configured");
    const res = await fetch(t.baseUrl + path, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${t.token}`,
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok) throw new ApiError(res.status, await res.text());
    return (await res.json()) as T;
  }
  return {
    health: () => request<{ ok: boolean }>("/health"),
    capabilities: () => request<Capabilities>("/capabilities"),
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
