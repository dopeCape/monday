// The Agent's View flow (docs/spec/views.md, "Making a View: the Agent
// must test it" and "Changing and removing"): draft from the sentence, try it
// on the owner's own Threads, show it, take corrections as Examples, revise
// and try again on the same Threads, and save only when the user clicks Pin
// view (Apply for an edit whose Lanes or Signals changed, after the moves
// are shown). A pure name or layout change applies at once with Undo.

import type { Id, View, ViewDoc, ViewDraft, ViewExample, ViewTest } from "@monday/shared";
import {
  factLanesOnly,
  lanesChanged,
  laneView,
  layoutForComponent,
  signalName,
  viewIdFor,
  viewMoves,
} from "@monday/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { groups, views as viewsTable } from "../../db/schema.ts";
import type { Mailstore } from "../../mailstore/index.ts";
import { readGlobalSettings } from "../../settings/read.ts";
import type { DraftStore } from "../../views/drafts.ts";
import { ViewLimitError, ViewNotFoundError, type ViewStore } from "../../views/index.ts";
import type { HostedRuntime } from "../runtime/index.ts";
import type { Signals } from "../signals/index.ts";
import {
  type AuthorContext,
  type AuthorSettings,
  type CorrectionLine,
  reviseView,
  rewordedSignals,
  writeView,
} from "./author.ts";
import { runViewTest, type TestRun, type TestSettings } from "./test.ts";

const KEYS = [
  "views.max",
  "views.max_lanes",
  "views.max_signals",
  "views.scope.max_threads",
  "views.test.pool",
  "views.test.shown",
  "views.test.widen_days",
  "views.examples_in_question",
  "views.draft.retries",
  "views.prompt",
  "views.revise_prompt",
  "signals.backfill.concurrency",
  "sections.rules",
  "strings.views.not_read",
  "strings.views.change.reworded",
  "strings.views.change.examples",
  "strings.views.change.none",
  "strings.views.pin_needs_test",
  "strings.views.needs_typesafe",
  "strings.views.too_many",
] as const;

const fill = (t: string, vars: Record<string, string | number>) =>
  t.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));

/** A correction the user made on the card. */
export interface DraftCorrection {
  threadId: Id;
  /** "Move to": the Lane (or unsure) the Thread belongs in. */
  lane?: string | undefined;
  /** "Wrong": a Noul of the View's own and what it should have said. */
  signal?: string | undefined;
  holds?: boolean | undefined;
}

/** What update_view proposes: a change applied at once, or a draft whose moves the user sees first. */
export type UpdateProposal =
  | { kind: "direct"; view: View; next: ViewDoc }
  | { kind: "draft"; draft: ViewDraft };

export interface ViewDrafting {
  drafts: DraftStore;
  /** create_view: writes the document from the sentence and tries it. Nothing is saved as a View. */
  propose(workspaceId: Id, sentence: string): Promise<ViewDraft>;
  /** A correction from the card, kept as the draft's Examples. */
  correct(draftId: Id, correction: DraftCorrection): Promise<ViewDraft>;
  /** revise_view: the corrections into the questions, then tried again on the same Threads. */
  revise(draftId: Id, instruction?: string): Promise<ViewDraft>;
  /** Pin view: saves version 1, pins it and starts the backfill of its scope. */
  pin(draftId: Id, options?: { factsOnly?: boolean }): Promise<{ view: View; draft: ViewDraft }>;
  /** update_view: a new document for a pinned View; a Lane or Signal change is tried and its moves shown first. */
  proposeUpdate(
    viewId: Id,
    change: {
      instruction?: string | undefined;
      name?: string | undefined;
      icon?: string | undefined;
      component?: ViewDoc["layout"]["component"] | undefined;
      foldCorrections?: boolean | undefined;
    },
  ): Promise<UpdateProposal>;
  /** Apply on an edit's card: the new version, whose Undo points back at the old one. */
  apply(draftId: Id): Promise<{ view: View; draft: ViewDraft; previous: number }>;
  /** Not now. */
  discard(draftId: Id): Promise<ViewDraft>;
}

