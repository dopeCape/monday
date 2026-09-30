// The values a View's Extractions picked (docs/spec/views.md, "Data and
// sync"): kept sealed with each Thread's Facts on the Server (they are mail
// content), read here decrypted for the owner's Device, which mirrors them
// into the Cache's view_values and computes every Block from them.

import type { ExtractedValue, Id, JsonValue } from "@monday/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { signalAnswers, threadFacts } from "../db/schema.ts";
import type { Mailstore } from "../mailstore/index.ts";

/** Values by Thread, then by the Extraction's stored id. */
export type ValuesByThread = Record<Id, Record<string, ExtractedValue>>;

interface SealedPicks {
  picks?: Record<
    string,
    { value: string; confidence: number; normalized?: unknown } | undefined
  > | null;
}

/**
 * The picked values of these Extractions (stored ids) on these Threads, or,
 * with no Threads named, on every Thread that has a pick for one of them.
 */
export async function readValues(
  db: Db,
  mailstore: Mailstore,
  workspaceId: Id,
  extractionIds: readonly string[],
  threadIds?: readonly Id[],
  limit = 5000,
): Promise<ValuesByThread> {
  const out: ValuesByThread = {};
  if (extractionIds.length === 0) return out;
  let ids = threadIds ? [...new Set(threadIds)] : null;
  if (!ids) {
    const rows = await db
      .selectDistinct({ threadId: signalAnswers.threadId })
      .from(signalAnswers)
      .where(
        and(
          eq(signalAnswers.workspaceId, workspaceId),
          inArray(signalAnswers.signalId, [...extractionIds]),
          eq(signalAnswers.choice, "picked"),
        ),
      )
      .limit(limit);
    ids = rows.map((r) => r.threadId);
  }
  if (ids.length === 0) return out;
  const wanted = new Set(extractionIds);
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await db
      .select({
        threadId: threadFacts.threadId,
        contentEnc: threadFacts.contentEnc,
        contentKey: threadFacts.contentKey,
      })
      .from(threadFacts)
      .where(
        and(
          eq(threadFacts.workspaceId, workspaceId),
          inArray(threadFacts.threadId, ids.slice(i, i + 500)),
        ),
      );
    for (const r of rows) {
      if (!r.contentEnc || !r.contentKey) continue;
      let sealed: SealedPicks;
      try {
        sealed = JSON.parse(
          await mailstore.readText({
            workspaceId,
            kind: "facts",
            key: r.contentKey,
            chunks: [r.contentEnc],
            size: -1,
          }),
        ) as SealedPicks;
      } catch {
        continue;
      }
      const values: Record<string, ExtractedValue> = {};
      for (const [id, p] of Object.entries(sealed.picks ?? {})) {
        if (!p || !wanted.has(id)) continue;
        values[id] = {
          text: p.value,
          value: (p.normalized ?? p.value) as JsonValue,
          confidence: p.confidence,
        };
      }
      if (Object.keys(values).length) out[r.threadId] = values;
    }
  }
  return out;
}
