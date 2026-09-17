-- The Cache: the client's per-Workspace SQLite copy (CONTEXT.md "Cache";
-- docs/spec/architecture.md "Client SQLite mirrors"). One file per Workspace,
-- so no table carries a workspace column. Applied on every open; every
-- statement is idempotent. Booleans are 0/1, dates are ISO strings, JSON is
-- TEXT the TypeScript side parses. The Store bumps `meta.schema_version` and
-- rebuilds the content tables when a version changes their shape.

create table if not exists meta (
  key text primary key,
  value text not null
);

-- Thread headers. `rid` is the stable rowid the FTS index points at; `id` is
-- the Server's id. Subject and snippet are content: they arrive through the
-- content routes, so a Changes feed row leaves them alone once set.
create table if not exists threads (
  rid integer primary key,
  id text not null unique,
  subject text not null default '',
  participants text not null default '[]',
  last_activity text not null,
  message_count integer not null default 0,
  unread integer not null default 0,
  starred integer not null default 0,
  archived integer not null default 0,
  deleted integer not null default 0,
  snoozed_until text,
  section text,
  group_id text,
  subgroup_id text,
  has_attachments integer not null default 0,
  bulk integer not null default 0,
  snippet text not null default '',
  updated_at text not null default ''
);
create index if not exists threads_list_idx on threads (archived, deleted, last_activity desc);
create index if not exists threads_section_idx on threads (section);
create index if not exists threads_group_idx on threads (group_id);

-- Bodies are nullable: only Messages inside the Cache window carry them.
-- `rid` is the stable rowid the FTS index points at. `body_at` is when the
-- body arrived or was last read, for LRU eviction above the size cap.
create table if not exists messages (
  rid integer primary key,
  id text not null unique,
  thread_id text not null,
  sender text not null,
  recipients text not null default '[]',
  cc text not null default '[]',
  date text not null,
  body_text text,
  body_html text,
  body_at text,
  has_attachments integer not null default 0
);
create index if not exists messages_thread_idx on messages (thread_id, date);
create index if not exists messages_date_idx on messages (date desc);
create index if not exists messages_body_idx on messages (body_at) where body_text is not null;

create table if not exists attachments (
  id text primary key,
  message_id text not null,
  name text not null,
  size integer not null default 0,
  media_type text not null default '',
  text text
);
create index if not exists attachments_message_idx on attachments (message_id);

create table if not exists labels (
  id text primary key,
  name text not null,
  provider_id text not null
);

create table if not exists tags (
  id text primary key,
  name text not null
);

create table if not exists thread_tags (
  thread_id text not null,
  tag_id text not null,
  primary key (thread_id, tag_id)
);

create table if not exists thread_labels (
  thread_id text not null,
  label_id text not null,
  primary key (thread_id, label_id)
);

-- Groups as the feed carries them: the sentence and the Predicate in the
-- clear, the revised model prompt behind GET /groups (it is content).
create table if not exists groups (
  id text primary key,
  parent_id text,
  name text not null,
  sentence text not null default '',
  predicate text not null default '{}',
  threshold real,
  brief_policy text
);

-- Needs a decision: the Threads whose best rule was not sure enough, with
-- their candidate Groups. A feed row with no candidates removes the entry.
create table if not exists decisions (
  thread_id text primary key,
  candidates text not null default '[]',
  at text not null default ''
);

create table if not exists section_rules (
  id text primary key,
  name text not null,
  position integer not null default 0,
  rule text not null default '{}',
  hidden integer not null default 0
);

create table if not exists briefs (
  thread_id text primary key,
  bullets text not null default '[]',
  actions text not null default '[]',
  computed_at text not null,
  stale integer not null default 0
);

create table if not exists settings (
  key text primary key,
  value text not null
);

-- Drafts are Server-owned (ADR 0010); the Cache keeps every open one with
-- its content so compose works offline. A feed row carries headers only:
-- when it is newer than the local row and no save is pending, content_stale
-- marks the content for a fetch on open.
create table if not exists drafts (
  id text primary key,
  thread_id text,
  kind text not null default 'new',
  in_reply_to_message_id text,
  recipients text not null default '[]',
  cc text not null default '[]',
  bcc text not null default '[]',
  subject text not null default '',
  body_html text not null default '',
  body_text text not null default '',
  attachments text not null default '[]',
  status text not null default 'open',
  deleted integer not null default 0,
  content_stale integer not null default 0,
  updated_at text not null default '',
  updated_by text not null default ''
);
create index if not exists drafts_thread_idx on drafts (thread_id);

