// The Agent's Board tools (slice 40, docs/spec/boards.md): list_boards reads
// the pinned Boards with their Lane counts; create_board writes a Board from
// the owner's sentence and tries it on their own mail (the Board card shows
// the tried Threads; nothing is saved until the user clicks Pin board);
// revise_board folds the user's corrections into the questions and tries
// again on the same Threads; update_board changes a Board (a name, icon or
// layout applies with Undo; a Lane or Signal change is tried and its moves
// shown before Apply); delete_board removes it with Undo. Approvals stay in
// the tool server (ADR 0002): Pin board and Apply are the user's clicks.

import type { Board, BoardDraft, BoardPreview, ToolPreview, UndoRecord } from "@monday/shared";
import { BOARD_COMPONENTS, OTHERS_LANE, UNSURE_LANE } from "@monday/shared";
import { z } from "zod";
import type { BoardIntelligence } from "../../boards/index.ts";
import type { ToolContext, ToolDefinition, ToolPlan } from "./catalog.ts";

/** What the Board tools act through: the Boards module with its drafts. */
export type BoardsSeam = Pick<BoardIntelligence, "store" | "drafting" | "place" | "changed">;

const refused = (text: string): ToolPlan => ({ kind: "refused", text });

function seamOf(ctx: ToolContext): BoardsSeam | null {
  return ctx.extensions?.boards ?? null;
}

const card = (p: Omit<BoardPreview, "kind">): ToolPreview => ({ kind: "board", ...p });

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The draft's test in one paragraph for the model: counts, what the card shows, what waits on the user. */
function draftText(d: BoardDraft): string {
  const t = d.test;
  const lanes = [
    ...d.doc.lanes.map((l) => [l.id, l.label] as const),
    [UNSURE_LANE, "Unsure"] as const,
  ];
  const counts = t
    ? lanes.map(([id, label]) => `${label} ${t.counts[id] ?? 0}`).join(", ") +
      (t.counts[OTHERS_LANE] ? `, no lane ${t.counts[OTHERS_LANE]}` : "")
    : "";
  return [
    `Draft ${d.id}: "${d.doc.name}".`,
    t?.empty
      ? "Nothing in its scope to try it on yet; the user may pin it and check back."
      : t
        ? `Tried on ${t.tried} threads: ${counts}. The card shows ${t.shown.length} of them.`
        : "",
    t?.widened
      ? `Its scope held only ${t.widened.count} threads, so the test looked at earlier days.`
      : "",
    t?.agreement
      ? `Agrees with the user's corrections on ${t.agreement.agree} of ${t.agreement.total}.`
      : "",
    t?.moves?.length
      ? `Threads that would move: ${t.moves.map((m) => `${m.threadIds.length} ${m.from} to ${m.to}`).join(", ")}.`
      : "",
    t?.needsJudge ? "It reads mail through questions and no TypeSafe key answers them." : "",
    d.boardId
      ? "Nothing changes until the user clicks Apply on the card."
      : "Nothing is saved until the user clicks Pin board on the card; they can correct rows there, then ask you to revise.",
  ]
    .filter(Boolean)
    .join(" ");
}

const describe = async (seam: BoardsSeam, b: Board) => {
  const placed = await seam.place(b.workspaceId, b.doc, { placements: b.placements });
  const counts = placed.view.lanes.map((l) => `${l.label} ${l.rows.length}`).join(", ");
  return `${b.id}: ${b.doc.name} (version ${b.version}${b.pinned ? "" : ", unpinned"}, ${b.doc.layout.component}): ${counts}. Scope: ${JSON.stringify(b.doc.scope.facts)}. Signals: ${
    [...b.doc.signals.map((s) => s.id), ...b.doc.uses].join(", ") || "none"
  }.`;
};

/* ------------------------------ list_boards ------------------------------ */

