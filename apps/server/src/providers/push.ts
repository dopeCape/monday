// Provider push registrations as Jobs (ADR 0005): Gmail's watch renewed daily
// wherever a Server is awake, the Gmail push subscription and the Graph change
// notification subscription only where a public URL exists
// (needs-public-url), each recording which Server registered it. The webhook
// handlers here are runtime neutral: verify, wake the sync engine, return.
// A Sidecar that claims these Jobs while no Cloud is alive finds no public
// URL and simply sleeps; its in-process watch (Pub/Sub pull, Graph delta
// polling) carries push meanwhile.

import type { Provider as ProviderKind } from "@monday/shared";
import { settingsSchema } from "@monday/shared";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { accounts, settings } from "../db/schema.ts";
import type { Jobs } from "../jobs/index.ts";
import { isGmailSession } from "./gmail/index.ts";
import { decodePubsubData } from "./gmail/pubsub.ts";
import {
  createSubscription,
  isGraphSession,
  parseNotifications,
  renewSubscription,
  SUBSCRIPTION_REQUEST_MINUTES,
} from "./graph/index.ts";
import { randomState } from "./oauth/pkce.ts";
import type { SyncEngine } from "./sync.ts";

export const GMAIL_WATCH_RENEW_STEP = "provider.gmail.watch-renew";
export const GMAIL_PUSH_SUBSCRIBE_STEP = "provider.gmail.push-subscribe";
export const GRAPH_SUBSCRIBE_STEP = "provider.graph.subscribe";

/** How long a needs-public-url Job sleeps when this Server has no public URL. */
export const NO_PUBLIC_URL_SLEEP_MS = 30 * 60_000;
/** Renew a Graph subscription when less than this remains. */
export const GRAPH_RENEW_MARGIN_MS = 24 * 3_600_000;

export interface GmailPushState {
  watchExpiration: number | null;
  watchHistoryId: string | null;
  pushSubscription: string | null;
  pushSecret: string | null;
  registeredBy: string | null;
}

export interface GraphPushState {
  subscriptionId: string | null;
  expiration: string | null;
  clientState: string | null;
  registeredBy: string | null;
}

export interface PushState {
  gmail?: GmailPushState;
  graph?: GraphPushState;
}

export interface PushSettings {
  gmailWatchRenewHours: number;
  graphSubscriptionRenewHours: number;
  publicUrl: string;
}

export function defaultPushSettings(): PushSettings {
  return {
    gmailWatchRenewHours: settingsSchema["sync.gmail_watch_renew_hours"].default,
    graphSubscriptionRenewHours: settingsSchema["sync.graph_subscription_renew_hours"].default,
    publicUrl: settingsSchema["server.public_url"].default,
  };
}

export async function readPushSettings(db: Db): Promise<PushSettings> {
  const out = defaultPushSettings();
  const rows = await db
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(and(eq(settings.scope, "global"), isNull(settings.deviceId)));
  const num = (key: string, current: number) => {
    const row = rows.find((r) => r.key === key);
    return typeof row?.value === "number" ? row.value : current;
  };
  out.gmailWatchRenewHours = num("sync.gmail_watch_renew_hours", out.gmailWatchRenewHours);
  out.graphSubscriptionRenewHours = num(
    "sync.graph_subscription_renew_hours",
    out.graphSubscriptionRenewHours,
  );
  const url = rows.find((r) => r.key === "server.public_url");
  if (typeof url?.value === "string") out.publicUrl = url.value;
  return out;
}

export async function readPushState(db: Db, accountId: string): Promise<PushState> {
  const row = await db.query.accounts.findFirst({ where: eq(accounts.id, accountId) });
  return ((row?.syncState as PushState | null) ?? {}) as PushState;
}

export async function writePushState(
  db: Db,
  accountId: string,
  patch: Partial<PushState>,
): Promise<void> {
  const current = await readPushState(db, accountId);
  await db
    .update(accounts)
    .set({ syncState: { ...current, ...patch } })
    .where(eq(accounts.id, accountId));
}