-- Scheduled sends: one row per press of Send, so the Undo bar and the
-- Scheduled view read the same rows the feed keeps current.
create table if not exists sends (
  id text primary key,
  draft_id text not null,
  run_at text not null,
  status text not null default 'scheduled',
  cancelled_at text,
  sent_at text,
  job_id text,
  error text,
  created_at text not null default ''
);
create index if not exists sends_status_idx on sends (status, run_at);

-- The reply-all choice remembered per Thread (ADR 0010).
create table if not exists reply_prefs (
  thread_id text primary key,
  reply_all integer not null default 0
);

-- The Outbox: intents made locally, replayed in order (CONTEXT.md "Outbox").
-- `thread_id` holds the entity the intent targets: a Thread id, or a Draft id
-- for the draft.* and send.* kinds.
create table if not exists outbox (
  seq integer primary key autoincrement,
  thread_id text not null,
  kind text not null,
  payload text not null default '{}',
  at text not null,
  actor text not null default 'user',
  attempts integer not null default 0,
  last_error text
);

-- Search (ADR 0011). Two external-content FTS5 indexes kept in step by
-- triggers, so the index never duplicates the text it points at. Each index
-- reads its content through a view that turns the JSON people columns into
-- "Name email" text, so the JSON keys never become search terms; the delete
-- triggers spell out the same expressions over the old row, because an
-- external-content delete must hand FTS5 exactly the values it indexed.
--
-- threads_fts over the Thread headers (subject, participants, snippet), for
-- the palette and header-only matches.
--
-- messages_fts over every Message (the Thread's subject, sender, recipients
-- with cc, body): the index a search runs against. detail=full keeps phrase
-- and NEAR queries; unicode61 folds diacritics and is not English-only like
-- porter. The subject stays on the Thread row; a body arriving later (the
-- pre-warm Job, "search older mail") re-indexes on update. bm25() weights
-- are given at query time, subject highest.
--
-- threads_trgm is the small trigram index over subject and addresses for
-- substring matches ("ridianfund" finds kenji.w@meridianfund.co); it needs
-- three characters and is only consulted for bare words of that length.
--
-- After a sync batch the Store runs 'merge' rather than 'optimize', so the
-- index is folded incrementally instead of rewritten.
create view if not exists threads_content as
  select t.rid as rid,
    t.subject as subject,
    case when json_valid(t.participants)
      then coalesce((select group_concat(coalesce(json_extract(value, '$.name'), '') || ' ' || coalesce(json_extract(value, '$.email'), ''), ' ')
        from json_each(t.participants)), '')
      else t.participants end as participants,
    t.snippet as snippet
  from threads t;

create virtual table if not exists threads_fts using fts5(
  subject,
  participants,
  snippet,
  content = 'threads_content',
  content_rowid = 'rid',
  tokenize = 'unicode61',
  detail = full
);

create virtual table if not exists threads_trgm using fts5(
  subject,
  participants,
  content = 'threads_content',
  content_rowid = 'rid',
  tokenize = 'trigram'
);

create trigger if not exists threads_fts_ai after insert on threads begin
  insert into threads_fts (rowid, subject, participants, snippet)
  select rid, subject, participants, snippet from threads_content where rid = new.rid;
  insert into threads_trgm (rowid, subject, participants)
  select rid, subject, participants from threads_content where rid = new.rid;
end;

create trigger if not exists threads_fts_ad after delete on threads begin
  insert into threads_fts (threads_fts, rowid, subject, participants, snippet)
  values ('delete', old.rid, old.subject,
    case when json_valid(old.participants)
      then coalesce((select group_concat(coalesce(json_extract(value, '$.name'), '') || ' ' || coalesce(json_extract(value, '$.email'), ''), ' ')
        from json_each(old.participants)), '')
      else old.participants end,
    old.snippet);
  insert into threads_trgm (threads_trgm, rowid, subject, participants)
  values ('delete', old.rid, old.subject,
    case when json_valid(old.participants)
      then coalesce((select group_concat(coalesce(json_extract(value, '$.name'), '') || ' ' || coalesce(json_extract(value, '$.email'), ''), ' ')
        from json_each(old.participants)), '')
      else old.participants end);
end;

-- Only a change to the indexed columns re-indexes; a flag flip does not.
create trigger if not exists threads_fts_au after update of subject, participants, snippet on threads begin
  insert into threads_fts (threads_fts, rowid, subject, participants, snippet)
  values ('delete', old.rid, old.subject,
    case when json_valid(old.participants)
      then coalesce((select group_concat(coalesce(json_extract(value, '$.name'), '') || ' ' || coalesce(json_extract(value, '$.email'), ''), ' ')
        from json_each(old.participants)), '')
      else old.participants end,
    old.snippet);
  insert into threads_fts (rowid, subject, participants, snippet)
  select rid, subject, participants, snippet from threads_content where rid = new.rid;
  insert into threads_trgm (threads_trgm, rowid, subject, participants)
  values ('delete', old.rid, old.subject,
    case when json_valid(old.participants)
      then coalesce((select group_concat(coalesce(json_extract(value, '$.name'), '') || ' ' || coalesce(json_extract(value, '$.email'), ''), ' ')
        from json_each(old.participants)), '')
      else old.participants end);
  insert into threads_trgm (rowid, subject, participants)
  select rid, subject, participants from threads_content where rid = new.rid;
