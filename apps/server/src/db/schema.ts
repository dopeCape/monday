// Postgres schema, the source of truth (docs/spec/architecture.md, "Data model").
// Server core: servers, jobs, devices, settings and pairing. Mailstore: accounts,
// workspaces, workspace keys, threads, messages, attachments, blobs, labels and
// tags. Every body-derived column is ciphertext (research 5); the plaintext
// columns are exactly the header fields sync, threading and routing need.

import type {
  AccountCapabilities,
  Actor,
  AgentEvent,
  ApprovalDecision,
  Attendee,
  BriefPolicy,
  CalendarSource,
  ChangeKind,
  DecisionCandidate,
  DraftAttachment,
  DraftKind,
  DraftStatus,
  EventStatus,
  FieldWrites,
  HostedProvider,
  InviteMethod,
  Person,
  Predicate,
  Provider,
  RouteBy,
  RsvpResponse,
  RunStatus,
  RunStepStatus,
  RunTrigger,
  Runtime,
  ScheduledSendStatus,
  Score,
  SendError,
  StepContext,
  StepKind,
  Task,
  Tier,
  ToolCall,
  ToolPreview,
  UndoRecord,
  WorkflowInput,
} from "@monday/shared";
import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  bigserial,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

/** Raw bytes. postgres.js sends a Uint8Array as bytea and returns a Buffer. */
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
  toDriver: (value) => value,
  fromDriver: (value) => new Uint8Array(value),
});

/** A Postgres text-search document; read back as its text form, never written by the app. */
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

/**
 * The plaintext participants as one string for the headers index (research 5):
 * every name and address, weight B under the subject prefix. jsonb_path_query_array
 * is immutable, which a generated column requires.
 */
export const PARTICIPANTS_TEXT_SQL =
  "jsonb_path_query_array(participants, '$[*].name')::text || ' ' || jsonb_path_query_array(participants, '$[*].email')::text";

/** One row per running Server, refreshed every 30 s (ADR 0005). */
export const servers = pgTable("servers", {
  id: text("id").primaryKey(),
  mode: text("mode").notNull(),
  lastSeen: timestamp("last_seen", { withTimezone: true, mode: "date" }).notNull(),
});

export type JobStatus = "queued" | "running" | "done" | "failed";

/** The only coordination between Servers: leased, idempotent, time-budgeted rows. */
export const jobs = pgTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    class: text("class").notNull(),
    /** Need tags such as needs-public-url or needs-process. Empty means anyone. */
    needs: text("needs").array().notNull().default([]),
    payload: jsonb("payload").notNull().default({}),
    runAt: timestamp("run_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    leaseUntil: timestamp("lease_until", { withTimezone: true, mode: "date" }),
    leaseOwner: text("lease_owner"),
    attempts: integer("attempts").notNull().default(0),
    status: text("status").$type<JobStatus>().notNull().default("queued"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    index("jobs_claim_idx").on(t.status, t.runAt),
    index("jobs_lease_idx").on(t.status, t.leaseUntil),
  ],
);

