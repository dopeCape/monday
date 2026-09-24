// The external MCP module (docs/spec/external-mcp.md, slice 19): the second
// transport on the Agent host seam (ADR 0009). It authenticates a credential
// (a Key or an OAuth token, never a Device token: ADR 0006), builds the MCP
// server for it with the scope filter and the credential name as actor,
// enforces the per-credential rate limit and the search cap, and routes the
// approvals of always-ask tools to the owner.
//
// Where an external approval lives: each credential gets one Session per
// Workspace, titled after it, on the composer's default Runtime. The card
// is appended to that Session and published on its live feed, so the
// owner's client renders and answers it with the ordinary approval route,
// the history lists the caller by name, and every card of one caller stays
// in one transcript. A well-known Session shared by every caller would mix
// callers and could never be opened as "what did my assistant do".
//
// The external call blocks until the card is answered or the Setting's
// timeout passes; then it returns a pending status the caller polls. While
// it waits, the owner's open client learns of the card through the
// Workspace's external feed; when nothing is subscribed to that feed, a
// desktop notification is requested through the notify seam.

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  AgentEvent,
  ApprovalDecision,
  ExternalCredential,
  ExternalKeyCreated,
  ExternalPending,
} from "@monday/shared";
import {
  type AgentHost,
  createMondayMcpServer,
  type McpServer,
} from "../intelligence/agent/index.ts";
import type { ExternalSeam } from "../intelligence/agent/tools/extensions.ts";
import {
  type CredentialStore,
  credentialLive,
  credentialReaches,
  keyInputDefaults,
  mintKey,
} from "./credentials.ts";
import type { Notifier } from "./notify.ts";
import { createOAuthServer, type OAuthServer } from "./oauth.ts";

export * from "./credentials.ts";
export * from "./notify.ts";
export * from "./oauth.ts";

export interface ExternalSettings {
  ratePerMinute: number;
  searchCap: number;
  approvalTimeoutMs: number;
  keyExpiryDays: number;
  /** How long a consent page waits for the owner. */
  consentTtlMs: number;
}

export interface ExternalOptions {
  agent: AgentHost;
  store: CredentialStore;
  settings(): Promise<ExternalSettings>;
  notify: Notifier;
  now?: () => Date;
  /** The Workspaces of this Server, for the consent page and the key form. */
  workspaces?: (() => Promise<Array<{ id: string; address: string }>>) | undefined;
}

export type AuthFailure = "missing" | "unknown" | "revoked" | "expired";

export interface External extends ExternalSeam {
  /** The credential a bearer names, or why not. */
  authenticate(
    bearer: string | null,
  ): Promise<{ ok: true; credential: ExternalCredential } | { ok: false; reason: AuthFailure }>;
  reaches(credential: Pick<ExternalCredential, "workspaceIds">, workspaceId: string): boolean;
  /** False once the credential is over its calls per minute. */
  admit(credentialId: string): Promise<boolean>;
  /** The Workspaces of this Server the credential reaches, for a caller that names none. */
  workspacesFor(
    credential: Pick<ExternalCredential, "workspaceIds">,
  ): Promise<Array<{ id: string; address: string }>>;
  /** The MCP server for one credential in one Workspace. */
  mcpServer(credential: ExternalCredential, workspaceId: string): Promise<McpServer>;
  listCredentials(): Promise<ExternalCredential[]>;
  /** The calls of this Workspace parked on an approval, for the owner's client. */
  pending(workspaceId: string): Promise<ExternalPending[]>;
  /** One parked call by its Activity row, for the caller's poll; null when it never was external. */
  pendingOne(activityId: string): Promise<ExternalPending | null>;
  /** Answers a parked call from the owner's client. */
  decide(activityId: string, decision: ApprovalDecision): Promise<ExternalPending | null>;
  /** The Workspace's external feed: the cards of external calls as they move. */
  live(workspaceId: string, listener: (pending: ExternalPending) => void): () => void;
  oauth: OAuthServer;
}

