// The Hono app: a runtime-neutral fetch handler. No Bun, Node or platform API
// here; the entry under entry/ supplies the database, the loopback test and
// the process-level pieces (research 22, section 2.1).

import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { DeploymentMode } from "@monday/shared";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import type { Auth } from "./auth/index.ts";
import {
  type AppEnv,
  authenticate,
  isLoopbackAddress,
  type LoopbackCheck,
  PUBLIC_PATHS,
  PUBLIC_PREFIXES,
  requireAuth,
} from "./auth/middleware.ts";
import { capabilitiesFor } from "./capabilities.ts";
import { type ChangeBus, createChangeBus } from "./changes/bus.ts";
import { DecryptError } from "./crypto/aead.ts";
import { createKeys, type Keys, LockedError } from "./crypto/keys.ts";
import type { Db } from "./db/client.ts";
import { accounts, type BodyState, syncMessages, threads, workspaces } from "./db/schema.ts";
import {
  createDrafts,
  DraftNotOpenError,
  type Drafts,
  NoRecipientsError,
  SendTooLargeError,
} from "./drafts/index.ts";
import {
  createCredentialStore,
  createExternal,
  createMemoryNotifier,
  type External,
  type Notifier,
} from "./external/index.ts";
import { currentTopology, HEARTBEAT_STALE_MS } from "./heartbeat.ts";
import {
  AiOffError,
  BriefNotReadyError,
  BriefOutputError,
  ClassifyOutputError,
  createIntelligence,
  GroupNestingError,
  type Intelligence,
  NoProviderKeyError,
  RunNotWaitingError,
  SessionNotFoundError,
  TurnBusyError,
  WorkflowNotFoundError,
} from "./intelligence/index.ts";
import type { Jobs } from "./jobs/index.ts";
import { createMailstore, type Mailstore, NotFoundError } from "./mailstore/index.ts";
import type { PushManager } from "./providers/push.ts";
import type { SyncEngine } from "./providers/sync.ts";
import { type AccountRoutesOptions, accountRoutes } from "./routes/accounts.ts";
import { agentRoutes } from "./routes/agent.ts";
import { changesRoutes } from "./routes/changes.ts";
import { devicesRoutes } from "./routes/devices.ts";
import { draftsRoutes } from "./routes/drafts.ts";
import {
  EXTERNAL_PUBLIC_PATHS,
  EXTERNAL_PUBLIC_PREFIXES,
  externalRoutes,
} from "./routes/external.ts";
import { intelligenceRoutes } from "./routes/intelligence.ts";
import { mailRoutes } from "./routes/mail.ts";
import { type OAuthRoutesOptions, oauthRoutes } from "./routes/oauth.ts";
import { pairRoutes } from "./routes/pair.ts";
import { routingRoutes } from "./routes/routing.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { storageRoutes } from "./routes/storage.ts";
import { unlockRoutes } from "./routes/unlock.ts";
import { webhookRoutes } from "./routes/webhooks.ts";
import { workflowRoutes } from "./routes/workflows.ts";
import { readGlobalSettings } from "./settings/read.ts";

export type { AppEnv } from "./auth/middleware.ts";

const EXTERNAL_SETTING_KEYS = [
  "external.rate_per_minute",
  "external.search_cap",
  "external.approval_timeout_minutes",
  "external.key_expiry_days",
  "external.consent_timeout_minutes",
] as const;

const CONSENT_STRING_KEYS = [
  "strings.external.consent.title",
  "strings.external.consent.intro",
  "strings.external.scope.read",
  "strings.external.scope.act",
  "strings.external.consent.code_hint",
  "strings.external.consent.waiting",
  "strings.external.consent.deny",
  "strings.external.consent.approved",
  "strings.external.consent.denied",
  "strings.external.consent.expired",
] as const;