/** One installed client holding a per-Device token (ADR 0006). */
export const devices = pgTable("devices", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** SHA-256 of the bearer token, hex. The token itself is never stored. */
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  lastSeen: timestamp("last_seen", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export type SettingScope = "global" | "device";

/** A Setting saved by the UI or the Agent; global or per Device (ADR 0004). */
export const settings = pgTable(
  "settings",
  {
    scope: text("scope").$type<SettingScope>().notNull(),
    /** Null for global scope. */
    deviceId: text("device_id"),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [unique("settings_scope_device_key").on(t.scope, t.deviceId, t.key).nullsNotDistinct()],
);

/** A short code shown on the new Device and confirmed from an existing one. */
export const pairingCodes = pgTable("pairing_codes", {
  code: text("code").primaryKey(),
  /** SHA-256 of the secret the pending Device holds to claim its token. */
  secretHash: text("secret_hash").notNull(),
  deviceName: text("device_name").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: "date" }),
  used: boolean("used").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

/* ------------------------------ Mailstore ------------------------------ */

/** One connection to a Provider. Credentials live elsewhere; this holds a reference. */
export const accounts = pgTable("accounts", {
  id: text("id").primaryKey(),
  provider: text("provider").$type<Provider>().notNull(),
  address: text("address").notNull(),
  displayName: text("display_name").notNull().default(""),
  /** Where the Provider credentials are kept (keychain entry, OAuth row); null until connected. */
  credentialsRef: text("credentials_ref"),
  /** Provider sync cursors: JMAP state strings, history ids, UIDVALIDITY tables. */
  syncState: jsonb("sync_state").notNull().default({}),
  capabilities: jsonb("capabilities").$type<AccountCapabilities>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

/** One Account is exactly one Workspace. */
export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  accountId: text("account_id")
    .notNull()
    .unique()
    .references(() => accounts.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

/** K_ws wrapped under K_root (src/crypto/keys.ts). The root key itself is never here. */
export const workspaceKeys = pgTable("workspace_keys", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  wrappedKey: bytea("wrapped_key").notNull(),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  rotatedAt: timestamp("rotated_at", { withTimezone: true, mode: "date" }),
});

/**
 * Thread headers. The subject is content and lives in the envelope
 * (subject_enc plus its wrapped data key in subject_key). subject_search is the
 * one deliberate leak: the first 80 characters, lowercased and whitespace
 * collapsed, so the headers-only index can match a subject while the laptop is
 * closed (research 5, "headers plus decrypt-and-filter for agents"). It is never
 * shown as the subject; the reader decrypts subject_enc.
 */
export const threads = pgTable(
  "threads",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    providerThreadId: text("provider_thread_id").notNull(),
    subjectEnc: bytea("subject_enc").notNull(),
    subjectKey: bytea("subject_key").notNull(),
    subjectSearch: text("subject_search").notNull().default(""),
    participants: jsonb("participants").$type<Person[]>().notNull().default([]),
    lastActivity: timestamp("last_activity", { withTimezone: true, mode: "date" }).notNull(),
    messageCount: integer("message_count").notNull().default(0),
    unread: boolean("unread").notNull().default(false),
    starred: boolean("starred").notNull().default(false),
    archived: boolean("archived").notNull().default(false),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true, mode: "date" }),
    section: text("section"),
    groupId: text("group_id"),
    subgroupId: text("subgroup_id"),
    /** In the Provider's trash; a permanent delete removes the row. */
    deleted: boolean("deleted").notNull().default(false),
    hasAttachments: boolean("has_attachments").notNull().default(false),
    /** List mail: any Message carries List-Id, List-Unsubscribe or Precedence bulk. Headers only. */
    bulk: boolean("bulk").notNull().default(false),
    /**
     * Per field group, when it was last written and by whom, for last-writer-wins
     * against replayed intents (ADR 0005; packages/shared sync.ts). A group with
     * no entry has only ever been written by sync.
     */
    writes: jsonb("writes").$type<FieldWrites>().notNull().default({}),
    /**
     * The headers-only search document (ADR 0011, research 5): the subject
     * prefix at weight A and the participants at weight B, in the `simple`
     * configuration so no language stemming is assumed. Generated, so it can
     * never drift from the columns; GIN-indexed for `/search/headers`.
     */
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql.raw(
        `setweight(to_tsvector('simple', coalesce(subject_search, '')), 'A') || setweight(to_tsvector('simple', ${PARTICIPANTS_TEXT_SQL}), 'B')`,
      ),
    ),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    unique("threads_workspace_provider").on(t.workspaceId, t.providerThreadId),
    index("threads_list_idx").on(t.workspaceId, t.archived, t.lastActivity, t.id),
    index("threads_section_idx").on(t.workspaceId, t.section),
    index("threads_group_idx").on(t.workspaceId, t.groupId),
    index("threads_search_idx").using("gin", t.searchVector),
  ],
);

/** One email. Addresses, date and headers are plaintext; body and snippet are not. */
export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    providerMessageId: text("provider_message_id").notNull(),
    from: jsonb("from").$type<Person>().notNull(),
    to: jsonb("to").$type<Person[]>().notNull().default([]),
    cc: jsonb("cc").$type<Person[]>().notNull().default([]),
    date: timestamp("date", { withTimezone: true, mode: "date" }).notNull(),
    /** Message-Id, In-Reply-To, References, List-Id and the other headers routing reads. */
    headers: jsonb("headers").$type<Record<string, string>>().notNull().default({}),
    bodyEnc: bytea("body_enc").notNull(),
    bodyKey: bytea("body_key").notNull(),
    snippetEnc: bytea("snippet_enc").notNull(),
    snippetKey: bytea("snippet_key").notNull(),
    hasAttachments: boolean("has_attachments").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    unique("messages_workspace_provider").on(t.workspaceId, t.providerMessageId),
    index("messages_thread_idx").on(t.threadId, t.date),
  ],
);

