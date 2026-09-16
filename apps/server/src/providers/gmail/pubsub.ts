// Cloud Pub/Sub for Gmail push (research, "Detecting new mail"): the self-
// hoster's topic gets a pull subscription when a Sidecar or container holds
// the connection (no public endpoint needed) and a push subscription when a
// Cloud server has a public URL. Notifications carry only an address and a
// historyId; the sync engine fetches the delta from its stored cursor, so a
// notification is nothing more than a wake-up.

import { asyncQueue } from "../queue.ts";
import { ProviderError, type WatchEvent } from "../types.ts";
import { type GmailClient, PUBSUB_BASE } from "./client.ts";

export const PUBSUB_ACK_DEADLINE_SECONDS = 10;
/** Pub/Sub's maximum; the default 7 days would let a month-long outage drop the subscription. */
export const PUBSUB_RETENTION = "604800s";
export const PULL_MAX_MESSAGES = 10;

export interface TopicName {
  project: string;
  topic: string;
}

export function parseTopic(topic: string): TopicName {
  const m = /^projects\/([^/]+)\/topics\/([^/]+)$/.exec(topic.trim());
  if (!m?.[1] || !m[2]) {
    throw new ProviderError(`not a Pub/Sub topic name: ${topic}`, "unsupported");
  }
  return { project: m[1], topic: m[2] };
}

/** The subscription monday creates for a topic, one per delivery kind. */
export function subscriptionNameFor(topic: string, kind: "pull" | "push"): string {
  const { project, topic: name } = parseTopic(topic);
  return `projects/${project}/subscriptions/monday-${name}-${kind}`;
}

export interface PubsubMessage {
  ackId: string;
  messageId: string;
  emailAddress: string | null;
  historyId: string | null;
}

export function decodePubsubData(data: string | undefined): {
  emailAddress: string | null;
  historyId: string | null;
} {
  if (!data) return { emailAddress: null, historyId: null };
  try {
    const text = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
    const parsed = JSON.parse(text) as { emailAddress?: string; historyId?: string | number };
    return {
      emailAddress: typeof parsed.emailAddress === "string" ? parsed.emailAddress : null,
      historyId: parsed.historyId !== undefined ? String(parsed.historyId) : null,
    };
  } catch {
    return { emailAddress: null, historyId: null };
  }
}

async function ensureSubscription(
  client: GmailClient,
  topic: string,
  subscription: string,
  extra: Record<string, unknown>,
): Promise<void> {
  const body = {
    topic,
    ackDeadlineSeconds: PUBSUB_ACK_DEADLINE_SECONDS,
    messageRetentionDuration: PUBSUB_RETENTION,
    // Never expire: the default drops the subscription after 31 idle days.
    expirationPolicy: {},
    ...extra,
  };
  const response = await client.fetch(`${PUBSUB_BASE}/${subscription}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${await client.token()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (response.ok) return;
  if (response.status === 409) {
    // Already there; make sure the delivery config matches.
    if ("pushConfig" in extra) {
      const modify = await client.fetch(`${PUBSUB_BASE}/${subscription}:modifyPushConfig`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${await client.token()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ pushConfig: extra.pushConfig }),
      });
      if (!modify.ok) throw new ProviderError(`modifyPushConfig ${modify.status}`, "protocol");
    }
    return;
  }
  const text = await response.text();
  throw new ProviderError(
    `cannot create Pub/Sub subscription (${response.status}): ${text.slice(0, 300)}`,
    response.status === 403 || response.status === 401 ? "auth" : "protocol",
  );
}

export async function ensurePullSubscription(
  client: GmailClient,
  topic: string,
  subscription = subscriptionNameFor(topic, "pull"),
): Promise<string> {
  await ensureSubscription(client, topic, subscription, {});
  return subscription;
}

export async function ensurePushSubscription(
  client: GmailClient,
  topic: string,
  pushEndpoint: string,
  subscription = subscriptionNameFor(topic, "push"),
): Promise<string> {
  await ensureSubscription(client, topic, subscription, {
    pushConfig: { pushEndpoint },
  });
  return subscription;
}

export async function deleteSubscription(client: GmailClient, subscription: string): Promise<void> {
  const response = await client.fetch(`${PUBSUB_BASE}/${subscription}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${await client.token()}` },
  });
  if (!response.ok && response.status !== 404) {
    throw new ProviderError(`cannot delete subscription (${response.status})`, "protocol");
  }
}

export async function pull(
  client: GmailClient,
  subscription: string,
  maxMessages = PULL_MAX_MESSAGES,
): Promise<PubsubMessage[]> {
  const response = await client.fetch(`${PUBSUB_BASE}/${subscription}:pull`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await client.token()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ maxMessages, returnImmediately: false }),
  });
  if (!response.ok) {
    throw new ProviderError(
      `pull failed (${response.status})`,
      response.status === 401 || response.status === 403 ? "auth" : "network",
    );
  }
  const body = (await response.json()) as {
    receivedMessages?: { ackId: string; message?: { data?: string; messageId?: string } }[];
  };
  return (body.receivedMessages ?? []).map((m) => ({
    ackId: m.ackId,
    messageId: m.message?.messageId ?? "",
    ...decodePubsubData(m.message?.data),
  }));
}

export async function acknowledge(
  client: GmailClient,
  subscription: string,
  ackIds: string[],
): Promise<void> {
  if (ackIds.length === 0) return;
  const response = await client.fetch(`${PUBSUB_BASE}/${subscription}:acknowledge`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await client.token()}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ackIds }),
  });
  if (!response.ok) throw new ProviderError(`acknowledge failed (${response.status})`, "network");
}

export interface PullLoopOptions {
  client: GmailClient;
  subscription: string;
  /** Only notifications for this address wake the engine. */
  emailAddress: string;
  sleep?: (ms: number) => Promise<void>;
  /** Pause after a failed pull. */
  retryMs?: number;
}

export interface PullLoop {
  events: AsyncIterable<WatchEvent>;
  stop(): void;
}

/** Long-polls the pull subscription and turns notifications into watch events. */
export function pullLoop(options: PullLoopOptions): PullLoop {
  const queue = asyncQueue<WatchEvent>();
  const sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const retryMs = options.retryMs ?? 5_000;
  let stopped = false;
  (async () => {
    let connected = false;
    while (!stopped) {
      try {
        const messages = await pull(options.client, options.subscription);
        if (stopped) break;
        if (!connected) {
          connected = true;
          queue.push({ type: "connected" });
        }
        await acknowledge(
          options.client,
          options.subscription,
          messages.map((m) => m.ackId),
        );
        const mine = messages.some(
          (m) =>
            m.emailAddress === null ||
            m.emailAddress.toLowerCase() === options.emailAddress.toLowerCase(),
        );
        if (mine) queue.push({ type: "changed", mailboxIds: [] });
      } catch (error) {
        if (stopped) break;
        connected = false;
        queue.push({
          type: "disconnected",
          reason: error instanceof Error ? error.message : String(error),
        });
        await sleep(retryMs);
      }
    }
    queue.close();
  })();
  return {
    events: queue,
    stop() {
      stopped = true;
      queue.close();
    },
  };
}
