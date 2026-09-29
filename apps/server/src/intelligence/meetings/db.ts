// The meetings module's seams over the Server's database: the Thread through
// the mailstore (headers in the clear, text decrypted on demand), readings in
// thread_meetings sealed under the Workspace key, and the feed change.

import type { MeetingChange, MeetingChip } from "@monday/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { accounts, threadMeetings, threads, workspaces } from "../../db/schema.ts";
import type { Mailstore } from "../../mailstore/index.ts";
import type { MeetingStore, MeetingThreadSource } from "./index.ts";
import type { MeetingReading } from "./resolve.ts";

export function createDbMeetingSource(db: Db, mailstore: Mailstore): MeetingThreadSource {
  return {
    async read(threadId) {
      const row = await db.query.threads.findFirst({ where: eq(threads.id, threadId) });
      if (!row) return null;
      const [owner] = await db
        .select({ address: accounts.address, name: accounts.displayName })
        .from(workspaces)
        .innerJoin(accounts, eq(accounts.id, workspaces.accountId))
        .where(eq(workspaces.id, row.workspaceId));
      const headers = await mailstore.listMessages(threadId);
      return {
        workspaceId: row.workspaceId,
        subject: await mailstore.readThreadSubject(threadId),
        owner: { name: owner?.name ?? "", email: owner?.address ?? "" },
        participants: row.participants,
        messages: headers.map((m) => ({
          id: m.id,
          from: m.from,
          to: m.to,
          cc: m.cc,
          date: m.date,
          headers: m.headers,
          attachments: m.attachments.map((a) => ({ mediaType: a.mediaType })),
        })),
      };
    },
    async text(messageId) {
      return (await mailstore.readMessageBody(messageId)).text;
    },
  };
}

export function createDbMeetingStore(db: Db, mailstore: Mailstore): MeetingStore {
  return {
    async get(threadId) {
      const row = await db.query.threadMeetings.findFirst({
        where: eq(threadMeetings.threadId, threadId),
      });
      if (!row) return null;
      const json = await mailstore.readText({
        workspaceId: row.workspaceId,
        kind: "meeting",
        key: row.readingKey,
        chunks: [row.readingEnc],
        size: -1,
      });
      return { reading: JSON.parse(json) as MeetingReading, chip: row.chip ?? null };
    },
    async put(reading: MeetingReading, chip: MeetingChip | null) {
      const sealed = await mailstore.storeContent(
        reading.workspaceId,
        "meeting",
        JSON.stringify(reading),
      );
      const enc = sealed.chunks[0];
      if (!enc) throw new RangeError("meeting envelope missing");
      const values = {
        workspaceId: reading.workspaceId,
        messageId: reading.messageId,
        messageCount: reading.messageCount,
        readingEnc: enc,
        readingKey: sealed.key,
        judgedBy: reading.judgedBy,
        model: reading.model,
        chip,
        judgedAt: new Date(reading.judgedAt),
      };
      await db
        .insert(threadMeetings)
        .values({ threadId: reading.threadId, ...values })
        .onConflictDoUpdate({ target: threadMeetings.threadId, set: values });
    },
    async setChip(threadId, chip) {
      await db.update(threadMeetings).set({ chip }).where(eq(threadMeetings.threadId, threadId));
    },
  };
}

/** The feed change for a Thread's meeting chip. */
export function recordMeeting(db: Db, mailstore: Mailstore) {
  return async (workspaceId: string, change: MeetingChange) => {
    await mailstore.recordChange(db, {
      workspaceId,
      kind: "meeting",
      entityId: change.threadId,
      payload: change,
    });
  };
}