/**
 * A chunked, encrypted byte sequence: attachment bytes or a compose upload.
 * A compose upload arrives chunk by chunk (POST /blobs, PUT /blobs/:id/chunks/:i)
 * and is `complete` once every chunk is in; name and media type are plaintext
 * like an attachment's (research 5).
 */
export const blobs = pgTable("blobs", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  /** Plaintext length. */
  size: integer("size").notNull(),
  chunkSize: integer("chunk_size").notNull(),
  chunkCount: integer("chunk_count").notNull(),
  /** The blob's data key wrapped under K_ws; every chunk is under this one key. */
  key: bytea("key").notNull(),
  name: text("name").notNull().default(""),
  mediaType: text("media_type").notNull().default("application/octet-stream"),
  complete: boolean("complete").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const blobChunks = pgTable(
  "blob_chunks",
  {
    blobId: text("blob_id")
      .notNull()
      .references(() => blobs.id, { onDelete: "cascade" }),
    index: integer("index").notNull(),
    data: bytea("data").notNull(),
  },
  (t) => [primaryKey({ columns: [t.blobId, t.index] })],
);

/** Name, size and media type are plaintext (research 5); bytes and extracted text are not. */
export const attachments = pgTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    size: integer("size").notNull(),
    mediaType: text("media_type").notNull(),
    blobId: text("blob_id").references(() => blobs.id, { onDelete: "set null" }),
    textEnc: bytea("text_enc"),
    textKey: bytea("text_key"),
    /** Content-ID of an inline part, without angle brackets, so cid: images resolve. */
    contentId: text("content_id"),
    inline: boolean("inline").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("attachments_message_idx").on(t.messageId)],
);

/** A Provider label or folder, synced both ways. `role` is the well-known use (inbox, sent, trash ...). */
export const labels = pgTable(
  "labels",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    name: text("name").notNull(),
    role: text("role"),
  },
  (t) => [unique("labels_workspace_provider").on(t.workspaceId, t.providerId)],
);

export const threadLabels = pgTable(
  "thread_labels",
  {
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    labelId: text("label_id")
      .notNull()
      .references(() => labels.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.threadId, t.labelId] })],
);

/** monday's own marker, never pushed to the Provider. The name is a label and stays plaintext. */
export const tags = pgTable(
  "tags",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
  },
  (t) => [unique("tags_workspace_name").on(t.workspaceId, t.name)],
);

export const threadTags = pgTable(
  "thread_tags",
  {
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.threadId, t.tagId] })],
);

/* ------------------------------ Providers and sync ------------------------------ */

/**
 * The Account's Provider credentials as one encrypted object (kind
 * "credential") under the Workspace envelope: the wrapped data key and the
 * envelope. accounts.credentials_ref points at the row.
 */
