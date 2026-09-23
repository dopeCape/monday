// HTTP client for the Server (ADR 0006). One base URL and one token; the Sidecar on
// loopback when it runs, the Cloud URL otherwise. Typed routes arrive with the generated
// client in packages/shared; until then this is the minimal fetch wrapper.

import type {
  AccountCapabilities,
  ActivityRecord,
  AgentEvent,
  ApprovalDecision,
  Brief,
  BriefTrigger,
  Calendar,
  CalendarEvent,
  CalendarInfo,
  Capabilities,
  ChangesPage,
  CorrectionResult,
  DeploymentMode,
  Device,
  Draft,
  DraftContent,
  DraftIntent,
  DryRunPreview,
  EventInput,
  EventPatch,
  ExternalConsent,
  ExternalCredential,
  ExternalKeyCreated,
  ExternalKeyInput,
  ExternalPending,
  FirstSyncProgress,
  GroupInput,
  GroupView,
  HeaderSearchPage,
  Id,
  Intent,
  IntentReading,
  IntentRequest,
  IntentResult,
  Invite,
  InviteIntent,
  KeyProvider,
  KeyValidation,
  MessageBodiesPage,
  MeterMonth,
  ProposedMove,
  Provider,
  RoutingApplied,
  RoutingDecision,
  RoutingPreview,
  Runtime,
  RunView,
  ScheduledSend,
  ScheduleResult,
  SessionSummary,
  ThreadRoute,
  TurnContext,
  VoiceProfile,
  WorkflowInput,
  WorkflowInputRaw,
  WorkflowView,
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

/** One Thread's judged Sections and custom actions, as POST /sections/judgments returns them (slice 26). */
export interface SectionJudgmentView {
  threadId: Id;
  /** Probability per rule id: a Section's judge statement or a custom action's. */
  rules: Record<string, number>;
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
  /**
   * Whether this is the Message's body or the empty stand-in a header-only
   * sync keeps (the Provider has not handed it over yet). Absent from older
   * Servers, which never said; only a fetched body belongs in the Cache.
   */
  bodyState?: "pending" | "fetched" | "deferred";
  display: { html: string; quoted: boolean; blockedImages: number };
}

export interface BlobState {
  id: Id;
  chunkSize: number;
  chunkCount: number;
  received: number;
  complete: boolean;
}

/**
 * Reads a text/event-stream body and hands each `data:` payload to `onEvent`
 * as it arrives. fetch, not EventSource, because the Device token rides in a
 * header and the turn is a POST.
 */
export async function readEvents(
  res: Response,
  onEvent: (event: AgentEvent) => void,
): Promise<void> {
  const body = res.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const flush = (chunk: string) => {
    buffer += chunk;
    let at = buffer.indexOf("\n\n");
    while (at >= 0) {
      const block = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      const data = block
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .join("\n");
      if (data) {
        try {
          onEvent(JSON.parse(data) as AgentEvent);
        } catch {
          // A malformed frame is dropped; the next one stands on its own.
        }
      }
      at = buffer.indexOf("\n\n");
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    flush(decoder.decode(value, { stream: true }));
  }
  flush(decoder.decode());
  if (buffer.trim()) flush("\n\n");
}

export interface ApiOptions {
  /** A request to this target got no answer at all; the Shell's picker moves to the other one. */
  onUnreachable?: ((target: ServerTarget) => void) | undefined;
  /** The fetch underneath; the browser's by default, a Server's handler in a test. */
  fetch?: ((url: string, init?: RequestInit) => Promise<Response>) | undefined;
}

export function createApi(target: () => ServerTarget | null, options: ApiOptions = {}) {
  const fetchImpl = options.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init));
  async function raw(path: string, init: RequestInit = {}): Promise<Response> {
    const t = target();
    if (!t) throw new ApiError(0, "No server configured");
    let res: Response;
    try {
      res = await fetchImpl(t.baseUrl + path, {
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
      /** Which providers hold a shared key; TypeSafe among them (ADR 0012). */
      shared: () => request<{ shared: KeyProvider[] }>("/keys"),
      /** Sends a key to the Server, stored under the envelope of `workspaceId`. 423 when locked. */
      share: (workspaceId: Id, provider: KeyProvider, key: string) =>
        request<{ provider: KeyProvider; shared: boolean }>(
          `/keys/${provider}`,
          json("PUT", { workspace: workspaceId, key }),
        ),
      /** Forgets the shared key; the Device copy in the keychain is untouched. */
      unshare: (provider: KeyProvider) =>
        raw(`/keys/${provider}`, { method: "DELETE" }).then(() => undefined),
      /**
       * The live check of a pasted key, run by the Server so this Device never
       * talks to the provider (slice 24). Answers in plain words; stores nothing.
       * 404 when the provider has no check.
       */
      validate: (provider: KeyProvider, key: string) =>
        request<KeyValidation>(`/keys/${provider}/validate`, json("POST", { key })),
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
    judge: {
      /**
       * The palette's typed sentence as one Judgment (slice 27): the reading
       * the Device assembles into an intent, or null when no judge answers
       * (409 no_judge or ai_off), so the palette behaves as before.
       */
      intent: async (body: IntentRequest): Promise<IntentReading | null> => {
        try {
          return await request<IntentReading>("/judge/intent", json("POST", body));
        } catch (error) {
          if (error instanceof ApiError && error.status === 409) return null;
          throw error;
        }
      },
    },
    devices: {
      list: () => request<Device[]>("/devices"),
      /** The caller: this Device's id, or the Sidecar's fixed one. */
      me: () => request<DeviceMe>("/devices/me"),
      /** Pairing codes other Devices are showing and waiting on, plus whether the setup code still applies. */
      pending: () => request<PendingPairings>("/devices/pending"),
      revoke: (id: Id) => raw(`/devices/${encodeURIComponent(id)}`, { method: "DELETE" }),
      /** Approves a pairing code another Device is showing (ADR 0006). */
      confirm: (code: string) => request<{ ok: boolean }>("/pair/confirm", json("POST", { code })),
    },
    /** What the Server holds: message count and database size, for the Storage line. */
    storage: () => request<StorageInfo>("/storage"),
    /** External access (slice 19, docs/spec/external-mcp.md): keys, OAuth consents, parked approvals. */
    external: {
      credentials: () =>
        request<{ credentials: ExternalCredential[] }>("/external/credentials").then(
          (r) => r.credentials,
        ),
      /** Makes a key; the secret in the answer is shown once and never listed again. */
      createKey: (input: ExternalKeyInput) =>
        request<ExternalKeyCreated>("/external/credentials", json("POST", input)),
      revoke: (id: Id) =>
        raw(`/external/credentials/${encodeURIComponent(id)}`, { method: "DELETE" }).then(
          () => undefined,
        ),
      /** External calls of the Workspace parked on an approval. */
      pending: (workspaceId: Id) =>
        request<{ pending: ExternalPending[] }>(
          `/external/pending?${new URLSearchParams({ workspace: workspaceId })}`,
        ).then((r) => r.pending),
      decide: (activityId: Id, decision: ApprovalDecision) =>
        request<ExternalPending>(
          `/external/pending/${encodeURIComponent(activityId)}`,
          json("POST", { decision }),
        ),
      /**
       * The Workspace's external feed: the cards of external calls as they move.
       * Subscribed while a client is open, which is how the Server knows one is. Returns the unsubscribe.
       */
      live: (workspaceId: Id, onPending: (pending: ExternalPending) => void): (() => void) => {
        const controller = new AbortController();
        void raw(`/external/live?${new URLSearchParams({ workspace: workspaceId })}`, {
          signal: controller.signal,
        })
          .then((res) => readEvents(res, (event) => onPending(event as unknown as ExternalPending)))
          .catch(() => {
            // Aborted by the unsubscribe, or the Server went away.
          });
        return () => controller.abort();
      },
      consents: () =>
        request<{ consents: ExternalConsent[] }>("/external/consents").then((r) => r.consents),
      /** Approves an OAuth consent by its id from the list, or by the code the sign-in page shows. */
      approveConsent: (ref: { id: Id } | { code: string }, workspaceIds: Id[] | null = null) =>
        request<ExternalConsent>(
          "/external/consents/approve",
          json("POST", { ...ref, workspaceIds }),
        ),
      denyConsent: (id: Id) =>
        raw(`/external/consents/${encodeURIComponent(id)}/deny`, { method: "POST" }).then(
          () => undefined,
        ),
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
      /**
       * The judged Sections and custom actions per Thread (slice 26): the
       * cached answers, plus the Judge's for what was missing when it is
       * available. Threads the conditions settle alone are left out.
       */
      sectionJudgments: (workspaceId: Id, threadIds: readonly Id[]) =>
        request<{ judgments: SectionJudgmentView[] }>(
          "/sections/judgments",
          json("POST", { workspace: workspaceId, threads: threadIds }),
        ).then((r) => r.judgments),
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
    /** Workflows (slice 16, ADR 0003): documents, versions, Runs, approvals, Dry runs. */
    workflows: {
      list: (workspaceId: Id) =>
        request<{ workflows: WorkflowView[] }>(
          `/workflows?${new URLSearchParams({ workspace: workspaceId })}`,
        ).then((r) => r.workflows),
      get: (workflowId: Id) =>
        request<WorkflowView>(`/workflows/${encodeURIComponent(workflowId)}`),
      create: (workspaceId: Id, input: WorkflowInputRaw) =>
        request<WorkflowView>("/workflows", json("POST", { workspace: workspaceId, ...input })),
      /** A new version; Runs keep the one they ran under. */
      update: (workflowId: Id, input: WorkflowInputRaw) =>
        request<WorkflowView>(`/workflows/${encodeURIComponent(workflowId)}`, json("PUT", input)),
      remove: (workflowId: Id) =>
        raw(`/workflows/${encodeURIComponent(workflowId)}`, { method: "DELETE" }).then(
          () => undefined,
        ),
      enable: (workflowId: Id, enabled: boolean) =>
        request<WorkflowView>(
          `/workflows/${encodeURIComponent(workflowId)}/enable`,
          json("POST", { enabled }),
        ),
      version: (workflowId: Id, version: number) =>
        request<{ version: number; document: WorkflowInput }>(
          `/workflows/${encodeURIComponent(workflowId)}/versions/${version}`,
        ),
      /** Over the last N matching Threads; nothing is applied. */
      dryRun: (workflowId: Id, recent?: number) =>
        request<DryRunPreview>(
          `/workflows/${encodeURIComponent(workflowId)}/dry-run`,
          json("POST", recent ? { recent } : {}),
        ),
      /** A manual Run, on a Thread when the Workflow is about one. */
      run: (workflowId: Id, threadId: Id | null = null) =>
        request<RunView>(
          `/workflows/${encodeURIComponent(workflowId)}/run`,
          json("POST", { threadId }),
        ),
      /** Grants or revokes a Standing approval on one Step. */
      standing: (workflowId: Id, step: string, granted: boolean) =>
        request<WorkflowView>(
          `/workflows/${encodeURIComponent(workflowId)}/approvals`,
          json("POST", { step, granted }),
        ),
      runs: (workspaceId: Id, options: { workflowId?: Id; status?: RunView["status"] } = {}) =>
        request<{ runs: RunView[] }>(
          `/workflows/runs?${new URLSearchParams({
            workspace: workspaceId,
            ...(options.workflowId ? { workflow: options.workflowId } : {}),
            ...(options.status ? { status: options.status } : {}),
          })}`,
        ).then((r) => r.runs),
      runOf: (runId: Id) => request<RunView>(`/workflows/runs/${encodeURIComponent(runId)}`),
      /** The Activity rows a Run's Steps wrote, oldest first; the waiting one carries the card's preview. */
      runActivity: (runId: Id) =>
        request<{ activity: ActivityRecord[] }>(
          `/workflows/runs/${encodeURIComponent(runId)}/activity`,
        ).then((r) => r.activity),
      /** Answers a paused Run; `standing` also grants a Standing approval on that Step. */
      decide: (runId: Id, decision: ApprovalDecision, standing = false) =>
        request<RunView>(
          `/workflows/runs/${encodeURIComponent(runId)}/approvals`,
          json("POST", { decision, standing }),
        ),
    },
    /** The calendar (slice 18): calendars, Events in a window, the content batch, Invites and the RSVP intent. */
    calendar: {
      info: (workspaceId: Id) =>
        request<CalendarInfo>(`/calendar/info?${new URLSearchParams({ workspace: workspaceId })}`),
      calendars: (workspaceId: Id) =>
        request<{ calendars: Calendar[] }>(
          `/calendars?${new URLSearchParams({ workspace: workspaceId })}`,
        ).then((r) => r.calendars),
      setVisible: (calendarId: Id, visible: boolean) =>
        request<Calendar>(
          `/calendars/${encodeURIComponent(calendarId)}/visible`,
          json("PUT", { visible }),
        ),
      linkCalDav: (accountId: Id, link: { url: string; user: string; password: string } | null) =>
        request<CalendarInfo>(
          `/accounts/${encodeURIComponent(accountId)}/caldav`,
          json("PUT", link),
        ),
      events: (workspaceId: Id, from: string, to: string) =>
        request<{ events: CalendarEvent[] }>(
          `/calendar/events?${new URLSearchParams({ workspace: workspaceId, from, to })}`,
        ).then((r) => r.events),
      eventsContent: (workspaceId: Id, ids: readonly Id[]) =>
        request<{
          events: Array<{ id: Id; title: string; description: string; location: string }>;
        }>("/calendar/events/content", json("POST", { workspace: workspaceId, ids })).then(
          (r) => r.events,
        ),
      event: (eventId: Id) =>
        request<CalendarEvent>(`/calendar/events/${encodeURIComponent(eventId)}`),
      create: (workspaceId: Id, input: EventInput) =>
        request<CalendarEvent>(
          "/calendar/events",
          json("POST", { workspace: workspaceId, ...input }),
        ),
      update: (eventId: Id, patch: EventPatch) =>
        request<CalendarEvent>(
          `/calendar/events/${encodeURIComponent(eventId)}`,
          json("PUT", patch),
        ),
      remove: (eventId: Id) =>
        raw(`/calendar/events/${encodeURIComponent(eventId)}`, { method: "DELETE" }).then(
          () => undefined,
        ),
      respond: (eventId: Id, response: "accepted" | "tentative" | "declined") =>
        request<CalendarEvent>(
          `/calendar/events/${encodeURIComponent(eventId)}/respond`,
          json("POST", { response }),
        ),
      invite: async (inviteId: Id): Promise<Invite | null> => {
        try {
          return await request<Invite>(`/invites/${encodeURIComponent(inviteId)}`);
        } catch (error) {
          if (error instanceof ApiError && error.status === 404) return null;
          throw error;
        }
      },
      invitesOf: (threadId: Id) =>
        request<{ invites: Invite[] }>(`/threads/${encodeURIComponent(threadId)}/invites`).then(
          (r) => r.invites,
        ),
      rsvp: (intent: InviteIntent) =>
        request<IntentResult>(
          `/invites/${encodeURIComponent(intent.inviteId)}/rsvp`,
          json("POST", { at: intent.at, actor: intent.actor, response: intent.response }),
        ),
    },
    /** The Agent host (ADR 0002): Sessions, turns streamed over SSE, approvals, the Activity log. */
    agent: {
      sessions: (workspaceId: Id) =>
        request<{ sessions: SessionSummary[] }>(
          `/sessions?${new URLSearchParams({ workspace: workspaceId })}`,
        ),
      /** A Session on the Hosted runtime, or on the Local runtime this Device names. */
      createSession: (workspaceId: Id, runtime?: Runtime) =>
        request<SessionSummary>(
          "/sessions",
          json("POST", { workspace: workspaceId, ...(runtime ? { runtime } : {}) }),
        ),
      /** Moves a Session to another Runtime; the line the thread shows comes back. */
      switchRuntime: (sessionId: Id, runtime: Runtime) =>
        request<AgentEvent>(
          `/sessions/${encodeURIComponent(sessionId)}/runtime`,
          json("PATCH", { runtime }),
        ),
      /** What a Local runtime's CLI said, persisted in the Session's transcript. */
      appendEvent: (sessionId: Id, event: AgentEvent) =>
        request<{ ok: boolean }>(
          `/sessions/${encodeURIComponent(sessionId)}/events`,
          json("POST", { event }),
        ).then(() => undefined),
      /**
       * The Server's own events for a Session as they happen (the tool cards
       * of a Local runtime's MCP calls). Returns the unsubscribe.
       */
      live: (sessionId: Id, onEvent: (event: AgentEvent) => void): (() => void) => {
        const controller = new AbortController();
        void raw(`/sessions/${encodeURIComponent(sessionId)}/live`, {
          signal: controller.signal,
        })
          .then((res) => readEvents(res, onEvent))
          .catch(() => {
            // Aborted by the unsubscribe, or the Server went away; the next turn reconnects.
          });
        return () => controller.abort();
      },
      session: (sessionId: Id) =>
        request<{ session: SessionSummary; events: AgentEvent[] }>(
          `/sessions/${encodeURIComponent(sessionId)}`,
        ),
      /** Sends a turn and yields its events as they stream; resolves when the turn ends or pauses. */
      turn: async (
        sessionId: Id,
        text: string,
        context: TurnContext,
        onEvent: (event: AgentEvent) => void,
      ) => {
        const res = await raw(`/sessions/${encodeURIComponent(sessionId)}/turns`, {
          ...json("POST", { text, context }),
          headers: { "content-type": "application/json" },
        });
        await readEvents(res, onEvent);
      },
      approve: async (
        sessionId: Id,
        activityId: Id,
        decision: ApprovalDecision,
        context: TurnContext,
        onEvent: (event: AgentEvent) => void,
      ) => {
        const res = await raw(
          `/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(activityId)}`,
          {
            ...json("POST", { decision, context }),
            headers: { "content-type": "application/json" },
          },
        );
        await readEvents(res, onEvent);
      },
      activity: (workspaceId: Id, limit = 100) =>
        request<{ activity: ActivityRecord[] }>(
          `/activity?${new URLSearchParams({ workspace: workspaceId, limit: String(limit) })}`,
        ),
      undo: (activityId: Id, sessionId: Id | null) =>
        request<ActivityRecord>(
          `/activity/${encodeURIComponent(activityId)}/undo`,
          json("POST", sessionId ? { session: sessionId } : {}),
        ),
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
      /** The first sync's progress (docs/spec/onboarding.md, "First sync"). */
      sync: (id: string) =>
        request<{ progress: FirstSyncProgress }>(`/accounts/${encodeURIComponent(id)}/sync`),
      /** Clears the last failure and asks for a pass now. */
      retrySync: async (id: string): Promise<void> => {
        await raw(`/accounts/${encodeURIComponent(id)}/sync`, { method: "POST" });
      },
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
      /** The provider's saved sign-in app, app level; null when none is set up. */
      app: (provider: OAuthProvider) =>
        request<{ app: OAuthAppView | null }>(`/oauth/${provider}/app`),
      /** Checks the registration live and saves it only when it passes. */
      saveApp: (provider: OAuthProvider, body: OAuthAppBody) =>
        request<{ result: ValidationResult; app: OAuthAppView | null }>(`/oauth/${provider}/app`, {
          method: "PUT",
          body: JSON.stringify(body),
        }),
      /** The extras a later wizard step fills in (the Pub/Sub topic, the project id). */
      updateApp: (
        provider: OAuthProvider,
        patch: { projectId?: string | null; pubsubTopic?: string | null },
      ) =>
        request<{ app: OAuthAppView }>(`/oauth/${provider}/app`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        }),
      removeApp: (provider: OAuthProvider) =>
        request<unknown>(`/oauth/${provider}/app`, { method: "DELETE" }),
    },
  };
}

/* ------------------------------ Devices and storage (ADR 0006) ------------------------------ */

export interface DeviceMe {
  id: Id;
  kind: "device" | "sidecar";
}

export interface PendingPairing {
  code: string;
  name: string;
  expiresAt: string;
}

export interface PendingPairings {
  pending: PendingPairing[];
  /** The one-time setup code would still be accepted: no Device has paired yet. */
  setupAvailable: boolean;
}

export interface StorageInfo {
  messages: number;
  bytes: number;
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

/** The saved sign-in app of a provider, app level; the secret is never sent back, only whether one is kept. */
export interface OAuthAppView {
  provider: OAuthProvider;
  clientId: string;
  hasSecret: boolean;
  tenant: string | null;
  accountType: "personal" | "work" | null;
  projectId: string | null;
  pubsubTopic: string | null;
  updatedAt: string;
}

export interface OAuthAppBody {
  clientId: string;
  clientSecret?: string | null;
  tenant?: string | null;
  accountType?: "personal" | "work" | null;
  projectId?: string | null;
  pubsubTopic?: string | null;
}

export interface OAuthStartBody {
  /** Absent: the Server signs in through the saved app. */
  clientId?: string;
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
