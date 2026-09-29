// The Agent's View tools (slice 40, docs/spec/views.md): list_views reads
// the pinned Views with their Lane counts; create_view writes a View from
// the owner's sentence and tries it on their own mail (the View card shows
// the tried Threads; nothing is saved until the user clicks Pin view);
// revise_view folds the user's corrections into the questions and tries
// again on the same Threads; update_view changes a View (a name, icon or
// layout applies with Undo; a Lane or Signal change is tried and its moves
// shown before Apply); delete_view removes it with Undo. Approvals stay in
// the tool server (ADR 0002): Pin view and Apply are the user's clicks.

import type { ToolPreview, UndoRecord, View, ViewDraft, ViewPreview } from "@monday/shared";
import { LANE_COMPONENTS, OTHERS_LANE, UNSURE_LANE } from "@monday/shared";
import { z } from "zod";
import type { ViewIntelligence } from "../../views/index.ts";
import type { ToolContext, ToolDefinition, ToolPlan } from "./catalog.ts";

/** What the View tools act through: the Views module with its drafts. */
export type ViewsSeam = Pick<ViewIntelligence, "store" | "drafting" | "place" | "changed">;

const refused = (text: string): ToolPlan => ({ kind: "refused", text });

function seamOf(ctx: ToolContext): ViewsSeam | null {
  return ctx.extensions?.views ?? null;
}

const card = (p: Omit<ViewPreview, "kind">): ToolPreview => ({ kind: "view", ...p });

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The draft's test in one paragraph for the model: counts, what the card shows, what waits on the user. */
function draftText(d: ViewDraft): string {
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
    d.viewId
      ? "Nothing changes until the user clicks Apply on the card."
      : "Nothing is saved until the user clicks Pin view on the card; they can correct rows there, then ask you to revise.",
  ]
    .filter(Boolean)
    .join(" ");
}

const describe = async (seam: ViewsSeam, b: View) => {
  const placed = await seam.place(b.workspaceId, b.doc, { placements: b.placements });
  const counts = placed.lanes.lanes.map((l) => `${l.label} ${l.rows.length}`).join(", ");
  return `${b.id}: ${b.doc.name} (version ${b.version}${b.pinned ? "" : ", unpinned"}, blocks: ${b.doc.blocks.map((x) => x.type).join(", ")}): ${counts}. Scope: ${JSON.stringify(b.doc.scope.facts)}. Signals: ${
    [...b.doc.signals.map((s) => s.id), ...b.doc.uses].join(", ") || "none"
  }.`;
};

/* ------------------------------ list_views ------------------------------ */

const listViews: ToolDefinition<Record<string, never>> = {
  name: "list_views",
  description:
    "List the user's Views: id, name, version, layout, how many threads are in each Lane now, the scope and the Signals each reads. Read-only.",
  tier: "read",
  input: z.object({}),
  summarize: () => "views",
  async run(_input, ctx) {
    const seam = seamOf(ctx);
    if (!seam) return refused("Views are not available from this host.");
    const views = await seam.store.list(ctx.host.workspaceId);
    if (views.length === 0) return { kind: "result", text: "No views yet.", data: { views: [] } };
    const lines = await Promise.all(views.map((b) => describe(seam, b)));
    return {
      kind: "result",
      text: lines.join("\n"),
      data: { views: views.map((b) => ({ id: b.id, name: b.doc.name, version: b.version })) },
    };
  },
};

/* ------------------------------ create_view ------------------------------ */

const createView: ToolDefinition<{ sentence: string }> = {
  name: "create_view",
  description:
    "Make a View from the user's sentence (\"show today's support requests as red, yellow and green\"). monday writes the View (exact Facts for dates, addresses, counts and amounts; questions only for what needs reading, reusing shipped Signals), validates it, and tries it on the newest threads in its scope, widening a quiet scope's dates. The card shows the tried threads with their Lane and the answers behind it; the user corrects rows there and pins it. Nothing is saved until the user clicks Pin view. Metered, read-only.",
  tier: "read",
  input: z.object({
    sentence: z.string().min(3).max(1000).describe("The user's words for what the View shows"),
  }),
  summarize: (i) => i.sentence,
  async run(input, ctx) {
    const seam = seamOf(ctx);
    if (!seam) return refused("Views are not available from this host.");
    let draft: ViewDraft;
    try {
      draft = await seam.drafting.propose(ctx.host.workspaceId, input.sentence);
    } catch (error) {
      return refused(`The View could not be made: ${message(error)}`);
    }
    return {
      kind: "result",
      text: draftText(draft),
      data: { draftId: draft.id, name: draft.doc.name },
      preview: card({
        action: "create",
        draftId: draft.id,
        viewId: null,
        name: draft.doc.name,
        draft,
      }),
    };
  },
};

/* ------------------------------ revise_view ------------------------------ */

