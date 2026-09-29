// The Views a screen reads, live from the Cache (docs/spec/views.md): the
// pinned Views in nav order (kept in step with the Server by cache.ts), and
// one View's lanes, its Lanes computed on the Device from thread_signals and
// thread_facts in SQLite, updated as the answers and the Facts change (a new
// Thread lands in its Lane when its Signal request answers; a Thread moves
// when its answers change). Outside a StoreProvider nothing is listed.

import type { LaneView, Settings, View, ViewContext, ViewDoc } from "@monday/shared";
import { laneView, scopeSince } from "@monday/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { useShell } from "../shell/Shell.tsx";
import { useOptionalStore } from "../store/react.tsx";
import type { Store } from "../store/store.ts";
import {
  type CachedViewThread,
  rowToView,
  rowToViewThread,
  VIEWS_SQL,
  viewThreadsSql,
} from "../store/views.ts";
import { useWorkspace } from "../workspace.tsx";
import { ensureViewSync } from "./cache.ts";

/** The View code's context from the Settings: the reading rules, the zone, the owner. */
export function viewContextOf(settings: Settings, owner: string, now: Date): ViewContext {
  return {
    rules: {
      noulLow: settings["signals.unsure.noul_low"],
      noulHigh: settings["signals.unsure.noul_high"],
      confidenceBelow: settings["signals.unsure.confidence_below"],
      staleAnswers: settings["signals.stale_answers"],
      hysteresis: settings["signals.hysteresis"],
    },
    now,
    zone: settings["calendar.time_zone"],
    owner: owner.toLowerCase(),
  };
}

/** The Workspace's Views not deleted, pinned or not, in nav order; undefined until the Cache answered. */
export function useViews(): View[] | undefined {
  const shell = useShell();
  const store = useOptionalStore();
  const [views, setViews] = useState<View[] | undefined>(undefined);
  const enabled = shell.settings["views.enabled"];
  useEffect(() => {
    if (!store || !enabled) {
      setViews(store ? [] : undefined);
      return;
    }
    if (shell.server) {
      const api = shell.api.views;
      ensureViewSync(store, {
        list: (workspaceId) => api.list(workspaceId),
        values: (viewId) => api.values(viewId),
        valuesFor: (workspaceId, threadIds) => api.valuesFor(workspaceId, threadIds),
      });
    }
    const live = store.live<Record<string, unknown>>(VIEWS_SQL, []);
    const off = live.subscribe((rows) =>
      setViews(rows.flatMap((r) => rowToView(r, store.workspaceId) ?? [])),
    );
    return () => {
      off();
      live.close();
    };
  }, [store, shell.api, shell.server, enabled]);
  return views;
}

/** The rows a View reads from the Cache, live; undefined until the first read. */
function useViewThreads(
  store: Store | null,
  doc: ViewDoc | null,
  since: Date | null,
): CachedViewThread[] | undefined {
  const [threads, setThreads] = useState<CachedViewThread[] | undefined>(undefined);
  const query = useMemo(
    () =>
      doc ? viewThreadsSql(doc.scope.facts, since, Math.min(doc.scope.limit * 2, 5000)) : null,
    [doc, since],
  );
  useEffect(() => {
    if (!store || !query) {
      setThreads(undefined);
      return;
    }
    const live = store.live<Record<string, unknown>>(query.sql, query.params);
    const off = live.subscribe((rows) =>
      setThreads(rows.map((r) => rowToViewThread(r, store.workspaceId))),
    );
    return () => {
      off();
      live.close();
    };
  }, [store, query]);
  return threads;
}

/** The start of the scope's dates, recomputed per day so "today" turns over at midnight. */
function useScopeSince(doc: ViewDoc | null, ctx: ViewContext): Date | null {
  const day = ctx.now.toDateString();
  // biome-ignore lint/correctness/useExhaustiveDependencies: the dates resolve per day, not per clock tick
  return useMemo(
    () => (doc ? scopeSince(doc.scope.facts, ctx.now, ctx.zone) : null),
    [doc, day, ctx.zone],
  );
}

/**
 * One View's lanes over the Cache, live. Hysteresis reads where each Thread
 * was on the last read, so a Thread near a threshold does not flicker.
 */
export function useLaneView(
  view: View | null,
  now: Date,
): { lanes: LaneView<CachedViewThread> | undefined; context: ViewContext } {
  const shell = useShell();
  const ws = useWorkspace();
  const store = useOptionalStore();
  const ctx = useMemo(
    () => viewContextOf(shell.settings, ws.address, now),
    [shell.settings, ws.address, now],
  );
  const doc = view?.doc ?? null;
  const since = useScopeSince(doc, ctx);
  const threads = useViewThreads(store, doc, since);
  const previous = useRef<{ id: string; lanes: Map<string, string> } | null>(null);
  const lanes = useMemo(() => {
    if (!view || !threads) return undefined;
    const before = previous.current?.id === view.id ? previous.current.lanes : undefined;
    const v = laneView(view.doc, threads, ctx, {
      previous: before,
      placements: view.placements,
      unsureLabel: shell.settings["strings.views.unsure"],
      othersLabel: shell.settings["strings.views.everything_else"],
    });
    previous.current = { id: view.id, lanes: v.lanesOf };
    return v;
  }, [view, threads, ctx, shell.settings]);
  return { lanes, context: ctx };
}

/**
 * The nav's number for each pinned View, live: the count of the Lane the
 * View names, else its total. Empty while views.nav.show_counts is off.
 */
export function useViewCounts(
  views: readonly View[] | undefined,
  now: Date,
): Record<string, number> {
  const shell = useShell();
  const ws = useWorkspace();
  const store = useOptionalStore();
  const show = shell.settings["views.nav.show_counts"];
  const [counts, setCounts] = useState<Record<string, number>>({});
  const day = now.toDateString();
  // The context changes with the Settings and the day, never with each clock tick.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the day stands for the clock
  const ctx = useMemo(
    () => viewContextOf(shell.settings, ws.address, now),
    [shell.settings, ws.address, day],
  );
  const pinned = useMemo(() => (views ?? []).filter((b) => b.pinned), [views]);
  useEffect(() => {
    if (!store || !show || pinned.length === 0) {
      setCounts({});
      return;
    }
    const offs = pinned.map((b) => {
      const q = viewThreadsSql(
        b.doc.scope.facts,
        scopeSince(b.doc.scope.facts, ctx.now, ctx.zone),
        Math.min(b.doc.scope.limit * 2, 5000),
      );
      const live = store.live<Record<string, unknown>>(q.sql, q.params);
      const off = live.subscribe((rows) => {
        const threads = rows.map((r) => rowToViewThread(r, store.workspaceId));
        const n = laneView(b.doc, threads, ctx, { placements: b.placements }).navCount;
        setCounts((c) => (c[b.id] === n ? c : { ...c, [b.id]: n }));
      });
      return () => {
        off();
        live.close();
      };
    });
    return () => {
      for (const off of offs) off();
    };
  }, [store, show, pinned, ctx]);
  return counts;
}
