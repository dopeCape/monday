// HTTP client for the Server (ADR 0006). One base URL and one token; the Sidecar on
// loopback when it runs, the Cloud URL otherwise. Typed routes arrive with the generated
// client in packages/shared; until then this is the minimal fetch wrapper.

import type {
  AccountCapabilities,
  Brief,
  BriefTrigger,
  Capabilities,
  ChangesPage,
  CorrectionResult,
  DeploymentMode,
  Device,
  Draft,
  DraftContent,
  DraftIntent,
  GroupInput,
  GroupView,
  HeaderSearchPage,
  HostedProvider,
  Id,
  Intent,
  IntentResult,
  MessageBodiesPage,
  MeterMonth,
  ProposedMove,
  Provider,
  RoutingApplied,
  RoutingDecision,
  RoutingPreview,
  ScheduledSend,
  ScheduleResult,
  ThreadRoute,
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

/** What POST /threads/:id/brief answers: the queued Job, or that a fresh Brief already exists. */
export type BriefRequestResult =
  | { jobId: Id; fresh?: undefined }
  | { fresh: true; jobId?: undefined };

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

export interface ApiOptions {
  /** A request to this target got no answer at all; the Shell's picker moves to the other one. */
  onUnreachable?: ((target: ServerTarget) => void) | undefined;
}

export function createApi(target: () => ServerTarget | null, options: ApiOptions = {}) {
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
      options.onUnreachable?.(t);
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
    /** The target requests go to right now, for screens that show it. */
    target,
    health: () => request<{ ok: boolean; mode: string; uptimeMs: number }>("/health"),
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
    search: {
      /** The Server's headers-only index, for the Agent's lookups while a laptop is closed. */
      headers: (workspaceId: Id, q: string, limit = 50) =>
        request<HeaderSearchPage>(
          `/search/headers?${new URLSearchParams({ workspace: workspaceId, q, limit: String(limit) })}`,
        ),
    },
    /** Shared provider keys (ADR 0007): "Let the server use this key". The Server never returns a key. */
    keys: {
      /** Which providers hold a shared key. */
      shared: () => request<{ shared: HostedProvider[] }>("/keys"),
      /** Sends a key to the Server, stored under the envelope of `workspaceId`. 423 when locked. */
      share: (workspaceId: Id, provider: HostedProvider, key: string) =>
        request<{ provider: HostedProvider; shared: boolean }>(
          `/keys/${provider}`,
          json("PUT", { workspace: workspaceId, key }),
        ),
      /** Forgets the shared key; the Device copy in the keychain is untouched. */
      unshare: (provider: HostedProvider) =>
        raw(`/keys/${provider}`, { method: "DELETE" }).then(() => undefined),
    },
    meter: {
      /** This month by Task and provider with cost; `month` is "YYYY-MM", default now. */
      month: (workspaceId: Id, month?: string) => {
        const q = new URLSearchParams({ workspace: workspaceId });
        if (month) q.set("month", month);
        return request<MeterMonth>(`/meter?${q}`);
      },
    },
    briefs: {
      /**
       * Asks for a Brief under the brief policy (slice 13): "open" from the
       * reader, "user" by hand. The Brief arrives through the Changes feed
       * once the Job ran; an open that finds a fresh one queues nothing.
       */
      compute: (workspaceId: Id, threadId: Id, trigger: BriefTrigger = "user") =>
        request<BriefRequestResult>(
          `/threads/${encodeURIComponent(threadId)}/brief`,
          json("POST", { workspace: workspaceId, trigger }),
        ),
      /** The stored Brief, or null when none yet. */
      get: async (threadId: Id): Promise<Brief | null> => {
        try {
          return await request<Brief>(`/threads/${encodeURIComponent(threadId)}/brief`);
        } catch (error) {
          if (error instanceof ApiError && error.status === 404) return null;
          throw error;
        }
      },
    },
    devices: {
      list: () => request<Device[]>("/devices"),
      revoke: (id: Id) => raw(`/devices/${encodeURIComponent(id)}`, { method: "DELETE" }),
      /** Approves a pairing code another Device is showing (ADR 0006). */
      confirm: (code: string) => request<{ ok: boolean }>("/pair/confirm", json("POST", { code })),
    },
    upgrade: {
      status: () => request<UpgradeStatus>("/upgrade"),
      export: () => request<ExportResult>("/upgrade/export", { method: "POST" }),
      copy: (databaseUrl: string, replace = false) =>
        request<CopyResult>("/upgrade/copy", json("POST", { databaseUrl, replace })),
      attach: (databaseUrl: string) =>
        request<{ restartRequired: boolean }>("/upgrade/attach", json("POST", { databaseUrl })),
      detach: () => request<{ restartRequired: boolean }>("/upgrade/attach", { method: "DELETE" }),
    },
    /** Routing (slice 12): Groups, Needs a decision, the re-run with preview. */
    routing: {
      /** Every Group with its Examples, counts and mean Confidence. Needs the Server unlocked for revised prompts. */
      groups: (workspaceId: Id) =>
        request<{ groups: GroupView[] }>(
          `/groups?${new URLSearchParams({ workspace: workspaceId })}`,
        ).then((r) => r.groups),
      createGroup: (workspaceId: Id, input: GroupInput) =>
        request<GroupView>("/groups", json("POST", { workspace: workspaceId, ...input })),
      updateGroup: (groupId: Id, patch: Partial<GroupInput>) =>
        request<GroupView>(`/groups/${encodeURIComponent(groupId)}`, json("PATCH", patch)),
      deleteGroup: (groupId: Id) =>
        raw(`/groups/${encodeURIComponent(groupId)}`, { method: "DELETE" }).then(() => undefined),
      /** Needs a decision, newest first. */
      decisions: (workspaceId: Id) =>
        request<{ decisions: RoutingDecision[] }>(
          `/routing/decisions?${new URLSearchParams({ workspace: workspaceId })}`,
        ).then((r) => r.decisions),
      /** The user's choice for a Thread in Needs a decision: a Group id, or null to leave it out. */
      decide: (threadId: Id, groupId: Id | null) =>
        request<CorrectionResult>(
          `/routing/decisions/${encodeURIComponent(threadId)}`,
          json("POST", { group: groupId, at: new Date().toISOString() }),
        ),
      /** A dry run over the newest Threads: what would move. Nothing moves. */
      rerun: (workspaceId: Id, recent?: number) =>
        request<RoutingPreview>(
          "/routing/rerun",
          json("POST", { workspace: workspaceId, ...(recent ? { recent } : {}) }),
        ),
      /** The second call: applies the moves a preview proposed. */
      apply: (workspaceId: Id, moves: ProposedMove[]) =>
        request<RoutingApplied>(
          "/routing/rerun/apply",
          json("POST", { workspace: workspaceId, moves }),
        ),
      /** Enqueues the route Job for one Thread. */
      route: (workspaceId: Id, threadId: Id) =>
        request<{ jobId: Id }>(
          `/threads/${encodeURIComponent(threadId)}/route`,
          json("POST", { workspace: workspaceId }),
        ),
      /** Where routing put a Thread and how sure it was, or null when never routed. */
      routeOf: async (threadId: Id): Promise<ThreadRoute | null> => {
        try {
          return await request<ThreadRoute>(`/threads/${encodeURIComponent(threadId)}/route`);
        } catch (error) {
          if (error instanceof ApiError && error.status === 404) return null;
          throw error;
        }
      },
    },
    settings: {
      /** Global and per-Device buckets; device wins for device-scoped keys. */
      all: () =>
        request<{ global: Record<string, unknown>; device: Record<string, unknown> }>("/settings"),
      set: (key: string, value: unknown, scope: "global" | "device" = "global") =>
        request<unknown>(`/settings/${encodeURIComponent(key)}`, json("PUT", { value, scope })),
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

/* ------------------------------ Upgrade shapes (ADR 0008) ------------------------------ */

export interface ExportResult {
  path: string;
  bytes: number;
  at: string;
}

export interface CopyResult {
  tables: Array<{ name: string; rows: number }>;
  elapsedMs: number;
}

export interface UpgradeStatus {
  mode: DeploymentMode;
  canExport: boolean;
  lastExport: ExportResult | null;
  attachedHost: string | null;
  restartRequired: boolean;
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
