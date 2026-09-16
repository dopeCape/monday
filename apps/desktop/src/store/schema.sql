-- The Cache: the client's per-Workspace SQLite copy (CONTEXT.md "Cache";
-- docs/spec/architecture.md "Client SQLite mirrors"). One file per Workspace,
-- so no table carries a workspace column. Applied on every open; every
-- statement is idempotent. Booleans are 0/1, dates are ISO strings, JSON is
-- TEXT the TypeScript side parses. Slice 10 adds bodies to the index.

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
  snippet text not null default '',
  updated_at text not null default ''
);
create index if not exists threads_list_idx on threads (archived, deleted, last_activity desc);
create index if not exists threads_section_idx on threads (section);
create index if not exists threads_group_idx on threads (group_id);

-- Bodies are nullable: only Threads inside the Cache window carry them.
create table if not exists messages (
  id text primary key,
  thread_id text not null,
  sender text not null,
  recipients text not null default '[]',
  cc text not null default '[]',
  date text not null,
  body_text text,
  body_html text,
  has_attachments integer not null default 0
);
create index if not exists messages_thread_idx on messages (thread_id, date);

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

create table if not exists groups (
  id text primary key,
  parent_id text,
  name text not null,
  rule text not null default '{}',
  threshold real
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

-- Search (ADR 0011): an external-content FTS5 index over the Thread headers,
-- kept in step by triggers. Slice 10 adds bodies.
create virtual table if not exists threads_fts using fts5(
  subject,
  participants,
  snippet,
  content = 'threads',
  content_rowid = 'rid',
  tokenize = 'unicode61'
);

create trigger if not exists threads_fts_ai after insert on threads begin
  insert into threads_fts (rowid, subject, participants, snippet)
  values (new.rid, new.subject, new.participants, new.snippet);
end;

create trigger if not exists threads_fts_ad after delete on threads begin
  insert into threads_fts (threads_fts, rowid, subject, participants, snippet)
  values ('delete', old.rid, old.subject, old.participants, old.snippet);
end;

create trigger if not exists threads_fts_au after update on threads begin
  insert into threads_fts (threads_fts, rowid, subject, participants, snippet)
  values ('delete', old.rid, old.subject, old.participants, old.snippet);
  insert into threads_fts (rowid, subject, participants, snippet)
  values (new.rid, new.subject, new.participants, new.snippet);
end;
