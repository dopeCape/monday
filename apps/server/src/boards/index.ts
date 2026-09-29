// Boards on the Server (docs/spec/boards.md, "Data and sync"). A Board is a
// row in `boards` (its place in the nav, the version in effect, whether it
// is pinned, deleted with Undo) and one sealed document per version in
// `board_versions`; every edit is a new version and the old ones are kept.
// The user's placements and the corrections they made on the Board live
// beside it, sealed. Every write is a `board` row on the Changes feed with
// the headers only, so each Device reads GET /boards again and mirrors the
// documents into the Cache, where the Lanes are computed.
//
// Validated on every write, like a Workflow: the schema and the limits
// (boards.max, boards.max_lanes, boards.max_signals,
// boards.scope.max_threads, signals.max_active), before anything is saved.
// A Board's own Signals become Signal definitions owned by the Board
// (`board:<boardId>:<signalId>`, scoped by its scope's Facts) while it is
// pinned and not deleted; deleting it removes their consumer, and the
// answers stay signals.keep_inactive_days so an Undo asks nothing again.

import type {
  Board,
  BoardChange,
  BoardDoc,
  BoardExample,
  BoardPlacement,
  BoardScopeFacts,
  Id,
  LaneCondition,
  SignalQuestion,
} from "@monday/shared";
import { boardIdFor, boardSignalDefs, validateBoard } from "@monday/shared";
import { and, asc, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { boards as boardsTable, boardVersions, signalDefs } from "../db/schema.ts";
import type { Mailstore } from "../mailstore/index.ts";
import { readGlobalSettings } from "../settings/read.ts";

type BoardRow = typeof boardsTable.$inferSelect;

/** The document would not save: the schema or a limit refused it. */
export class BoardInvalidError extends Error {
  readonly status = 422;
  constructor(readonly errors: string[]) {
    super(errors.join(" "));
    this.name = "BoardInvalidError";
  }
}

export class BoardNotFoundError extends Error {
  readonly status = 404;
  constructor(readonly id: string) {
    super(`board ${id} not found`);
    this.name = "BoardNotFoundError";
  }
}

/** A limit refused a new Board or a new Signal, before anything was saved. */
export class BoardLimitError extends Error {
  readonly status = 409;
  constructor(
    readonly reason: "boards" | "signals" | "judge" | "test",
    message: string,
  ) {
    super(message);
    this.name = "BoardLimitError";
  }
}

const SETTING_KEYS = [
  "boards.max",
  "boards.max_lanes",
  "boards.max_signals",
  "boards.scope.max_threads",
  "boards.examples_in_question",
  "signals.max_active",
  "signals.keep_inactive_days",
  "signals.backfill.scope",
] as const;

/** What lives beside a Board's document: the user's placements and the corrections they made on it. */
interface Extras {
  placements: Record<Id, BoardPlacement>;
  /** Corrections made on the Board, not yet folded into its questions, by Signal. */
  examples: Record<string, BoardExample[]>;
}

const NO_EXTRAS: Extras = { placements: {}, examples: {} };

/** A Board's Signal as the Signal store takes it. */
export interface BoardSignalWanted {
  id: string;
  kind: "noul" | "choice" | "score";
  question: SignalQuestion;
  facts: BoardScopeFacts;
  boardId: Id;
  /** The Board's name, who uses it. */
  consumer: string;
}

export interface BoardStore {
  /** The Workspace's Boards not deleted, in nav order. Throws LockedError when locked. */
  list(workspaceId: Id): Promise<Board[]>;
  /** One Board, deleted or not; null when there is none. */
  get(id: Id): Promise<Board | null>;
  /** An older version's document. */
  version(id: Id, version: number): Promise<BoardDoc | null>;
  /** Saves a new Board at version 1, pinned last in the nav. Validates and checks the limits first. */
  create(
    workspaceId: Id,
    doc: unknown,
    options?: { checkBar?: boolean | undefined; pinned?: boolean | undefined },
  ): Promise<Board>;
  /** Saves a new version of a Board's document; returns it and the version it replaced. */
  update(id: Id, doc: unknown): Promise<{ board: Board; previous: number }>;
  /** Puts an older version back in effect (Undo of an edit). */
  revert(id: Id, version: number): Promise<Board>;
  /** Moves a Board up (-1) or down (1) in the nav; returns the Boards in their new order. */
  move(id: Id, by: -1 | 1): Promise<Board[]>;
  setPinned(id: Id, pinned: boolean): Promise<Board>;
  /** Deletes with Undo: out of the nav, its Signals lose their consumer. */
  remove(id: Id): Promise<Board>;
  /** Undo of a delete: the Board comes back as it was, its answers still there. */
  restore(id: Id): Promise<Board>;
  /**
   * A Thread the user placed by hand on the Board ("Move to", a drag): it
   * stays there until the Thread changes, and the correction is kept for the
   * Lane's deciding Signal. `lane` null takes the placement back.
   */
  place(
    id: Id,
    threadId: Id,
    placement: { lane: string | null; messageCount: number; from: string | null },
    examples?: ReadonlyArray<{
      /** A Signal's local id, or `_lanes` for the Lane the user chose. */
      signal: string;
      holds?: boolean | undefined;
      lane?: string | undefined;
      from?: string | undefined;
      subject?: string | undefined;
    }>,
  ): Promise<Board>;
  /** The corrections made on the Board, not yet folded into its questions. */
  corrections(id: Id): Promise<Record<string, BoardExample[]>>;
  /** Forgets the corrections once they were folded into a new version. */
  clearCorrections(id: Id): Promise<void>;
  dismissCheck(id: Id): Promise<Board>;
  /** The Signals every pinned Board in the Workspace declares. */
  signalsWanted(workspaceId: Id): Promise<BoardSignalWanted[]>;
}

export interface BoardStoreOptions {
  db: Db;
  mailstore: Mailstore;
  now?: () => Date;
}

/** The feed's headers for a row. */
export function boardHeaders(r: BoardRow): BoardChange {
  return {
    id: r.id,
    version: r.version,
    pinned: r.pinned,
    position: r.position,
    deleted: r.deletedAt !== null,
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** How many own Signals a document adds to the active set. */
function ownSignals(doc: BoardDoc): string[] {
  return doc.signals.map((s) => `board:${doc.id}:${s.id}`);
}

/** The own Nouls a Lane requires to hold (inside its `all`s), in order. */
function requiredNouls(doc: BoardDoc, laneId: string | null): string[] {
  const lane = doc.lanes.find((l) => l.id === laneId);
  if (!lane) return [];
  const own = new Set(doc.signals.filter((s) => s.kind === "noul").map((s) => s.id));
  const out: string[] = [];
  const walk = (c: LaneCondition) => {
    if ("all" in c) c.all.forEach(walk);
    else if ("signal" in c && c.holds === true && own.has(c.signal) && !out.includes(c.signal)) {
      out.push(c.signal);
    }
  };
  walk(lane.when);
  return out;
}

/**
 * The Signal a move is evidence for, and which way: the first own Noul the
 * Lane it left required and the Lane it entered does not (it does not hold),
 * else the first the entered Lane requires and the left one did not (it
 * holds). Null when the move says nothing about a Noul (a Score decided).
 */
export function decidingSignal(
  doc: BoardDoc,
  from: string | null,
  to: string | null,
): { signal: string; holds: boolean } | null {
  const left = requiredNouls(doc, from);
  const entered = requiredNouls(doc, to);
  const out = left.find((s) => !entered.includes(s));
  if (out) return { signal: out, holds: false };
  const into = entered.find((s) => !left.includes(s));
  return into ? { signal: into, holds: true } : null;
}

export function createBoardStore(options: BoardStoreOptions): BoardStore {
  const { db, mailstore } = options;
  const now = options.now ?? (() => new Date());
  const settings = () => readGlobalSettings(db, SETTING_KEYS);

  const seal = async (workspaceId: Id, value: unknown) => {
    const ref = await mailstore.storeContent(workspaceId, "board", JSON.stringify(value));
    const enc = ref.chunks[0];
    if (!enc) throw new RangeError("board envelope missing");
    return { enc, key: ref.key };
  };
  const open = async <T>(workspaceId: Id, enc: Uint8Array, key: Uint8Array): Promise<T> =>
    JSON.parse(
      await mailstore.readText({ workspaceId, kind: "board", key, chunks: [enc], size: -1 }),
    ) as T;

  const row = async (id: Id): Promise<BoardRow | null> =>
    (await db.query.boards.findFirst({ where: eq(boardsTable.id, id) })) ?? null;

  const docAt = async (r: Pick<BoardRow, "id" | "workspaceId">, version: number) => {
    const [v] = await db
      .select()
      .from(boardVersions)
      .where(and(eq(boardVersions.boardId, r.id), eq(boardVersions.version, version)));
    return v ? open<BoardDoc>(r.workspaceId, v.contentEnc, v.contentKey) : null;
  };

  const extrasOf = async (r: BoardRow): Promise<Extras> =>
    r.extrasEnc && r.extrasKey ? open<Extras>(r.workspaceId, r.extrasEnc, r.extrasKey) : NO_EXTRAS;

  const toBoard = async (r: BoardRow): Promise<Board> => {
    const doc = await docAt(r, r.version);
    if (!doc) throw new BoardNotFoundError(r.id);
    const extras = await extrasOf(r);
    return {
      id: r.id,
      workspaceId: r.workspaceId,
      version: r.version,
      pinned: r.pinned,
      position: r.position,
      deletedAt: r.deletedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      doc: { ...doc, version: r.version },
      placements: extras.placements,
      checkBar: r.checkBar,
    };
  };

  /**
   * The Signals each Workspace's Boards declare, read on every Signal request:
   * kept a few seconds and dropped on every write here, so a new or deleted
   * Board is seen at once on this Server and within seconds on another.
   */
  const wantedCache = new Map<Id, { at: number; value: BoardSignalWanted[] }>();
  const record = (executor: Db | Tx, r: BoardRow) => {
    wantedCache.delete(r.workspaceId);
    return mailstore.recordChange(executor, {
      workspaceId: r.workspaceId,
      kind: "board",
      entityId: r.id,
      payload: boardHeaders(r),
    });
  };

  const mustRow = async (id: Id) => {
    const r = await row(id);
    if (!r) throw new BoardNotFoundError(id);
    return r;
  };

  const validated = async (input: unknown): Promise<BoardDoc> => {
    const s = await settings();
    const r = validateBoard(input, {
      maxLanes: s["boards.max_lanes"],
      maxSignals: s["boards.max_signals"],
      maxThreads: s["boards.scope.max_threads"],
    });
    if (!r.ok) throw new BoardInvalidError(r.errors);
    return r.doc;
  };

  /** Refuses a document whose new Signals would pass signals.max_active. */
  const checkActive = async (workspaceId: Id, doc: BoardDoc, replacing: BoardDoc | null) => {
    const s = await settings();
    const mine = new Set(replacing ? ownSignals(replacing) : []);
    const fresh = ownSignals(doc).filter((id) => !mine.has(id));
    if (fresh.length === 0) return;
    const [counted] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(signalDefs)
      .where(and(eq(signalDefs.workspaceId, workspaceId), eq(signalDefs.active, true)));
    const active = Number(counted?.n ?? 0);
    if (active + fresh.length > s["signals.max_active"]) {
      throw new BoardLimitError(
        "signals",
        `This Board adds ${fresh.length} questions to the ${active} monday already asks of every new thread; the most is ${s["signals.max_active"]}. Remove a question, or retire one on the Signals page.`,
      );
    }
  };

  const liveRows = (workspaceId: Id) =>
    db
      .select()
      .from(boardsTable)
      .where(and(eq(boardsTable.workspaceId, workspaceId), isNull(boardsTable.deletedAt)))
      .orderBy(asc(boardsTable.position), asc(boardsTable.createdAt));

  /** Past the keep window a deleted Board goes for good. */
  const sweep = async (workspaceId: Id) => {
    const s = await settings();
    const cutoff = new Date(now().getTime() - s["signals.keep_inactive_days"] * 86_400_000);
    await db
      .delete(boardsTable)
      .where(
        and(
          eq(boardsTable.workspaceId, workspaceId),
          isNotNull(boardsTable.deletedAt),
          lt(boardsTable.deletedAt, cutoff),
        ),
      );
  };

  const saveExtras = async (r: BoardRow, extras: Extras) => {
    const sealed = await seal(r.workspaceId, extras);
    const [updated] = await db
      .update(boardsTable)
      .set({ extrasEnc: sealed.enc, extrasKey: sealed.key, updatedAt: now() })
      .where(eq(boardsTable.id, r.id))
      .returning();
    if (!updated) throw new BoardNotFoundError(r.id);
    await record(db, updated);
    return updated;
  };

  const store: BoardStore = {
    async list(workspaceId) {
      await sweep(workspaceId);
      return Promise.all((await liveRows(workspaceId)).map(toBoard));
    },

    async get(id) {
      const r = await row(id);
      return r ? toBoard(r) : null;
    },

    async version(id, version) {
      const r = await mustRow(id);
      return docAt(r, version);
    },

    async create(workspaceId, input, opts = {}) {
      const s = await settings();
      const live = await liveRows(workspaceId);
      const pinned = opts.pinned ?? true;
      if (pinned && live.filter((b) => b.pinned).length >= s["boards.max"]) {
        throw new BoardLimitError(
          "boards",
          `You have ${s["boards.max"]} boards, the most there can be. Delete one first.`,
        );
      }
      const raw = (input ?? {}) as Record<string, unknown>;
      const taken = new Set(
        (await db.select({ id: boardsTable.id }).from(boardsTable)).map((b) => b.id),
      );
      const wantedId = typeof raw.id === "string" && raw.id ? raw.id : null;
      const id =
        wantedId && !taken.has(wantedId)
          ? wantedId
          : boardIdFor(typeof raw.name === "string" ? raw.name : "board", taken);
      const doc = await validated({ ...raw, id, version: 1 });
      await checkActive(workspaceId, doc, null);
      const at = now();
      const sealed = await seal(workspaceId, doc);
      const position = live.reduce((max, b) => Math.max(max, b.position + 1), 0);
      const inserted = await db.transaction(async (tx) => {
        const [r] = await tx
          .insert(boardsTable)
          .values({
            id,
            workspaceId,
            version: 1,
            pinned,
            position,
            checkBar: opts.checkBar ?? false,
            createdAt: at,
            updatedAt: at,
          })
          .returning();
        if (!r) throw new Error("board insert failed");
        await tx.insert(boardVersions).values({
          id: `${id}@1`,
          boardId: id,
          workspaceId,
          version: 1,
          contentEnc: sealed.enc,
          contentKey: sealed.key,
          createdAt: at,
        });
        await record(tx, r);
        return r;
      });
      return toBoard(inserted);
    },

    async update(id, input) {
      const r = await mustRow(id);
      const current = await docAt(r, r.version);
      const [max] = await db
        .select({ v: sql<number>`max(${boardVersions.version})::int` })
        .from(boardVersions)
        .where(eq(boardVersions.boardId, id));
      const version = Number(max?.v ?? r.version) + 1;
      const doc = await validated({ ...(input as Record<string, unknown>), id, version });
      await checkActive(r.workspaceId, doc, current);
      const sealed = await seal(r.workspaceId, doc);
      const at = now();
      const updated = await db.transaction(async (tx) => {
        await tx.insert(boardVersions).values({
          id: `${id}@${version}`,
          boardId: id,
          workspaceId: r.workspaceId,
          version,
          contentEnc: sealed.enc,
          contentKey: sealed.key,
          createdAt: at,
        });
        const [u] = await tx
          .update(boardsTable)
          .set({ version, updatedAt: at })
          .where(eq(boardsTable.id, id))
          .returning();
        if (!u) throw new BoardNotFoundError(id);
        await record(tx, u);
        return u;
      });
      return { board: await toBoard(updated), previous: r.version };
    },

    async revert(id, version) {
      const r = await mustRow(id);
      if (!(await docAt(r, version))) throw new BoardNotFoundError(`${id} version ${version}`);
      const [u] = await db
        .update(boardsTable)
        .set({ version, updatedAt: now() })
        .where(eq(boardsTable.id, id))
        .returning();
      if (!u) throw new BoardNotFoundError(id);
      await record(db, u);
      return toBoard(u);
    },

    async move(id, by) {
      const r = await mustRow(id);
      const rows = await liveRows(r.workspaceId);
      const order = rows.map((b) => b.id);
      const from = order.indexOf(id);
      const to = Math.max(0, Math.min(order.length - 1, from + by));
      if (from >= 0 && to !== from) {
        order.splice(from, 1);
        order.splice(to, 0, id);
      }
      const at = now();
      await db.transaction(async (tx) => {
        for (const [position, boardId] of order.entries()) {
          const before = rows.find((b) => b.id === boardId);
          if (before?.position === position) continue;
          const [u] = await tx
            .update(boardsTable)
            .set({ position, updatedAt: at })
            .where(eq(boardsTable.id, boardId))
            .returning();
          if (u) await record(tx, u);
        }
      });
      return store.list(r.workspaceId);
    },

    async setPinned(id, pinned) {
      const r = await mustRow(id);
      if (pinned && !r.pinned) {
        const s = await settings();
        const live = await liveRows(r.workspaceId);
        if (live.filter((b) => b.pinned).length >= s["boards.max"]) {
          throw new BoardLimitError(
            "boards",
            `You have ${s["boards.max"]} boards, the most there can be. Delete one first.`,
          );
        }
      }
      const [u] = await db
        .update(boardsTable)
        .set({ pinned, updatedAt: now() })
        .where(eq(boardsTable.id, id))
        .returning();
      if (!u) throw new BoardNotFoundError(id);
      await record(db, u);
      return toBoard(u);
    },

    async remove(id) {
      await mustRow(id);
      const [u] = await db
        .update(boardsTable)
        .set({ deletedAt: now(), updatedAt: now() })
        .where(eq(boardsTable.id, id))
        .returning();
      if (!u) throw new BoardNotFoundError(id);
      await record(db, u);
      return toBoard(u);
    },

    async restore(id) {
      await mustRow(id);
      const [u] = await db
        .update(boardsTable)
        .set({ deletedAt: null, updatedAt: now() })
        .where(eq(boardsTable.id, id))
        .returning();
      if (!u) throw new BoardNotFoundError(id);
      await record(db, u);
      return toBoard(u);
    },

    async place(id, threadId, placement, given = []) {
      const r = await mustRow(id);
      const extras = await extrasOf(r);
      const placements = { ...extras.placements };
      if (placement.lane === null) delete placements[threadId];
      else {
        placements[threadId] = {
          lane: placement.lane,
          messageCount: placement.messageCount,
          at: now().toISOString(),
          from: placement.from,
        };
      }
      const examples = { ...extras.examples };
      for (const example of given) {
        const list = (examples[example.signal] ?? []).filter((e) => e.threadId !== threadId);
        list.push({
          threadId,
          ...(example.holds !== undefined ? { holds: example.holds } : {}),
          ...(example.lane ? { lane: example.lane } : {}),
          ...(example.from ? { from: example.from } : {}),
          ...(example.subject ? { subject: example.subject } : {}),
          at: now().toISOString(),
        });
        examples[example.signal] = list.slice(-200);
      }
      return toBoard(await saveExtras(r, { placements, examples }));
    },

    async corrections(id) {
      return (await extrasOf(await mustRow(id))).examples;
    },

    async clearCorrections(id) {
      const r = await mustRow(id);
      const extras = await extrasOf(r);
      await saveExtras(r, { placements: extras.placements, examples: {} });
    },

    async dismissCheck(id) {
      await mustRow(id);
      const [u] = await db
        .update(boardsTable)
        .set({ checkBar: false, updatedAt: now() })
        .where(eq(boardsTable.id, id))
        .returning();
      if (!u) throw new BoardNotFoundError(id);
      await record(db, u);
      return toBoard(u);
    },

    async signalsWanted(workspaceId) {
      const at = Date.now();
      const cached = wantedCache.get(workspaceId);
      if (cached && at - cached.at >= 0 && at - cached.at < WANTED_TTL_MS) return cached.value;
      const value = await readWanted(workspaceId);
      wantedCache.set(workspaceId, { at, value });
      return value;
    },
  };

  async function readWanted(workspaceId: Id): Promise<BoardSignalWanted[]> {
    const rows = (await liveRows(workspaceId)).filter((r) => r.pinned);
    if (rows.length === 0) return [];
    const s = await settings();
    const out: BoardSignalWanted[] = [];
    for (const r of rows) {
      const doc = await docAt(r, r.version);
      if (!doc) continue;
      for (const def of boardSignalDefs({ ...doc, id: r.id }, s["boards.examples_in_question"])) {
        out.push({
          id: def.id,
          kind: def.kind,
          question: def.question,
          facts: doc.scope.facts,
          boardId: r.id,
          consumer: doc.name,
        });
      }
    }
    return out;
  }

  return store;
}

/** How long a Workspace's Board Signals are kept between reads when nothing here wrote a Board. */
const WANTED_TTL_MS = 5_000;
