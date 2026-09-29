// The Cache's Signals (ADR 0014; docs/spec/signals.md, "Where answers live"):
// thread_signals holds the newest answer per Thread and Signal, numbers only,
// straight from the feed's `signals` changes; signal_defs mirrors each
// Signal's current Question version, so an answer under an older one reads
// as stale without a change per Thread. Indexed by (signal, noul) and
// (signal, score), so a Section, a Lane or a chip row is one SQL query and
// never waits on the network (ADR 0011).
//
// A Cache from before the Signal store kept thread_judgments; its rows move
// here once (applySchema) and the table goes. A feed still carrying the old
// `judgments` change (a Cache rebuilt from an old log) lands here the same way.

import type {
  FactsChange,
  JudgmentsChange,
  LowTrust,
  SignalDefChange,
  SignalReading,
  SignalReadings,
  SignalsChange,
  ThreadJudgments,
} from "@monday/shared";
import { judgmentsFromSignals } from "@monday/shared";
import type { Row, Statement } from "./driver.ts";

export const SIGNALS_SCHEMA_SQL = `
  create table if not exists thread_signals (
    thread_id text not null,
    signal_id text not null,
    version integer not null default 1,
    noul real,
    choice text,
    score real,
    confidence real,
    stale integer not null default 0,
    low_trust text,
    judged_at text not null default '',
    primary key (thread_id, signal_id)
  );
  create index if not exists thread_signals_noul_idx on thread_signals (signal_id, noul);
  create index if not exists thread_signals_score_idx on thread_signals (signal_id, score);
  create table if not exists thread_facts (
    thread_id text primary key,
    received_at text,
    last_activity_at text,
    from_address text,
    from_domain text,
    to_me_directly integer not null default 0,
    owner_wrote_last integer not null default 0,
    known_sender integer not null default 0,
    list_id text,
    has_invite integer not null default 0,
    language text not null default 'en',
    image_only integer not null default 0,
    amount_count integer not null default 0,
    deadline_at text,
    deadline_unclear integer not null default 0,
    facts text not null default '{}'
  );
  create index if not exists thread_facts_deadline_idx on thread_facts (deadline_at);
  create table if not exists signal_defs (
    id text primary key,
    kind text not null,
    version integer not null default 1,
    owner_kind text not null default 'shipped',
    owner_id text,
    active integer not null default 1,
    label text not null default ''
  );
`;

export const SIGNALS_DROP_SQL = `
  drop table if exists thread_signals;
  drop table if exists thread_facts;
  drop table if exists signal_defs;
`;

export const SIGNALS_FORMAT_KEY = "signals_format";
/** Bumped when thread_signals must be filled again from an older table. */
export const SIGNALS_FORMAT = 1;

/** Moves a slice 25 Cache's thread_judgments into thread_signals, then drops it. */
export const SIGNALS_FILL_SQL: readonly string[] = [
  ...(
    [
      ["needs_reply", "needs_reply", "noul"],
      ["waiting_on_others", "waiting_on_others", "noul"],
      ["newsletter", "newsletter", "noul"],
      ["automated", "automated", "noul"],
      ["brief_worth", "brief_worth", "score"],
      ["urgency", "urgency", "score"],
    ] as const
  ).map(
    ([id, column, kind]) =>
      `insert or ignore into thread_signals (thread_id, signal_id, version, ${kind}, judged_at)
       select thread_id, '${id}', 1, ${column}, judged_at from thread_judgments`,
  ),
  "drop table thread_judgments",
];

/** The Cache statements for one `signals` change: the answers upserted, the removed ones dropped. */
export function signalsStatements(c: SignalsChange): Statement[] {
  if (c.deleted)
    return [{ sql: "delete from thread_signals where thread_id = ?", params: [c.threadId] }];
  const out: Statement[] = [];
  for (const id of c.removed ?? []) {
    out.push({
      sql: "delete from thread_signals where thread_id = ? and signal_id = ?",
      params: [c.threadId, id],
    });
  }
  for (const a of c.answers) {
    out.push({
      sql: `insert into thread_signals (thread_id, signal_id, version, noul, choice, score, confidence, stale, low_trust, judged_at)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict (thread_id, signal_id) do update set
              version = excluded.version, noul = excluded.noul, choice = excluded.choice,
              score = excluded.score, confidence = excluded.confidence, stale = excluded.stale,
              low_trust = excluded.low_trust, judged_at = excluded.judged_at`,
      params: [
        c.threadId,
        a.signalId,
        a.version,
        a.noul,
        a.choice,
        a.score,
        a.confidence,
        a.stale ? 1 : 0,
        a.lowTrust,
        a.judgedAt,
      ],
    });
  }
  return out;
}

