// Templates on the Server (docs/spec/templates.md, "Where Templates live").
// A Template is the user's content, like a Draft: a row in `templates` whose
// name, fits-when, subject, body and Placeholders are one envelope under the
// Workspace key (ADR 0009), never a Setting and never the Config file (ADR
// 0001). Every write is a `template` row on the Changes feed carrying the
// headers only, so each Device mirrors its Workspace's Templates into the
// Cache by asking GET /templates again.
//
// The built-ins are data in @monday/shared and never rows: editing one saves
// a copy here (built_in names it) that replaces it in the library, and
// "Restore the original" deletes the copy. "Use in every account" saves one
// row per Workspace, each sealed under its own key, linked by share_group_id.

import type {
  Id,
  Template,
  TemplateChange,
  TemplateFile,
  TemplateInput,
  TemplateScope,
} from "@monday/shared";
import {
  findBuiltinTemplate,
  templateErrors,
  templateLibrary,
  templatesFromFiles,
  templatesToFiles,
  tidyTemplate,
} from "@monday/shared";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { templates as templatesTable, workspaces } from "../db/schema.ts";
import type { Mailstore } from "../mailstore/index.ts";
import { readGlobalSetting } from "../settings/read.ts";

type TemplateRow = typeof templatesTable.$inferSelect;

/** The Template would not save: a Placeholder is undeclared or unused, or a field is missing. */
export class TemplateInvalidError extends Error {
  readonly status = 422;
  constructor(readonly errors: string[]) {
    super(errors.join(" "));
    this.name = "TemplateInvalidError";
  }
}

export class TemplateNotFoundError extends Error {
  readonly status = 404;
  constructor(readonly id: string) {
    super(`template ${id} not found`);
    this.name = "TemplateNotFoundError";
  }
}

/** A built-in is read-only: it is edited by saving a copy. */
export class BuiltinTemplateError extends Error {
  readonly status = 409;
  constructor(readonly id: string) {
    super(`${id} is a built-in template; edit it by saving a copy`);
    this.name = "BuiltinTemplateError";
  }
}

export interface CreateOptions {
  /** This Workspace only, or a copy in every Workspace; absent reads templates.default_scope. */
  scope?: TemplateScope | undefined;
  createdBy?: "user" | "agent" | undefined;
  /** The built-in this is an edited copy of. */
  builtIn?: string | null | undefined;
  /** A fixed id for the row in the calling Workspace (Undo of a delete puts the same id back). */
  id?: Id | undefined;
}

export interface Templates {
  /** The Workspace's own Templates, decrypted, oldest first. Throws LockedError when locked. */
  list(workspaceId: Id): Promise<Template[]>;
  /** Own Templates and the built-ins they do not replace or the Setting hides, in the picker's order. */
  library(workspaceId: Id): Promise<Template[]>;
  /** An own Template or a built-in by id; null when neither exists (or it was deleted). */
  get(id: Id): Promise<Template | null>;
  /**
   * Saves a new Template: one row here, or one per Workspace when the scope
   * is everywhere, linked by a share group. Returns the rows, this
   * Workspace's first. Throws TemplateInvalidError.
   */
  create(workspaceId: Id, input: TemplateInput, options?: CreateOptions): Promise<Template[]>;
  /**
   * Changes a Template. `everywhere` changes every copy in its share group;
   * otherwise only this row, which then leaves the group. A built-in id
   * saves a copy in `workspaceId` instead. Returns the rows written.
   */
  update(
    id: Id,
    input: TemplateInput,
    options?: { everywhere?: boolean; workspaceId?: Id },
  ): Promise<Template[]>;
  /** Deletes a Template, or every copy of it; returns what was deleted, for Undo. */
  remove(id: Id, options?: { everywhere?: boolean }): Promise<Template[]>;
  /** Puts deleted rows back exactly as they were (Undo of a delete). */
  restore(ids: readonly Id[]): Promise<Template[]>;
  /** The Workspace's own Templates as Markdown files (Export). */
  exportFiles(workspaceId: Id): Promise<TemplateFile[]>;
  /** Reads Markdown files into new Templates (Import); a file that does not read is listed with why. */
  importFiles(
    workspaceId: Id,
    files: readonly TemplateFile[],
    options?: { scope?: TemplateScope },
  ): Promise<{ created: Template[]; errors: Array<{ file: string; message: string }> }>;
}

