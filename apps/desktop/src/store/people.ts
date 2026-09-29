// The Cache's people table: everyone on a cached Message, for the composer's
// To, Cc and Bcc (packages/shared people.ts), answered at once and without
// the network. Derived from `messages` by triggers, like thread_senders, so it
// never disagrees with the Message headers; filled once for a Cache that
// predates it (applySchema). One row per lowercased address:
//
//   addressed   cached Messages with the person on To or Cc: mostly the
//               user's own mail to them, which the Cache cannot tell apart
//               from a group Message without knowing the user's address;
//   wrote       cached Messages they sent;
//   last        the newest of those Messages; the name is the one last seen.
//
// The Server's people index (GET /people) counts the whole mailbox exactly;
// the composer merges both (src/people/lookup.ts).

import type { PeopleRanking, PersonHit } from "@monday/shared";
import { peopleQueryWords, personMatches, personScore } from "@monday/shared";
import type { Row, SqlParam } from "./driver.ts";

/** Each person on the Message `m` (new or old in a trigger), once, with what they were on it. */
function entries(m: "new" | "old"): string {
  const person = (json: string) =>
    `lower(trim(coalesce(json_extract(${json}, '$.email'), ''))) as email, trim(coalesce(json_extract(${json}, '$.name'), '')) as name`;
  const list = (col: string) =>
    `json_each(case when json_valid(${m}.${col}) and json_type(${m}.${col}) = 'array' then ${m}.${col} else '[]' end)`;
  return `(select email, max(name) as name, max(wrote) as wrote, max(addressed) as addressed from (
      select ${person(`${m}.sender`)}, 1 as wrote, 0 as addressed where json_valid(${m}.sender)
      union all select ${person("r.value")}, 0, 1 from ${list("recipients")} r
      union all select ${person("r.value")}, 0, 1 from ${list("cc")} r
    ) where email <> '' group by email)`;
}

const add = (m: "new") => `
  update people set
    wrote = people.wrote + e.wrote,
    addressed = people.addressed + e.addressed,
    name = case when e.name <> '' and ${m}.date >= people.name_at then e.name else people.name end,
    name_at = case when e.name <> '' and ${m}.date >= people.name_at then ${m}.date else people.name_at end,
    last = max(people.last, ${m}.date)
  from ${entries(m)} as e where people.email = e.email;
  insert into people (email, name, name_at, wrote, addressed, last)
  select e.email, e.name, case when e.name <> '' then ${m}.date else '' end, e.wrote, e.addressed, ${m}.date
  from ${entries(m)} as e where not exists (select 1 from people p where p.email = e.email);`;

const remove = (m: "old") => `
  update people set
    wrote = max(people.wrote - e.wrote, 0),
    addressed = max(people.addressed - e.addressed, 0)
  from ${entries(m)} as e where people.email = e.email;
  delete from people where wrote = 0 and addressed = 0
    and email in (select email from ${entries(m)});`;

/**
 * The table and its triggers. The triggers update, then insert what is
 * missing, rather than upsert: a trigger's conflict clause gives way to the
 * outer statement's (the feed's upserts).
 */
export const PEOPLE_SCHEMA_SQL = `
create table if not exists people (
  email text primary key,
  name text not null default '',
  name_at text not null default '',
  wrote integer not null default 0,
  addressed integer not null default 0,
  last text not null default ''
) without rowid;
create index if not exists people_last_idx on people (last desc);

create trigger if not exists people_ai after insert on messages begin
${add("new")}
end;

create trigger if not exists people_ad after delete on messages begin
${remove("old")}
end;

create trigger if not exists people_au after update of sender, recipients, cc on messages
when old.sender is not new.sender or old.recipients is not new.recipients or old.cc is not new.cc begin
${remove("old")}
${add("new")}
end;
`;

/** Dropped with the content tables when the Cache is rebuilt. */
export const PEOPLE_DROP_SQL = `
  drop trigger if exists people_ai;
  drop trigger if exists people_ad;
  drop trigger if exists people_au;
  drop table if exists people;
`;

/** Bumped when the people table must be filled again from `messages`. */
export const PEOPLE_FORMAT = 1;
export const PEOPLE_FORMAT_KEY = "people_format";

