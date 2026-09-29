// What the Sidecar told while monday was closed (ADR 0013). The background
// service posts new-mail and Workflow-approval notifications itself while no
// client is connected; opened afterwards, the app asks it once (GET /service,
// `notified`) and does not tell the same things again: mail dated at or before
// `mailThrough`, and the waiting Steps it named. Without a Sidecar (a Cloud,
// the browser) nothing was told and nothing waits.

import type { ServiceStatus } from "@monday/shared";

export interface SidecarTold {
  mailThrough: number | null;
  approvals: ReadonlySet<string>;
}

export const NOTHING_TOLD: SidecarTold = { mailThrough: null, approvals: new Set() };

/** Reads it once; a Server that does not answer (not a Sidecar, too old) told nothing. */
export async function loadSidecarTold(
  status: (() => Promise<Pick<ServiceStatus, "notified">>) | null,
  timeoutMs = 3000,
): Promise<SidecarTold> {
  if (!status) return NOTHING_TOLD;
  const answer = await Promise.race([
    status().catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);
  if (!answer?.notified) return NOTHING_TOLD;
  const through = answer.notified.mailThrough
    ? Date.parse(answer.notified.mailThrough)
    : Number.NaN;
  return {
    mailThrough: Number.isFinite(through) ? through : null,
    approvals: new Set(answer.notified.approvals),
  };
}

const once = new WeakMap<object, Promise<SidecarTold>>();

/**
 * Once per connection (an Api instance: a restarted Sidecar is a new one), so
 * the new-mail and the approval notices share one answer.
 */
export function sidecarToldOnce(
  api: { service: { status(): Promise<Pick<ServiceStatus, "notified">> } } | null,
): Promise<SidecarTold> {
  if (!api) return Promise.resolve(NOTHING_TOLD);
  let told = once.get(api);
  if (!told) {
    told = loadSidecarTold(() => api.service.status());
    once.set(api, told);
  }
  return told;
}

/** Whether a Message's date says the Sidecar already covered it. */
export function toldBySidecar(told: SidecarTold, date: string): boolean {
  if (told.mailThrough === null) return false;
  const at = Date.parse(date);
  return Number.isFinite(at) && at <= told.mailThrough;
}