export const accountCredentials = pgTable("account_credentials", {
  id: text("id").primaryKey(),
  accountId: text("account_id")
    .notNull()
    .unique()
    .references(() => accounts.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  key: bytea("key").notNull(),
  dataEnc: bytea("data_enc").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export type SyncTierName = "qresync" | "condstore" | "full-scan" | "state";

/** Per-Account sync progress: one state token per mailbox, the tier in use, the last full and reconcile passes. */
export const syncState = pgTable("sync_state", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  accountId: text("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  tier: text("tier").$type<SyncTierName>(),
  /** Provider mailbox id to opaque state token. */
  mailboxStates: jsonb("mailbox_states").$type<Record<string, string>>().notNull().default({}),
  /** Mailboxes still paging their first pass. */
  pending: text("pending").array().notNull().default(sql`'{}'::text[]`),
  lastFullSync: timestamp("last_full_sync", { withTimezone: true, mode: "date" }),
  lastReconcile: timestamp("last_reconcile", { withTimezone: true, mode: "date" }),
  lastError: text("last_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export type BodyState = "pending" | "fetched" | "deferred";

/**
 * The engine's mirror of what the Provider holds, keyed by the Provider's
 * message id: which mailboxes, which flags, and which Mailstore row it maps to.
 * Several Provider ids can map to one Message (IMAP copies across folders).
 */
export const syncMessages = pgTable(
  "sync_messages",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    /** The Provider Thread id or the engine's own key. */
    threadKey: text("thread_key").notNull(),
    rfcMessageId: text("rfc_message_id"),
    /** In-Reply-To and References ids, so a parent that arrives late can claim its children. */
    references: text("references").array().notNull().default(sql`'{}'::text[]`),
    subjectKey: text("subject_key").notNull().default(""),
    participants: text("participants").array().notNull().default(sql`'{}'::text[]`),
    mailboxIds: text("mailbox_ids").array().notNull().default(sql`'{}'::text[]`),
    seen: boolean("seen").notNull().default(false),
    flagged: boolean("flagged").notNull().default(false),
    date: timestamp("date", { withTimezone: true, mode: "date" }).notNull(),
    bodyState: text("body_state").$type<BodyState>().notNull().default("pending"),
    /** Set on a mailbox reset; cleared when the Provider yields the Message again, else dropped. */
    stale: boolean("stale").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.providerId] }),
    index("sync_messages_message_idx").on(t.messageId),
    index("sync_messages_thread_idx").on(t.threadId),
    index("sync_messages_rfc_idx").on(t.workspaceId, t.rfcMessageId),
    index("sync_messages_references_idx").using("gin", t.references),
    index("sync_messages_subject_idx").on(t.workspaceId, t.subjectKey, t.date),
    index("sync_messages_body_idx").on(t.workspaceId, t.bodyState, t.date),
  ],
);

/* ------------------------------ Changes feed and activity ------------------------------ */

/**
 * The ordered stream a client reads from its cursor (docs/spec/architecture.md,
 * "API shape"). Every Mailstore write a client cares about appends one row in
 * the same transaction; `seq` is the cursor. Payloads are headers only: content
 * stays behind the envelope and the content routes.
 */
export const changes = pgTable(
  "changes",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: text("kind").$type<ChangeKind>().notNull(),
    entityId: text("entity_id").notNull(),
    payload: jsonb("payload").notNull(),
    at: timestamp("at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("changes_workspace_seq_idx").on(t.workspaceId, t.seq)],
);

/** Who made an Activity row: the Agent through a tool, the user, or automation (a replayed intent). */
export type ActivityActor = Actor | "agent";

/**
 * The Activity log (ADR 0002): one row per Tool call, with the tier, the
 * preview shown, who decided, the result and what Undo replays. The tool
 * server also uses it as its ledger: a call id already recorded is not run
 * twice when the LangGraph node re-executes after an interrupt. The sync
 * engine's rows (intents that lost last-writer-wins) carry only the summary.
 */
export const activity = pgTable(
  "activity",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    actor: text("actor").$type<ActivityActor>().notNull(),
    tool: text("tool").notNull(),
    summary: text("summary").notNull(),
    at: timestamp("at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    sessionId: text("session_id"),
    /** The model's id for the call, unique within a Session. */
    callId: text("call_id"),
    tier: text("tier").$type<Tier>(),
    input: jsonb("input").$type<Record<string, unknown>>(),
    preview: jsonb("preview").$type<ToolPreview>(),
    decision: text("decision").$type<ApprovalDecision | "auto" | "standing">(),
    status: text("status").$type<ToolCall["status"]>().notNull().default("done"),
    result: jsonb("result"),
    undo: jsonb("undo").$type<UndoRecord>(),
    undoneAt: timestamp("undone_at", { withTimezone: true, mode: "date" }),
    /** The Workflow Run a Step ran under (slice 16); the ledger key beside call_id for Runs. */
    runId: text("run_id"),
  },
  (t) => [
    index("activity_workspace_at_idx").on(t.workspaceId, t.at),
    unique("activity_session_call").on(t.sessionId, t.callId),
    index("activity_run_idx").on(t.runId),
  ],
);

/* ------------------------------ Agent host: Sessions (ADR 0002, ADR 0007) ------------------------------ */

/**
 * One conversation with the Agent. The LangGraph checkpoint for it lives in
 * the checkpointer's own tables under the `langgraph` schema, keyed by this
 * id as its thread_id; the transcript the composer replays is session_events.
 */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    runtime: jsonb("runtime").$type<Runtime>().notNull(),
    /** The first user turn, for the history list. */
    title: text("title").notNull().default(""),
    developerMode: boolean("developer_mode").notNull().default(false),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    lastActivity: timestamp("last_activity", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("sessions_workspace_idx").on(t.workspaceId, t.lastActivity)],
);

/** The persisted events of a Session, in order: user turns, answers, tool cards. */
export const sessionEvents = pgTable(
  "session_events",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    event: jsonb("event").$type<AgentEvent>().notNull(),
    at: timestamp("at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("session_events_session_idx").on(t.sessionId, t.seq)],
);

/* ------------------------------ Drafts, sends and voice (ADR 0010) ------------------------------ */

/**
 * A Draft is Server-owned and mirrored into the Provider's Drafts folder.
 * Subject and body are content (each its own envelope); recipients, the
 * Thread link and the blob ids are headers. `updated_by` is the Device or
 * actor that saved it last, for last-writer-wins between Devices.
 */
export const drafts = pgTable(
  "drafts",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    threadId: text("thread_id").references(() => threads.id, { onDelete: "set null" }),
    kind: text("kind").$type<DraftKind>().notNull().default("new"),
    inReplyToMessageId: text("in_reply_to_message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    to: jsonb("to").$type<Person[]>().notNull().default([]),
    cc: jsonb("cc").$type<Person[]>().notNull().default([]),
    bcc: jsonb("bcc").$type<Person[]>().notNull().default([]),
    subjectEnc: bytea("subject_enc").notNull(),
    subjectKey: bytea("subject_key").notNull(),
    /** JSON {text, html} under one envelope. */
    bodyEnc: bytea("body_enc").notNull(),
    bodyKey: bytea("body_key").notNull(),
    blobIds: text("blob_ids").array().notNull().default(sql`'{}'::text[]`),
    attachments: jsonb("attachments").$type<DraftAttachment[]>().notNull().default([]),
    /** The Provider's id for the mirrored copy; replaced on every mirror. */
    providerDraftId: text("provider_draft_id"),
    /** The content hash the last mirror wrote, so an unchanged Draft is not re-appended. */
    mirroredHash: text("mirrored_hash"),
    status: text("status").$type<DraftStatus>().notNull().default("open"),
    deleted: boolean("deleted").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedBy: text("updated_by").notNull().default("user"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    index("drafts_workspace_idx").on(t.workspaceId, t.deleted, t.updatedAt),
    index("drafts_thread_idx").on(t.threadId),
  ],
);

/** One press of Send: the Job that will deliver, and the window in which Undo cancels it. */
export const scheduledSends = pgTable(
  "scheduled_sends",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    draftId: text("draft_id")
      .notNull()
      .references(() => drafts.id, { onDelete: "cascade" }),
    runAt: timestamp("run_at", { withTimezone: true, mode: "date" }).notNull(),
    status: text("status").$type<ScheduledSendStatus>().notNull().default("scheduled"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: "date" }),
    sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }),
    jobId: text("job_id"),
    error: jsonb("error").$type<SendError | null>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    index("scheduled_sends_workspace_idx").on(t.workspaceId, t.status, t.runAt),
    index("scheduled_sends_draft_idx").on(t.draftId),
  ],
);

