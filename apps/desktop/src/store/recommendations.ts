// The Cache's Recommended actions (docs/spec/actions.md): the feed's
// `recommendations` row carries headers only (the Thread version, when, which
// kinds); the actions with their arguments are content, fetched through
// GET /threads/:id/recommendations as soon as the row lands, the way a
// Brief's bullets are, so a list row's hover chip and the reader's chips read
// the Cache and never wait (ADR 0011). A row whose content lags its headers
// keeps showing the old actions until the fetch replaces them (the chip stays
// until the new answers arrive).

import type {
  Recommendation,
  RecommendationsChange,
  RecommendedActionKind,
  ThreadRecommendations,
} from "@monday/shared";
import type { Row, Statement } from "./driver.ts";

export const RECOMMENDATIONS_SCHEMA_SQL = `
  create table if not exists thread_recommendations (
    thread_id text primary key,
    message_count integer not null default 0,
    computed_at text not null default '',
    kinds text not null default '[]',
    actions text not null default '[]',
    from_domain text,
    content_stale integer not null default 1
  );
  create index if not exists thread_recommendations_stale_idx
    on thread_recommendations (content_stale, computed_at);
`;

export const RECOMMENDATIONS_DROP_SQL = "drop table if exists thread_recommendations;";

/** The feed's header row: a newer computation marks the content stale; a removal drops the row. */
export function recommendationsStatements(c: RecommendationsChange): Statement[] {
  if (c.deleted) {
    return [
      { sql: "delete from thread_recommendations where thread_id = ?", params: [c.threadId] },
    ];
  }
  return [
    {
      sql: `insert into thread_recommendations (thread_id, message_count, computed_at, kinds, content_stale)
            values (?, ?, ?, ?, 1)
            on conflict (thread_id) do update set
              kinds = excluded.kinds,
              content_stale = case when excluded.computed_at > thread_recommendations.computed_at
                then 1 else thread_recommendations.content_stale end,
              message_count = case when excluded.computed_at > thread_recommendations.computed_at
                then excluded.message_count else thread_recommendations.message_count end,
              computed_at = max(thread_recommendations.computed_at, excluded.computed_at)`,
      params: [c.threadId, c.messageCount, c.computedAt, JSON.stringify(c.kinds)],
    },
  ];
}

/** The Cache statements for a Thread's actions fetched whole. */
export function cachedRecommendationsStatements(r: ThreadRecommendations): Statement[] {
  return [
    {
      sql: `insert into thread_recommendations (thread_id, message_count, computed_at, kinds, actions, from_domain, content_stale)
            values (?, ?, ?, ?, ?, ?, 0)
            on conflict (thread_id) do update set
              message_count = excluded.message_count, computed_at = excluded.computed_at,
              kinds = excluded.kinds, actions = excluded.actions,
              from_domain = excluded.from_domain, content_stale = 0`,
      params: [
        r.threadId,
        r.messageCount,
        r.computedAt,
        JSON.stringify(r.actions.map((a) => a.kind)),
        JSON.stringify(r.actions),
        r.fromDomain,
      ],
    },
  ];
}

/** Rows whose content lags their headers, for the Store to warm after a pull. */
export const RECOMMENDATIONS_TO_WARM_SQL =
  "select thread_id from thread_recommendations where content_stale = 1 order by computed_at desc limit ?";

/** The columns a Thread row joins (`left join thread_recommendations rc`). */
export const RECOMMENDATIONS_COLUMNS_SQL =
  "rc.actions as rc_actions, rc.message_count as rc_count, rc.from_domain as rc_domain";

/** What a Thread row holds of its Recommended actions: the actions, the Thread version, the sender's domain. */
export interface CachedRecommendations {
  actions: Recommendation[];
  messageCount: number;
  fromDomain: string | null;
}

const isKind = (k: unknown): k is RecommendedActionKind => typeof k === "string" && k.length > 0;

export function rowToRecommendations(r: Row): CachedRecommendations | null {
  if (typeof r.rc_actions !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.rc_actions);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const actions = parsed.filter(
    (a): a is Recommendation =>
      !!a && typeof a === "object" && isKind((a as { kind?: unknown }).kind),
  );
  return {
    actions,
    messageCount: Number(r.rc_count ?? 0),
    fromDomain: typeof r.rc_domain === "string" ? r.rc_domain : null,
  };
}
