// The Agent's View tools (docs/spec/views.md, "Making a View" and "Changing
// and removing"; ADR 0016): list_views reads the Views with their Lane
// counts; create_view writes a View from the owner's sentence (its Fields,
// its own Jev questions and Extractions, its Blocks and buttons) and tries
// it on their own mail (the card draws every Block small over the tried
// Threads; nothing is saved until the user clicks Pin view); revise_view
// folds the user's corrections into the questions and tries again on the
// Threads its scope still admits; update_view changes a View (a name, icon, Block or button
// applies with Undo; a Lane, Signal, Extraction or scope change is tried and
// its moves shown before Apply); delete_view removes it with Undo. The
// Board tool names stay as aliases (TOOL_ALIASES). Approvals stay in the
// tool server (ADR 0002): Pin view and Apply are the user's clicks.

import type {
  BlockPreview,
  ToolPreview,
  UndoRecord,
  View,
  ViewDraft,
  ViewPreview,
} from "@monday/shared";
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

/** One Block of the card in words for the model: "stat Spent this month $120.00 (up 186%)". */
function blockLine(b: BlockPreview): string {
  const head = [b.type, b.title].filter(Boolean).join(" ");
  const value = b.value ? ` ${b.value}${b.change ? ` (${b.change})` : ""}` : "";
  const items = b.items
    .slice(0, 6)
    .map((i) => `${i.label}${i.value ? ` ${i.value}` : i.count !== undefined ? ` ${i.count}` : ""}`)
    .join(", ");
  return `${head}${value}${items ? `: ${items}` : ""}${b.unsure ? ` (${b.unsure} unsure)` : ""}`;
}

const quote = (s: string, max = 60) => `"${s.length > max ? `${s.slice(0, max)}...` : s}"`;

/** Before coverage was kept: each Extraction over the shown Threads. */
function legacyValueLines(d: ViewDraft): string[] {
  const rows = d.test?.shown ?? [];
  if (!rows.length) return [];
  return d.doc.extractions.map((x) => {
    const values = rows.map((r) => r.values.find((v) => v.extraction === x.id));
    const found = values.filter((v) => v?.state === "value").length;
    const unsure = values.filter((v) => v?.state === "unsure").length;
    return `${x.label || x.id}: a value on ${found} of the ${rows.length} shown threads${unsure ? `, ${unsure} unsure` : ""}.`;
  });
}

/**
 * What the model needs to diagnose a draft without guessing: how the tried
 * Threads were chosen, who sent them, and how each Extraction and Signal read
 * over all of them (a value, none of these, below the floor, or no candidate
 * found, which means code found nothing of that kind in the text, not that
 * the text was missing), with a few picks, and how to look closer.
 */
function coverageLines(d: ViewDraft, t: NonNullable<ViewDraft["test"]>): string[] {
  const c = t.coverage;
  if (!c) return [];
  const out: string[] = [];
  const p = t.pool;
  out.push(
    `In scope: ${t.inScope} threads.${
      p
        ? ` Tried ${t.tried}: ${p.kept ? `${p.kept} tried before and still in scope, ` : ""}${p.fresh} newest in scope${
            p.skipped
              ? `; code looked through ${p.scanned ?? 0} and passed over ${p.skipped} whose text holds none of the values the blocks add up`
              : ""
          }.`
        : ""
    }`,
  );
  if (c.senders.length)
    out.push(
      `Tried threads come from: ${c.senders.map((s) => `${s.from} ${s.count}`).join(", ")}.`,
    );
  for (const f of c.fields) {
    const x = f.field.startsWith("x:")
      ? d.doc.extractions.find((e) => e.id === f.field.slice(2))
      : undefined;
    const parts = x
      ? [
          f.values !== undefined
            ? `${f.values} values on ${f.resolved} of ${t.tried} threads`
            : `a value on ${f.resolved} of ${t.tried}`,
          f.none ? `none of the candidates on ${f.none}` : "",
          f.unsure ? `below its confidence floor on ${f.unsure}` : "",
          f.noCandidates
            ? `no candidates found on ${f.noCandidates} (code found no ${x.find} in their text, so nothing was asked)`
            : "",
          f.notRead ? `not read on ${f.notRead}` : "",
          f.capped ? `candidates cut at the limit on ${f.capped} (the rest were not asked)` : "",
        ]
      : f.per === "row"
        ? [
            `asked per row: clear on ${f.resolved} rows`,
            f.unsure ? `unsure on ${f.unsure}` : "",
            f.none ? `none on ${f.none}` : "",
          ]
        : [
            `clear on ${f.resolved} of ${t.tried}`,
            f.unsure ? `unsure on ${f.unsure}` : "",
            f.none ? `none on ${f.none}` : "",
            f.notRead ? `not read on ${f.notRead}` : "",
          ];
    const examples = f.examples.length
      ? ` For example: ${f.examples.map((e) => quote(e)).join(", ")}.`
      : "";
    out.push(
      `${f.label} (${f.field}${x ? `, find ${x.find}` : ""}): ${parts.filter(Boolean).join("; ")}.${examples}`,
    );
  }
  if (t.shown.length)
    out.push(
      `Tried threads the card shows: ${t.shown
        .map((r) => `${r.threadId} (${r.from}, ${quote(r.subject, 40)})`)
        .join("; ")}.`,
    );
  out.push(
    `To see why a thread read as it did (what code found in it, what the judge chose, why the scope admits it), call inspect_view_thread with draft_id ${d.id} and its thread id before revising.`,
  );
  return out;
}

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
    t?.blocks.length ? `It shows: ${t.blocks.map(blockLine).join("; ")}.` : "",
    ...(t?.coverage ? coverageLines(d, t) : legacyValueLines(d)),
    d.doc.actions.length
      ? `Buttons on its items: ${d.doc.actions.map((a) => a.label).join(", ")}.`
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
    "List the user's Views: id, name, version, its Blocks, how many threads are in each Lane now, the scope and the Signals each reads. Read-only.",
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
    'Make a View from the user\'s sentence: any page of their mail they ask for, such as "today\'s support requests as red, yellow and green", "all my Amazon orders with shipped and delivered lanes and total spend per month", "invoices I owe as a table by due date", "who emails me most this quarter", "my travel bookings on a calendar", with buttons on the items when asked ("with a button that runs my refund workflow"). monday writes the View: exact Facts for dates, addresses and counts; values such as totals, due dates and order numbers picked from what code finds in the mail; its own yes, no, choice or score questions only for what needs reading; Blocks from a fixed catalog (lanes, list, counts, table, stat, chart, timeline, calendar, cards, people, checklist, heatmap, text) with sums and groups done by code. It validates the View and tries it on the newest threads in its scope, each thread asked once. The card draws every Block small over the tried threads with the values and answers behind each row; the user corrects rows there (Move to, Wrong, Wrong value) and pins it. Nothing is saved until the user clicks Pin view. Metered, read-only.',
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
    'Revise a View draft after the user corrected rows on its card (Move to, Wrong, Wrong value): the corrections become Examples in its questions, a question the corrections show is off is rewritten, and the draft is tried again: on the same threads while its scope still admits them, and on the newest threads of a changed scope. instruction carries the user\'s own words when they asked for more ("try it with only paying customers", "add a chart of spend per vendor", "add a button to track the package"). Returns the new card with the agreement line. Metered, read-only.',
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

