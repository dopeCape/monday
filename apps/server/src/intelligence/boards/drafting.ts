// The Agent's Board flow (docs/spec/boards.md, "Making a Board: the Agent
// must test it" and "Changing and removing"): draft from the sentence, try it
// on the owner's own Threads, show it, take corrections as Examples, revise
// and try again on the same Threads, and save only when the user clicks Pin
// board (Apply for an edit whose Lanes or Signals changed, after the moves
// are shown). A pure name or layout change applies at once with Undo.

import type { Board, BoardDoc, BoardDraft, BoardExample, BoardTest, Id } from "@monday/shared";
import {
  boardIdFor,
  boardMoves,
  boardView,
  factLanesOnly,
  lanesChanged,
  layoutForComponent,
  signalName,
} from "@monday/shared";
import { eq } from "drizzle-orm";
import type { DraftStore } from "../../boards/drafts.ts";
import { BoardLimitError, BoardNotFoundError, type BoardStore } from "../../boards/index.ts";
import type { Db } from "../../db/client.ts";
import { boards as boardsTable, groups } from "../../db/schema.ts";
import type { Mailstore } from "../../mailstore/index.ts";
import { readGlobalSettings } from "../../settings/read.ts";
import type { HostedRuntime } from "../runtime/index.ts";
import type { Signals } from "../signals/index.ts";
import {
  type AuthorContext,
  type AuthorSettings,
  type CorrectionLine,
  reviseBoard,
  rewordedSignals,
  writeBoard,
} from "./author.ts";
import { runBoardTest, type TestRun, type TestSettings } from "./test.ts";

const KEYS = [
  "boards.max",
  "boards.max_lanes",
  "boards.max_signals",
  "boards.scope.max_threads",
  "boards.test.pool",
  "boards.test.shown",
  "boards.test.widen_days",
  "boards.examples_in_question",
  "boards.draft.retries",
  "boards.prompt",
  "boards.revise_prompt",
  "signals.backfill.concurrency",
  "sections.rules",
  "strings.boards.not_read",
  "strings.boards.change.reworded",
  "strings.boards.change.examples",
  "strings.boards.change.none",
  "strings.boards.pin_needs_test",
  "strings.boards.needs_typesafe",
  "strings.boards.too_many",
] as const;

const fill = (t: string, vars: Record<string, string | number>) =>
  t.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));

/** A correction the user made on the card. */
export interface DraftCorrection {
  threadId: Id;
  /** "Move to": the Lane (or unsure) the Thread belongs in. */
  lane?: string | undefined;
  /** "Wrong": a Noul of the Board's own and what it should have said. */
  signal?: string | undefined;
  holds?: boolean | undefined;
}

/** What update_board proposes: a change applied at once, or a draft whose moves the user sees first. */
export type UpdateProposal =
  | { kind: "direct"; board: Board; next: BoardDoc }
  | { kind: "draft"; draft: BoardDraft };

export interface BoardDrafting {
  drafts: DraftStore;
  /** create_board: writes the document from the sentence and tries it. Nothing is saved as a Board. */
  propose(workspaceId: Id, sentence: string): Promise<BoardDraft>;
  /** A correction from the card, kept as the draft's Examples. */
  correct(draftId: Id, correction: DraftCorrection): Promise<BoardDraft>;
  /** revise_board: the corrections into the questions, then tried again on the same Threads. */
  revise(draftId: Id, instruction?: string): Promise<BoardDraft>;
  /** Pin board: saves version 1, pins it and starts the backfill of its scope. */
  pin(draftId: Id, options?: { factsOnly?: boolean }): Promise<{ board: Board; draft: BoardDraft }>;
  /** update_board: a new document for a pinned Board; a Lane or Signal change is tried and its moves shown first. */
  proposeUpdate(
    boardId: Id,
    change: {
      instruction?: string | undefined;
      name?: string | undefined;
      icon?: string | undefined;
      component?: BoardDoc["layout"]["component"] | undefined;
      foldCorrections?: boolean | undefined;
    },
  ): Promise<UpdateProposal>;
  /** Apply on an edit's card: the new version, whose Undo points back at the old one. */
  apply(draftId: Id): Promise<{ board: Board; draft: BoardDraft; previous: number }>;
  /** Not now. */
  discard(draftId: Id): Promise<BoardDraft>;
}

