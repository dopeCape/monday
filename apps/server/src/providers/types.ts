// Providers: Gmail, Graph, JMAP and IMAP behind one sync, send and watch
// interface (ADR 0009, docs/research/provider-sync.md). This file is the whole
// seam. An adapter is a Provider; connect() yields a Session that speaks the
// wire protocol; the sync engine (sync.ts) turns Session events into Mailstore
// writes and never sees a protocol detail. The fake under fake/ is the seam
// every later slice tests against.
//
// Ids are the Provider's own: a JMAP Email id, an IMAP "path:uidvalidity:uid",
// a Gmail message id. They are opaque to everyone but the adapter that minted
// them. State tokens are opaque strings the adapter alone can read; the engine
// stores them per mailbox and hands them back.

import type {
  AccountCapabilities,
  IsoDate,
  Person,
  Provider as ProviderKind,
} from "@monday/shared";

/* ------------------------------ Credentials ------------------------------ */

/** How the Session authenticates. Stored encrypted (kind "credential") and never logged. */
export type Auth =
  | { kind: "password"; user: string; password: string }
  /** A bearer API token (Fastmail). */
  | { kind: "token"; token: string }
  | {
      kind: "oauth";
      user: string;
      issuer: "google" | "microsoft" | string;
      accessToken: string;
      refreshToken?: string;
      expiresAt?: IsoDate;
    };

export type Tls = "tls" | "starttls" | "none";

export interface HostPort {
  host: string;
  port: number;
  tls: Tls;
}

/** Where the Provider lives. Absent for adapters with a fixed endpoint (Gmail, Graph, fake). */
export type Endpoint =
  | { kind: "jmap"; sessionUrl: string }
  | { kind: "imap"; imap: HostPort; smtp: HostPort }
  | { kind: "none" };

export interface Credentials {
  /** The Account's address; the identity sends go out as. */
  address: string;
  auth: Auth;
  endpoint: Endpoint;
}

/* ------------------------------ Capabilities ------------------------------ */

/** How incremental sync is computed (research, "Incremental sync"). */
export type SyncTier = "qresync" | "condstore" | "full-scan" | "state";

export interface ProviderCapabilities extends AccountCapabilities {
  syncTier: SyncTier;
  /** The Provider groups Messages into Threads itself (JMAP, Gmail). Otherwise the engine threads by headers. */
  threads: boolean;
  /** The Provider keeps its own copy of sent mail, so send() must not append one. */
  savesSentCopy: boolean;
  /** Largest message send() accepts, from EHLO SIZE or the submission capability; null when unknown. */
  maxSendBytes: number | null;
}

/* ------------------------------ Mailboxes and messages ------------------------------ */

export type MailboxRole =
  | "inbox"
  | "archive"
  | "drafts"
  | "sent"
  | "trash"
  | "junk"
  | "all"
  | "important"
  | "flagged"
  | "subscribed";

export interface Mailbox {
  id: string;
  name: string;
  role: MailboxRole | null;
  parentId: string | null;
  totalMessages: number | null;
  unreadMessages: number | null;
}

/** Flags with a fixed meaning across Providers plus the Provider's free-form keywords. */
export interface Flags {
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  draft: boolean;
  keywords: string[];
}

/** What sync learns about a Message before its body: everything routing, threading and the list need. */
export interface MessageSummary {
  id: string;
  /** Present only when capabilities().threads. */
  threadId: string | null;
  mailboxIds: string[];
  flags: Flags;
  from: Person | null;
  to: Person[];
  cc: Person[];
  subject: string;
  /** The Date header, falling back to receivedAt. */
  date: IsoDate;
  receivedAt: IsoDate;
  /** RFC 5322 Message-ID without angle brackets. */
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  /** Lowercased header names the engine and routing read: list-id, list-unsubscribe, precedence, auto-submitted, ... */
  headers: Record<string, string>;
  size: number;
  hasAttachments: boolean;
  /** A short plaintext preview when the Provider gives one for free (JMAP). */
  preview: string | null;
}

export interface RawAttachment {
  name: string;
  mediaType: string;
  size: number;
  /** Content-ID for inline parts, without angle brackets. */
  contentId: string | null;
  inline: boolean;
  /** The bytes, in order, in whatever chunking the transport produced. */
  content(): AsyncIterable<Uint8Array>;
}

/** One Message with its body. Headers are the full parsed set, lowercased names. */
export interface RawMessage {
  id: string;
  headers: Record<string, string>;
  text: string;
  html: string | null;
  attachments: RawAttachment[];
}

/* ------------------------------ Sync ------------------------------ */

export interface SyncOptions {
  /** At most this many "added" events per call. The state token records where to resume. */
  limit?: number;
}

