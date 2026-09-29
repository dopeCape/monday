// What a View's actions may name outside the document (docs/spec/views.md,
// "Actions on items"): the Workspace's Workflows, Templates, Custom actions
// and Groups. Validation checks an action against these, and the drafting
// prompt lists them so the model names only what exists.

import type { Id, ViewRefs } from "@monday/shared";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { groups, templates, workflows } from "../db/schema.ts";
import { readGlobalSettings } from "../settings/read.ts";

export interface NamedRefs extends Required<ViewRefs> {
  /** The same with their names, for the drafting prompt. */
  named: {
    workflows: Array<{ id: string; name: string }>;
    customActions: Array<{ id: string; name: string }>;
    groups: Array<{ id: string; name: string }>;
  };
}

export async function viewRefs(db: Db, workspaceId: Id): Promise<NamedRefs> {
  const [w, t, g, s] = await Promise.all([
    db
      .select({ id: workflows.id, name: workflows.name })
      .from(workflows)
      .where(eq(workflows.workspaceId, workspaceId)),
    db
      .select({ id: templates.id })
      .from(templates)
      .where(and(eq(templates.workspaceId, workspaceId), eq(templates.deleted, false))),
    db
      .select({ id: groups.id, name: groups.name })
      .from(groups)
      .where(eq(groups.workspaceId, workspaceId)),
    readGlobalSettings(db, ["actions.custom"] as const),
  ]);
  const custom = s["actions.custom"].map((a) => ({ id: a.id, name: a.label }));
  return {
    workflows: w.map((x) => x.id),
    templates: t.map((x) => x.id),
    customActions: custom.map((a) => a.id),
    groups: g.map((x) => x.id),
    named: { workflows: w, customActions: custom, groups: g },
  };
}
