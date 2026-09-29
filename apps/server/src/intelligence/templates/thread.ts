// A Thread as the Templates questions read it: the owner, the subject and
// each Message's headers and own words (quoted history dropped), newest
// last. The same shape feeds the candidate finders and the judge's state, so
// a picked span is always text the state showed. Decrypts, so it needs the
// root key.

import type { FillThread, Id, JsonValue, Person } from "@monday/shared";
import { ownWords } from "@monday/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { accounts, threads, workspaces } from "../../db/schema.ts";
import { type Mailstore, NotFoundError } from "../../mailstore/index.ts";

export interface ReadThread extends FillThread {
  threadId: Id;
  workspaceId: Id;
  messages: Array<FillThread["messages"][number] & { id: Id; date: string }>;
}

export async function ownerOf(db: Db, workspaceId: Id): Promise<string> {
  const [row] = await db
    .select({ address: accounts.address })
    .from(workspaces)
    .innerJoin(accounts, eq(accounts.id, workspaces.accountId))
    .where(eq(workspaces.id, workspaceId));
  return (row?.address ?? "").toLowerCase();
}

export async function readThread(db: Db, mailstore: Mailstore, threadId: Id): Promise<ReadThread> {
  const row = await db.query.threads.findFirst({ where: eq(threads.id, threadId) });
  if (!row) throw new NotFoundError("thread", threadId);
  const owner = await ownerOf(db, row.workspaceId);
  const subject = await mailstore.readThreadSubject(threadId);
  const headers = await mailstore.listMessages(threadId);
  const messages = await Promise.all(
    headers.map(async (h) => ({
      id: h.id,
      date: h.date,
      from: h.from,
      to: h.to,
      cc: h.cc,
      text: (await mailstore.readMessageBody(h.id)).text,
    })),
  );
  return {
    threadId,
    workspaceId: row.workspaceId,
    subject,
    owner: owner ? [owner] : [],
    messages,
  };
}

const personLine = (p: Person) => (p.name ? `${p.name} <${p.email}>` : p.email);

/**
 * The judge's view of a Thread: the owner, the subject and the newest
 * Messages' own words, capped at `maxChars` of text from the newest back.
 */
export function threadState(thread: FillThread, maxChars: number): Record<string, JsonValue> {
  const out: JsonValue[] = [];
  let budget = maxChars;
  for (const m of [...thread.messages].reverse()) {
    if (budget <= 0) break;
    const text = ownWords(m.text).slice(0, budget);
    budget -= text.length;
    out.unshift({
      from: personLine(m.from),
      to: m.to.map(personLine),
      ...(m.cc.length ? { cc: m.cc.map(personLine) } : {}),
      text,
    });
  }
  return { owner: thread.owner[0] ?? "", subject: thread.subject, messages: out };
}
