// What the onboarding tools act through (docs/spec/onboarding.md): the top
// senders already synced (headers only, no bodies), the Thread count, Group
// proposals scored by routing's preview before any Group exists, the catalog
// of Workflows with a Dry run of an unsaved document, and the level in
// effect. Everything a proposal shows is computed here; nothing is created
// until the tool's approval applies it.

import type {
  AiLevel,
  DryRunPreview,
  GroupInput,
  GroupView,
  Id,
  ProposedMove,
  RoutingApplied,
  RoutingPreview,
  WorkflowInput,
} from "@monday/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { accounts, messages, threads, workspaces } from "../db/schema.ts";
import { type CatalogEntry, catalogEntry, matchCatalog } from "../workflows/catalog.ts";
import type { Workflows } from "../workflows/index.ts";
import type { CandidateGroup, Routing } from "./routing/index.ts";

/** One sender as the what-matters chips and the Group proposals see it. */
export interface TopSender {
  name: string;
  email: string;
  domain: string;
  /** Messages from this sender in the Workspace. */
  messages: number;
}

export interface OnboardingSeam {
  level(): Promise<AiLevel>;
  /** The Account's address, so the owner is never a top sender. */
  address(workspaceId: Id): Promise<string>;
  topSenders(workspaceId: Id, limit: number): Promise<TopSender[]>;
  threadCount(workspaceId: Id): Promise<number>;
  /** Routing's preview with the candidates scored beside the stored Groups, over the newest Threads. */
  previewGroups(
    workspaceId: Id,
    candidates: readonly CandidateGroup[],
    recent: number,
  ): Promise<RoutingPreview>;
  createGroup(workspaceId: Id, input: GroupInput): Promise<GroupView>;
  deleteGroup(groupId: Id): Promise<void>;
  applyMoves(workspaceId: Id, moves: readonly ProposedMove[]): Promise<RoutingApplied>;
  catalog(tools: readonly string[], max: number): CatalogEntry[];
  catalogEntry(id: string): CatalogEntry | undefined;
  dryRunInput(workspaceId: Id, input: WorkflowInput): Promise<DryRunPreview>;
}

export interface OnboardingOptions {
  db: Db;
  routing: Routing;
  workflows: Workflows;
  level: () => Promise<AiLevel>;
}

export function createOnboarding(options: OnboardingOptions): OnboardingSeam {
  const { db, routing, workflows } = options;
  const address = async (workspaceId: Id): Promise<string> => {
    const rows = await db
      .select({ address: accounts.address })
      .from(workspaces)
      .innerJoin(accounts, eq(accounts.id, workspaces.accountId))
      .where(eq(workspaces.id, workspaceId));
    return rows[0]?.address ?? "";
  };
  return {
    level: options.level,
    address,

    async topSenders(workspaceId, limit) {
      const me = (await address(workspaceId)).toLowerCase();
      const rows = await db
        .select({
          email: sql<string>`lower(${messages.from}->>'email')`,
          name: sql<string>`max(${messages.from}->>'name')`,
          count: sql<number>`count(*)::int`,
        })
        .from(messages)
        .where(eq(messages.workspaceId, workspaceId))
        .groupBy(sql`lower(${messages.from}->>'email')`)
        .orderBy(desc(sql`count(*)`))
        .limit(Math.max(1, limit + 1));
      return rows
        .filter((r) => r.email && r.email !== me)
        .slice(0, limit)
        .map((r) => ({
          name: r.name ?? "",
          email: r.email,
          domain: r.email.split("@")[1] ?? "",
          messages: r.count,
        }));
    },

    async threadCount(workspaceId) {
      const rows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(threads)
        .where(and(eq(threads.workspaceId, workspaceId), eq(threads.deleted, false)));
      return rows[0]?.count ?? 0;
    },

    previewGroups: (workspaceId, candidates, recent) =>
      routing.preview(workspaceId, { candidates, recent }),
    createGroup: (workspaceId, input) => routing.createGroup(workspaceId, input),
    deleteGroup: (groupId) => routing.deleteGroup(groupId),
    applyMoves: (workspaceId, moves) => routing.apply(workspaceId, moves),
    catalog: (tools, max) => matchCatalog(tools, max),
    catalogEntry: (id) => catalogEntry(id),
    dryRunInput: (workspaceId, input) => workflows.dryRunInput(workspaceId, input),
  };
}