const listBoards: ToolDefinition<Record<string, never>> = {
  name: "list_boards",
  description:
    "List the user's Boards: id, name, version, layout, how many threads are in each Lane now, the scope and the Signals each reads. Read-only.",
  tier: "read",
  input: z.object({}),
  summarize: () => "boards",
  async run(_input, ctx) {
    const seam = seamOf(ctx);
    if (!seam) return refused("Boards are not available from this host.");
    const boards = await seam.store.list(ctx.host.workspaceId);
    if (boards.length === 0)
      return { kind: "result", text: "No boards yet.", data: { boards: [] } };
    const lines = await Promise.all(boards.map((b) => describe(seam, b)));
    return {
      kind: "result",
      text: lines.join("\n"),
      data: { boards: boards.map((b) => ({ id: b.id, name: b.doc.name, version: b.version })) },
    };
  },
};

/* ------------------------------ create_board ------------------------------ */

const createBoard: ToolDefinition<{ sentence: string }> = {
  name: "create_board",
  description:
    "Make a Board from the user's sentence (\"show today's support requests as red, yellow and green\"). monday writes the Board (exact Facts for dates, addresses, counts and amounts; questions only for what needs reading, reusing shipped Signals), validates it, and tries it on the newest threads in its scope, widening a quiet scope's dates. The card shows the tried threads with their Lane and the answers behind it; the user corrects rows there and pins it. Nothing is saved until the user clicks Pin board. Metered, read-only.",
  tier: "read",
  input: z.object({
    sentence: z.string().min(3).max(1000).describe("The user's words for what the Board shows"),
  }),
  summarize: (i) => i.sentence,
  async run(input, ctx) {
    const seam = seamOf(ctx);
    if (!seam) return refused("Boards are not available from this host.");
    let draft: BoardDraft;
    try {
      draft = await seam.drafting.propose(ctx.host.workspaceId, input.sentence);
    } catch (error) {
      return refused(`The Board could not be made: ${message(error)}`);
    }
    return {
      kind: "result",
      text: draftText(draft),
      data: { draftId: draft.id, name: draft.doc.name },
      preview: card({
        action: "create",
        draftId: draft.id,
        boardId: null,
        name: draft.doc.name,
        draft,
      }),
    };
  },
};

/* ------------------------------ revise_board ------------------------------ */

const reviseBoard: ToolDefinition<{ draft_id: string; instruction?: string | undefined }> = {
  name: "revise_board",
  description:
    'Revise a Board draft after the user corrected rows on its card (Move to, Wrong): the corrections become Examples in its questions, a question the corrections show is off is rewritten, and the draft is tried again on the same threads. instruction carries the user\'s own words when they asked for more ("try it with only paying customers"). Returns the new card with the agreement line. Metered, read-only.',
  tier: "read",
  input: z.object({
    draft_id: z.string().min(1),
    instruction: z.string().max(1000).optional(),
  }),
  summarize: (i) => i.draft_id,
  async run(input, ctx) {
    const seam = seamOf(ctx);
    if (!seam) return refused("Boards are not available from this host.");
    let draft: BoardDraft;
    try {
      draft = await seam.drafting.revise(input.draft_id, input.instruction);
    } catch (error) {
      return refused(`The draft could not be revised: ${message(error)}`);
    }
    return {
      kind: "result",
      text: `${draftText(draft)}${draft.test?.changes.length ? ` Changed: ${draft.test.changes.join("; ")}.` : ""}`,
      data: { draftId: draft.id },
      preview: card({
        action: "revise",
        draftId: draft.id,
        boardId: draft.boardId,
        name: draft.doc.name,
        draft,
      }),
    };
  },
};

/* ------------------------------ update_board ------------------------------ */

type UpdateInput = {
  board_id: string;
  instruction?: string | undefined;
  name?: string | undefined;
  icon?: string | undefined;
  show_as?: (typeof BOARD_COMPONENTS)[number] | undefined;
  fold_corrections?: boolean | undefined;
};

