// The Activity log (ADR 0002, CONTEXT.md): the per-Workspace record of every
// Tool call with tool, tier, input summary, preview, who decided, result and
// the undo record. The tool server writes a row when a call starts and
// updates it as the call waits, applies, fails or is undone; keyed by
// (session, call id) it is also the ledger that makes a re-executed LangGraph
// node idempotent. Postgres in production, memory in tests.

import type {
  ActivityRecord,
  ApprovalDecision,
  Tier,
  ToolCall,
  ToolPreview,
  UndoRecord,
} from "@monday/shared";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { activity } from "../../db/schema.ts";

export interface ActivityStart {
  workspaceId: string;
  sessionId: string | null;
  callId: string | null;
  tool: string;
  tier: Tier;
  input: Record<string, unknown>;
  summary: string;
  preview: ToolPreview | null;
  status: ToolCall["status"];
  decision: ApprovalDecision | "auto" | null;
}

export interface ActivityPatch {
  status?: ToolCall["status"];
  decision?: ApprovalDecision | "auto" | null;
  preview?: ToolPreview | null;
  summary?: string;
  result?: unknown;
  /** The one-line result the card shows. */
  resultText?: string | null;
  undo?: UndoRecord | null;
  undoneAt?: string | null;
}

/** The stored row plus what the API never returns: the undo record, the full result text the model read, the data. */
export interface ActivityRow extends ActivityRecord {
  undo: UndoRecord | null;
  resultText: string | null;
  resultData: unknown;
}

export interface ActivityLog {
  start(entry: ActivityStart): Promise<ActivityRow>;
  update(id: string, patch: ActivityPatch): Promise<ActivityRow>;
  get(id: string): Promise<ActivityRow | null>;
  /** The row for a model's call id in a Session, if the call was already started. */
  findCall(sessionId: string, callId: string): Promise<ActivityRow | null>;
  list(
    workspaceId: string,
    options?: { limit?: number; sessionId?: string },
  ): Promise<ActivityRow[]>;
  /** The newest done row with an undo record that has not been undone, in the Session or the Workspace. */
  latestUndoable(workspaceId: string, sessionId?: string | null): Promise<ActivityRow | null>;
}

/** The one line a card shows of a result: its first line, without a trailing colon, cut short. */
export function resultLine(text: string): string {
  const first = text.split("\n")[0] ?? "";
  return first.replace(/:\s*$/, "").slice(0, 160);
}

/** The API projection: everything but the undo record and the raw result. */
export function publicActivity(row: ActivityRow): ActivityRecord {
  const { undo: _undo, resultText: _text, resultData: _data, ...rest } = row;
  return rest;
}

type Row = typeof activity.$inferSelect;

function project(r: Row): ActivityRow {
  const resultText =
    typeof r.result === "object" && r.result !== null && "text" in r.result
      ? String((r.result as { text?: unknown }).text ?? "")
      : undefined;
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    sessionId: r.sessionId,
    runId: null,
    tool: r.tool,
    tier: r.tier ?? "read-only",
    inputSummary: r.summary,
    status: r.status,
    approvedBy: r.decision === "approved" ? "user" : null,
    ...(resultText !== undefined ? { result: resultLine(resultText) } : {}),
    undoable: r.undo !== null && r.undoneAt === null && r.status === "done",
    undoneAt: r.undoneAt?.toISOString() ?? null,
    actor: r.actor === "user" ? "user" : r.actor === "automation" ? "automation" : "agent",
    callId: r.callId,
    input: r.input ?? null,
    preview: r.preview ?? null,
    decision: r.decision ?? null,
    at: r.at.toISOString(),
    undo: r.undo ?? null,
    resultText: resultText ?? null,
    resultData:
      typeof r.result === "object" && r.result !== null && "data" in r.result
        ? (r.result as { data?: unknown }).data
        : null,
  };
}

function resultColumn(patch: ActivityPatch): { text: string; data: unknown } | undefined {
  if (patch.result === undefined && patch.resultText === undefined) return undefined;
  return { text: patch.resultText ?? "", data: patch.result ?? null };
}