export interface TemplatesOptions {
  db: Db;
  mailstore: Mailstore;
  now?: () => Date;
  id?: () => string;
}

/** The feed's headers for a row. */
export function templateHeaders(r: TemplateRow): TemplateChange {
  return {
    id: r.id,
    kind: r.kind,
    builtIn: r.builtIn,
    shareGroupId: r.shareGroupId,
    createdBy: r.createdBy,
    updatedAt: r.updatedAt.toISOString(),
    deleted: r.deleted,
  };
}

interface SealedContent {
  name: string;
  fitsWhen: string;
  subject: string | null;
  body: string;
  placeholders: TemplateInput["placeholders"];
}

function validated(input: TemplateInput): TemplateInput {
  const tidy = tidyTemplate(input);
  const errors = templateErrors(tidy);
  if (errors.length > 0) throw new TemplateInvalidError(errors);
  return tidy;
}

export function createTemplates(options: TemplatesOptions): Templates {
  const { db, mailstore } = options;
  const now = options.now ?? (() => new Date());
  const newId = options.id ?? (() => `tpl_${crypto.randomUUID()}`);

  const seal = async (workspaceId: Id, input: TemplateInput) => {
    const content: SealedContent = {
      name: input.name,
      fitsWhen: input.fitsWhen,
      subject: input.subject,
      body: input.body,
      placeholders: input.placeholders,
    };
    const ref = await mailstore.storeContent(workspaceId, "template", JSON.stringify(content));
    const contentEnc = ref.chunks[0];
    if (!contentEnc) throw new RangeError("template envelope missing");
    return { contentEnc, contentKey: ref.key };
  };

  const open = async (r: TemplateRow): Promise<Template> => {
    const content = JSON.parse(
      await mailstore.readText({
        workspaceId: r.workspaceId,
        kind: "template",
        key: r.contentKey,
        chunks: [r.contentEnc],
        size: -1,
      }),
    ) as SealedContent;
    return {
      id: r.id,
      workspaceId: r.workspaceId,
      shareGroupId: r.shareGroupId,
      builtIn: r.builtIn,
      createdBy: r.createdBy,
      updatedAt: r.updatedAt.toISOString(),
      kind: r.kind,
      name: content.name,
      fitsWhen: content.fitsWhen,
      subject: content.subject,
      body: content.body,
      placeholders: content.placeholders,
    };
  };

  const record = (executor: Db | Tx, r: TemplateRow) =>
    mailstore.recordChange(executor, {
      workspaceId: r.workspaceId,
      kind: "template",
      entityId: r.id,
      payload: templateHeaders(r),
    });

  const row = async (id: Id): Promise<TemplateRow | null> =>
    (await db.query.templates.findFirst({ where: eq(templatesTable.id, id) })) ?? null;

  const liveRow = async (id: Id): Promise<TemplateRow> => {
    const r = await row(id);
    if (!r || r.deleted) throw new TemplateNotFoundError(id);
    return r;
  };

  const groupRows = async (r: TemplateRow): Promise<TemplateRow[]> =>
    r.shareGroupId
      ? db
          .select()
          .from(templatesTable)
          .where(
            and(eq(templatesTable.shareGroupId, r.shareGroupId), eq(templatesTable.deleted, false)),
          )
      : [r];

  const allWorkspaces = async (first: Id): Promise<Id[]> => {
    const rows = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .orderBy(asc(workspaces.id));
    return [first, ...rows.map((w) => w.id).filter((id) => id !== first)];
  };

  const api: Templates = {
    async list(workspaceId) {
      const rows = await db
        .select()
        .from(templatesTable)
        .where(and(eq(templatesTable.workspaceId, workspaceId), eq(templatesTable.deleted, false)))
        .orderBy(asc(templatesTable.createdAt), asc(templatesTable.id));
      return Promise.all(rows.map(open));
    },

    async library(workspaceId) {
      const hidden = await readGlobalSetting(db, "templates.builtin.hidden");
      return templateLibrary(await api.list(workspaceId), hidden);
    },

    async get(id) {
      const builtin = findBuiltinTemplate(id);
      if (builtin) return builtin;
      const r = await row(id);
      return r && !r.deleted ? open(r) : null;
    },

    async create(workspaceId, input, opts = {}) {
      const tidy = validated(input);
      const scope = opts.scope ?? (await readGlobalSetting(db, "templates.default_scope"));
      const targets = scope === "everywhere" ? await allWorkspaces(workspaceId) : [workspaceId];
      const shareGroupId = targets.length > 1 ? `tsg_${crypto.randomUUID()}` : null;
      const at = now();
      const sealed = await Promise.all(targets.map((w) => seal(w, tidy)));
      const rows = await db.transaction(async (tx) => {
        const out: TemplateRow[] = [];
        for (const [i, w] of targets.entries()) {
          const s = sealed[i];
          if (!s) continue;
          const [r] = await tx
            .insert(templatesTable)
            .values({
              id: i === 0 && opts.id ? opts.id : newId(),
              workspaceId: w,
              shareGroupId,
              kind: tidy.kind,
              builtIn: opts.builtIn ?? null,
              createdBy: opts.createdBy ?? "user",
              ...s,
              updatedAt: at,
              createdAt: at,
            })
            .returning();
          if (!r) throw new Error("insert returned no row");
          await record(tx, r);
          out.push(r);
        }
        return out;
      });
      return Promise.all(rows.map(open));
    },

    async update(id, input, opts = {}) {
      const builtin = findBuiltinTemplate(id);
      if (builtin) {
        if (!opts.workspaceId) throw new BuiltinTemplateError(id);
        // Editing a built-in saves a copy that replaces it in this Workspace's picker.
        const existing = (await api.list(opts.workspaceId)).find((t) => t.builtIn === id);
        if (existing) return api.update(existing.id, input, { everywhere: false });
        return api.create(opts.workspaceId, input, { scope: "workspace", builtIn: id });
      }
      const tidy = validated(input);
      const target = await liveRow(id);
      const rows = opts.everywhere ? await groupRows(target) : [target];
      const at = now();
      const sealed = await Promise.all(rows.map((r) => seal(r.workspaceId, tidy)));
      const written = await db.transaction(async (tx) => {
        const out: TemplateRow[] = [];
        for (const [i, r] of rows.entries()) {
          const s = sealed[i];
          if (!s) continue;
          const [u] = await tx
            .update(templatesTable)
            .set({
              ...s,
              kind: tidy.kind,
              // "Only here" takes this copy out of its group, so a later "everywhere" leaves it alone.
              shareGroupId: opts.everywhere ? r.shareGroupId : null,
              updatedAt: at,
            })
            .where(eq(templatesTable.id, r.id))
            .returning();
          if (!u) continue;
          await record(tx, u);
          out.push(u);
        }
        return out;
      });
      return Promise.all(written.map(open));
    },

    async remove(id, opts = {}) {
      if (findBuiltinTemplate(id)) throw new BuiltinTemplateError(id);
      const target = await liveRow(id);
      const rows = opts.everywhere ? await groupRows(target) : [target];
      const before = await Promise.all(rows.map(open));
      const at = now();
      await db.transaction(async (tx) => {
        for (const r of rows) {
          const [u] = await tx
            .update(templatesTable)
            .set({ deleted: true, updatedAt: at })
            .where(eq(templatesTable.id, r.id))
            .returning();
          if (u) await record(tx, u);
        }
      });
      return before;
    },

    async restore(ids) {
      if (ids.length === 0) return [];
      const at = now();
      const rows = await db.transaction(async (tx) => {
        const out = await tx
          .update(templatesTable)
          .set({ deleted: false, updatedAt: at })
          .where(inArray(templatesTable.id, [...ids]))
          .returning();
        for (const r of out) await record(tx, r);
        return out;
      });
      return Promise.all(rows.map(open));
    },

    async exportFiles(workspaceId) {
      return templatesToFiles(await api.list(workspaceId));
    },

    async importFiles(workspaceId, files, opts = {}) {
      const read = templatesFromFiles(files);
      const created: Template[] = [];
      for (const input of read.templates) {
        const [first] = await api.create(workspaceId, input, { scope: opts.scope });
        if (first) created.push(first);
      }
      return { created, errors: read.errors };
    },
  };
  return api;
}
