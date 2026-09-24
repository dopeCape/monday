// "Your inbox is ready" (docs/spec/onboarding.md, "First sync"): once per
// Account, when the first sync's wait completes, monday says so with the count
// synced. While the window is in front a note in the window is enough; else a
// desktop notification through the platform, the path calendar reminders
// take. It watches every Account, so an Account whose first sync finishes
// while the user is elsewhere (another Workspace, Settings, another app) is
// still told, and so is one connected after the watch began, even when its
// small Inbox finished between two looks. An Account that was already there
// and already synced when the watch began (one from before this existed, or
// one whose sync finished while the app was closed) is recorded without a
// word. Behind notifications.inbox_ready; what was told is kept in
// sync.first_run_announced so it never repeats.

import type { FirstSyncProgress, Settings } from "@monday/shared";
import { firstSyncComplete } from "@monday/shared";
import { useEffect, useRef } from "react";

export type ReadySettings = Pick<
  Settings,
  | "notifications.enabled"
  | "notifications.inbox_ready"
  | "sync.first_run_wait"
  | "sync.first_run_announced"
  | "sync.first_run_poll_seconds"
  | "accounts.status_poll_seconds"
  | "strings.first_sync.ready_title"
  | "strings.first_sync.ready_body"
>;

export interface ReadyNotice {
  accountId: string;
  title: string;
  body: string;
}

/** The words for one Account: the title and the count synced. */
export function readyNotice(progress: FirstSyncProgress, s: ReadySettings): ReadyNotice {
  const count = progress.headers.done.toLocaleString("en-US");
  return {
    accountId: progress.accountId,
    title: s["strings.first_sync.ready_title"],
    body: s["strings.first_sync.ready_body"]
      .replaceAll("{count}", count)
      .replaceAll("{address}", progress.address),
  };
}

export interface ReadyWatcherOptions {
  /** The Accounts of this Server. */
  list(): Promise<ReadonlyArray<{ id: string }>>;
  /** One Account's first sync progress (GET /accounts/:id/sync). */
  read(accountId: string): Promise<FirstSyncProgress>;
  settings(): ReadySettings;
  /** Keeps what was told: the whole map, so two Accounts finishing together both stay. */
  record(announced: Record<string, string>): void;
  /** A desktop notification. */
  notify(title: string, body: string): Promise<void>;
  /** A note in the window, for when the user is looking at it. */
  note(notice: ReadyNotice): void;
  /** Whether the window is in front and visible. */
  inFront(): boolean;
  now?: () => Date;
}

/** Starts watching; returns the stop function. */
export function watchInboxReady(options: ReadyWatcherOptions): () => void {
  const now = options.now ?? (() => new Date());
  const seenSyncing = new Set<string>();
  // The Accounts present at the first look; any other one is new this session.
  let present: Set<string> | null = null;
  const told: Record<string, string> = {};
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async () => {
    let waiting = false;
    try {
      const accounts = await options.list();
      if (present === null) present = new Set(accounts.map((a) => a.id));
      // No Account yet (the welcome): one is about to be connected, so look often.
      if (accounts.length === 0) waiting = true;
      for (const { id } of accounts) {
        if (stopped) return;
        const s = options.settings();
        if (s["sync.first_run_announced"][id] || told[id]) continue;
        let progress: FirstSyncProgress;
        try {
          progress = await options.read(id);
        } catch {
          waiting = true;
          continue;
        }
        if (!firstSyncComplete(progress, s["sync.first_run_wait"])) {
          seenSyncing.add(id);
          waiting = true;
          continue;
        }
        told[id] = now().toISOString();
        options.record({ ...options.settings()["sync.first_run_announced"], ...told });
        if (!seenSyncing.has(id) && present.has(id)) continue;
        if (!s["notifications.enabled"] || !s["notifications.inbox_ready"]) continue;
        const notice = readyNotice(progress, s);
        if (options.inFront()) options.note(notice);
        else await options.notify(notice.title, notice.body).catch(() => {});
      }
    } catch {
      waiting = true;
    }
    if (stopped) return;
    // While a first sync runs, at the first sync screen's pace; else now and then, for new Accounts.
    const s = options.settings();
    const seconds = waiting ? s["sync.first_run_poll_seconds"] : s["accounts.status_poll_seconds"];
    timer = setTimeout(() => void tick(), seconds * 1000);
  };
  void tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/** The window is in front: visible and focused. */
export function windowInFront(): boolean {
  if (typeof document === "undefined") return false;
  return document.visibilityState === "visible" && document.hasFocus();
}

/** The watcher over the Shell's seams while a Server is picked. */
export function useInboxReady(
  options: Omit<ReadyWatcherOptions, "settings"> & { settings: ReadySettings },
  active: boolean,
): void {
  const ref = useRef(options);
  ref.current = options;
  useEffect(() => {
    if (!active) return;
    return watchInboxReady({
      list: () => ref.current.list(),
      read: (id) => ref.current.read(id),
      settings: () => ref.current.settings,
      record: (m) => ref.current.record(m),
      notify: (t, b) => ref.current.notify(t, b),
      note: (n) => ref.current.note(n),
      inFront: () => ref.current.inFront(),
      ...(ref.current.now ? { now: ref.current.now } : {}),
    });
  }, [active]);
}