end;

create view if not exists messages_content as
  select m.rid as rid,
    coalesce(t.subject, '') as subject,
    case when json_valid(m.sender)
      then coalesce(json_extract(m.sender, '$.name'), '') || ' ' || coalesce(json_extract(m.sender, '$.email'), '')
      else m.sender end as sender,
    (case when json_valid(m.recipients)
      then coalesce((select group_concat(coalesce(json_extract(value, '$.name'), '') || ' ' || coalesce(json_extract(value, '$.email'), ''), ' ')
        from json_each(m.recipients)), '')
      else m.recipients end)
    || ' ' ||
    (case when json_valid(m.cc)
      then coalesce((select group_concat(coalesce(json_extract(value, '$.name'), '') || ' ' || coalesce(json_extract(value, '$.email'), ''), ' ')
        from json_each(m.cc)), '')
      else m.cc end) as recipients,
    coalesce(m.body_text, '') as body
  from messages m left join threads t on t.id = m.thread_id;

create virtual table if not exists messages_fts using fts5(
  subject,
  sender,
  recipients,
  body,
  content = 'messages_content',
  content_rowid = 'rid',
  tokenize = 'unicode61',
  detail = full
);

create trigger if not exists messages_fts_ai after insert on messages begin
  insert into messages_fts (rowid, subject, sender, recipients, body)
  select rid, subject, sender, recipients, body from messages_content where rid = new.rid;
end;

create trigger if not exists messages_fts_ad after delete on messages begin
  insert into messages_fts (messages_fts, rowid, subject, sender, recipients, body)
  values ('delete', old.rid,
    coalesce((select subject from threads where id = old.thread_id), ''),
    case when json_valid(old.sender)
      then coalesce(json_extract(old.sender, '$.name'), '') || ' ' || coalesce(json_extract(old.sender, '$.email'), '')
      else old.sender end,
    (case when json_valid(old.recipients)
      then coalesce((select group_concat(coalesce(json_extract(value, '$.name'), '') || ' ' || coalesce(json_extract(value, '$.email'), ''), ' ')
        from json_each(old.recipients)), '')
      else old.recipients end)
    || ' ' ||
    (case when json_valid(old.cc)
      then coalesce((select group_concat(coalesce(json_extract(value, '$.name'), '') || ' ' || coalesce(json_extract(value, '$.email'), ''), ' ')
        from json_each(old.cc)), '')
      else old.cc end),
    coalesce(old.body_text, ''));
end;

create trigger if not exists messages_fts_au after update of thread_id, sender, recipients, cc, body_text on messages begin
  insert into messages_fts (messages_fts, rowid, subject, sender, recipients, body)
  values ('delete', old.rid,
    coalesce((select subject from threads where id = old.thread_id), ''),
    case when json_valid(old.sender)
      then coalesce(json_extract(old.sender, '$.name'), '') || ' ' || coalesce(json_extract(old.sender, '$.email'), '')
      else old.sender end,
    (case when json_valid(old.recipients)
      then coalesce((select group_concat(coalesce(json_extract(value, '$.name'), '') || ' ' || coalesce(json_extract(value, '$.email'), ''), ' ')
        from json_each(old.recipients)), '')
      else old.recipients end)
    || ' ' ||
    (case when json_valid(old.cc)
      then coalesce((select group_concat(coalesce(json_extract(value, '$.name'), '') || ' ' || coalesce(json_extract(value, '$.email'), ''), ' ')
        from json_each(old.cc)), '')
      else old.cc end),
    coalesce(old.body_text, ''));
  insert into messages_fts (rowid, subject, sender, recipients, body)
  select rid, subject, sender, recipients, body from messages_content where rid = new.rid;
end;

-- A subject that arrives after its Messages (content follows headers) re-indexes them.
create trigger if not exists messages_fts_subject after update of subject on threads
when old.subject is not new.subject begin
  insert into messages_fts (messages_fts, rowid, subject, sender, recipients, body)
  select 'delete', c.rid, old.subject, c.sender, c.recipients, c.body
  from messages m join messages_content c on c.rid = m.rid where m.thread_id = old.id;
  insert into messages_fts (rowid, subject, sender, recipients, body)
  select c.rid, new.subject, c.sender, c.recipients, c.body
  from messages m join messages_content c on c.rid = m.rid where m.thread_id = new.id;
end;
