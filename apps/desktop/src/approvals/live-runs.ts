// The Workspace's live Workflow Runs (queued, running, paused), kept for the
// whole window: the nav's running count, the Approvals queue, the approval
// notices and the Workflows page's live flow all read them from here. They
// are asked for once on start, again whenever the Store's Changes feed says a
// Run moved (a `run` change on the wake connection the Store already holds,
// so no connection of its own), and, only while a Run is queued or running,
// every workflows.live.poll_seconds as a safety net. A Run paused on an
// approval can wait for days: it is never polled, the feed says when it moves.
// The waiting Step's Activity row (what it wants to do, the card's preview)
// is read once per waiting Step.

import type { ActivityRecord, RunView, WorkflowView } from "@monday/shared";
import type { WorkflowsApi } from "../screens/workflows/workflow-data.ts";

/** The Run statuses that are still going or waiting. */
export const LIVE_STATUSES: readonly RunView["status"][] = ["queued", "running", "paused"];

export type LiveRunsApi = Pick<WorkflowsApi, "runs" | "list" | "runActivity" | "decide">;

export interface LiveRunsSnapshot {
  /** Live Runs, newest first. */
  runs: readonly RunView[];
  /** The Workspace's Workflows by id, for names and Step counts. */
  workflows: ReadonlyMap<string, WorkflowView>;
  /**
   * The waiting Activity row by its id, once read; null when it could not be
   * read (the Step's own line stands in). Absent while it is being read.
   */
  activity: ReadonlyMap<string, ActivityRecord | null>;
  /** Whether the first answer arrived. */
  loaded: boolean;
  /** Bumped on every answer that changed something, for screens that re-read on it. */
  version: number;
}

export interface LiveRunsTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface LiveRunsOptions {
  api: LiveRunsApi;
  workspaceId: string;
  /** workflows.live.poll_seconds, read each time a poll is planned. */
  pollSeconds: () => number;
  /** How long a burst of feed wakes is gathered into one read. */
  wakeDelayMs?: number | undefined;
  timers?: LiveRunsTimers | undefined;
  log?: ((message: string) => void) | undefined;
}

export interface LiveRuns {
  snapshot(): LiveRunsSnapshot;
  subscribe(listener: () => void): () => void;
  /** Reads the live Runs now; a read already under way runs once more after it. */
  refresh(): Promise<void>;
  /** The feed said a Run moved: one read soon, however many wakes arrive meanwhile. */
  wake(): void;
  /**
   * Answers a paused Run through POST /workflows/runs/:id/approvals, the
   * route the Workflows page uses (ADR 0002 unchanged); the Run leaves the
   * live list at once and the next read says where it went.
   */
  decide(
    runId: string,
    decision: "approved" | "declined",
    standing: boolean,
  ): Promise<RunView | null>;
  stop(): void;
}

const EMPTY: LiveRunsSnapshot = {
  runs: [],
  workflows: new Map(),
  activity: new Map(),
  loaded: false,
  version: 0,
};

const defaultTimers: LiveRunsTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** What a snapshot shows, as one string: an answer that changes none of it is not news. */
function fingerprint(s: Omit<LiveRunsSnapshot, "version">): string {
  return JSON.stringify([
    s.loaded,
    s.runs.map((r) => [
      r.id,
      r.status,
      r.currentStep,
      r.waitingActivityId,
      r.error,
      r.steps.map((st) => `${st.index}:${st.status}:${st.detail}`),
    ]),
    [...s.workflows.values()].map((w) => [w.id, w.name, w.version, w.steps.length]),
    [...s.activity.entries()].map(([id, a]) => [id, a?.status ?? null]),
  ]);
}