export function createBoardDrafting(deps: {
  db: Db;
  mailstore: Mailstore;
  runtime: HostedRuntime;
  signals: Signals;
  store: BoardStore;
  drafts: DraftStore;
  context: (workspaceId: Id) => Promise<import("@monday/shared").BoardContext>;
  changed: (workspaceId: Id) => Promise<void>;
  log: (message: string) => void;
}): BoardDrafting {
  const { db, store, drafts } = deps;
  const settings = () => readGlobalSettings(db, KEYS);

  const authorSettings = (s: Awaited<ReturnType<typeof settings>>): AuthorSettings => ({
    prompt: s["boards.prompt"],
    revisePrompt: s["boards.revise_prompt"],
    retries: s["boards.draft.retries"],
    limits: {
      maxLanes: s["boards.max_lanes"],
      maxSignals: s["boards.max_signals"],
      maxThreads: s["boards.scope.max_threads"],
    },
  });

  const testSettings = (s: Awaited<ReturnType<typeof settings>>): TestSettings => ({
    pool: s["boards.test.pool"],
    shown: s["boards.test.shown"],
    widenDays: s["boards.test.widen_days"],
    maxThreads: s["boards.scope.max_threads"],
    examplesMax: s["boards.examples_in_question"],
    notRead: s["strings.boards.not_read"].toLowerCase(),
    concurrency: Math.max(1, s["signals.backfill.concurrency"]),
  });

  const authorContext = async (
    workspaceId: Id,
    s: Awaited<ReturnType<typeof settings>>,
  ): Promise<AuthorContext> => {
    const ctx = await deps.context(workspaceId);
    const g = await db
      .select({ id: groups.id, name: groups.name })
      .from(groups)
      .where(eq(groups.workspaceId, workspaceId));
    return {
      owner: ctx.owner,
      today: ctx.now.toDateString(),
      groups: g,
      sections: s["sections.rules"].map((r) => ({ id: r.id, name: r.name?.trim() || r.id })),
    };
  };

  const test = async (
    workspaceId: Id,
    doc: BoardDoc,
    threadIds?: readonly Id[],
  ): Promise<TestRun> => {
    const s = await settings();
    return runBoardTest(
      {
        db,
        mailstore: deps.mailstore,
        runtime: deps.runtime,
        signals: deps.signals,
        context: await deps.context(workspaceId),
        workspaceId,
        log: deps.log,
      },
      doc,
      testSettings(s),
      threadIds ? { threadIds } : {},
    );
  };

  const pinnedCount = async (workspaceId: Id) =>
    (await store.list(workspaceId)).filter((b) => b.pinned).length;

  /** The draft's corrections as the revision reads them: who, what, what the owner said, what the Board read. */
  const correctionLines = (draft: BoardDraft): CorrectionLine[] => {
    const shown = new Map(draft.test?.shown.map((t) => [t.threadId, t]) ?? []);
    const lines: CorrectionLine[] = [];
    for (const [key, list] of Object.entries(draft.doc.examples)) {
      for (const e of list) {
        const t = shown.get(e.threadId);
        const lane = draft.doc.lanes.find((l) => l.id === e.lane)?.label ?? e.lane;
        lines.push({
          from: e.from ?? t?.from ?? "",
          subject: e.subject ?? t?.subject ?? "",
          said:
            key === "_lanes"
              ? `it belongs in ${lane}`
              : `${signalName(draft.doc, key)} ${e.holds ? "holds" : "does not hold"}`,
          answers: t?.reasons ?? [],
        });
      }
    }
    return lines;
  };

  const api: BoardDrafting = {
    drafts,

    async propose(workspaceId, sentence) {
      const s = await settings();
      if ((await pinnedCount(workspaceId)) >= s["boards.max"]) {
        throw new BoardLimitError(
          "boards",
          fill(s["strings.boards.too_many"], { max: s["boards.max"] }),
        );
      }
      const taken = new Set(
        (await db.select({ id: boardsTable.id }).from(boardsTable)).map((b) => b.id),
      );
      const { doc } = await writeBoard({
        runtime: deps.runtime,
        workspaceId,
        sentence,
        context: await authorContext(workspaceId, s),
        settings: authorSettings(s),
        id: boardIdFor(sentence.split(/\s+/).slice(0, 4).join(" "), taken),
      });
      const run = await test(workspaceId, doc);
      return drafts.create(workspaceId, {
        boardId: null,
        doc,
        previous: null,
        test: run.test,
        threadIds: run.threadIds,
      });
    },

    async correct(draftId, c) {
      const draft = await drafts.get(draftId);
      const tried = draft.test?.shown.find((t) => t.threadId === c.threadId);
      let subject = tried?.subject ?? "";
      if (!subject) {
        try {
          subject = await deps.mailstore.readThreadSubject(c.threadId);
        } catch {}
      }
      const example: BoardExample = {
        threadId: c.threadId,
        ...(tried?.from ? { from: tried.from } : {}),
        ...(subject ? { subject } : {}),
        at: new Date().toISOString(),
      };
      const key = c.lane !== undefined ? "_lanes" : c.signal;
      if (!key || (key !== "_lanes" && !draft.doc.signals.some((x) => x.id === key))) {
        throw new BoardNotFoundError(`${draftId} signal ${c.signal ?? ""}`);
      }
      const list = (draft.doc.examples[key] ?? []).filter((e) => e.threadId !== c.threadId);
      list.push(
        key === "_lanes" ? { ...example, lane: c.lane } : { ...example, holds: c.holds ?? false },
      );
      return drafts.save(draftId, {
        doc: { ...draft.doc, examples: { ...draft.doc.examples, [key]: list } },
      });
    },

    async revise(draftId, instruction) {
      const draft = await drafts.get(draftId);
      const s = await settings();
      let doc = draft.doc;
      const lines = correctionLines(draft);
      try {
        doc = (
          await reviseBoard({
            runtime: deps.runtime,
            workspaceId: draft.workspaceId,
            doc: draft.doc,
            corrections: lines,
            instruction,
            context: await authorContext(draft.workspaceId, s),
            settings: authorSettings(s),
          })
        ).doc;
      } catch (error) {
        // No language model, or no answer that validates: the corrections still ride as Examples.
        deps.log(
          `board revise ${draftId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const before = draft.test ? draft.doc : null;
      const reworded = before ? rewordedSignals(before, doc) : [];
      const changes = [
        ...reworded.map((id) =>
          fill(s["strings.boards.change.reworded"], { signal: signalName(doc, id) }),
        ),
        ...doc.signals.flatMap((sig) => {
          const n = (doc.examples[sig.id] ?? []).length;
          return n
            ? [
                fill(s["strings.boards.change.examples"], {
                  count: n,
                  signal: signalName(doc, sig.id),
                }),
              ]
            : [];
        }),
      ];
      const run = await test(draft.workspaceId, doc, draft.threadIds);
      const moves = draft.test
        ? boardMoves(
            new Map(draft.test.shown.map((t) => [t.threadId, t.lane])),
            new Map(
              [...run.lanesOf].filter(([id]) => draft.test?.shown.some((t) => t.threadId === id)),
            ),
          )
        : null;
      const next: BoardTest = {
        ...run.test,
        widened: draft.test?.widened ?? run.test.widened,
        inScope: draft.test?.inScope ?? run.test.inScope,
        changes: changes.length ? changes : [s["strings.boards.change.none"]],
        moves: draft.boardId ? (draft.test?.moves ?? null) : moves,
      };
      return drafts.save(draftId, { doc, test: next, threadIds: run.threadIds });
    },

    async pin(draftId, options = {}) {
      const draft = await drafts.get(draftId);
      const s = await settings();
      if (draft.status !== "open" || draft.boardId) throw new BoardNotFoundError(draftId);
      const t = draft.test;
      const need = Math.min(s["boards.test.shown"], t?.tried ?? 0);
      if (!t || (!t.empty && t.shown.length < need)) {
        throw new BoardLimitError("test", s["strings.boards.pin_needs_test"]);
      }
      let doc = draft.doc;
      if (options.factsOnly) {
        const facts = factLanesOnly(doc);
        if (!facts) throw new BoardLimitError("judge", s["strings.boards.needs_typesafe"]);
        doc = facts;
      } else if (t.needsJudge) {
        throw new BoardLimitError("judge", s["strings.boards.needs_typesafe"]);
      }
      const board = await store.create(draft.workspaceId, doc, { checkBar: t.empty });
      await deps.changed(draft.workspaceId);
      return { board, draft: await drafts.save(draftId, { status: "pinned" }) };
    },

    async proposeUpdate(boardId, change) {
      const board = await store.get(boardId);
      if (!board || board.deletedAt) throw new BoardNotFoundError(boardId);
      const s = await settings();
      let next: BoardDoc = {
        ...board.doc,
        ...(change.name ? { name: change.name } : {}),
        ...(change.icon ? { nav: { ...board.doc.nav, icon: change.icon } } : {}),
        ...(change.component
          ? { layout: layoutForComponent(change.component, board.doc.layout) }
          : {}),
      };
      if (change.foldCorrections) {
        const folded = await store.corrections(boardId);
        const examples = { ...next.examples };
        for (const [key, list] of Object.entries(folded)) {
          const kept = (examples[key] ?? []).filter(
            (e) => !list.some((x) => x.threadId === e.threadId),
          );
          examples[key] = [...kept, ...list];
        }
        next = { ...next, examples };
      }
      if (change.instruction) {
        next = (
          await reviseBoard({
            runtime: deps.runtime,
            workspaceId: board.workspaceId,
            doc: next,
            corrections: [],
            instruction: change.instruction,
            context: await authorContext(board.workspaceId, s),
            settings: authorSettings(s),
          })
        ).doc;
      }
      if (!lanesChanged(board.doc, next)) return { kind: "direct", board, next };
      // What decides the Lanes changed: try it, and show which Threads would move before Apply.
      const run = await test(board.workspaceId, next);
      const ctx = await deps.context(board.workspaceId);
      const stored = await deps.signals.readings(run.threadIds);
      const before = boardView(
        { ...board.doc, scope: { facts: { folder: "any" }, limit: run.threads.length || 1 } },
        run.threads.map((t) => ({ ...t, readings: stored.get(t.id) ?? {} })),
        ctx,
      );
      const moves = boardMoves(before.lanesOf, run.lanesOf);
      const draft = await drafts.create(board.workspaceId, {
        boardId,
        doc: next,
        previous: board.doc,
        test: { ...run.test, moves },
        threadIds: run.threadIds,
      });
      return { kind: "draft", draft };
    },

    async apply(draftId) {
      const draft = await drafts.get(draftId);
      if (draft.status !== "open" || !draft.boardId) throw new BoardNotFoundError(draftId);
      const { board, previous } = await store.update(draft.boardId, draft.doc);
      const folded = Object.keys(await store.corrections(draft.boardId)).length > 0;
      if (folded && Object.keys(draft.doc.examples).length)
        await store.clearCorrections(draft.boardId);
      await deps.changed(board.workspaceId);
      return { board, previous, draft: await drafts.save(draftId, { status: "applied" }) };
    },

    async discard(draftId) {
      return drafts.save(draftId, { status: "discarded" });
    },
  };
  return api;
}
