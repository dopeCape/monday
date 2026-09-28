// The window's side of live Runs and approvals, per Workspace: the live Runs
// (live-runs.ts) woken by the Store's Changes feed, the approval notices told
// once per waiting Step, and the Approvals queue's items with the answers
// that go through the same routes as where each approval started.

import type { ExternalPending, RunChange, RunView, Settings, ToolCall } from "@monday/shared";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  createLiveRuns,
  type LiveRuns,
  type LiveRunsApi,
  type LiveRunsSnapshot,
} from "./live-runs.ts";
import { type ApprovalNotice, approvalNotices } from "./notices.ts";
import { type ApprovalItem, approvalItems, runCounts } from "./queue.ts";

/** Where `run` changes arrive: the Workspace's Store. */
export interface RunFeed {
  onRuns(listener: (runs: readonly RunChange[]) => void): () => void;
}

export interface ApprovalsOptions {
  /** The Workflow routes; null without a Server (nothing is live then). */
  api: LiveRunsApi | null;
  workspaceId: string;
  feed?: RunFeed | null | undefined;
  settings: Settings;
  /** Calls waiting in the current agent Session. */
  session: readonly ToolCall[];
  external: readonly ExternalPending[];
  /** Tells one notice: a desktop notification or a note in the window. */
  tell?: ((notice: ApprovalNotice) => void) | undefined;
  now?: (() => Date) | undefined;
}

export interface Approvals {
  live: LiveRunsSnapshot;
  items: ApprovalItem[];
  /** Runs going (queued or running). */
  running: number;
  /** Approvals waiting for the user, of every kind: the badge. */
  count: number;
  decideRun(run: RunView, decision: "approved" | "declined", standing: boolean): Promise<void>;
  refresh(): void;
}

const IDLE: LiveRunsSnapshot = {
  runs: [],
  workflows: new Map(),
  activity: new Map(),
  loaded: false,
  version: 0,
};
const noSubscribe = () => () => {};
const idle = () => IDLE;

export function useApprovals(options: ApprovalsOptions): Approvals {
  const { api, workspaceId, feed, settings } = options;
  const pollRef = useRef(settings["workflows.live.poll_seconds"]);
  pollRef.current = settings["workflows.live.poll_seconds"];
  const [tracker, setTracker] = useState<LiveRuns | null>(null);
  useEffect(() => {
    if (!api) {
      setTracker(null);
      return;
    }
    const t = createLiveRuns({
      api,
      workspaceId,
      pollSeconds: () => pollRef.current,
      log: (m) => console.warn(`[runs] ${m}`),
    });
    setTracker(t);
    void t.refresh();
    return () => t.stop();
  }, [api, workspaceId]);
  // The feed wakes it; the wake connection is the Store's own.
  useEffect(() => {
    if (!tracker || !feed) return;
    return feed.onRuns(() => tracker.wake());
  }, [tracker, feed]);

  const source = useMemo(
    () =>
      tracker
        ? {
            subscribe: (l: () => void) => tracker.subscribe(l),
            snapshot: () => tracker.snapshot(),
          }
        : { subscribe: noSubscribe, snapshot: idle },
    [tracker],
  );
  const live = useSyncExternalStore(source.subscribe, source.snapshot, source.snapshot);

  // Once per waiting Step, from the first answer on.
  const told = useRef<ReadonlySet<string>>(new Set());
  const tellRef = useRef(options.tell);
  tellRef.current = options.tell;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const nowRef = useRef(options.now);
  nowRef.current = options.now;
  useEffect(() => {
    if (!live.loaded) return;
    const due = approvalNotices({
      live,
      told: told.current,
      settings: settingsRef.current,
      now: nowRef.current?.() ?? new Date(),
    });
    told.current = due.told;
    for (const n of due.notices) tellRef.current?.(n);
  }, [live]);

  const strings = settings;
  const items = useMemo(
    () =>
      approvalItems({
        live,
        session: options.session,
        external: options.external,
        strings,
      }),
    [live, options.session, options.external, strings],
  );
  return {
    live,
    items,
    running: runCounts(live).running,
    count: items.length,
    async decideRun(run, decision, standing) {
      if (!tracker) return;
      await tracker.decide(run.id, decision, standing);
    },
    refresh() {
      void tracker?.refresh();
    },
  };
}
