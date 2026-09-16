// Postgres schema, the source of truth (docs/spec/architecture.md, "Data model").
// Server core: servers, jobs, devices, settings and pairing. Mailstore: accounts,
// workspaces, workspace keys, threads, messages, attachments, blobs, labels and
// tags. Every body-derived column is ciphertext (research 5); the plaintext
// columns are exactly the header fields sync, threading and routing need.

import type { AccountCapabilities, Person, Provider } from "@monday/shared";
import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
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
    hasAttachments: boolean("has_attachments").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (t) => [
    unique("threads_workspace_provider").on(t.workspaceId, t.providerThreadId),
    index("threads_list_idx").on(t.workspaceId, t.archived, t.lastActivity, t.id),
    index("threads_section_idx").on(t.workspaceId, t.section),
    index("threads_group_idx").on(t.workspaceId, t.groupId),
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

/** A chunked, encrypted byte sequence: attachment bytes or a compose upload. */
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
