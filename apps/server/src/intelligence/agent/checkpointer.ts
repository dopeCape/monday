// LangGraph's Postgres checkpointer with every blob under the envelope
// (ADR 0007, research 5). A checkpoint holds the model's memory of a
// Session: the user's turns, what the tools read back, the drafts the model
// wrote. PostgresSaver stores those as serialized blobs in
// langgraph.checkpoint_blobs and langgraph.checkpoint_writes, so this
// subclass wraps its serializer: every blob is sealed under the Workspace
// key of the graph thread being written, as the "checkpoint" content kind,
// and opened on the way back. The thread id reaches the serializer through
// AsyncLocalStorage around the four public entry points, because the
// serializer protocol carries no context of its own.
//
// Which Workspace a thread belongs to: a Session's threads are its id and
// `<id>#<epoch>` after a Runtime switch (session-runtime.ts); an agentic
// Step's thread is `run:<runId>:<index>` (workflows). Both resolve through
// the tables, cached, since a thread never changes Workspace.
//
// Rows written before migration 0014 keep their plain "json" type and read
// as they are; nothing rewrites history, and a paused turn from before the
// upgrade still resumes. Checkpoint metadata (source, step, parents) holds
// no content and stays a JSONB column the plain serializer writes.
//
// A locked Server cannot open a checkpoint: a turn on it fails with
// LockedError, which the app answers 423, the same as any content read.

import { AsyncLocalStorage } from "node:async_hooks";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  type BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointMetadata,
  type CheckpointTuple,
  MemorySaver,
} from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { eq } from "drizzle-orm";
import pg from "pg";
import type { Db } from "../../db/client.ts";
import { sessions, workflowRuns } from "../../db/schema.ts";
import type { ContentStore } from "../../mailstore/content.ts";

/** Where the checkpointer keeps its tables, apart from ours. */
export const LANGGRAPH_SCHEMA = "langgraph";

/** The type prefix a sealed blob carries; the inner type follows it. */
export const SEALED_TYPE_PREFIX = "monday-sealed+";

/** The checkpoint package's own types, reached through the saver since the package is not a direct dependency. */
export type SerializerProtocol = BaseCheckpointSaver["serde"];
type ChannelVersions = Parameters<PostgresSaver["put"]>[3];
type PendingWrites = Parameters<PostgresSaver["putWrites"]>[1];
type ListOptions = Parameters<PostgresSaver["list"]>[1];

export interface CheckpointSealer {
  /** Seals and opens the blobs; the Mailstore in production. */
  content: ContentStore;
  /** The Workspace a graph thread belongs to, or null when the thread is unknown. */
  workspaceOf(threadId: string): Promise<string | null>;
}

const current = new AsyncLocalStorage<string>();

/** A sealed blob on the wire: u16 key length, the wrapped data key, the envelope. */
export function encodeSealed(key: Uint8Array, envelope: Uint8Array): Uint8Array {
  if (key.length > 0xffff) throw new RangeError("wrapped key too long");
  const out = new Uint8Array(2 + key.length + envelope.length);
  new DataView(out.buffer).setUint16(0, key.length);
  out.set(key, 2);
  out.set(envelope, 2 + key.length);
  return out;
}