const reviseView: ToolDefinition<{ draft_id: string; instruction?: string | undefined }> = {
  name: "revise_view",
  description:
    'Revise a View draft after the user corrected rows on its card (Move to, Wrong): the corrections become Examples in its questions, a question the corrections show is off is rewritten, and the draft is tried again on the same threads. instruction carries the user\'s own words when they asked for more ("try it with only paying customers"). Returns the new card with the agreement line. Metered, read-only.',
  tier: "read",
  input: z.object({
    draft_id: z.string().min(1),
    instruction: z.string().max(1000).optional(),
  }),
  summarize: (i) => i.draft_id,
  async run(input, ctx) {
    const seam = seamOf(ctx);
    if (!seam) return refused("Views are not available from this host.");
    let draft: ViewDraft;
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
        viewId: draft.viewId,
        name: draft.doc.name,
        draft,
      }),
    };
  },
};

/* ------------------------------ update_view ------------------------------ */

type UpdateInput = {
  view_id: string;
  instruction?: string | undefined;
  name?: string | undefined;
  icon?: string | undefined;
  show_as?: (typeof LANE_COMPONENTS)[number] | undefined;
  fold_corrections?: boolean | undefined;
};

const updateView: ToolDefinition<UpdateInput> = {
  name: "update_view",
  description:
    'Change a View. A new name, icon or layout (show_as: lanes, list, counts, table, timeline) applies at once with Undo. instruction (the user\'s words: "make yellow only paying customers") or fold_corrections (the moves the user made on the View folded into its questions) change what decides the Lanes: the card tries the new version and shows which threads would move before the user clicks Apply. Reversible.',
  tier: "reversible",
  input: z.object({
    view_id: z.string().min(1),
    instruction: z.string().max(1000).optional(),
    name: z.string().min(1).max(60).optional(),
    icon: z.string().min(1).max(40).optional(),
    show_as: z.enum(LANE_COMPONENTS).optional(),
    fold_corrections: z.boolean().optional(),
  }),
  summarize: (i) => i.view_id,
  async run(input, ctx) {
    const seam = seamOf(ctx);
    if (!seam) return refused("Views are not available from this host.");
    let proposal: Awaited<ReturnType<ViewsSeam["drafting"]["proposeUpdate"]>>;
    try {
      proposal = await seam.drafting.proposeUpdate(input.view_id, {
        instruction: input.instruction,
        name: input.name,
        icon: input.icon,
        component: input.show_as,
        foldCorrections: input.fold_corrections,
      });
    } catch (error) {
      return refused(`The View could not be changed: ${message(error)}`);
    }
    if (proposal.kind === "draft") {
      const d = proposal.draft;
      return {
        kind: "result",
        text: draftText(d),
        data: { draftId: d.id, viewId: d.viewId },
        preview: card({
          action: "update",
          draftId: d.id,
          viewId: d.viewId,
          name: d.doc.name,
          draft: d,
        }),
      };
    }
    const { view, next } = proposal;
    return {
      kind: "action",
      preview: card({
        action: "update",
        draftId: null,
        viewId: view.id,
        name: next.name,
        draft: null,
      }),
      count: 1,
      apply: async () => {
        const r = await seam.store.update(view.id, next);
        await seam.changed(view.workspaceId);
        const undo: UndoRecord = {
          kind: "view",
          action: "update",
          viewId: view.id,
          previous: r.previous,
        };
        return {
          text: `View ${view.id} is now version ${r.view.version}: ${next.name}, with ${next.blocks.map((x) => x.type).join(", ")}.`,
          data: { viewId: view.id, version: r.view.version },
          undo,
        };
      },
    };
  },
};

/* ------------------------------ delete_view ------------------------------ */

const deleteView: ToolDefinition<{ view_id: string }> = {
  name: "delete_view",
  description:
    "Delete a View: it leaves the nav and its questions stop being asked; their answers are kept for a while, so Undo brings it back as it was without reading the mail again. Reversible.",
  tier: "reversible",
  input: z.object({ view_id: z.string().min(1) }),
  summarize: (i) => i.view_id,
  async run(input, ctx) {
    const seam = seamOf(ctx);
    if (!seam) return refused("Views are not available from this host.");
    const view = await seam.store.get(input.view_id);
    if (!view || view.deletedAt)
      return refused(`View ${input.view_id} not found; list_views names them.`);
    return {
      kind: "action",
      preview: card({
        action: "delete",
        draftId: null,
        viewId: view.id,
        name: view.doc.name,
        draft: null,
      }),
      count: 1,
      apply: async () => {
        await seam.store.remove(view.id);
        await seam.changed(view.workspaceId);
        return {
          text: `Deleted the View ${view.doc.name}.`,
          data: { viewId: view.id },
          undo: { kind: "view", action: "delete", viewId: view.id, previous: null },
        };
      },
    };
  },
};

/** Undo of a View change or delete. */
export async function undoView(
  seam: ViewsSeam | undefined,
  undo: Extract<UndoRecord, { kind: "view" }>,
): Promise<string> {
  if (!seam) return "Cannot undo: Views are not available from this host.";
  const view =
    undo.action === "delete"
      ? await seam.store.restore(undo.viewId)
      : await seam.store.revert(undo.viewId, undo.previous ?? 1);
  await seam.changed(view.workspaceId);
  return undo.action === "delete"
    ? `Undone: the View ${view.doc.name} is back.`
    : `Undone: the View ${view.doc.name} is back at version ${view.version}.`;
}

export const VIEW_TOOLS = [listViews, createView, reviseView, updateView, deleteView];
