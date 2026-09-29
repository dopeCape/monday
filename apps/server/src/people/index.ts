// The people index over the whole mailbox (packages/shared people.ts): who
// the user writes with, for the composer's To, Cc and Bcc and anything else
// that offers a person. One row per address in `people`, kept in step on write:
//
//   recordMessage   a Message newly stored (sync, first sync, the sent copy of
//                   a send): the user's own Message counts once for each
//                   person on To or Cc (and settles one pending send), anyone
//                   else's counts once for its sender; everyone else on it is
//                   remembered with no count, so they can still be found.
//   recordSend      a send delivered: one pending send for each recipient,
//                   Bcc included, so a person written to a minute ago is
//                   found before the Provider hands the sent copy back.
//   search          prefix match on the name's words and the address, its
//                   local part, domain and pieces (the generated `terms`,
//                   GIN-indexed), ranked by the shared score in SQL.
//
// Migration 0022 fills the table once from the Messages already stored, by
// the same rules. The user's own address is never a row.

import type { IsoDate, PeopleRanking, Person, PersonHit } from "@monday/shared";
import { PEOPLE_MIN_EXPONENT, peopleQueryWords } from "@monday/shared";
import { eq, sql } from "drizzle-orm";
import type { Db, Tx } from "../db/client.ts";
import { accounts, workspaces } from "../db/schema.ts";

interface Entry {
  address: string;
  name: string;
  at: Date;
  sent: number;
  pending: number;
  received: number;
}

const clean = (p: Person | null | undefined) => ({
  address: (p?.email ?? "").trim().toLowerCase(),
  name: (p?.name ?? "").trim(),
});

/** The Workspace's own address, lowercased; cached, since an Account's address does not change. */
export function ownerLookup(): (executor: Db | Tx, workspaceId: string) => Promise<string> {
  const cache = new Map<string, string>();
  return async (executor, workspaceId) => {
    const known = cache.get(workspaceId);
    if (known !== undefined) return known;
    const rows = await executor
      .select({ address: accounts.address })
      .from(workspaces)
      .innerJoin(accounts, eq(accounts.id, workspaces.accountId))
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    const address = (rows[0]?.address ?? "").trim().toLowerCase();
    if (address) cache.set(workspaceId, address);
    return address;
  };
}

/** The rows one Message adds to, by the rules above; one per address. */
export function messageEntries(
  owner: string,
  message: { from: Person; to: readonly Person[]; cc: readonly Person[]; date: IsoDate | Date },
): Entry[] {
  const at = message.date instanceof Date ? message.date : new Date(message.date);
  const sender = clean(message.from);
  const mine = sender.address !== "" && sender.address === owner;
  const out = new Map<string, Entry>();
  const put = (p: { address: string; name: string }, sent: number, received: number) => {
    if (!p.address || p.address === owner) return;
    const had = out.get(p.address);
    if (had) {
      if (!had.name && p.name) had.name = p.name;
      return;
    }
    out.set(p.address, { address: p.address, name: p.name, at, sent, pending: 0, received });
  };
  if (!mine) put(sender, 0, 1);
  for (const p of [...message.to, ...message.cc]) put(clean(p), mine ? 1 : 0, 0);
  return [...out.values()];
}

async function upsert(executor: Db | Tx, workspaceId: string, entries: Entry[]): Promise<void> {
  if (entries.length === 0) return;
  const values = sql.join(
    entries.map(
      (e) =>
        sql`(${workspaceId}, ${e.address}, ${e.name}, ${e.name ? e.at.toISOString() : null}::timestamptz, ${e.sent}, ${e.pending}, ${e.received}, ${e.at.toISOString()}::timestamptz)`,
    ),
    sql`, `,
  );
  // A newer name replaces an older one; an empty one never does. A counted
  // sent Message settles one pending send, never below zero.
  await executor.execute(sql`
    insert into people as p (workspace_id, address, name, name_at, sent_count, pending_sent, received_count, last_at)
    values ${values}
    on conflict (workspace_id, address) do update set
      sent_count = p.sent_count + excluded.sent_count,
      pending_sent = greatest(p.pending_sent + excluded.pending_sent - excluded.sent_count, 0),
      received_count = p.received_count + excluded.received_count,
      last_at = greatest(p.last_at, excluded.last_at),
      name = case when excluded.name <> '' and (p.name_at is null or excluded.name_at >= p.name_at)
        then excluded.name else p.name end,
      name_at = case when excluded.name <> '' and (p.name_at is null or excluded.name_at >= p.name_at)
        then excluded.name_at else p.name_at end`);
}