export function decodeSealed(bytes: Uint8Array): { key: Uint8Array; envelope: Uint8Array } {
  if (bytes.length < 2) throw new RangeError("sealed blob too short");
  const keyLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(0);
  if (bytes.length < 2 + keyLength) throw new RangeError("sealed blob truncated");
  return { key: bytes.slice(2, 2 + keyLength), envelope: bytes.slice(2 + keyLength) };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function threadOf(config: RunnableConfig | undefined): string | null {
  const id = config?.configurable?.thread_id;
  return typeof id === "string" ? id : null;
}

/** The serializer: the plain one underneath, every blob sealed for the thread in scope. */
export function createSealingSerde(
  plain: SerializerProtocol,
  sealer: CheckpointSealer,
): SerializerProtocol {
  const workspaceInScope = async (): Promise<string> => {
    const threadId = current.getStore();
    if (!threadId) throw new Error("checkpoint blob touched outside a graph thread");
    const workspaceId = await sealer.workspaceOf(threadId);
    if (!workspaceId) throw new Error(`no Workspace for graph thread ${threadId}`);
    return workspaceId;
  };
  return {
    async dumpsTyped(data: unknown) {
      const [type, bytes] = await plain.dumpsTyped(data);
      const workspaceId = await workspaceInScope();
      const ref = await sealer.content.storeContent(workspaceId, "checkpoint", bytes);
      const envelope = ref.chunks[0];
      if (!envelope) throw new RangeError("checkpoint envelope missing");
      return [`${SEALED_TYPE_PREFIX}${type}`, encodeSealed(ref.key, envelope)];
    },
    async loadsTyped(type: string, data: Uint8Array | string) {
      if (!type.startsWith(SEALED_TYPE_PREFIX)) return plain.loadsTyped(type, data);
      const workspaceId = await workspaceInScope();
      const bytes = typeof data === "string" ? encoder.encode(data) : data;
      const { key, envelope } = decodeSealed(bytes);
      const plainBytes = await sealer.content.readContent({
        workspaceId,
        kind: "checkpoint",
        key,
        chunks: [envelope],
        size: -1,
      });
      return plain.loadsTyped(type.slice(SEALED_TYPE_PREFIX.length), plainBytes);
    },
  };
}

/** The Workspace of a graph thread, from the Sessions and Runs tables, remembered once found. */
export function graphThreadWorkspaces(db: Db): CheckpointSealer["workspaceOf"] {
  const known = new Map<string, string>();
  return async (threadId) => {
    const cached = known.get(threadId);
    if (cached) return cached;
    let workspaceId: string | null = null;
    // A Run's id carries colons of its own (run:<workflow>:<trigger>:<...>), so the
    // Step index is the last field and everything before it is the Run.
    const run = /^run:(.+):\d+$/.exec(threadId);
    if (run?.[1]) {
      const row = await db.query.workflowRuns.findFirst({
        where: eq(workflowRuns.id, run[1]),
        columns: { workspaceId: true },
      });
      workspaceId = row?.workspaceId ?? null;
    } else {
      const sessionId = threadId.split("#")[0] ?? threadId;
      const row = await db.query.sessions.findFirst({
        where: eq(sessions.id, sessionId),
        columns: { workspaceId: true },
      });
      workspaceId = row?.workspaceId ?? null;
    }
    if (workspaceId) known.set(threadId, workspaceId);
    return workspaceId;
  };
}

export class SealedPostgresSaver extends PostgresSaver {
  private readonly plain: SerializerProtocol;

  constructor(
    pool: pg.Pool,
    sealer: CheckpointSealer,
    options?: { schema?: string; plain?: SerializerProtocol },
  ) {
    // The default serializer is the base class's own; borrowed from a MemorySaver.
    const plain = options?.plain ?? new MemorySaver().serde;
    super(pool, createSealingSerde(plain, sealer), { schema: options?.schema ?? LANGGRAPH_SCHEMA });
    this.plain = plain;
  }

  private scoped<T>(config: RunnableConfig | undefined, fn: () => Promise<T>): Promise<T> {
    const threadId = threadOf(config);
    return threadId ? current.run(threadId, fn) : fn();
  }

  override put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    return this.scoped(config, () => super.put(config, checkpoint, metadata, newVersions));
  }

  override putWrites(config: RunnableConfig, writes: PendingWrites, taskId: string): Promise<void> {
    return this.scoped(config, () => super.putWrites(config, writes, taskId));
  }

  override getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    return this.scoped(config, () => super.getTuple(config));
  }

  override async *list(
    config: RunnableConfig,
    options?: ListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const inner = super.list(config, options);
    while (true) {
      const next = await this.scoped(config, () => inner.next());
      if (next.done) return;
      yield next.value;
    }
  }

  /** Metadata carries no content and stays a JSONB column: the plain serializer writes it. */
  protected override async _dumpMetadata(metadata: CheckpointMetadata): Promise<unknown> {
    const [, bytes] = await this.plain.dumpsTyped(metadata);
    return JSON.parse(decoder.decode(bytes).replace(/\0/g, ""));
  }

  protected override async _loadMetadata(metadata: Record<string, unknown>): Promise<unknown> {
    const [type, bytes] = await this.plain.dumpsTyped(metadata);
    return this.plain.loadsTyped(type, bytes);
  }
}

export interface SealedCheckpointerOptions {
  schema?: string;
}

/**
 * The checkpointer every entry uses: PostgresSaver over the same database
 * with sealed blobs, its tables set up right after our own migrations.
 */
export async function createSealedCheckpointer(
  databaseUrl: string,
  sealer: CheckpointSealer,
  options: SealedCheckpointerOptions = {},
): Promise<SealedPostgresSaver> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const saver = new SealedPostgresSaver(pool, sealer, {
    ...(options.schema ? { schema: options.schema } : {}),
  });
  try {
    await saver.setup();
  } catch (error) {
    await pool.end().catch(() => {});
    throw error;
  }
  return saver;
}

export type { BaseCheckpointSaver };