export function createActivityLog(db: Db, options: { now?: () => Date } = {}): ActivityLog {
  const now = options.now ?? (() => new Date());
  return {
    async start(entry) {
      const id = crypto.randomUUID();
      const [row] = await db
        .insert(activity)
        .values({
          id,
          workspaceId: entry.workspaceId,
          actor: "agent",
          tool: entry.tool,
          summary: entry.summary,
          at: now(),
          sessionId: entry.sessionId,
          callId: entry.callId,
          tier: entry.tier,
          input: entry.input,
          preview: entry.preview,
          decision: entry.decision,
          status: entry.status,
        })
        .returning();
      if (!row) throw new Error("activity insert returned nothing");
      return project(row);
    },

    async update(id, patch) {
      const result = resultColumn(patch);
      const [row] = await db
        .update(activity)
        .set({
          ...(patch.status !== undefined ? { status: patch.status } : {}),
          ...(patch.decision !== undefined ? { decision: patch.decision } : {}),
          ...(patch.preview !== undefined ? { preview: patch.preview } : {}),
          ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
          ...(result !== undefined ? { result } : {}),
          ...(patch.undo !== undefined ? { undo: patch.undo } : {}),
          ...(patch.undoneAt !== undefined
            ? { undoneAt: patch.undoneAt ? new Date(patch.undoneAt) : null }
            : {}),
        })
        .where(eq(activity.id, id))
        .returning();
      if (!row) throw new Error(`activity ${id} not found`);
      return project(row);
    },

    async get(id) {
      const row = await db.query.activity.findFirst({ where: eq(activity.id, id) });
      return row ? project(row) : null;
    },

    async findCall(sessionId, callId) {
      const row = await db.query.activity.findFirst({
        where: and(eq(activity.sessionId, sessionId), eq(activity.callId, callId)),
      });
      return row ? project(row) : null;
    },

    async list(workspaceId, opts = {}) {
      const rows = await db
        .select()
        .from(activity)
        .where(
          and(
            eq(activity.workspaceId, workspaceId),
            ...(opts.sessionId ? [eq(activity.sessionId, opts.sessionId)] : []),
          ),
        )
        .orderBy(desc(activity.at), desc(activity.id))
        .limit(Math.max(1, Math.min(opts.limit ?? 100, 500)));
      return rows.map(project);
    },

    async latestUndoable(workspaceId, sessionId) {
      const rows = await db
        .select()
        .from(activity)
        .where(
          and(
            eq(activity.workspaceId, workspaceId),
            eq(activity.status, "done"),
            isNotNull(activity.undo),
            isNull(activity.undoneAt),
            ...(sessionId ? [eq(activity.sessionId, sessionId)] : []),
          ),
        )
        .orderBy(desc(activity.at), desc(activity.id))
        .limit(1);
      const row = rows[0];
      return row ? project(row) : null;
    },
  };
}

/** The same interface in memory, for tool server tests that need no database. */
export function createMemoryActivityLog(options: { now?: () => Date } = {}): ActivityLog & {
  rows: ActivityRow[];
} {
  const now = options.now ?? (() => new Date());
  const rows: ActivityRow[] = [];
  const undoable = (r: ActivityRow) =>
    r.status === "done" && r.undo !== null && r.undoneAt === null;
  return {
    rows,
    async start(entry) {
      const row: ActivityRow = {
        id: crypto.randomUUID(),
        workspaceId: entry.workspaceId,
        sessionId: entry.sessionId,
        runId: null,
        tool: entry.tool,
        tier: entry.tier,
        inputSummary: entry.summary,
        status: entry.status,
        approvedBy: null,
        undoable: false,
        undoneAt: null,
        actor: "agent",
        callId: entry.callId,
        input: entry.input,
        preview: entry.preview,
        decision: entry.decision,
        at: now().toISOString(),
        undo: null,
        resultText: null,
        resultData: null,
      };
      rows.push(row);
      return row;
    },
    async update(id, patch) {
      const row = rows.find((r) => r.id === id);
      if (!row) throw new Error(`activity ${id} not found`);
      if (patch.status !== undefined) row.status = patch.status;
      if (patch.decision !== undefined) {
        row.decision = patch.decision;
        row.approvedBy = patch.decision === "approved" ? "user" : null;
      }
      if (patch.preview !== undefined) row.preview = patch.preview;
      if (patch.summary !== undefined) row.inputSummary = patch.summary;
      if (patch.resultText !== undefined) {
        row.resultText = patch.resultText;
        if (patch.resultText === null) delete row.result;
        else row.result = resultLine(patch.resultText);
      }
      if (patch.result !== undefined) row.resultData = patch.result;
      if (patch.undo !== undefined) row.undo = patch.undo;
      if (patch.undoneAt !== undefined) row.undoneAt = patch.undoneAt;
      row.undoable = undoable(row);
      return row;
    },
    async get(id) {
      return rows.find((r) => r.id === id) ?? null;
    },
    async findCall(sessionId, callId) {
      return rows.find((r) => r.sessionId === sessionId && r.callId === callId) ?? null;
    },
    async list(workspaceId, opts = {}) {
      return rows
        .filter(
          (r) =>
            r.workspaceId === workspaceId && (!opts.sessionId || r.sessionId === opts.sessionId),
        )
        .slice()
        .reverse()
        .slice(0, opts.limit ?? 100);
    },
    async latestUndoable(workspaceId, sessionId) {
      return (
        rows
          .filter(
            (r) =>
              r.workspaceId === workspaceId &&
              undoable(r) &&
              (!sessionId || r.sessionId === sessionId),
          )
          .at(-1) ?? null
      );
    },
  };
}