/** A Message newly stored in the Workspace. Call once per Message, inside its write. */
export async function recordMessage(
  executor: Db | Tx,
  workspaceId: string,
  owner: string,
  message: { from: Person; to: readonly Person[]; cc: readonly Person[]; date: IsoDate | Date },
): Promise<void> {
  await upsert(executor, workspaceId, messageEntries(owner, message));
}

/** A send delivered to these recipients (To, Cc and Bcc) at `at`. */
export async function recordSend(
  executor: Db | Tx,
  workspaceId: string,
  owner: string,
  recipients: readonly Person[],
  at: Date,
): Promise<void> {
  const out = new Map<string, Entry>();
  for (const p of recipients) {
    const c = clean(p);
    if (!c.address || c.address === owner || out.has(c.address)) continue;
    out.set(c.address, { ...c, at, sent: 0, pending: 1, received: 0 });
  }
  await upsert(executor, workspaceId, [...out.values()]);
}

/** The tsquery for the typed words, or "" when nothing searchable was typed. */
export function peopleTsQuery(q: string): string {
  const lexeme = (s: string) => `'${s.replaceAll("\\", "\\\\").replaceAll("'", "''")}':*`;
  return peopleQueryWords(q)
    .map((w) =>
      w.pieces.length > 1 || w.pieces[0] !== w.word
        ? `(${lexeme(w.word)} | (${w.pieces.map(lexeme).join(" & ")}))`
        : lexeme(w.word),
    )
    .join(" & ");
}

export interface SearchPeopleOptions {
  q: string;
  limit: number;
  ranking: PeopleRanking;
  now?: Date;
}

/** People matching every typed word, best score first; the owner is never among them. */
export async function searchPeople(
  db: Db,
  workspaceId: string,
  owner: string,
  options: SearchPeopleOptions,
): Promise<PersonHit[]> {
  const tsq = peopleTsQuery(options.q);
  if (tsq === "") return [];
  const limit = Math.max(1, Math.min(options.limit, 100));
  const now = (options.now ?? new Date()).toISOString();
  const [ws, wr, wt] = options.ranking.weights;
  const half = Math.max(options.ranking.halfLifeDays, 1e-6);
  // The SQL twin of personScore (packages/shared people.ts).
  const rows = await db.execute<{
    address: string;
    name: string;
    sent: number;
    received: number;
    last_at: string | null;
    score: number;
  }>(sql`
    select address, name, sent_count + pending_sent as sent, received_count as received, last_at,
      ${ws}::float8 * ln(1 + sent_count + pending_sent)
        + ${wr}::float8 * ln(1 + received_count)
        + ${wt}::float8 * coalesce(exp(least(0, greatest(${PEOPLE_MIN_EXPONENT}::float8,
            -ln(2) * extract(epoch from (${now}::timestamptz - last_at)) / 86400 / ${half}::float8))), 0)
        as score
    from people
    where workspace_id = ${workspaceId} and address <> ${owner}
      and terms @@ ${tsq}::tsquery
    order by score desc, address
    limit ${limit}`);
  return rows.map((r) => ({
    name: r.name,
    email: r.address,
    sent: Number(r.sent),
    received: Number(r.received),
    lastAt: r.last_at ? new Date(r.last_at).toISOString() : null,
    score: Number(r.score),
  }));
}
