// Boards' intelligence (docs/spec/boards.md, "Code, Jev, language model"):
// the stored Boards (../../boards) plus where their Threads land on the
// Server's answers. Code owns the scope, the Lanes, the three-valued logic
// and the counts; Jev answers the Board's Signals in the ordinary Signal
// request; the language model writes and revises the document (slice 40).

import type {
  Board,
  BoardContext,
  BoardDoc,
  BoardPlacement,
  BoardThread,
  BoardView,
  Id,
} from "@monday/shared";
import { boardView, scopeSince } from "@monday/shared";
import { eq } from "drizzle-orm";
import { BoardNotFoundError, type BoardStore, decidingSignal } from "../../boards/index.ts";
import { loadBoardThreads } from "../../boards/threads.ts";
import type { Db } from "../../db/client.ts";
import { accounts, workspaces } from "../../db/schema.ts";
import type { Mailstore } from "../../mailstore/index.ts";
import { readGlobalSettings } from "../../settings/read.ts";
import type { HostedRuntime } from "../runtime/index.ts";
import type { Signals } from "../signals/index.ts";

const CONTEXT_KEYS = [
  "signals.unsure.noul_low",
  "signals.unsure.noul_high",
  "signals.unsure.confidence_below",
  "signals.stale_answers",
  "signals.hysteresis",
  "calendar.time_zone",
] as const;

export interface BoardPlaced {
  threads: BoardThread[];
  view: BoardView;
}

export interface BoardIntelligence {
  store: BoardStore;
  /**
   * Tells the Signal store the Workspace's Boards changed: a new Board's
   * Signals are defined and read over the mail already there (the backfill),
   * a deleted one's lose their consumer. Never throws.
   */
  changed(workspaceId: Id): Promise<void>;
  /** The reading rules, the clock, the zone and the owner, as the Board code takes them. */
  context(workspaceId: Id): Promise<BoardContext>;
  /**
   * Where the Threads in a document's scope land now, on the answers the
   * Server holds, newest first up to the scope's limit (or only `threadIds`).
   */
  place(
    workspaceId: Id,
    doc: BoardDoc,
    options?: {
      threadIds?: readonly Id[] | undefined;
      placements?: Readonly<Record<Id, BoardPlacement>> | undefined;
    },
  ): Promise<BoardPlaced>;
  /**
   * The user moved a Thread on the Board ("Move to", a drag): it stays in
   * that Lane until it changes, and the move is kept as an Example for the
   * deciding Signal of the Lane it left (does not hold) or entered (holds).
   * `lane` null takes the placement back.
   */
  moveThread(boardId: Id, threadId: Id, lane: string | null): Promise<Board>;
}

export interface BoardIntelligenceOptions {
  db: Db;
  mailstore: Mailstore;
  runtime: HostedRuntime;
  signals: Signals;
  store: BoardStore;
  now?: () => Date;
  log?: (message: string) => void;
}

export function createBoardIntelligence(options: BoardIntelligenceOptions): BoardIntelligence {
  const { db, signals, store } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});

  const context = async (workspaceId: Id): Promise<BoardContext> => {
    const s = await readGlobalSettings(db, CONTEXT_KEYS);
    const [owner] = await db
      .select({ address: accounts.address })
      .from(workspaces)
      .innerJoin(accounts, eq(accounts.id, workspaces.accountId))
      .where(eq(workspaces.id, workspaceId));
    return {
      rules: {
        noulLow: s["signals.unsure.noul_low"],
        noulHigh: s["signals.unsure.noul_high"],
        confidenceBelow: s["signals.unsure.confidence_below"],
        staleAnswers: s["signals.stale_answers"],
        hysteresis: s["signals.hysteresis"],
      },
      now: now(),
      zone: s["calendar.time_zone"],
      owner: (owner?.address ?? "").toLowerCase(),
    };
  };

  /** Threads with their answers: the Server's readings, by stored Signal id. */
  const withReadings = async (threads: BoardThread[]): Promise<BoardThread[]> => {
    const readings = await signals.readings(threads.map((t) => t.id));
    return threads.map((t) => ({ ...t, readings: readings.get(t.id) ?? {} }));
  };

  const place: BoardIntelligence["place"] = async (workspaceId, doc, opts = {}) => {
    const ctx = await context(workspaceId);
    const threads = await withReadings(
      await loadBoardThreads(db, {
        workspaceId,
        ...(opts.threadIds
          ? { ids: opts.threadIds }
          : { since: scopeSince(doc.scope.facts, ctx.now, ctx.zone) }),
        limit: opts.threadIds ? opts.threadIds.length : Math.min(doc.scope.limit * 2, 5000),
      }),
    );
    return { threads, view: boardView(doc, threads, ctx, { placements: opts.placements }) };
  };

  return {
    store,
    context,
    async changed(workspaceId) {
      try {
        await signals.defs(workspaceId);
      } catch (error) {
        log(`boards ${workspaceId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    place,
    async moveThread(boardId, threadId, lane) {
      const board = await store.get(boardId);
      if (!board) throw new BoardNotFoundError(boardId);
      const placed = await place(board.workspaceId, board.doc, {
        threadIds: [threadId],
        placements: board.placements,
      });
      const thread = placed.threads[0];
      if (!thread) throw new BoardNotFoundError(`${boardId} thread ${threadId}`);
      const was = placed.view.lanesOf.get(threadId) ?? null;
      const at = { lane, messageCount: thread.messageCount, from: was };
      if (lane === null) return store.place(boardId, threadId, at);
      let subject = "";
      try {
        subject = await options.mailstore.readThreadSubject(threadId);
      } catch {}
      const who = { ...(thread.from ? { from: thread.from } : {}), subject };
      // The Lane the user chose, and the evidence for the Signal that decided between the two Lanes.
      const evidence = decidingSignal(board.doc, was, lane);
      return store.place(boardId, threadId, at, [
        { signal: "_lanes", lane, ...who },
        ...(evidence ? [{ ...evidence, ...who }] : []),
      ]);
    },
  };
}