export interface AppOptions {
  db: Db;
  auth: Auth;
  mode: DeploymentMode;
  /** The key holder; the entry creates it so it can unlock at boot. Defaults to a locked one. */
  keys?: Keys;
  /** Defaults to a Mailstore over `db` and `keys`. Tests substitute fakes here. */
  mailstore?: Mailstore;
  /** The Jobs table, so a send schedules its Job (ADR 0010). Absent in tests that never send. */
  jobs?: Jobs;
  /** The sync engine, for Provider Sessions (mirror, send) and body states. */
  sync?: SyncEngine;
  /** Defaults to a Drafts module over `db`, `mailstore`, `jobs` and `sync`. */
  drafts?: Drafts;
  /**
   * The Hosted runtime, shared keys, Meter and Briefs (ADR 0007). Defaults to
   * one over `db` and `mailstore` with LangChain underneath; tests pass one
   * built on the fake seam.
   */
  intelligence?: Intelligence;
  /** LangGraph's checkpointer for the Agent host's paused turns; the entry passes PostgresSaver. */
  checkpointer?: BaseCheckpointSaver;
  /**
   * The in-process wake bus for the Changes feed. The entry feeds it from a
   * LISTEN connection and shares it with the WebSocket transport; defaults to a
   * bus nobody feeds, which leaves SSE on its poll fallback.
   */
  changes?: ChangeBus;
  /** SSE keepalive and poll intervals, for tests. */
  sse?: { heartbeatMs?: number; pollMs?: number };
  /** Peer address of a request, when the runtime can tell. Defaults to "unknown". */
  remoteAddress?: (c: Parameters<LoopbackCheck>[0]) => string | null | undefined;
  /** Milliseconds since the process started, for /health. */
  uptimeMs?: () => number;
  /** The Accounts routes; absent in tests that do not need them. */
  accounts?: AccountRoutesOptions;
  /** The OAuth wizard routes; needs `accounts`. */
  oauth?: Omit<OAuthRoutesOptions, "accounts">;
  /** Provider push webhooks (public paths, verified by their own secrets). */
  push?: PushManager;
  /**
   * This Server's heartbeat id, so /capabilities can report the topology
   * (Sidecar only, Cloud, both) from the fresh heartbeats. Absent, the Server
   * reports itself alone.
   */
  serverId?: string;
  /** The stale window for heartbeats, in ms; defaults to the Setting's shipped default. */
  staleMs?: () => Promise<number> | number;
  /** The clock the topology is judged by; tests drive it. */
  now?: () => Date;
  /** Extra route groups mounted at the root: the cron tick, the upgrade routes. */
  mounts?: Hono<AppEnv>[];
  /**
   * The external MCP module (slice 19). Defaults to one over `db` and the
   * Agent host; tests pass one over the memory store.
   */
  external?: External;
  /** Where an external approval's desktop notification goes when no client is open; the entry supplies it. */
  notifier?: Notifier;
  /** The Server's public URL, the OAuth issuer, when configured; the request's origin otherwise. */
  publicUrl?: () => Promise<string | null>;
}