/** Fills the table from every cached Message by the triggers' rules. */
export const PEOPLE_FILL_SQL = [
  "delete from people",
  `insert into people (email, name, name_at, wrote, addressed, last)
   with raw as (
     select m.rid as rid, m.date as date,
       lower(trim(coalesce(json_extract(m.sender, '$.email'), ''))) as email,
       trim(coalesce(json_extract(m.sender, '$.name'), '')) as name, 1 as wrote, 0 as addressed
     from messages m where json_valid(m.sender)
     union all
     select m.rid, m.date, lower(trim(coalesce(json_extract(r.value, '$.email'), ''))),
       trim(coalesce(json_extract(r.value, '$.name'), '')), 0, 1
     from messages m, json_each(case when json_valid(m.recipients) and json_type(m.recipients) = 'array' then m.recipients else '[]' end) r
     union all
     select m.rid, m.date, lower(trim(coalesce(json_extract(r.value, '$.email'), ''))),
       trim(coalesce(json_extract(r.value, '$.name'), '')), 0, 1
     from messages m, json_each(case when json_valid(m.cc) and json_type(m.cc) = 'array' then m.cc else '[]' end) r
   ),
   e as (
     select rid, date, email, max(name) as name, max(wrote) as wrote, max(addressed) as addressed
     from raw where email <> '' group by rid, email
   ),
   named as (select email, name, max(date) as name_at from e where name <> '' group by email)
   select e.email, coalesce(n.name, ''), coalesce(n.name_at, ''), sum(e.wrote), sum(e.addressed), max(e.date)
   from e left join named n on n.email = e.email
   group by e.email`,
];

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Where a term of the person can start: the address, after @ . - _ +, the name, after a space - . or '. */
const TERM_STARTS: ReadonlyArray<{ column: "email" | "lower(name)"; before: string }> = [
  { column: "email", before: "" },
  { column: "email", before: "%@" },
  { column: "email", before: "%." },
  { column: "email", before: "%-" },
  { column: "email", before: "%\\_" },
  { column: "email", before: "%+" },
  { column: "lower(name)", before: "" },
  { column: "lower(name)", before: "% " },
  { column: "lower(name)", before: "%-" },
  { column: "lower(name)", before: "%." },
  { column: "lower(name)", before: "%'" },
];

/** How many candidates the Cache reads before ranking; a few times what is shown. */
const CANDIDATES_PER_RESULT = 8;

/**
 * The Cache's people matching every typed word, as SQL: a cheap substring
 * test first, then the places a term can start. The caller filters the rows
 * with personMatches (the exact rule) and ranks them.
 */
export function peopleSearchQuery(
  q: string,
  owner: string,
  limit: number,
): { sql: string; params: SqlParam[] } | null {
  const words = peopleQueryWords(q);
  if (words.length === 0) return null;
  const params: SqlParam[] = [owner.trim().toLowerCase()];
  const has = (piece: string): string => {
    params.push(piece, piece);
    const contains = "(instr(email, ?) > 0 or instr(lower(name), ?) > 0)";
    const starts = TERM_STARTS.map((t) => {
      params.push(`${t.before}${likeEscape(piece)}%`);
      return `${t.column} like ? escape '\\'`;
    });
    return `(${contains} and (${starts.join(" or ")}))`;
  };
  const clauses = words.map((w) =>
    w.pieces.length > 1 || w.pieces[0] !== w.word
      ? `(${has(w.word)} or (${w.pieces.map(has).join(" and ")}))`
      : has(w.word),
  );
  params.push(Math.max(1, limit) * CANDIDATES_PER_RESULT);
  return {
    sql: `select email, name, wrote, addressed, last from people
          where email <> ? and ${clauses.join(" and ")}
          order by addressed desc, wrote desc, last desc limit ?`,
    params,
  };
}

/** Rows of peopleSearchQuery as ranked hits: exact matches only, best first. */
export function rowsToPeople(
  rows: readonly Row[],
  q: string,
  ranking: PeopleRanking,
  now: Date,
  limit: number,
): PersonHit[] {
  const words = peopleQueryWords(q);
  const out: PersonHit[] = [];
  for (const r of rows) {
    const p = {
      name: String(r.name ?? ""),
      email: String(r.email ?? ""),
      sent: Number(r.addressed ?? 0),
      received: Number(r.wrote ?? 0),
      lastAt: typeof r.last === "string" && r.last ? r.last : null,
    };
    if (!personMatches(p, words)) continue;
    out.push({ ...p, score: personScore(p, now, ranking) });
  }
  return out
    .sort((a, b) => b.score - a.score || a.email.localeCompare(b.email))
    .slice(0, Math.max(0, limit));
}

/** The people the Cache has seen most recently, for lists that want everyone (the palette's contacts, calendar guests). */
export const RECENT_PEOPLE_SQL =
  "select email, name from people where email <> ? order by last desc limit ?";