export function createViewDrafting(deps: {
  db: Db;
  mailstore: Mailstore;
  runtime: HostedRuntime;
  signals: Signals;
  store: ViewStore;
  drafts: DraftStore;
  context: (workspaceId: Id) => Promise<import("@monday/shared").ViewContext>;
  changed: (workspaceId: Id) => Promise<void>;
  log: (message: string) => void;
}): ViewDrafting {
  const { db, store, drafts } = deps;
  const settings = () => readGlobalSettings(db, KEYS);

  const authorSettings = (s: Awaited<ReturnType<typeof settings>>): AuthorSettings => ({
    prompt: s["views.prompt"],
    revisePrompt: s["views.revise_prompt"],
    retries: s["views.draft.retries"],
    limits: {
      maxLanes: s["views.max_lanes"],
      maxSignals: s["views.max_signals"],
      maxThreads: s["views.scope.max_threads"],
    },
  });

  const testSettings = (s: Awaited<ReturnType<typeof settings>>): TestSettings => ({
    pool: s["views.test.pool"],
    shown: s["views.test.shown"],
    widenDays: s["views.test.widen_days"],
    maxThreads: s["views.scope.max_threads"],
    examplesMax: s["views.examples_in_question"],
    notRead: s["strings.views.not_read"].toLowerCase(),
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
    doc: ViewDoc,
    threadIds?: readonly Id[],
  ): Promise<TestRun> => {
    const s = await settings();
    return runViewTest(
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

  /** The draft's corrections as the revision reads them: who, what, what the owner said, what the View read. */
  const correctionLines = (draft: ViewDraft): CorrectionLine[] => {
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

  const api: ViewDrafting = {
    drafts,

    async propose(workspaceId, sentence) {
      const s = await settings();
      if ((await pinnedCount(workspaceId)) >= s["views.max"]) {
        throw new ViewLimitError(
          "views",
          fill(s["strings.views.too_many"], { max: s["views.max"] }),
        );
      }
      const taken = new Set(
        (await db.select({ id: viewsTable.id }).from(viewsTable)).map((b) => b.id),
      );
      const { doc } = await writeView({
        runtime: deps.runtime,
        workspaceId,
        sentence,
        context: await authorContext(workspaceId, s),
        settings: authorSettings(s),
        id: viewIdFor(sentence.split(/\s+/).slice(0, 4).join(" "), taken),
      });
      const run = await test(workspaceId, doc);
      return drafts.create(workspaceId, {
        viewId: null,
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
      const example: ViewExample = {
        threadId: c.threadId,
        ...(tried?.from ? { from: tried.from } : {}),
        ...(subject ? { subject } : {}),
        at: new Date().toISOString(),
      };
      const key = c.lane !== undefined ? "_lanes" : c.signal;
      if (!key || (key !== "_lanes" && !draft.doc.signals.some((x) => x.id === key))) {
        throw new ViewNotFoundError(`${draftId} signal ${c.signal ?? ""}`);
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
          await reviseView({
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
          `view revise ${draftId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const before = draft.test ? draft.doc : null;
      const reworded = before ? rewordedSignals(before, doc) : [];
      const changes = [
        ...reworded.map((id) =>
          fill(s["strings.views.change.reworded"], { signal: signalName(doc, id) }),
        ),
        ...doc.signals.flatMap((sig) => {
          const n = (doc.examples[sig.id] ?? []).length;
          return n
            ? [
                fill(s["strings.views.change.examples"], {
                  count: n,
                  signal: signalName(doc, sig.id),
                }),
              ]
            : [];
        }),
      ];
      const run = await test(draft.workspaceId, doc, draft.threadIds);
      const moves = draft.test
        ? viewMoves(
            new Map(draft.test.shown.map((t) => [t.threadId, t.lane])),
            new Map(
              [...run.lanesOf].filter(([id]) => draft.test?.shown.some((t) => t.threadId === id)),
            ),
          )
        : null;
      const next: ViewTest = {
        ...run.test,
        widened: draft.test?.widened ?? run.test.widened,
        inScope: draft.test?.inScope ?? run.test.inScope,
        changes: changes.length ? changes : [s["strings.views.change.none"]],
        moves: draft.viewId ? (draft.test?.moves ?? null) : moves,
      };
      return drafts.save(draftId, { doc, test: next, threadIds: run.threadIds });
    },

    async pin(draftId, options = {}) {
      const draft = await drafts.get(draftId);
      const s = await settings();
      if (draft.status !== "open" || draft.viewId) throw new ViewNotFoundError(draftId);
      const t = draft.test;
      const need = Math.min(s["views.test.shown"], t?.tried ?? 0);
      if (!t || (!t.empty && t.shown.length < need)) {
        throw new ViewLimitError("test", s["strings.views.pin_needs_test"]);
      }
      let doc = draft.doc;
      if (options.factsOnly) {
        const facts = factLanesOnly(doc);
        if (!facts) throw new ViewLimitError("judge", s["strings.views.needs_typesafe"]);
        doc = facts;
      } else if (t.needsJudge) {
        throw new ViewLimitError("judge", s["strings.views.needs_typesafe"]);
      }
      const view = await store.create(draft.workspaceId, doc, { checkBar: t.empty });
      await deps.changed(draft.workspaceId);
      return { view, draft: await drafts.save(draftId, { status: "pinned" }) };
    },

    async proposeUpdate(viewId, change) {
      const view = await store.get(viewId);
      if (!view || view.deletedAt) throw new ViewNotFoundError(viewId);
      const s = await settings();
      let next: ViewDoc = {
        ...view.doc,
        ...(change.name ? { name: change.name } : {}),
        ...(change.icon ? { nav: { ...view.doc.nav, icon: change.icon } } : {}),
        ...(change.component
          ? { layout: layoutForComponent(change.component, view.doc.layout) }
          : {}),
      };
      if (change.foldCorrections) {
        const folded = await store.corrections(viewId);
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
          await reviseView({
            runtime: deps.runtime,
            workspaceId: view.workspaceId,
            doc: next,
            corrections: [],
            instruction: change.instruction,
            context: await authorContext(view.workspaceId, s),
            settings: authorSettings(s),
          })
        ).doc;
      }
      if (!lanesChanged(view.doc, next)) return { kind: "direct", view, next };
      // What decides the Lanes changed: try it, and show which Threads would move before Apply.
      const run = await test(view.workspaceId, next);
      const ctx = await deps.context(view.workspaceId);
      const stored = await deps.signals.readings(run.threadIds);
      const before = laneView(
        { ...view.doc, scope: { facts: { folder: "any" }, limit: run.threads.length || 1 } },
        run.threads.map((t) => ({ ...t, readings: stored.get(t.id) ?? {} })),
        ctx,
      );
      const moves = viewMoves(before.lanesOf, run.lanesOf);
      const draft = await drafts.create(view.workspaceId, {
        viewId,
        doc: next,
        previous: view.doc,
        test: { ...run.test, moves },
        threadIds: run.threadIds,
      });
      return { kind: "draft", draft };
    },

    async apply(draftId) {
      const draft = await drafts.get(draftId);
      if (draft.status !== "open" || !draft.viewId) throw new ViewNotFoundError(draftId);
      const { view, previous } = await store.update(draft.viewId, draft.doc);
      const folded = Object.keys(await store.corrections(draft.viewId)).length > 0;
      if (folded && Object.keys(draft.doc.examples).length)
        await store.clearCorrections(draft.viewId);
      await deps.changed(view.workspaceId);
      return { view, previous, draft: await drafts.save(draftId, { status: "applied" }) };
    },

    async discard(draftId) {
      return drafts.save(draftId, { status: "discarded" });
    },
  };
  return api;
}
