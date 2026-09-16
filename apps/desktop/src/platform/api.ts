// HTTP client for the Server (ADR 0006). One base URL and one token; the Sidecar on
// loopback when it runs, the Cloud URL otherwise. Typed routes arrive with the generated
// client in packages/shared; until then this is the minimal fetch wrapper.

import type {
  Capabilities,
  ChangesPage,
  Draft,
  DraftContent,
  DraftIntent,
  Id,
  Intent,
  IntentResult,
  ScheduledSend,
  ScheduleResult,
  VoiceProfile,
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

/** One Message's header with attachments and body state, as GET /threads/:id/messages returns it. */
export interface MessageHeaderResponse {
  id: Id;
  threadId: Id;
  from: { name: string; email: string };
  to: { name: string; email: string }[];
  cc: { name: string; email: string }[];
  date: string;
  headers: Record<string, string>;
  hasAttachments: boolean;
  attachments: Array<{
    id: Id;
    messageId: Id;
    name: string;
    size: number;
    mediaType: string;
    contentId: string | null;
    inline: boolean;
  }>;
  bodyState: "pending" | "fetched" | "deferred";
}

export interface BodyResponse {
  text: string;
  html: string | null;
  snippet: string;
  display: { html: string; quoted: boolean; blockedImages: number };
}

export interface BlobState {
  id: Id;
  chunkSize: number;
  chunkCount: number;
  received: number;
  complete: boolean;
}

export function createApi(target: () => ServerTarget | null) {
  async function raw(path: string, init: RequestInit = {}): Promise<Response> {
    const t = target();
    if (!t) throw new ApiError(0, "No server configured");
    let res: Response;
    try {
      res = await fetch(t.baseUrl + path, {
        ...init,
        headers: {
          authorization: `Bearer ${t.token}`,
          ...(init.headers ?? {}),
        },
      });
    } catch (error) {
      throw new ApiError(0, error instanceof Error ? error.message : String(error));
    }
    if (!res.ok) throw new ApiError(res.status, await res.text());
    return res;
  }
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await raw(path, {
      ...init,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
    return (await res.json()) as T;
  }
  const json = (method: string, body: unknown): RequestInit => ({
    method,
    body: JSON.stringify(body),
  });
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
          return request<IntentResult>(`${intentPath(intent)}/tags`, json("PUT", body));
        }
        return request<IntentResult>(`${intentPath(intent)}/${kind}`, json("POST", body));
      },
      messages: (threadId: Id) =>
        request<{ messages: MessageHeaderResponse[] }>(
          `/threads/${encodeURIComponent(threadId)}/messages`,
        ),
    },
    messages: {
      body: (messageId: Id, options: { images?: boolean } = {}) =>
        request<BodyResponse>(
          `/messages/${encodeURIComponent(messageId)}/body${options.images ? "?images=1" : ""}`,
        ),
    },
    attachments: {
      /** The bytes and media type of one attachment, for a download or an inline image. */
      bytes: async (attachmentId: Id) => {
        const res = await raw(`/attachments/${encodeURIComponent(attachmentId)}`);
        return {
          bytes: new Uint8Array(await res.arrayBuffer()),
          mediaType: res.headers.get("content-type") ?? "application/octet-stream",
        };
      },
    },
    drafts: {
      list: (workspaceId: Id) =>
        request<{ drafts: Draft[] }>(`/drafts?${new URLSearchParams({ workspace: workspaceId })}`),
      get: (draftId: Id) => request<Draft>(`/drafts/${encodeURIComponent(draftId)}`),
      /** One Draft or send intent from the Outbox to its route. */
      intent: (workspaceId: Id, intent: DraftIntent): Promise<ScheduleResult> => {
        const path = `/drafts/${encodeURIComponent(intent.draftId)}`;
        switch (intent.kind) {
          case "draft.save":
            return request<{ applied: boolean; reason?: string }>(
              path,
              json("PUT", {
                workspace: workspaceId,
                at: intent.at,
                actor: intent.actor,
                updatedBy: "device",
                content: intent.content satisfies DraftContent,
              }),
            );
          case "draft.delete":
            return request<IntentResult>(
              path,
              json("DELETE", { at: intent.at, actor: intent.actor }),
            );
          case "send.schedule":
            return request<ScheduleResult>(
              `${path}/send`,
              json("POST", {
                sendId: intent.sendId,
                ...(intent.delaySeconds !== undefined ? { delaySeconds: intent.delaySeconds } : {}),
                ...(intent.runAt ? { at: intent.runAt } : {}),
              }),
            );
          case "send.cancel":
            return request<IntentResult>(
              `/sends/${encodeURIComponent(intent.sendId)}/cancel`,
              json("POST", {}),
            );
        }
      },
    },
    sends: {
      list: (workspaceId: Id) =>
        request<{ sends: ScheduledSend[] }>(
          `/sends?${new URLSearchParams({ workspace: workspaceId })}`,
        ),
    },
    blobs: {
      start: (workspaceId: Id, file: { name: string; mediaType: string; size: number }) =>
        request<BlobState>("/blobs", json("POST", { workspace: workspaceId, ...file })),
      chunk: async (blobId: Id, index: number, bytes: Uint8Array) => {
        const res = await raw(`/blobs/${encodeURIComponent(blobId)}/chunks/${index}`, {
          method: "PUT",
          headers: { "content-type": "application/octet-stream" },
          body: bytes as unknown as BodyInit,
        });
        return (await res.json()) as BlobState;
      },
    },
    voice: {
      get: (workspaceId: Id) =>
        request<VoiceProfile>(`/voice?${new URLSearchParams({ workspace: workspaceId })}`),
      put: (
        workspaceId: Id,
        patch: Partial<Pick<VoiceProfile, "description" | "excerpts" | "enabled">>,
      ) => request<VoiceProfile>("/voice", json("PUT", { workspace: workspaceId, ...patch })),
    },
    settings: {
      /** Global and per-Device buckets; device wins for device-scoped keys. */
      all: () =>
        request<{ global: Record<string, unknown>; device: Record<string, unknown> }>("/settings"),
      set: (key: string, value: unknown, scope: "global" | "device" = "global") =>
        request<unknown>(`/settings/${encodeURIComponent(key)}`, json("PUT", { value, scope })),
    },
  };
}

export type Api = ReturnType<typeof createApi>;