/** How often a credential's last use is written. */
export const LAST_USE_RESOLUTION_MS = 60_000;

/** The title an external credential's Session carries, so the history names the caller. */
export function externalSessionTitle(name: string): string {
  return `${name} (external)`;
}

/** What the caller reads while its call waits for the owner. */
export function pendingResult(pending: ExternalPending): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: `Pending: "${pending.tool}" waits for the owner's approval in monday. Poll GET /mcp/pending/${pending.activityId} with the same credential; the result appears there once decided.`,
      },
    ],
    _meta: { pending: true, activityId: pending.activityId, status: pending.status },
  };
}

export function createExternal(options: ExternalOptions): External {
  const { agent, store } = options;
  const now = options.now ?? (() => new Date());
  const oauth = createOAuthServer({
    store,
    now,
    settings: async () => {
      const s = await options.settings();
      return { tokenExpiryDays: s.keyExpiryDays, consentTtlMs: s.consentTtlMs };
    },
  });
  /** Call timestamps per credential inside the last minute. */
  const windows = new Map<string, number[]>();
  /** Every external call by Activity row: whose it was and where its card lives. */
  const calls = new Map<
    string,
    { workspaceId: string; credential: ExternalCredential; sessionId: string; callId: string }
  >();
  const listeners = new Map<string, Set<(p: ExternalPending) => void>>();
  /** The Session per credential and Workspace, once found or made. */
  const sessionIds = new Map<string, string>();

  const publish = (p: ExternalPending) => {
    for (const l of listeners.get(p.workspaceId) ?? []) l(p);
  };

  const pendingOf = (
    event: Extract<AgentEvent, { kind: "tool" }>,
    meta: { workspaceId: string; credential: ExternalCredential; sessionId: string },
  ): ExternalPending => ({
    activityId: event.call.id,
    workspaceId: meta.workspaceId,
    credentialId: meta.credential.id,
    credentialName: meta.credential.name,
    tool: event.call.tool,
    inputSummary: event.call.inputSummary,
    status: event.call.status,
    text: event.call.result ?? null,
    sessionId: meta.sessionId,
    at: now().toISOString(),
  });

  const sessionFor = async (credential: ExternalCredential, workspaceId: string) => {
    const key = `${credential.id}:${workspaceId}`;
    const cached = sessionIds.get(key);
    if (cached) return cached;
    const title = externalSessionTitle(credential.name);
    const existing = (await agent.listSessions(workspaceId)).find((s) => s.title === title);
    const session = existing ?? (await agent.createSession(workspaceId));
    if (!existing) {
      // The title is what the history shows; the first event names the caller.
      await agent.appendEvent(session.id, {
        kind: "user",
        id: crypto.randomUUID(),
        text: title,
      });
    }
    sessionIds.set(key, session.id);
    return session.id;
  };

  const fromRow = async (activityId: string): Promise<ExternalPending | null> => {
    const meta = calls.get(activityId);
    if (!meta) return null;
    const row = await agent.activityRecord(activityId);
    if (!row || row.sessionId !== meta.sessionId) return null;
    return {
      activityId,
      workspaceId: meta.workspaceId,
      credentialId: meta.credential.id,
      credentialName: meta.credential.name,
      tool: row.tool,
      inputSummary: row.inputSummary,
      status: row.status,
      text: row.result ?? null,
      sessionId: meta.sessionId,
      at: row.at,
    };
  };

  const external: External = {
    oauth,

    async authenticate(bearer) {
      if (!bearer) return { ok: false, reason: "missing" };
      const credential = await store.findBySecret(bearer);
      if (!credential) return { ok: false, reason: "unknown" };
      if (credential.revokedAt) return { ok: false, reason: "revoked" };
      if (!credentialLive(credential, now())) return { ok: false, reason: "expired" };
      // Last use is a minute's resolution: one write per credential per minute, not one per call.
      const lastUsed = credential.lastUsedAt ? Date.parse(credential.lastUsedAt) : 0;
      if (now().getTime() - lastUsed >= LAST_USE_RESOLUTION_MS) await store.touch(credential.id);
      return { ok: true, credential: { ...credential, lastUsedAt: now().toISOString() } };
    },

    reaches: credentialReaches,

    async admit(credentialId) {
      const { ratePerMinute } = await options.settings();
      const t = now().getTime();
      const recent = (windows.get(credentialId) ?? []).filter((at) => t - at < 60_000);
      if (recent.length >= ratePerMinute) {
        windows.set(credentialId, recent);
        return false;
      }
      recent.push(t);
      windows.set(credentialId, recent);
      return true;
    },

    async workspacesFor(credential) {
      const all = (await options.workspaces?.()) ?? [];
      return all.filter((w) => credentialReaches(credential, w.id));
    },

    async mcpServer(credential, workspaceId) {
      const settings = await options.settings();
      const sessionId = await sessionFor(credential, workspaceId);
      const actor = { kind: "external" as const, name: credential.name };
      return createMondayMcpServer(agent, {
        workspaceId,
        sessionId,
        scope: credential.scope,
        actor,
        searchLimit: settings.searchCap,
        around: async (run) => {
          const callId = crypto.randomUUID();
          let waiting: ExternalPending | null = null;
          let notified = false;
          const stop = agent.live(sessionId, (event) => {
            if (event.kind !== "tool" || event.call.tool === "undo") return;
            const p = pendingOf(event, { workspaceId, credential, sessionId });
            if (event.call.status === "waiting") {
              waiting = p;
              calls.set(p.activityId, { workspaceId, credential, sessionId, callId });
              if (!notified) {
                notified = true;
                const open = (listeners.get(workspaceId)?.size ?? 0) > 0;
                if (!open) {
                  void options.notify
                    .notify({
                      workspaceId,
                      title: `${credential.name} asks for an approval`,
                      body: `${event.call.tool.replaceAll("_", " ")}: ${event.call.inputSummary}`,
                      activityId: p.activityId,
                      sessionId,
                    })
                    .catch(() => {});
                }
              }
            }
            // Only cards that asked reach the feed: a silent read is nobody's business but the log's.
            if (calls.has(p.activityId)) publish(p);
          });
          let timer: ReturnType<typeof setTimeout> | null = null;
          const timeout = new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), settings.approvalTimeoutMs);
          });
          // Exactly one run: the promise outlives the timeout, so a late decision still applies.
          const promise = run();
          const settle = () => {
            if (timer) clearTimeout(timer);
            stop();
          };
          void promise.then(settle, settle);
          const result = await Promise.race([promise, timeout]);
          if (result !== "timeout") return result;
          // Nothing asked yet: the tool itself is slow. Wait it out.
          if (!waiting) return promise;
          return pendingResult(waiting);
        },
      });
    },

    listCredentials: () => store.list(),

    async createKey(input) {
      const settings = await options.settings();
      const secret = mintKey();
      const { expiresAt } = keyInputDefaults(input, settings.keyExpiryDays, now());
      const credential = await store.insert({
        kind: "key",
        name: input.name,
        scope: input.scope,
        workspaceIds: input.workspaceIds,
        secret,
        expiresAt,
      });
      return { credential, secret } satisfies ExternalKeyCreated;
    },

    revoke: (id) => store.revoke(id),

    async pending(workspaceId) {
      const out: ExternalPending[] = [];
      for (const [id, meta] of calls) {
        if (meta.workspaceId !== workspaceId) continue;
        const p = await fromRow(id);
        if (p?.status === "waiting") out.push(p);
      }
      return out;
    },

    pendingOne: fromRow,

    async decide(activityId, decision) {
      const meta = calls.get(activityId);
      if (!meta) return null;
      await agent.resume(meta.sessionId, activityId, decision, {}, () => {});
      return fromRow(activityId);
    },

    live(workspaceId, listener) {
      const set = listeners.get(workspaceId) ?? new Set();
      set.add(listener);
      listeners.set(workspaceId, set);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(workspaceId);
      };
    },
  };
  return external;
}