/* ------------------------------ Intelligence: Hosted runtime, Meter, Briefs (ADR 0007) ------------------------------ */

/**
 * A Hosted provider key the user shared with the Server ("Let the server use
 * this key"). One row per provider, the key under the envelope as a
 * "credential" object: wrapped under the K_ws of whichever Workspace the
 * sharing Device was showing, which any unlocked Server can open. Keys that
 * are not shared never reach this table; they stay in the Device keychain.
 */
export const providerKeys = pgTable("provider_keys", {
  provider: text("provider").$type<HostedProvider>().primaryKey(),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  key: bytea("key").notNull(),
  dataEnc: bytea("data_enc").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

/** The Meter: one row per Hosted model call. Cost is an estimate in USD micro-units. */
export const meter = pgTable(
  "meter",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    task: text("task").$type<Task>().notNull(),
    provider: text("provider").$type<HostedProvider>().notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cachedTokens: integer("cached_tokens").notNull().default(0),
    costMicros: bigint("cost_micros", { mode: "number" }).notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    jobId: text("job_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("meter_workspace_at_idx").on(t.workspaceId, t.createdAt)],
);

/**
 * A Brief per Thread (docs/spec/architecture.md, "Data model"): bullets and
 * actions are model-written text about mail content, so each is its own
 * envelope under the "brief" kind. Which model wrote it is a header, and so
 * is the Thread version it was computed for (message count and the newest
 * Message id): a Message arriving after that marks the Brief stale (slice 13).
 */
export const briefs = pgTable("briefs", {
  threadId: text("thread_id")
    .primaryKey()
    .references(() => threads.id, { onDelete: "cascade" }),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  bulletsEnc: bytea("bullets_enc").notNull(),
  bulletsKey: bytea("bullets_key").notNull(),
  actionsEnc: bytea("actions_enc").notNull(),
  actionsKey: bytea("actions_key").notNull(),
  provider: text("provider").$type<HostedProvider>().notNull(),
  model: text("model").notNull(),
  computedAt: timestamp("computed_at", { withTimezone: true, mode: "date" }).notNull(),
  stale: boolean("stale").notNull().default(false),
  messageCount: integer("message_count").notNull().default(0),
  latestMessageId: text("latest_message_id").notNull().default(""),
});

/** The Voice profile: storage and routes here; building it from sent mail is a later slice. */
export const voiceProfiles = pgTable("voice_profiles", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  description: text("description").notNull().default(""),
  excerpts: jsonb("excerpts").$type<string[]>().notNull().default([]),
  builtAt: timestamp("built_at", { withTimezone: true, mode: "date" }),
  enabled: boolean("enabled").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

/* ------------------------------ Intelligence: routing (ADR 0004, slice 12) ------------------------------ */

/**
 * A Group (CONTEXT.md): a smart inbox a Routing rule fills, nested at most one
 * level. The sentence and the Predicate are the user's own words and header
 * facts, plaintext; the model prompt the route Task revises from corrections
 * quotes mail and lives under the envelope ("rule" kind). Nothing is seeded
 * here: onboarding seeds Groups.
 */
export const groups = pgTable(
  "groups",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    parentId: text("parent_id").references((): AnyPgColumn => groups.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sentence: text("sentence").notNull().default(""),
    predicate: jsonb("predicate").$type<Predicate>().notNull().default({}),
    promptEnc: bytea("prompt_enc"),
    promptKey: bytea("prompt_key"),
    /** Per-Group route threshold; null means the Setting. */
    threshold: real("threshold"),
    briefPolicy: text("brief_policy").$type<BriefPolicy>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("groups_workspace_idx").on(t.workspaceId, t.parentId)],
);

/**
 * An Example (CONTEXT.md): a Thread the user confirmed or corrected into a
 * Group, or out of one. What the Routing page shows is the sender and the
 * plaintext subject prefix, so the row carries no content.
 */
export const examples = pgTable(
  "examples",
  {
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    groupId: text("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    positive: boolean("positive").notNull(),
    from: jsonb("from").$type<Person | null>(),
    subject: text("subject").notNull().default(""),
    at: timestamp("at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.threadId, t.groupId] }),
    index("examples_group_idx").on(t.groupId),
  ],
);

/** Where routing put a Thread and how sure it was, with the score of every Group it weighed. */
export const threadRoutes = pgTable(
  "thread_routes",
  {
    threadId: text("thread_id")
      .primaryKey()
      .references(() => threads.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    groupId: text("group_id"),
    subgroupId: text("subgroup_id"),
    confidence: real("confidence"),
    subgroupConfidence: real("subgroup_confidence"),
    by: text("by").$type<RouteBy>().notNull(),
    scores: jsonb("scores").$type<Score[]>().notNull().default([]),
    routedAt: timestamp("routed_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("thread_routes_group_idx").on(t.workspaceId, t.groupId)],
);

/** Needs a decision (CONTEXT.md): a Thread whose best rule was not sure enough, with its candidates. */
export const routingDecisions = pgTable(
  "routing_decisions",
  {
    threadId: text("thread_id")
      .primaryKey()
      .references(() => threads.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    candidates: jsonb("candidates").$type<DecisionCandidate[]>().notNull().default([]),
    at: timestamp("at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("routing_decisions_workspace_idx").on(t.workspaceId, t.at)],
);

/* ------------------------------ Workflows (ADR 0003, slice 16) ------------------------------ */

/**
 * A Workflow row is the mutable state around an immutable document: the
 * current version, the enabled switch and the Standing approvals. The
 * document itself lives in workflow_versions; every edit is a new version and
 * a Run always names the one it ran under.
 */
export const workflows = pgTable(
  "workflows",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(false),
    currentVersion: integer("current_version").notNull().default(1),
    /** Step ids whose always-ask calls run unattended (CONTEXT.md "Standing approval"). */
    standingApprovals: jsonb("standing_approvals").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [index("workflows_workspace_idx").on(t.workspaceId, t.updatedAt)],
);

/** One immutable document per version. */
export const workflowVersions = pgTable(
  "workflow_versions",
  {
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    document: jsonb("document").$type<WorkflowInput>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.workflowId, t.version] })],
);

/**
 * A Run (CONTEXT.md): one execution of a Workflow, a chain of Jobs one per
 * Step, with its state here and each Step's outcome in workflow_run_steps.
 * `context` is what the Steps reported, for the templates of later Steps.
 */
export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    status: text("status").$type<RunStatus>().notNull().default("queued"),
    trigger: jsonb("trigger").$type<RunTrigger>().notNull(),
    threadId: text("thread_id"),
    /** The plaintext subject prefix, for the log line. */
    subject: text("subject").notNull().default(""),
    currentStep: integer("current_step").notNull().default(0),
    failedStep: integer("failed_step"),
    /** The Activity row that waits for approval while paused. */
    waitingActivityId: text("waiting_activity_id"),
    /** The user's answer to the waiting Step, consumed when the Step resumes. */
    decision: text("decision").$type<ApprovalDecision>(),
    error: text("error"),
    context: jsonb("context").$type<Record<string, StepContext>>().notNull().default({}),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    index("workflow_runs_workflow_idx").on(t.workflowId, t.startedAt),
    index("workflow_runs_workspace_status_idx").on(t.workspaceId, t.status),
  ],
);

/** One Step's outcome in a Run: the Run log line and the Activity row it ran as. */
export const workflowRunSteps = pgTable(
  "workflow_run_steps",
  {
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    index: integer("index").notNull(),
    stepId: text("step_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").$type<StepKind>().notNull(),
    status: text("status").$type<RunStepStatus>().notNull(),
    detail: text("detail").notNull().default(""),
    activityId: text("activity_id"),
    result: jsonb("result"),
    at: timestamp("at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.index] })],
);

/* ------------------------------ Calendar (slice 18) ------------------------------ */

/** The push registration (Google channel, Graph subscription) a calendar holds while one is live. */
export interface CalendarSubscription {
  id: string;
  resourceId?: string;
  token: string;
  expiresAt: string;
  registeredBy: string;
}

/**
 * The calendars of a Workspace as its Provider lists them (research 6), or
 * the one Local calendar of an Account with no calendar API. `visible` is the
 * per-Workspace choice the views read; it lives here so every Device agrees.
 */
export const calendars = pgTable(
  "calendars",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    source: text("source").$type<CalendarSource>().notNull(),
    providerId: text("provider_id").notNull(),
    name: text("name").notNull(),
    primary: boolean("primary").notNull().default(false),
    writable: boolean("writable").notNull().default(true),
    visible: boolean("visible").notNull().default(true),
    color: text("color"),
    /** The Provider's incremental sync token for this calendar; null before the first pass. */
    syncToken: text("sync_token"),
    subscription: jsonb("subscription").$type<CalendarSubscription | null>(),
    lastSync: timestamp("last_sync", { withTimezone: true, mode: "date" }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [unique("calendars_workspace_provider").on(t.workspaceId, t.providerId)],
);

/**
 * An Event (CONTEXT.md): times, attendees, link and status in the clear, so
 * the views and the free/busy check work on a locked Server and the feed can
 * carry them; the title, description and location are content like a
 * Message body and sit under one envelope of the "event" kind.
 */
export const events = pgTable(
  "events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    calendarId: text("calendar_id")
      .notNull()
      .references(() => calendars.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    uid: text("uid"),
    /** JSON {title, description, location} under one envelope. */
    contentEnc: bytea("content_enc").notNull(),
    contentKey: bytea("content_key").notNull(),
    /** The lowercased 80-character title prefix, like threads.subject_search: the one leak, for the list on a locked Server. */
    titleSearch: text("title_search").notNull().default(""),
    start: timestamp("start", { withTimezone: true, mode: "date" }).notNull(),
    end: timestamp("end", { withTimezone: true, mode: "date" }).notNull(),
    allDay: boolean("all_day").notNull().default(false),
    timeZone: text("time_zone"),
    organizer: jsonb("organizer").$type<Person | null>(),
    attendees: jsonb("attendees").$type<Attendee[]>().notNull().default([]),
    link: text("link"),
    status: text("status").$type<EventStatus>().notNull().default("confirmed"),
    recurrence: text("recurrence"),
    recurringEventId: text("recurring_event_id"),
    response: text("response").$type<RsvpResponse | null>(),
    createdByAgent: boolean("created_by_agent").notNull().default(false),
    etag: text("etag"),
    /** The iCalendar SEQUENCE the Event was last seen at, for the invite bar's "ask again" rule. */
    sequence: integer("sequence").notNull().default(0),
    deleted: boolean("deleted").notNull().default(false),
    /** Set on a calendar reset; cleared when the Provider yields the Event again, else dropped. */
    stale: boolean("stale").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    unique("events_calendar_provider").on(t.calendarId, t.providerId),
    index("events_window_idx").on(t.workspaceId, t.start, t.end),
    index("events_uid_idx").on(t.workspaceId, t.uid),
  ],
);

/**
 * An Invite (CONTEXT.md): the text/calendar part of a Message, parsed. The
 * title and the part itself are content under the "event" kind; the times,
 * people and the answer so far are headers the invite bar renders from the
 * feed. `event_id` links it to the Event on the calendar once matched.
 */
export const invites = pgTable(
  "invites",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    eventId: text("event_id").references(() => events.id, { onDelete: "set null" }),
    method: text("method").$type<InviteMethod>().notNull(),
    uid: text("uid").notNull(),
    sequence: integer("sequence").notNull().default(0),
    titleEnc: bytea("title_enc").notNull(),
    titleKey: bytea("title_key").notNull(),
    /** The original text/calendar part, for the REPLY monday builds and for a late import. */
    icalEnc: bytea("ical_enc").notNull(),
    icalKey: bytea("ical_key").notNull(),
    start: timestamp("start", { withTimezone: true, mode: "date" }).notNull(),
    end: timestamp("end", { withTimezone: true, mode: "date" }).notNull(),
    allDay: boolean("all_day").notNull().default(false),
    organizer: jsonb("organizer").$type<Person | null>(),
    attendees: jsonb("attendees").$type<Attendee[]>().notNull().default([]),
    response: text("response").$type<RsvpResponse>().notNull().default("needs-action"),
    byMail: boolean("by_mail").notNull().default(false),
    senderMismatch: boolean("sender_mismatch").notNull().default(false),
    receivedAt: timestamp("received_at", { withTimezone: true, mode: "date" }).notNull(),
    writes: jsonb("writes").$type<FieldWrites>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    unique("invites_message").on(t.messageId),
    index("invites_thread_idx").on(t.threadId),
    index("invites_uid_idx").on(t.workspaceId, t.uid),
  ],
);