export function createApp(options: AppOptions): Hono<AppEnv> {
  const { db, auth, mode } = options;
  const keys = options.keys ?? createKeys(db);
  const mailstore = options.mailstore ?? createMailstore(db, keys);
  const drafts =
    options.drafts ??
    (() => {
      const created = createDrafts({
        db,
        mailstore,
        ...(options.sync ? { sync: options.sync } : {}),
      });
      if (options.jobs) created.registerSteps(options.jobs);
      if (options.sync) {
        options.sync.setDraftImporter(
          (found) => created.importProviderDraft(found).then(() => {}),
          (workspaceId) => created.knownProviderDraftIds(workspaceId),
        );
      }
      return created;
    })();
  const intelligence =
    options.intelligence ??
    (() => {
      const created = createIntelligence({
        db,
        mailstore,
        drafts,
        ...(options.checkpointer ? { checkpointer: options.checkpointer } : {}),
      });
      if (options.jobs) created.registerSteps(options.jobs);
      return created;
    })();
  // Threads whose bodies landed go to the brief policy through the Jobs table (slice 13).
  options.sync?.setThreadObserver((workspaceId, threadId) =>
    intelligence.briefs.threadReady(workspaceId, threadId),
  );
  // New Threads are routed on arrival, as route Jobs (slice 12), and start
  // the Workflows that listen for arrivals, as trigger Jobs (slice 16).
  if (options.sync) {
    options.sync.setArrivalHook(async (arrival) => {
      await intelligence.routing.onArrival(
        arrival.workspaceId,
        arrival.threadId,
        arrival.lastActivity,
      );
      await intelligence.workflows.onArrival(arrival.workspaceId, arrival.threadId);
    });
  }
  const placement = async (threadId: string) => {
    const row = await db.query.threads.findFirst({
      where: eq(threads.id, threadId),
      columns: { groupId: true, subgroupId: true },
    });
    return row ? { group: row.groupId, subgroup: row.subgroupId } : null;
  };
  const bus = options.changes ?? createChangeBus();
  // Thread events (a Tag applied, an archive) reach Workflows off the same feed the clients read.
  intelligence.workflows.watch(bus);
  const bodyStates = async (messageIds: string[]) => {
    const out = new Map<string, BodyState>();
    if (messageIds.length === 0) return out;
    const rows = await db
      .select({ messageId: syncMessages.messageId, bodyState: syncMessages.bodyState })
      .from(syncMessages)
      .where(inArray(syncMessages.messageId, messageIds));
    for (const r of rows) {
      // Several Provider copies can map to one Message; fetched wins.
      const current = out.get(r.messageId);
      if (current !== "fetched") out.set(r.messageId, r.bodyState);
    }
    return out;
  };
  const started = Date.now();
  const uptimeMs = options.uptimeMs ?? (() => Date.now() - started);
  const isLoopback: LoopbackCheck = (c) => isLoopbackAddress(options.remoteAddress?.(c));

  // The external MCP server (slice 19): credentials beside Device tokens, the
  // Agent host's tools behind a scope, approvals routed to the owner.
  const external =
    options.external ??
    createExternal({
      agent: intelligence.agent,
      store: createCredentialStore(db, options.now ? { now: options.now } : {}),
      notify: options.notifier ?? createMemoryNotifier((line) => console.warn(line)),
      ...(options.now ? { now: options.now } : {}),
      settings: async () => {
        const s = await readGlobalSettings(db, EXTERNAL_SETTING_KEYS);
        return {
          ratePerMinute: s["external.rate_per_minute"],
          searchCap: s["external.search_cap"],
          approvalTimeoutMs: s["external.approval_timeout_minutes"] * 60_000,
          keyExpiryDays: s["external.key_expiry_days"],
          consentTtlMs: s["external.consent_timeout_minutes"] * 60_000,
        };
      },
      workspaces: async () => {
        const rows = await db
          .select({ id: workspaces.id, address: accounts.address })
          .from(workspaces)
          .innerJoin(accounts, eq(accounts.id, workspaces.accountId));
        return rows;
      },
    });
  intelligence.extensions.external = external;

  const app = new Hono<AppEnv>();

  app.use("*", authenticate(auth, isLoopback));
  app.use(
    "*",
    requireAuth(
      [...PUBLIC_PATHS, ...EXTERNAL_PUBLIC_PATHS],
      [...PUBLIC_PREFIXES, ...EXTERNAL_PUBLIC_PREFIXES],
    ),
  );

  app.get("/health", async (c) => {
    try {
      await db.execute("select 1");
      return c.json({ ok: true, mode, uptimeMs: uptimeMs() });
    } catch {
      return c.json({ ok: false, mode, uptimeMs: uptimeMs() }, 503);
    }
  });

  app.get("/capabilities", async (c) => {
    const topology = options.serverId
      ? await currentTopology(
          db,
          { id: options.serverId, mode },
          options.now?.() ?? new Date(),
          await (options.staleMs?.() ?? HEARTBEAT_STALE_MS),
        )
      : undefined;
    return c.json(
      capabilitiesFor(mode, keys.isUnlocked(), await intelligence.hostedState(), topology),
    );
  });

  app.route("/pair", pairRoutes(auth));
  app.route("/settings", settingsRoutes(db));
  app.route("/devices", devicesRoutes(auth));
  app.route("/", storageRoutes(db));
  app.route("/", unlockRoutes(keys));
  app.route(
    "/",
    mailRoutes(mailstore, {
      bodyStates,
      placement,
      // A user's move is a correction routing learns from (ADR 0005: it beats automation).
      onMove: (intent, previous) => intelligence.routing.observeMove(intent, previous),
      log: (m) => console.warn(`[routing] ${m}`),
    }),
  );
  app.route("/", draftsRoutes(drafts, mailstore));
  app.route("/", changesRoutes(mailstore, { bus, ...(options.sse ?? {}) }));
  app.route("/", intelligenceRoutes(intelligence));
  app.route("/", routingRoutes(intelligence));
  app.route("/", agentRoutes(intelligence.agent));
  app.route("/", workflowRoutes(intelligence.workflows));
  // Before the provider OAuth wizard routes, whose /oauth/:provider/* must not catch these.
  app.route(
    "/",
    externalRoutes({
      external,
      ...(options.publicUrl ? { publicUrl: options.publicUrl } : {}),
      consentStrings: async () => {
        const s = await readGlobalSettings(db, CONSENT_STRING_KEYS);
        return {
          title: s["strings.external.consent.title"],
          intro: s["strings.external.consent.intro"],
          scopeRead: s["strings.external.scope.read"],
          scopeAct: s["strings.external.scope.act"],
          codeHint: s["strings.external.consent.code_hint"],
          waiting: s["strings.external.consent.waiting"],
          deny: s["strings.external.consent.deny"],
          approved: s["strings.external.consent.approved"],
          denied: s["strings.external.consent.denied"],
          expired: s["strings.external.consent.expired"],
        };
      },
    }),
  );
  if (options.accounts) {
    app.route("/", accountRoutes(options.accounts));
    if (options.oauth) {
      app.route("/", oauthRoutes({ ...options.oauth, accounts: options.accounts.accounts }));
    }
  }
  if (options.push) app.route("/", webhookRoutes(options.push));
  for (const mount of options.mounts ?? []) app.route("/", mount);

  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((error, c) => {
    // A locked server answers 423 for anything that needs the root key.
    if (error instanceof LockedError) return c.json({ error: "locked" }, 423);
    if (error instanceof NotFoundError) return c.json({ error: "not_found" }, 404);
    if (error instanceof NoRecipientsError) return c.json({ error: "no_recipients" }, 400);
    if (error instanceof DraftNotOpenError) {
      return c.json({ error: "draft_not_open", status: error.draftStatus }, 409);
    }
    if (error instanceof SendTooLargeError) {
      return c.json({ error: "too_large", size: error.size, limit: error.limit }, 413);
    }
    if (error instanceof NoProviderKeyError) {
      return c.json({ error: "no_shared_key", provider: error.provider }, 409);
    }
    if (error instanceof AiOffError) return c.json({ error: "ai_off", task: error.task }, 409);
    if (error instanceof BriefOutputError) return c.json({ error: "bad_output" }, 502);
    if (error instanceof BriefNotReadyError) return c.json({ error: "no_bodies" }, 409);
    if (error instanceof ClassifyOutputError) return c.json({ error: "bad_output" }, 502);
    if (error instanceof GroupNestingError) {
      return c.json({ error: "group_nesting", detail: error.detail }, 400);
    }
    if (error instanceof SessionNotFoundError) return c.json({ error: "not_found" }, 404);
    if (error instanceof TurnBusyError) return c.json({ error: "turn_running" }, 409);
    if (error instanceof WorkflowNotFoundError) return c.json({ error: "not_found" }, 404);
    if (error instanceof RunNotWaitingError) return c.json({ error: "run_not_waiting" }, 409);
    if (error instanceof DecryptError) {
      console.error(error);
      return c.json({ error: "unreadable_content" }, 500);
    }
    console.error(error);
    return c.json({ error: "internal" }, 500);
  });

  return app;
}
