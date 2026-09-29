// The Boards a screen reads, live from the Cache (docs/spec/boards.md): the
// pinned Boards in nav order (kept in step with the Server by cache.ts), and
// one Board's view, its Lanes computed on the Device from thread_signals and
// thread_facts in SQLite, updated as the answers and the Facts change (a new
// Thread lands in its Lane when its Signal request answers; a Thread moves
// when its answers change). Outside a StoreProvider nothing is listed.

import type { Board, BoardContext, BoardDoc, BoardView, Settings } from "@monday/shared";
import { boardView, scopeSince } from "@monday/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { useShell } from "../shell/Shell.tsx";
import {
  BOARDS_SQL,
  boardThreadsSql,
  type CachedBoardThread,
  rowToBoard,
  rowToBoardThread,
} from "../store/boards.ts";
import { useOptionalStore } from "../store/react.tsx";
import type { Store } from "../store/store.ts";
import { useWorkspace } from "../workspace.tsx";
import { ensureBoardSync } from "./cache.ts";

/** The Board code's context from the Settings: the reading rules, the zone, the owner. */
export function boardContextOf(settings: Settings, owner: string, now: Date): BoardContext {
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

/** The Workspace's Boards not deleted, pinned or not, in nav order; undefined until the Cache answered. */
export function useBoards(): Board[] | undefined {
  const shell = useShell();
  const store = useOptionalStore();
  const [boards, setBoards] = useState<Board[] | undefined>(undefined);
  const enabled = shell.settings["boards.enabled"];
  useEffect(() => {
    if (!store || !enabled) {
      setBoards(store ? [] : undefined);
      return;
    }
    if (shell.server) ensureBoardSync(store, (workspaceId) => shell.api.boards.list(workspaceId));
    const live = store.live<Record<string, unknown>>(BOARDS_SQL, []);
    const off = live.subscribe((rows) =>
      setBoards(rows.flatMap((r) => rowToBoard(r, store.workspaceId) ?? [])),
    );
    return () => {
      off();
      live.close();
    };
  }, [store, shell.api, shell.server, enabled]);
  return boards;
}

/** The rows a Board reads from the Cache, live; undefined until the first read. */
function useBoardThreads(
  store: Store | null,
  doc: BoardDoc | null,
  since: Date | null,
): CachedBoardThread[] | undefined {
  const [threads, setThreads] = useState<CachedBoardThread[] | undefined>(undefined);
  const query = useMemo(
    () =>
      doc ? boardThreadsSql(doc.scope.facts, since, Math.min(doc.scope.limit * 2, 5000)) : null,
    [doc, since],
  );
  useEffect(() => {
    if (!store || !query) {
      setThreads(undefined);
      return;
    }
    const live = store.live<Record<string, unknown>>(query.sql, query.params);
    const off = live.subscribe((rows) =>
      setThreads(rows.map((r) => rowToBoardThread(r, store.workspaceId))),
    );
    return () => {
      off();
      live.close();
    };
  }, [store, query]);
  return threads;
}

/** The start of the scope's dates, recomputed per day so "today" turns over at midnight. */
function useScopeSince(doc: BoardDoc | null, ctx: BoardContext): Date | null {
  const day = ctx.now.toDateString();
  // biome-ignore lint/correctness/useExhaustiveDependencies: the dates resolve per day, not per clock tick
  return useMemo(
    () => (doc ? scopeSince(doc.scope.facts, ctx.now, ctx.zone) : null),
    [doc, day, ctx.zone],
  );
}

/**
 * One Board's view over the Cache, live. Hysteresis reads where each Thread
 * was on the last read, so a Thread near a threshold does not flicker.
 */
export function useBoardView(
  board: Board | null,
  now: Date,
): { view: BoardView<CachedBoardThread> | undefined; context: BoardContext } {
  const shell = useShell();
  const ws = useWorkspace();
  const store = useOptionalStore();
  const ctx = useMemo(
    () => boardContextOf(shell.settings, ws.address, now),
    [shell.settings, ws.address, now],
  );
  const doc = board?.doc ?? null;
  const since = useScopeSince(doc, ctx);
  const threads = useBoardThreads(store, doc, since);
  const previous = useRef<{ id: string; lanes: Map<string, string> } | null>(null);
  const view = useMemo(() => {
    if (!board || !threads) return undefined;
    const before = previous.current?.id === board.id ? previous.current.lanes : undefined;
    const v = boardView(board.doc, threads, ctx, {
      previous: before,
      placements: board.placements,
      unsureLabel: shell.settings["strings.boards.unsure"],
      othersLabel: shell.settings["strings.boards.everything_else"],
    });
    previous.current = { id: board.id, lanes: v.lanesOf };
    return v;
  }, [board, threads, ctx, shell.settings]);
  return { view, context: ctx };
}

/**
 * The nav's number for each pinned Board, live: the count of the Lane the
 * Board names, else its total. Empty while boards.nav.show_counts is off.
 */
export function useBoardCounts(
  boards: readonly Board[] | undefined,
  now: Date,
): Record<string, number> {
  const shell = useShell();
  const ws = useWorkspace();
  const store = useOptionalStore();
  const show = shell.settings["boards.nav.show_counts"];
  const [counts, setCounts] = useState<Record<string, number>>({});
  const day = now.toDateString();
  // The context changes with the Settings and the day, never with each clock tick.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the day stands for the clock
  const ctx = useMemo(
    () => boardContextOf(shell.settings, ws.address, now),
    [shell.settings, ws.address, day],
  );
  const pinned = useMemo(() => (boards ?? []).filter((b) => b.pinned), [boards]);
  useEffect(() => {
    if (!store || !show || pinned.length === 0) {
      setCounts({});
      return;
    }
    const offs = pinned.map((b) => {
      const q = boardThreadsSql(
        b.doc.scope.facts,
        scopeSince(b.doc.scope.facts, ctx.now, ctx.zone),
        Math.min(b.doc.scope.limit * 2, 5000),
      );
      const live = store.live<Record<string, unknown>>(q.sql, q.params);
      const off = live.subscribe((rows) => {
        const threads = rows.map((r) => rowToBoardThread(r, store.workspaceId));
        const n = boardView(b.doc, threads, ctx, { placements: b.placements }).navCount;
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
