// The desktop notification seam (docs/spec/external-mcp.md): when an external
// call parks on an approval and no client is open, the Server asks the
// platform to notify the owner. The Sidecar's implementation hands the
// request to its parent client over stdout; the Cloud has no desktop and
// logs it. Slice 18 may plug the real Tauri notification plugin in behind
// this same interface.

export interface ExternalNotification {
  workspaceId: string;
  title: string;
  body: string;
  /** The parked Activity row and the Session its card lives in, so a click can open it. */
  activityId: string;
  sessionId: string;
}

export interface Notifier {
  notify(notification: ExternalNotification): Promise<void>;
}

/** Records what would have been shown; tests read it, the Cloud logs it. */
export function createMemoryNotifier(
  log?: (line: string) => void,
): Notifier & { sent: ExternalNotification[] } {
  const sent: ExternalNotification[] = [];
  return {
    sent,
    async notify(n) {
      sent.push(n);
      log?.(`[notify] ${n.title}: ${n.body}`);
    },
  };
}

/**
 * The Sidecar's notifier: one JSON line on stdout, prefixed, which the Tauri
 * parent reads beside the port line and turns into a desktop notification.
 */
export const NOTIFY_LINE_PREFIX = "monday notify ";

export function createLineNotifier(write: (line: string) => void): Notifier {
  return {
    async notify(n) {
      write(`${NOTIFY_LINE_PREFIX}${JSON.stringify(n)}`);
    },
  };
}
