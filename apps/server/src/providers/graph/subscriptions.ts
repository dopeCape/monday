// Graph change notifications (research, "Microsoft 365: Detecting new mail").
// A subscription on /me/messages with a lifetime under 10,080 minutes, a
// clientState the webhook checks on every delivery, and a lifecycle URL so
// reauthorizationRequired, subscriptionRemoved and missed reach us. Only a
// server with a public URL can hold one (needs-public-url); the Sidecar polls
// delta instead.

import type { GraphClient } from "./client.ts";

/** The documented maximum for Outlook message subscriptions. */
export const SUBSCRIPTION_MAX_MINUTES = 10_080;
/** Minutes to ask for, a little under the maximum so clock skew never trips the limit. */
export const SUBSCRIPTION_REQUEST_MINUTES = SUBSCRIPTION_MAX_MINUTES - 60;
export const SUBSCRIPTION_RESOURCE = "/me/messages";
export const SUBSCRIPTION_CHANGE_TYPES = "created,updated,deleted";

export interface GraphSubscription {
  id: string;
  resource: string;
  expirationDateTime: string;
  clientState: string | null;
  notificationUrl: string;
}

export interface CreateSubscriptionInput {
  notificationUrl: string;
  lifecycleNotificationUrl: string;
  clientState: string;
  /** Epoch milliseconds the expiry is computed from. */
  now: number;
  minutes?: number;
}

export function expirationFrom(now: number, minutes = SUBSCRIPTION_REQUEST_MINUTES): string {
  return new Date(now + minutes * 60_000).toISOString();
}

export async function createSubscription(
  client: GraphClient,
  input: CreateSubscriptionInput,
): Promise<GraphSubscription> {
  return client.request<GraphSubscription>("subscriptions", {
    body: {
      changeType: SUBSCRIPTION_CHANGE_TYPES,
      notificationUrl: input.notificationUrl,
      lifecycleNotificationUrl: input.lifecycleNotificationUrl,
      resource: SUBSCRIPTION_RESOURCE,
      expirationDateTime: expirationFrom(input.now, input.minutes),
      clientState: input.clientState,
    },
  });
}

export async function renewSubscription(
  client: GraphClient,
  id: string,
  now: number,
  minutes = SUBSCRIPTION_REQUEST_MINUTES,
): Promise<GraphSubscription> {
  return client.request<GraphSubscription>(`subscriptions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { expirationDateTime: expirationFrom(now, minutes) },
  });
}

export async function deleteSubscription(client: GraphClient, id: string): Promise<void> {
  try {
    await client.request(`subscriptions/${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch (error) {
    if ((error as { code?: string }).code === "not-found") return;
    throw error;
  }
}

/* ------------------------------ Notifications ------------------------------ */

export interface ChangeNotification {
  subscriptionId: string;
  clientState?: string;
  changeType: string;
  resource: string;
  resourceData?: { id?: string };
  /** Lifecycle events carry this instead of a changeType with resource data. */
  lifecycleEvent?: "reauthorizationRequired" | "subscriptionRemoved" | "missed";
  subscriptionExpirationDateTime?: string;
}

export function parseNotifications(body: unknown): ChangeNotification[] {
  if (!body || typeof body !== "object") return [];
  const value = (body as { value?: unknown }).value;
  if (!Array.isArray(value)) return [];
  return value.filter(
    (n): n is ChangeNotification =>
      !!n && typeof n === "object" && typeof (n as ChangeNotification).subscriptionId === "string",
  );
}
