// Views on the Server (docs/spec/views.md, "Data and sync"). A View is a
// row in `views` (its place in the nav, the version in effect, whether it
// is pinned, deleted with Undo) and one sealed document per version in
// `view_versions`; every edit is a new version and the old ones are kept.
// The user's placements and the corrections they made on the View live
// beside it, sealed. Every write is a `view` row on the Changes feed with
// the headers only, so each Device reads GET /views again and mirrors the
// documents into the Cache, where the Lanes are computed.
//
// Validated on every write, like a Workflow: the schema and the limits
// (views.max, views.max_lanes, views.max_signals,
// views.scope.max_threads, signals.max_active), before anything is saved.
// A View's own Signals become Signal definitions owned by the View
// (`board:<viewId>:<signalId>`, the stored prefix kept from Boards, scoped by its scope's Facts) while it is
// pinned and not deleted; deleting it removes their consumer, and the
// answers stay signals.keep_inactive_days so an Undo asks nothing again.

import type {
  Id,
  LaneCondition,
  SignalGate,
  SignalOptionsFrom,
  SignalQuestion,
  View,
  ViewChange,
  ViewDoc,
  ViewDone,
  ViewExample,
  ViewPlacement,
  ViewScopeFacts,
} from "@monday/shared";
import {
  normalizeView,
  validateView,
  viewExtractionDefs,
  viewExtractionId,
  viewIdFor,
  viewSignalDefs,
  viewSignalId,
} from "@monday/shared";
import { and, asc, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { signalDefs, views as viewsTable, viewVersions } from "../db/schema.ts";
import type { Mailstore } from "../mailstore/index.ts";
import { readGlobalSettings } from "../settings/read.ts";
import { viewRefs } from "./refs.ts";

type StoredRow = typeof viewsTable.$inferSelect;

/** The document would not save: the schema or a limit refused it. */
export class ViewInvalidError extends Error {
  readonly status = 422;
  constructor(readonly errors: string[]) {
    super(errors.join(" "));
    this.name = "ViewInvalidError";
  }
}

export class ViewNotFoundError extends Error {
  readonly status = 404;
  constructor(readonly id: string) {
    super(`view ${id} not found`);
    this.name = "ViewNotFoundError";
  }
}

/** A limit refused a new View or a new Signal, before anything was saved. */
export class ViewLimitError extends Error {
  readonly status = 409;
  constructor(
    readonly reason: "views" | "signals" | "judge" | "test",
    message: string,
  ) {
    super(message);
    this.name = "ViewLimitError";
  }
}

const SETTING_KEYS = [
  "views.max",
  "views.max_lanes",
  "views.max_signals",
  "views.scope.max_threads",
  "views.examples_in_question",
  "views.max_extractions",
  "views.max_blocks",
  "views.max_actions",
  "views.extract.none",
  "signals.max_active",
  "signals.keep_inactive_days",
  "signals.backfill.scope",
] as const;

/** What lives beside a View's document: the user's placements and the corrections they made on it. */
interface Extras {
  placements: Record<Id, ViewPlacement>;
  /** Corrections made on the View, not yet folded into its questions, by Signal. */
  examples: Record<string, ViewExample[]>;
  /** Checklist items checked. */
  done?: Record<Id, ViewDone> | undefined;
}

const NO_EXTRAS: Extras = { placements: {}, examples: {}, done: {} };

/** A View's Signal (or Extraction) as the Signal store takes it. */
export interface ViewSignalWanted {
  id: string;
  kind: "noul" | "choice" | "score";
  question: SignalQuestion;
  facts: ViewScopeFacts;
  viewId: Id;
  /** The View's name, who uses it. */
  consumer: string;
  /** An Extraction's: asked only when code finds candidates of its kind, which are its options. */
  gate?: SignalGate | undefined;
  optionsFrom?: SignalOptionsFrom | undefined;
}

export interface ViewStore {
  /** The Workspace's Views not deleted, in nav order. Throws LockedError when locked. */
  list(workspaceId: Id): Promise<View[]>;
  /** One View, deleted or not; null when there is none. */
  get(id: Id): Promise<View | null>;
  /** An older version's document. */
  version(id: Id, version: number): Promise<ViewDoc | null>;
  /** Saves a new View at version 1, pinned last in the nav. Validates and checks the limits first. */
  create(
    workspaceId: Id,
    doc: unknown,
    options?: { checkBar?: boolean | undefined; pinned?: boolean | undefined },
  ): Promise<View>;
  /** Saves a new version of a View's document; returns it and the version it replaced. */
  update(id: Id, doc: unknown): Promise<{ view: View; previous: number }>;
  /** Puts an older version back in effect (Undo of an edit). */
  revert(id: Id, version: number): Promise<View>;
  /** Moves a View up (-1) or down (1) in the nav; returns the Views in their new order. */
  move(id: Id, by: -1 | 1): Promise<View[]>;
  setPinned(id: Id, pinned: boolean): Promise<View>;
  /** Deletes with Undo: out of the nav, its Signals lose their consumer. */
  remove(id: Id): Promise<View>;
  /** Undo of a delete: the View comes back as it was, its answers still there. */
  restore(id: Id): Promise<View>;
  /**
   * A Thread the user placed by hand on the View ("Move to", a drag): it
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
  ): Promise<View>;
  /** A checklist item checked (for this Thread version) or unchecked. */
  setDone(id: Id, threadId: Id, done: boolean, messageCount: number): Promise<View>;
  /** The corrections made on the View, not yet folded into its questions. */
  corrections(id: Id): Promise<Record<string, ViewExample[]>>;
  /** Forgets the corrections once they were folded into a new version. */
  clearCorrections(id: Id): Promise<void>;
  dismissCheck(id: Id): Promise<View>;
  /** The Signals every pinned View in the Workspace declares. */
  signalsWanted(workspaceId: Id): Promise<ViewSignalWanted[]>;
}

export interface ViewStoreOptions {
  db: Db;
  mailstore: Mailstore;
  now?: () => Date;
}

/** The feed's headers for a row. */
export function viewHeaders(r: StoredRow): ViewChange {
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
function ownSignals(doc: ViewDoc): string[] {
  return [
    ...doc.signals.map((s) => viewSignalId(doc.id, s.id)),
    ...doc.extractions.map((x) => viewExtractionId(doc.id, x.id)),
  ];
}

/** The own Nouls a Lane requires to hold (inside its `all`s), in order. */
function requiredNouls(doc: ViewDoc, laneId: string | null): string[] {
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
  doc: ViewDoc,
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

export function createViewStore(options: ViewStoreOptions): ViewStore {
  const { db, mailstore } = options;
  const now = options.now ?? (() => new Date());
  const settings = () => readGlobalSettings(db, SETTING_KEYS);

  const seal = async (workspaceId: Id, value: unknown) => {
    const ref = await mailstore.storeContent(workspaceId, "board", JSON.stringify(value));
    const enc = ref.chunks[0];
    if (!enc) throw new RangeError("view envelope missing");
    return { enc, key: ref.key };
  };
  const open = async <T>(workspaceId: Id, enc: Uint8Array, key: Uint8Array): Promise<T> =>
    JSON.parse(
      await mailstore.readText({ workspaceId, kind: "board", key, chunks: [enc], size: -1 }),
    ) as T;

  const row = async (id: Id): Promise<StoredRow | null> =>
    (await db.query.views.findFirst({ where: eq(viewsTable.id, id) })) ?? null;

  const docAt = async (r: Pick<StoredRow, "id" | "workspaceId">, version: number) => {
    const [v] = await db
      .select()
      .from(viewVersions)
      .where(and(eq(viewVersions.viewId, r.id), eq(viewVersions.version, version)));
    // A Board's document reads as a View with one Block (ADR 0016).
    return v ? normalizeView(await open<unknown>(r.workspaceId, v.contentEnc, v.contentKey)) : null;
  };

  const extrasOf = async (r: StoredRow): Promise<Extras> =>
    r.extrasEnc && r.extrasKey ? open<Extras>(r.workspaceId, r.extrasEnc, r.extrasKey) : NO_EXTRAS;

  const toView = async (r: StoredRow): Promise<View> => {
    const doc = await docAt(r, r.version);
    if (!doc) throw new ViewNotFoundError(r.id);
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
      done: extras.done ?? {},
    };
  };

  /**
   * The Signals each Workspace's Views declare, read on every Signal request:
   * kept a few seconds and dropped on every write here, so a new or deleted
   * View is seen at once on this Server and within seconds on another.
   */
  const wantedCache = new Map<Id, { at: number; value: ViewSignalWanted[] }>();
  const record = (executor: Db | Tx, r: StoredRow) => {
    wantedCache.delete(r.workspaceId);
    return mailstore.recordChange(executor, {
      workspaceId: r.workspaceId,
      kind: "view",
      entityId: r.id,
      payload: viewHeaders(r),
    });
  };

  const mustRow = async (id: Id) => {
    const r = await row(id);
    if (!r) throw new ViewNotFoundError(id);
    return r;
  };

  const validated = async (workspaceId: Id, input: unknown): Promise<ViewDoc> => {
    const s = await settings();
    const r = validateView(
      input,
      {
        maxLanes: s["views.max_lanes"],
        maxSignals: s["views.max_signals"],
        maxThreads: s["views.scope.max_threads"],
        maxExtractions: s["views.max_extractions"],
        maxBlocks: s["views.max_blocks"],
        maxActions: s["views.max_actions"],
      },
      undefined,
      await viewRefs(db, workspaceId),
    );
    if (!r.ok) throw new ViewInvalidError(r.errors);
    return r.doc;
  };

  /** Refuses a document whose new Signals would pass signals.max_active. */
  const checkActive = async (workspaceId: Id, doc: ViewDoc, replacing: ViewDoc | null) => {
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
      throw new ViewLimitError(
        "signals",
        `This View adds ${fresh.length} questions to the ${active} monday already asks of every new thread; the most is ${s["signals.max_active"]}. Remove a question, or retire one on the Signals page.`,
      );
    }
  };

  const liveRows = (workspaceId: Id) =>
    db
      .select()
      .from(viewsTable)
      .where(and(eq(viewsTable.workspaceId, workspaceId), isNull(viewsTable.deletedAt)))
      .orderBy(asc(viewsTable.position), asc(viewsTable.createdAt));

  /** Past the keep window a deleted View goes for good. */
  const sweep = async (workspaceId: Id) => {
    const s = await settings();
    const cutoff = new Date(now().getTime() - s["signals.keep_inactive_days"] * 86_400_000);
    await db
      .delete(viewsTable)
      .where(
        and(
          eq(viewsTable.workspaceId, workspaceId),
          isNotNull(viewsTable.deletedAt),
          lt(viewsTable.deletedAt, cutoff),
        ),
      );
  };

  const saveExtras = async (r: StoredRow, extras: Extras) => {
    const sealed = await seal(r.workspaceId, extras);
    const [updated] = await db
      .update(viewsTable)
      .set({ extrasEnc: sealed.enc, extrasKey: sealed.key, updatedAt: now() })
      .where(eq(viewsTable.id, r.id))
      .returning();
    if (!updated) throw new ViewNotFoundError(r.id);
    await record(db, updated);
    return updated;
  };

  const store: ViewStore = {
    async list(workspaceId) {
      await sweep(workspaceId);
      return Promise.all((await liveRows(workspaceId)).map(toView));
    },

    async get(id) {
      const r = await row(id);
      return r ? toView(r) : null;
    },

    async version(id, version) {
      const r = await mustRow(id);
      return docAt(r, version);
    },

    async create(workspaceId, input, opts = {}) {
      const s = await settings();
      const live = await liveRows(workspaceId);
      const pinned = opts.pinned ?? true;
      if (pinned && live.filter((b) => b.pinned).length >= s["views.max"]) {
        throw new ViewLimitError(
          "views",
          `You have ${s["views.max"]} views, the most there can be. Delete one first.`,
        );
      }
      const raw = (input ?? {}) as Record<string, unknown>;
      const taken = new Set(
        (await db.select({ id: viewsTable.id }).from(viewsTable)).map((b) => b.id),
      );
      const wantedId = typeof raw.id === "string" && raw.id ? raw.id : null;
      const id =
        wantedId && !taken.has(wantedId)
          ? wantedId
          : viewIdFor(typeof raw.name === "string" ? raw.name : "view", taken);
      const doc = await validated(workspaceId, { ...raw, id, version: 1 });
      await checkActive(workspaceId, doc, null);
      const at = now();
      const sealed = await seal(workspaceId, doc);
      const position = live.reduce((max, b) => Math.max(max, b.position + 1), 0);
      const inserted = await db.transaction(async (tx) => {
        const [r] = await tx
          .insert(viewsTable)
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
        if (!r) throw new Error("view insert failed");
        await tx.insert(viewVersions).values({
          id: `${id}@1`,
          viewId: id,
          workspaceId,
          version: 1,
          contentEnc: sealed.enc,
          contentKey: sealed.key,
          createdAt: at,
        });
        await record(tx, r);
        return r;
      });
      return toView(inserted);
    },

    async update(id, input) {
      const r = await mustRow(id);
      const current = await docAt(r, r.version);
      const [max] = await db
        .select({ v: sql<number>`max(${viewVersions.version})::int` })
        .from(viewVersions)
        .where(eq(viewVersions.viewId, id));
      const version = Number(max?.v ?? r.version) + 1;
      const doc = await validated(r.workspaceId, {
        ...(input as Record<string, unknown>),
        id,
        version,
      });
      await checkActive(r.workspaceId, doc, current);
      const sealed = await seal(r.workspaceId, doc);
      const at = now();
      const updated = await db.transaction(async (tx) => {
        await tx.insert(viewVersions).values({
          id: `${id}@${version}`,
          viewId: id,
          workspaceId: r.workspaceId,
          version,
          contentEnc: sealed.enc,
          contentKey: sealed.key,
          createdAt: at,
        });
        const [u] = await tx
          .update(viewsTable)
          .set({ version, updatedAt: at })
          .where(eq(viewsTable.id, id))
          .returning();
        if (!u) throw new ViewNotFoundError(id);
        await record(tx, u);
        return u;
      });
      return { view: await toView(updated), previous: r.version };
    },

    async revert(id, version) {
      const r = await mustRow(id);
      if (!(await docAt(r, version))) throw new ViewNotFoundError(`${id} version ${version}`);
      const [u] = await db
        .update(viewsTable)
        .set({ version, updatedAt: now() })
        .where(eq(viewsTable.id, id))
        .returning();
      if (!u) throw new ViewNotFoundError(id);
      await record(db, u);
      return toView(u);
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
        for (const [position, viewId] of order.entries()) {
          const before = rows.find((b) => b.id === viewId);
          if (before?.position === position) continue;
          const [u] = await tx
            .update(viewsTable)
            .set({ position, updatedAt: at })
            .where(eq(viewsTable.id, viewId))
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
        if (live.filter((b) => b.pinned).length >= s["views.max"]) {
          throw new ViewLimitError(
            "views",
            `You have ${s["views.max"]} views, the most there can be. Delete one first.`,
          );
        }
      }
      const [u] = await db
        .update(viewsTable)
        .set({ pinned, updatedAt: now() })
        .where(eq(viewsTable.id, id))
        .returning();
      if (!u) throw new ViewNotFoundError(id);
      await record(db, u);
      return toView(u);
    },

    async remove(id) {
      await mustRow(id);
      const [u] = await db
        .update(viewsTable)
        .set({ deletedAt: now(), updatedAt: now() })
        .where(eq(viewsTable.id, id))
        .returning();
      if (!u) throw new ViewNotFoundError(id);
      await record(db, u);
      return toView(u);
    },

    async restore(id) {
      await mustRow(id);
      const [u] = await db
        .update(viewsTable)
        .set({ deletedAt: null, updatedAt: now() })
        .where(eq(viewsTable.id, id))
        .returning();
      if (!u) throw new ViewNotFoundError(id);
      await record(db, u);
      return toView(u);
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
      return toView(await saveExtras(r, { ...extras, placements, examples }));
    },

    async setDone(id, threadId, done, messageCount) {
      const r = await mustRow(id);
      const extras = await extrasOf(r);
      const marks = { ...(extras.done ?? {}) };
      if (done) marks[threadId] = { messageCount, at: now().toISOString() };
      else delete marks[threadId];
      return toView(await saveExtras(r, { ...extras, done: marks }));
    },

    async corrections(id) {
      return (await extrasOf(await mustRow(id))).examples;
    },

    async clearCorrections(id) {
      const r = await mustRow(id);
      const extras = await extrasOf(r);
      await saveExtras(r, { ...extras, examples: {} });
    },

    async dismissCheck(id) {
      await mustRow(id);
      const [u] = await db
        .update(viewsTable)
        .set({ checkBar: false, updatedAt: now() })
        .where(eq(viewsTable.id, id))
        .returning();
      if (!u) throw new ViewNotFoundError(id);
      await record(db, u);
      return toView(u);
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

  async function readWanted(workspaceId: Id): Promise<ViewSignalWanted[]> {
    const rows = (await liveRows(workspaceId)).filter((r) => r.pinned);
    if (rows.length === 0) return [];
    const s = await settings();
    const out: ViewSignalWanted[] = [];
    for (const r of rows) {
      const doc = await docAt(r, r.version);
      if (!doc) continue;
      for (const def of viewSignalDefs({ ...doc, id: r.id }, s["views.examples_in_question"])) {
        // A per-row Signal is asked once per item or Message, in the same request.
        const each = def.each
          ? "item" in def.each
            ? {
                gate: `extract:${def.each.item}` as const,
                optionsFrom: `each_item:${def.each.item}` as const,
              }
            : { optionsFrom: "each_message" as const }
          : {};
        out.push({
          id: def.id,
          kind: def.kind,
          question: def.question,
          facts: doc.scope.facts,
          viewId: r.id,
          consumer: doc.name,
          ...each,
        });
      }
      // Each Extraction: a Choice over the candidates code finds, asked only when it finds some.
      for (const def of viewExtractionDefs(
        { ...doc, id: r.id },
        { none: s["views.extract.none"], examplesMax: s["views.examples_in_question"] },
      )) {
        out.push({
          id: def.id,
          kind: "choice",
          question: def.question,
          facts: doc.scope.facts,
          viewId: r.id,
          consumer: doc.name,
          // One value: a Choice; many: a Noul per candidate; a message-grain View: one per Message.
          ...(def.mode === "message" ? {} : { gate: `extract:${def.find}` as const }),
          optionsFrom:
            def.mode === "many"
              ? `extract_many:${def.find}`
              : def.mode === "message"
                ? `extract_message:${def.find}`
                : `extract:${def.find}`,
        });
      }
    }
    return out;
  }

  return store;
}

/** How long a Workspace's View Signals are kept between reads when nothing here wrote a View. */
const WANTED_TTL_MS = 5_000;
