// The Hono app: a runtime-neutral fetch handler. No Bun, Node or platform API
// here; the entry under entry/ supplies the database, the loopback test and
// the process-level pieces (research 22, section 2.1).

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
import { type BodyState, syncMessages, threads } from "./db/schema.ts";
import {
  createDrafts,
  DraftNotOpenError,
  type Drafts,
  NoRecipientsError,
  SendTooLargeError,
} from "./drafts/index.ts";
import {
  BriefOutputError,
  ClassifyOutputError,
  createIntelligence,
  GroupNestingError,
  type Intelligence,
  NoProviderKeyError,
} from "./intelligence/index.ts";
import type { Jobs } from "./jobs/index.ts";
import { createMailstore, type Mailstore, NotFoundError } from "./mailstore/index.ts";
import type { PushManager } from "./providers/push.ts";
import type { SyncEngine } from "./providers/sync.ts";
import { type AccountRoutesOptions, accountRoutes } from "./routes/accounts.ts";
import { changesRoutes } from "./routes/changes.ts";
import { devicesRoutes } from "./routes/devices.ts";
import { draftsRoutes } from "./routes/drafts.ts";
import { intelligenceRoutes } from "./routes/intelligence.ts";
import { mailRoutes } from "./routes/mail.ts";
import { type OAuthRoutesOptions, oauthRoutes } from "./routes/oauth.ts";
import { pairRoutes } from "./routes/pair.ts";
import { routingRoutes } from "./routes/routing.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { unlockRoutes } from "./routes/unlock.ts";
import { webhookRoutes } from "./routes/webhooks.ts";

export type { AppEnv } from "./auth/middleware.ts";

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
      const created = createIntelligence({ db, mailstore });
      if (options.jobs) created.registerSteps(options.jobs);
      return created;
    })();
  // New Threads are routed on arrival, as route Jobs (slice 12).
  if (options.sync) {
    options.sync.setArrivalHook(async (arrival) => {
      await intelligence.routing.onArrival(
        arrival.workspaceId,
        arrival.threadId,
        arrival.lastActivity,
      );
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

  const app = new Hono<AppEnv>();

  app.use("*", authenticate(auth, isLoopback));
  app.use("*", requireAuth(PUBLIC_PATHS, PUBLIC_PREFIXES));

  app.get("/health", async (c) => {
    try {
      await db.execute("select 1");
      return c.json({ ok: true, mode, uptimeMs: uptimeMs() });
    } catch {
      return c.json({ ok: false, mode, uptimeMs: uptimeMs() }, 503);
    }
  });

  app.get("/capabilities", async (c) =>
    c.json(capabilitiesFor(mode, keys.isUnlocked(), await intelligence.hostedState())),
  );

  app.route("/pair", pairRoutes(auth));
  app.route("/settings", settingsRoutes(db));
  app.route("/devices", devicesRoutes(auth));
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
  if (options.accounts) {
    app.route("/", accountRoutes(options.accounts));
    if (options.oauth) {
      app.route("/", oauthRoutes({ ...options.oauth, accounts: options.accounts.accounts }));
    }
  }
  if (options.push) app.route("/", webhookRoutes(options.push));

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
    if (error instanceof BriefOutputError) return c.json({ error: "bad_output" }, 502);
    if (error instanceof ClassifyOutputError) return c.json({ error: "bad_output" }, 502);
    if (error instanceof GroupNestingError) {
      return c.json({ error: "group_nesting", detail: error.detail }, 400);
    }
    if (error instanceof DecryptError) {
      console.error(error);
      return c.json({ error: "unreadable_content" }, 500);
    }
    console.error(error);
    return c.json({ error: "internal" }, 500);
  });

  return app;
}