export function createLiveRuns(options: LiveRunsOptions): LiveRuns {
  const { api, workspaceId } = options;
  const timers = options.timers ?? defaultTimers;
  const log = options.log ?? (() => {});
  const wakeDelay = options.wakeDelayMs ?? 150;
  let state: LiveRunsSnapshot = EMPTY;
  let printed = fingerprint(EMPTY);
  const listeners = new Set<() => void>();
  let reading: Promise<void> | null = null;
  let again = false;
  let pollTimer: unknown = null;
  let wakeTimer: unknown = null;
  let stopped = false;
  /**
   * Runs answered here, by the approval answered: the Run stays paused on the
   * Server until its Step runs again, and is kept out of the list meanwhile.
   */
  const answered = new Map<string, string | null>();

  const publish = (next: Omit<LiveRunsSnapshot, "version">) => {
    const print = fingerprint(next);
    if (print === printed && state.loaded === next.loaded) return;
    printed = print;
    state = { ...next, version: state.version + 1 };
    for (const l of [...listeners]) l();
  };

  const plan = () => {
    if (pollTimer !== null) timers.clear(pollTimer);
    pollTimer = null;
    if (stopped) return;
    const seconds = options.pollSeconds();
    const going = state.runs.some((r) => r.status === "queued" || r.status === "running");
    if (!going || !(seconds > 0)) return;
    pollTimer = timers.set(() => {
      pollTimer = null;
      void refresh();
    }, seconds * 1000);
  };

  const readOnce = async () => {
    const runs = await api.runs(workspaceId, { status: LIVE_STATUSES });
    // A Run answered here stays out until a read shows it moved on (running,
    // finished, or paused again on another approval).
    for (const [id, waiting] of [...answered]) {
      const r = runs.find((x) => x.id === id);
      if (r?.status !== "paused" || r.waitingActivityId !== waiting) answered.delete(id);
    }
    const live = runs.filter((r) => !answered.has(r.id));
    let workflows = state.workflows;
    const known = new Set(state.runs.map((r) => r.id));
    // The names are read again when a Run appears (a new or renamed Workflow shows with it).
    if (!state.loaded || live.some((r) => !known.has(r.id) || !workflows.has(r.workflowId))) {
      workflows = new Map((await api.list(workspaceId)).map((w) => [w.id, w]));
    }
    const activity = new Map<string, ActivityRecord | null>();
    for (const r of live) {
      const id = r.waitingActivityId;
      if (r.status !== "paused" || !id) continue;
      if (state.activity.has(id)) {
        activity.set(id, state.activity.get(id) ?? null);
        continue;
      }
      try {
        const rows = await api.runActivity(r.id);
        activity.set(
          id,
          rows.find((a) => a.id === id) ?? rows.find((a) => a.status === "waiting") ?? null,
        );
      } catch (error) {
        log(`run ${r.id}: its waiting step could not be read: ${String(error)}`);
        activity.set(id, null);
      }
    }
    if (stopped) return;
    publish({ runs: live, workflows, activity, loaded: true });
  };

  const refresh = async (): Promise<void> => {
    if (stopped) return;
    if (reading) {
      again = true;
      return reading;
    }
    reading = (async () => {
      do {
        again = false;
        try {
          await readOnce();
        } catch (error) {
          log(`live runs: ${String(error)}`);
        }
      } while (again && !stopped);
    })();
    try {
      await reading;
    } finally {
      reading = null;
      plan();
    }
  };

  return {
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    wake() {
      if (stopped || wakeTimer !== null) return;
      wakeTimer = timers.set(() => {
        wakeTimer = null;
        void refresh();
      }, wakeDelay);
    },
    async decide(runId, decision, standing) {
      const waiting = state.runs.find((r) => r.id === runId)?.waitingActivityId ?? null;
      const answer = await api.decide(runId, decision, standing);
      answered.set(runId, waiting);
      publish({ ...state, runs: state.runs.filter((r) => r.id !== runId) });
      void refresh();
      return answer;
    },
    stop() {
      stopped = true;
      if (pollTimer !== null) timers.clear(pollTimer);
      if (wakeTimer !== null) timers.clear(wakeTimer);
      pollTimer = null;
      wakeTimer = null;
      listeners.clear();
    },
  };
}