const updateBoard: ToolDefinition<UpdateInput> = {
  name: "update_board",
  description:
    'Change a Board. A new name, icon or layout (show_as: lanes, list, counts, table, timeline) applies at once with Undo. instruction (the user\'s words: "make yellow only paying customers") or fold_corrections (the moves the user made on the Board folded into its questions) change what decides the Lanes: the card tries the new version and shows which threads would move before the user clicks Apply. Reversible.',
  tier: "reversible",
  input: z.object({
    board_id: z.string().min(1),
    instruction: z.string().max(1000).optional(),
    name: z.string().min(1).max(60).optional(),
    icon: z.string().min(1).max(40).optional(),
    show_as: z.enum(BOARD_COMPONENTS).optional(),
    fold_corrections: z.boolean().optional(),
  }),
  summarize: (i) => i.board_id,
  async run(input, ctx) {
    const seam = seamOf(ctx);
    if (!seam) return refused("Boards are not available from this host.");
    let proposal: Awaited<ReturnType<BoardsSeam["drafting"]["proposeUpdate"]>>;
    try {
      proposal = await seam.drafting.proposeUpdate(input.board_id, {
        instruction: input.instruction,
        name: input.name,
        icon: input.icon,
        component: input.show_as,
        foldCorrections: input.fold_corrections,
      });
    } catch (error) {
      return refused(`The Board could not be changed: ${message(error)}`);
    }
    if (proposal.kind === "draft") {
      const d = proposal.draft;
      return {
        kind: "result",
        text: draftText(d),
        data: { draftId: d.id, boardId: d.boardId },
        preview: card({
          action: "update",
          draftId: d.id,
          boardId: d.boardId,
          name: d.doc.name,
          draft: d,
        }),
      };
    }
    const { board, next } = proposal;
    return {
      kind: "action",
      preview: card({
        action: "update",
        draftId: null,
        boardId: board.id,
        name: next.name,
        draft: null,
      }),
      count: 1,
      apply: async () => {
        const r = await seam.store.update(board.id, next);
        await seam.changed(board.workspaceId);
        const undo: UndoRecord = {
          kind: "board",
          action: "update",
          boardId: board.id,
          previous: r.previous,
        };
        return {
          text: `Board ${board.id} is now version ${r.board.version}: ${next.name}, shown as ${next.layout.component}.`,
          data: { boardId: board.id, version: r.board.version },
          undo,
        };
      },
    };
  },
};

/* ------------------------------ delete_board ------------------------------ */

const deleteBoard: ToolDefinition<{ board_id: string }> = {
  name: "delete_board",
  description:
    "Delete a Board: it leaves the nav and its questions stop being asked; their answers are kept for a while, so Undo brings it back as it was without reading the mail again. Reversible.",
  tier: "reversible",
  input: z.object({ board_id: z.string().min(1) }),
  summarize: (i) => i.board_id,
  async run(input, ctx) {
    const seam = seamOf(ctx);
    if (!seam) return refused("Boards are not available from this host.");
    const board = await seam.store.get(input.board_id);
    if (!board || board.deletedAt)
      return refused(`Board ${input.board_id} not found; list_boards names them.`);
    return {
      kind: "action",
      preview: card({
        action: "delete",
        draftId: null,
        boardId: board.id,
        name: board.doc.name,
        draft: null,
      }),
      count: 1,
      apply: async () => {
        await seam.store.remove(board.id);
        await seam.changed(board.workspaceId);
        return {
          text: `Deleted the Board ${board.doc.name}.`,
          data: { boardId: board.id },
          undo: { kind: "board", action: "delete", boardId: board.id, previous: null },
        };
      },
    };
  },
};

/** Undo of a Board change or delete. */
export async function undoBoard(
  seam: BoardsSeam | undefined,
  undo: Extract<UndoRecord, { kind: "board" }>,
): Promise<string> {
  if (!seam) return "Cannot undo: Boards are not available from this host.";
  const board =
    undo.action === "delete"
      ? await seam.store.restore(undo.boardId)
      : await seam.store.revert(undo.boardId, undo.previous ?? 1);
  await seam.changed(board.workspaceId);
  return undo.action === "delete"
    ? `Undone: the Board ${board.doc.name} is back.`
    : `Undone: the Board ${board.doc.name} is back at version ${board.version}.`;
}

export const BOARD_TOOLS = [listBoards, createBoard, reviseBoard, updateBoard, deleteBoard];