/**
 * The events one syncMailbox call yields, in order. "reset" comes first when
 * the stored state cannot be continued (UIDVALIDITY change, JMAP
 * cannotCalculateChanges): every Message still in the mailbox is then
 * re-yielded as "added" and the engine drops what it did not see again.
 * "state" carries the token to store once everything before it is applied;
 * complete false means more pages remain and the call should be repeated.
 */
export type SyncEvent =
  | { type: "reset" }
  | { type: "added"; message: MessageSummary }
  | { type: "changed"; id: string; flags: Flags; mailboxIds: string[] }
  | { type: "removed"; id: string }
  | { type: "state"; state: string; complete: boolean };

/* ------------------------------ Changes (inbox.md, "Action semantics") ------------------------------ */

export type Change =
  | { kind: "archive" }
  | { kind: "delete" }
  | { kind: "star"; value: boolean }
  | { kind: "read"; value: boolean }
  | { kind: "move"; mailboxId: string }
  | { kind: "label"; add: string[]; remove: string[] };

export type ChangeTarget = { messageIds: string[] } | { threadId: string };

/* ------------------------------ Send ------------------------------ */

export interface SendOptions {
  /** Envelope recipients; derived from the headers when omitted. */
  to?: string[];
  /** The Draft the Provider holds for this Message, to replace on success. */
  draftId?: string | null;
}

export interface SendResult {
  /** The Provider's id for the sent Message, when it has one. */
  messageId: string | null;
}

/* ------------------------------ Drafts (ADR 0010) ------------------------------ */

export interface DraftResult {
  /** The Provider's id for the mirrored Draft. */
  id: string;
}

/* ------------------------------ Watch ------------------------------ */

export type WatchEvent =
  /** Something changed; mailboxIds is empty when the Provider does not say which. */
  | { type: "changed"; mailboxIds: string[] }
  | { type: "connected" }
  /** The push channel is down and retrying; the engine should poll until "connected". */
  | { type: "disconnected"; reason: string };

export interface Watch {
  /** False when this Provider or endpoint has no push; events then ends at once. */
  supported: boolean;
  events: AsyncIterable<WatchEvent>;
  stop(): Promise<void>;
}

/* ------------------------------ The interface ------------------------------ */

export interface Session {
  capabilities(): ProviderCapabilities;
  listMailboxes(): Promise<Mailbox[]>;
  syncMailbox(
    mailboxId: string,
    state: string | null,
    options?: SyncOptions,
  ): AsyncIterable<SyncEvent>;
  fetchMessage(id: string): Promise<RawMessage>;
  applyChange(target: ChangeTarget, change: Change): Promise<void>;
  send(mime: Uint8Array, options?: SendOptions): Promise<SendResult>;
  /**
   * Mirrors a Server-owned Draft into the Provider's Drafts folder (JMAP:
   * $draft keyword; IMAP: APPEND with \Draft) and removes the previous copy.
   * Absent on adapters that arrive later (Gmail, Graph in slice 9): the
   * mirror step then skips the Account.
   */
  putDraft?(mime: Uint8Array, previousId: string | null): Promise<DraftResult>;
  /** Removes a mirrored Draft, after a send or a delete. Missing ids are not an error. */
  deleteDraft?(id: string): Promise<void>;
  watch(mailboxIds: string[]): Watch;
  close(): Promise<void>;
}

export interface Provider {
  readonly kind: ProviderKind | "fake";
  connect(credentials: Credentials): Promise<Session>;
}

/* ------------------------------ Errors ------------------------------ */

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code:
      | "auth"
      | "network"
      | "unsupported"
      | "not-found"
      | "protocol"
      | "too-large"
      | "rate-limit",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ProviderError";
  }
}

export const EMPTY_FLAGS: Flags = {
  seen: false,
  flagged: false,
  answered: false,
  draft: false,
  keywords: [],
};

export function flagsEqual(a: Flags, b: Flags): boolean {
  if (a.seen !== b.seen || a.flagged !== b.flagged || a.answered !== b.answered) return false;
  if (a.draft !== b.draft || a.keywords.length !== b.keywords.length) return false;
  const sorted = [...b.keywords].sort();
  return [...a.keywords].sort().every((k, i) => k === sorted[i]);
}

export function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(b);
  return a.every((id) => set.has(id));
}

/** Strips angle brackets and whitespace from a Message-ID style token. */
export function normalizeMessageId(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().replace(/^<|>$/g, "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Splits a References header into normalized ids. */
export function parseReferences(value: string | null | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  for (const match of value.matchAll(/<([^<>\s]+)>/g)) {
    const id = match[1];
    if (id && !out.includes(id)) out.push(id);
  }
  if (out.length === 0) {
    for (const token of value.split(/[\s,]+/)) {
      const id = normalizeMessageId(token);
      if (id && !out.includes(id)) out.push(id);
    }
  }
  return out;
}