/** A Thread's Facts as the feed carries them (slice 32): the clear ones, as columns and whole. */
export function factsStatements(c: FactsChange): Statement[] {
  if (c.deleted)
    return [{ sql: "delete from thread_facts where thread_id = ?", params: [c.threadId] }];
  const f = c.facts;
  const text = (k: string) => (typeof f[k] === "string" ? (f[k] as string) : null);
  const flag = (k: string) => (f[k] === true ? 1 : 0);
  return [
    {
      sql: `insert into thread_facts (thread_id, received_at, last_activity_at, from_address, from_domain,
              to_me_directly, owner_wrote_last, known_sender, list_id, has_invite, language, image_only,
              amount_count, deadline_at, deadline_unclear, facts)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict (thread_id) do update set
              received_at = excluded.received_at, last_activity_at = excluded.last_activity_at,
              from_address = excluded.from_address, from_domain = excluded.from_domain,
              to_me_directly = excluded.to_me_directly, owner_wrote_last = excluded.owner_wrote_last,
              known_sender = excluded.known_sender, list_id = excluded.list_id,
              has_invite = excluded.has_invite, language = excluded.language,
              image_only = excluded.image_only, amount_count = excluded.amount_count,
              deadline_at = excluded.deadline_at, deadline_unclear = excluded.deadline_unclear,
              facts = excluded.facts`,
      params: [
        c.threadId,
        text("received_at"),
        text("last_activity_at"),
        text("from_address"),
        text("from_domain"),
        flag("to_me_directly"),
        flag("owner_wrote_last"),
        flag("known_sender"),
        text("list_id"),
        flag("has_invite"),
        text("language") ?? "en",
        flag("image_only"),
        typeof f.amount_count === "number" ? f.amount_count : 0,
        text("deadline_at"),
        flag("deadline_unclear"),
        JSON.stringify(f),
      ],
    },
  ];
}

/** A Signal's definition as the feed carries it. */
export function signalDefStatements(d: SignalDefChange): Statement[] {
  if (d.deleted) return [{ sql: "delete from signal_defs where id = ?", params: [d.id] }];
  return [
    {
      sql: `insert into signal_defs (id, kind, version, owner_kind, owner_id, active, label)
            values (?, ?, ?, ?, ?, ?, ?)
            on conflict (id) do update set
              kind = excluded.kind, version = excluded.version, owner_kind = excluded.owner_kind,
              owner_id = excluded.owner_id, active = excluded.active, label = excluded.label`,
      params: [d.id, d.kind, d.version, d.ownerKind, d.ownerId, d.active ? 1 : 0, d.label],
    },
  ];
}

/** An old `judgments` change as the shipped Signals it stands for, at version 1. */
export function legacyJudgmentsStatements(j: JudgmentsChange): Statement[] {
  const nouls: Record<string, number> = {
    needs_reply: j.needsReply,
    waiting_on_others: j.waitingOnOthers,
    newsletter: j.newsletter,
    automated: j.automated,
  };
  const answers: SignalsChange["answers"] = [
    ...Object.entries(nouls).map(([signalId, noul]) => ({
      signalId,
      version: 1,
      noul,
      choice: null,
      score: null,
      confidence: null,
      stale: false,
      lowTrust: null,
      judgedAt: j.judgedAt,
    })),
    ...(
      [
        ["brief_worth", j.briefWorth],
        ["urgency", j.urgency],
      ] as const
    ).map(([signalId, score]) => ({
      signalId,
      version: 1,
      noul: null,
      choice: null,
      score,
      confidence: null,
      stale: false,
      lowTrust: null,
      judgedAt: j.judgedAt,
    })),
  ];
  return signalsStatements({
    threadId: j.threadId,
    answers,
    ...(j.deleted ? { deleted: true } : {}),
  });
}

/**
 * Every answer of the Thread `t` as one JSON column (over `threads t`): per
 * Signal, [noul, score, choice, confidence, version, stale, low trust, judged
 * at], stale when the feed said so or signal_defs holds a newer version.
 */
export const SIGNALS_COLUMN_SQL = `(select json_group_object(s.signal_id, json_array(
    s.noul, s.score, s.choice, s.confidence, s.version,
    case when s.stale = 1 or (d.version is not null and s.version < d.version) then 1 else 0 end,
    s.low_trust, s.judged_at))
  from thread_signals s left join signal_defs d on d.id = s.signal_id
  where s.thread_id = t.id) as j_signals`;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The readings from a row's `j_signals` column; empty when the Thread has none. */
export function rowToReadings(r: Row): Record<string, SignalReading & { judgedAt: string }> {
  const raw = r.j_signals;
  if (typeof raw !== "string" || raw === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object") return {};
  const out: Record<string, SignalReading & { judgedAt: string }> = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    const [noul, score, choice, confidence, version, stale, lowTrust, judgedAt] = value;
    out[id] = {
      noul: num(noul),
      score: num(score),
      choice: typeof choice === "string" ? choice : null,
      confidence: num(confidence),
      version: num(version) ?? 1,
      stale: stale === 1 || stale === true,
      lowTrust: typeof lowTrust === "string" ? (lowTrust as LowTrust) : null,
      judgedAt: typeof judgedAt === "string" ? judgedAt : "",
    };
  }
  return out;
}

/** The slice 25 Judgments a row's Signals stand for, or null when it has none. */
export function readingsToJudgments(
  threadId: string,
  readings: SignalReadings & Record<string, { judgedAt?: string }>,
): ThreadJudgments | null {
  const newest = Object.values(readings)
    .map((r) => (r as { judgedAt?: string }).judgedAt ?? "")
    .sort()
    .pop();
  return judgmentsFromSignals(threadId, readings, { judgedAt: newest ?? "" });
}