export interface PushManagerOptions {
  db: Db;
  engine: SyncEngine;
  /** This Server's heartbeat id; recorded on every registration. */
  serverId: string;
  /** The HTTPS origin the internet reaches this Server at, or null. Env first, then the Setting. */
  publicUrl?: () => Promise<string | null>;
  settings?: () => Promise<PushSettings>;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface PushManager {
  registerSteps(jobs: Jobs): void;
  /** Enqueues the push Jobs an Account of this Provider needs; idempotent. */
  startAccount(jobs: Jobs, accountId: string, provider: ProviderKind | "fake"): Promise<void>;
  /** Pub/Sub push delivery for one Account. Returns false when the secret does not match. */
  gmailWebhook(accountId: string, secret: string | null, body: unknown): Promise<boolean>;
  /** Graph change notifications. Returns how many were accepted. */
  graphNotifications(body: unknown): Promise<number>;
  graphLifecycle(body: unknown): Promise<number>;
}

interface AccountPayload {
  accountId: string;
}

export function createPushManager(options: PushManagerOptions): PushManager {
  const { db, engine, serverId } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const readSettings = options.settings ?? (() => readPushSettings(db));
  const publicUrl =
    options.publicUrl ??
    (async () => {
      const s = await readSettings();
      return s.publicUrl.trim() ? s.publicUrl.trim().replace(/\/+$/, "") : null;
    });
  let jobsRef: Jobs | null = null;

  async function accountBySubscription(subscriptionId: string) {
    const [row] = await db
      .select({ id: accounts.id, syncState: accounts.syncState })
      .from(accounts)
      .where(sql`${accounts.syncState} -> 'graph' ->> 'subscriptionId' = ${subscriptionId}`)
      .limit(1);
    return row ? { id: row.id, state: (row.syncState as PushState).graph ?? null } : null;
  }

  const manager: PushManager = {
    registerSteps(jobs) {
      jobsRef = jobs;

      jobs.registerStep<AccountPayload>(GMAIL_WATCH_RENEW_STEP, async (job) => {
        const session = await engine.session(job.payload.accountId);
        if (!isGmailSession(session) || !session.pubsubTopic) return "done";
        const result = await session.renewWatch();
        const current = (await readPushState(db, job.payload.accountId)).gmail;
        await writePushState(db, job.payload.accountId, {
          gmail: {
            pushSubscription: current?.pushSubscription ?? null,
            pushSecret: current?.pushSecret ?? null,
            registeredBy: current?.registeredBy ?? null,
            watchExpiration: result.expiration,
            watchHistoryId: result.historyId,
          },
        });
        log(`gmail watch renewed for ${job.payload.accountId} until ${result.expiration}`);
        const s = await readSettings();
        return { sleepMs: s.gmailWatchRenewHours * 3_600_000 };
      });

      jobs.registerStep<AccountPayload>(GMAIL_PUSH_SUBSCRIBE_STEP, async (job) => {
        const origin = await publicUrl();
        if (!origin) return { sleepMs: NO_PUBLIC_URL_SLEEP_MS };
        const session = await engine.session(job.payload.accountId);
        if (!isGmailSession(session) || !session.pubsubTopic) return "done";
        const current = (await readPushState(db, job.payload.accountId)).gmail;
        const secret = current?.pushSecret ?? randomState();
        const endpoint = `${origin}/webhooks/gmail/${encodeURIComponent(job.payload.accountId)}?secret=${encodeURIComponent(secret)}`;
        const subscription = await session.subscribePush(endpoint);
        await writePushState(db, job.payload.accountId, {
          gmail: {
            watchExpiration: current?.watchExpiration ?? null,
            watchHistoryId: current?.watchHistoryId ?? null,
            pushSubscription: subscription,
            pushSecret: secret,
            registeredBy: serverId,
          },
        });
        const s = await readSettings();
        return { sleepMs: s.gmailWatchRenewHours * 3_600_000 };
      });

      jobs.registerStep<AccountPayload>(GRAPH_SUBSCRIBE_STEP, async (job) => {
        const origin = await publicUrl();
        if (!origin) return { sleepMs: NO_PUBLIC_URL_SLEEP_MS };
        const session = await engine.session(job.payload.accountId);
        if (!isGraphSession(session)) return "done";
        const current = (await readPushState(db, job.payload.accountId)).graph;
        const at = now().getTime();
        const s = await readSettings();
        const remaining = current?.expiration ? Date.parse(current.expiration) - at : 0;
        if (current?.subscriptionId && remaining > GRAPH_RENEW_MARGIN_MS) {
          try {
            const renewed = await renewSubscription(session.client, current.subscriptionId, at);
            await writePushState(db, job.payload.accountId, {
              graph: { ...current, expiration: renewed.expirationDateTime, registeredBy: serverId },
            });
            return { sleepMs: s.graphSubscriptionRenewHours * 3_600_000 };
          } catch (error) {
            log(`graph renew failed for ${job.payload.accountId}: ${error}; recreating`);
          }
        }
        const clientState = randomState();
        const created = await createSubscription(session.client, {
          notificationUrl: `${origin}/webhooks/graph`,
          lifecycleNotificationUrl: `${origin}/webhooks/graph/lifecycle`,
          clientState,
          now: at,
          minutes: SUBSCRIPTION_REQUEST_MINUTES,
        });
        await writePushState(db, job.payload.accountId, {
          graph: {
            subscriptionId: created.id,
            expiration: created.expirationDateTime,
            clientState,
            registeredBy: serverId,
          },
        });
        log(`graph subscription ${created.id} for ${job.payload.accountId}`);
        return { sleepMs: s.graphSubscriptionRenewHours * 3_600_000 };
      });
    },

    async startAccount(jobs, accountId, provider) {
      const payload: AccountPayload = { accountId };
      if (provider === "gmail") {
        await jobs.enqueue(GMAIL_WATCH_RENEW_STEP, payload, {
          id: `${GMAIL_WATCH_RENEW_STEP}:${accountId}`,
        });
        await jobs.enqueue(GMAIL_PUSH_SUBSCRIBE_STEP, payload, {
          id: `${GMAIL_PUSH_SUBSCRIBE_STEP}:${accountId}`,
          needs: ["needs-public-url"],
        });
      } else if (provider === "graph") {
        await jobs.enqueue(GRAPH_SUBSCRIBE_STEP, payload, {
          id: `${GRAPH_SUBSCRIBE_STEP}:${accountId}`,
          needs: ["needs-public-url"],
        });
      }
    },

    async gmailWebhook(accountId, secret, body) {
      const state = (await readPushState(db, accountId)).gmail;
      if (!state?.pushSecret || !secret || state.pushSecret !== secret) return false;
      const envelope = (body ?? {}) as { message?: { data?: string } };
      const data = decodePubsubData(envelope.message?.data);
      const row = await db.query.accounts.findFirst({ where: eq(accounts.id, accountId) });
      if (!row) return false;
      if (data.emailAddress && data.emailAddress.toLowerCase() !== row.address.toLowerCase()) {
        return true; // Not ours; acknowledge so Pub/Sub stops redelivering.
      }
      await engine.wake(accountId);
      return true;
    },

    async graphNotifications(body) {
      let accepted = 0;
      const woken = new Set<string>();
      for (const n of parseNotifications(body)) {
        const found = await accountBySubscription(n.subscriptionId);
        if (!found?.state?.clientState || found.state.clientState !== n.clientState) continue;
        accepted += 1;
        if (woken.has(found.id)) continue;
        woken.add(found.id);
        await engine.wake(found.id);
      }
      return accepted;
    },

    async graphLifecycle(body) {
      let handled = 0;
      for (const n of parseNotifications(body)) {
        const found = await accountBySubscription(n.subscriptionId);
        if (!found?.state?.clientState || found.state.clientState !== n.clientState) continue;
        handled += 1;
        const bucket = Math.floor(now().getTime() / 60_000);
        if (n.lifecycleEvent === "subscriptionRemoved") {
          await writePushState(db, found.id, {
            graph: { ...found.state, subscriptionId: null, expiration: null },
          });
        }
        if (n.lifecycleEvent === "missed") {
          await engine.wake(found.id);
          continue;
        }
        // reauthorizationRequired and subscriptionRemoved: run the subscribe step now.
        await jobsRef?.enqueue(
          GRAPH_SUBSCRIBE_STEP,
          { accountId: found.id } satisfies AccountPayload,
          {
            id: `${GRAPH_SUBSCRIBE_STEP}:${found.id}:lifecycle:${bucket}`,
            needs: ["needs-public-url"],
          },
        );
      }
      return handled;
    },
  };
  return manager;
}