/* ------------------------------ inspect_view_thread ------------------------------ */

const inspectViewThread: ToolDefinition<{ draft_id: string; thread_id: string }> = {
  name: "inspect_view_thread",
  description:
    "Look closely at one thread of a View draft, to diagnose a value or an answer before revising: why the scope admits it, each Extraction's candidates as code found them with the share of the judge's answer each got and what was picked, and each question's answer. For a thread the test did not try, what code finds in it (nothing is asked). Use the thread ids from create_view or revise_view, or from search_threads. Read-only.",
  tier: "read",
  input: z.object({ draft_id: z.string().min(1), thread_id: z.string().min(1) }),
  summarize: (i) => i.thread_id,
  async run(input, ctx) {
    const seam = seamOf(ctx);
    if (!seam) return refused("Views are not available from this host.");
    let r: Awaited<ReturnType<ViewsSeam["drafting"]["inspect"]>>;
    try {
      r = await seam.drafting.inspect(input.draft_id, input.thread_id);
    } catch (error) {
      return refused(`The thread could not be inspected: ${message(error)}`);
    }
    if (r.workspaceId !== ctx.host.workspaceId)
      return refused(`Draft ${input.draft_id} not found; create_view makes one.`);
    const lines = [
      `Thread ${r.threadId} from ${r.from || "unknown"}, ${quote(r.subject, 80)}${r.receivedAt ? `, received ${r.receivedAt.slice(0, 10)}` : ""}. ${
        r.tried
          ? "The test tried it."
          : "The test did not try it; below is what code finds in it, nothing was asked."
      }`,
      `Scope: ${r.admitted ? "admits it" : "does not admit it"} (${r.scope.join("; ")}).`,
      ...r.extractions.map((x) => {
        const head = `${x.label} (x:${x.extraction}, find ${x.find}): `;
        const what =
          x.state === "value"
            ? `picked ${quote(x.picked ?? "", 80)} at ${Math.round((x.confidence ?? 0) * 100)}% confidence`
            : x.state === "unsure"
              ? `picked ${quote(x.picked ?? "", 80)} at only ${Math.round((x.confidence ?? 0) * 100)}%, below its floor, so Unsure`
              : x.state === "none"
                ? `the judge chose none of the candidates${x.confidence !== null ? ` at ${Math.round(x.confidence * 100)}%` : ""}`
                : x.state === "no_candidates"
                  ? `code found no ${x.find} in its text, so nothing was asked`
                  : r.tried
                    ? "not read"
                    : `${x.candidates.length} candidates`;
        const list = x.candidates.length
          ? ` Candidates in order${x.capped ? " (cut at the limit)" : ""}: ${x.candidates
              .map(
                (c) =>
                  `${quote(c.span, 80)}${c.probability !== null ? ` ${Math.round(c.probability * 100)}%` : ""} [${c.line}]`,
              )
              .join("; ")}.`
          : "";
        return `${head}${what}.${list}`;
      }),
      ...r.signals.map((s) => `${s.label} (signal:${s.signal}): ${s.answer}.`),
    ];
    return {
      kind: "result",
      text: lines.join("\n"),
      data: { threadId: r.threadId, tried: r.tried, admitted: r.admitted },
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
    'Change a View. A new name, icon, or how its Lanes are drawn (show_as: lanes, list, counts, table, timeline) applies at once with Undo. instruction carries the user\'s words: a new Block, column, chart or button ("add a chart of spend per month", "a button that runs my refund workflow") applies with Undo; a change to what decides the Lanes or the values ("make yellow only paying customers") is tried first and the card shows which threads would move before the user clicks Apply. fold_corrections folds the moves the user made on the View into its questions. Reversible.',
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

export const VIEW_TOOLS = [
  listViews,
  createView,
  reviseView,
  inspectViewThread,
  updateView,
  deleteView,
];
