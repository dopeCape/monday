// Whether a client is connected to this Server right now (ADR 0013): a live
// Changes feed socket, or any authenticated request within the last few
// seconds. The Sidecar posts desktop notifications itself only while no
// client is, so an open app never sees the same notice twice. Runtime-neutral:
// the Bun entry feeds the socket count, the app's middleware the requests.

export interface Presence {
  /** A Changes feed socket opened. */
  open(): void;
  /** A Changes feed socket closed. */
  close(): void;
  /** An authenticated request arrived. */
  touch(): void;
  /** True while a socket is open or a request came within `graceMs` of `now`. */
  present(graceMs: number, now?: Date): boolean;
  /** When a client was last seen: now while a socket is open, else the last request; null for never. */
  lastSeen(now?: Date): Date | null;
}

export function createPresence(clock: () => Date = () => new Date()): Presence {
  let sockets = 0;
  let last: Date | null = null;
  return {
    open() {
      sockets += 1;
      last = clock();
    },
    close() {
      sockets = Math.max(0, sockets - 1);
      last = clock();
    },
    touch() {
      last = clock();
    },
    present(graceMs, now = clock()) {
      if (sockets > 0) return true;
      return last !== null && now.getTime() - last.getTime() < graceMs;
    },
    lastSeen(now = clock()) {
      return sockets > 0 ? now : last;
    },
  };
}
