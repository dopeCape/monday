// Providers: Gmail, Graph, JMAP and IMAP behind one sync, send and watch
// interface (ADR 0009, docs/research/provider-sync.md). This file is the whole
// seam. An adapter is a Provider; connect() yields a Session that speaks the
// wire protocol; the sync engine (sync.ts) turns Session events into Mailstore
// writes and never sees a protocol detail. The fake under fake/ is the seam
// every module above the Providers tests against.
//
// Ids are the Provider's own: a JMAP Email id, an IMAP "path:uidvalidity:uid",
// a Gmail message id. They are opaque to everyone but the adapter that minted
// them. State tokens are opaque strings the adapter alone can read; the engine
// stores them per mailbox and hands them back.

import type {
  AccountCapabilities,
  Attendee,
  CalendarInfo,
  EventInput,
  EventStatus,
  IsoDate,
  MeetingLinkKind,
  Person,
  Provider as ProviderKind,
  RsvpResponse,
} from "@monday/shared";

/* ------------------------------ Credentials ------------------------------ */

/** How the Session authenticates. Stored encrypted (kind "credential") and never logged. */
export type Auth =
  | { kind: "password"; user: string; password: string }
  /** A bearer API token (Fastmail). */
  | { kind: "token"; token: string }
  | OAuthAuth;

/**
 * OAuth credentials: the tokens plus the self-hoster's own client registration
 * (ADR 0008: no shared client id ships with monday), which every refresh needs.
 */
export interface OAuthAuth {
  kind: "oauth";
  user: string;
  issuer: "google" | "microsoft" | string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: IsoDate;
  client?: OAuthClient;
}

export interface OAuthClient {
  id: string;
  /** Google Desktop clients carry one; Entra public clients must not. */
  secret?: string;
  /** Entra only: a tenant id, "organizations", "consumers" or "common". */
  tenant?: string;
}

export type Tls = "tls" | "starttls" | "none";

export interface HostPort {
  host: string;
  port: number;
  tls: Tls;
}

/** Where the Provider lives. "none" for adapters with a fixed endpoint (Graph, fake). */
export type Endpoint =
  | { kind: "jmap"; sessionUrl: string }
  | { kind: "imap"; imap: HostPort; smtp: HostPort }
  /** Gmail: the Pub/Sub topic `users.watch` publishes to, or null for polling only. */
  | { kind: "gmail"; pubsubTopic: string | null }
  | { kind: "none" };

/** A CalDAV calendar linked to an Account whose Provider has no calendar API (slice 18). */
export interface CalDavLink {
  /** The calendar home or a calendar collection; discovery walks from here. */
  url: string;
  user: string;
  password: string;
}

export interface Credentials {
  /** The Account's address; the identity sends go out as. */
  address: string;
  auth: Auth;
  endpoint: Endpoint;
  /** Set when the user linked a CalDAV calendar under Settings, Accounts. */
  caldav?: CalDavLink | null;
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

/* ------------------------------ Calendar (slice 18, docs/research/calendar-apis.md) ------------------------------ */

/** One calendar as the Provider lists it. */
export interface ProviderCalendar {
  id: string;
  name: string;
  primary: boolean;
  writable: boolean;
  color: string | null;
}

/** An Event as the Provider holds it; ids are the Provider's own. */
export interface ProviderEvent {
  id: string;
  calendarId: string;
  uid: string | null;
  title: string;
  description: string;
  location: string;
  start: IsoDate;
  end: IsoDate;
  allDay: boolean;
  timeZone: string | null;
  organizer: Person | null;
  attendees: Attendee[];
  link: string | null;
  status: EventStatus;
  recurrence: string | null;
  recurringEventId: string | null;
  /** The Account's own response when it is an attendee. */
  response: RsvpResponse | null;
  etag: string | null;
  updatedAt: IsoDate;
  /**
   * Minutes before the start to remind; null when the Event keeps the
   * calendar's default, absent when the adapter does not say (the stored
   * value is kept then).
   */
  reminders?: number[] | null | undefined;
}

export interface EventWindow {
  from: IsoDate;
  to: IsoDate;
}

/**
 * The events one syncEvents call yields, in order, like SyncEvent for mail:
 * "reset" first when the stored state cannot be continued (Google 410, a
 * stale DAV sync-token), then every Event in the window as "upserted"; the
 * "state" token is stored once everything before it is applied.
 */
export type CalendarSyncEvent =
  | { type: "reset" }
  | { type: "upserted"; event: ProviderEvent }
  | { type: "removed"; id: string }
  | { type: "state"; state: string; complete: boolean };

/** What createEvent takes: the user's input plus who organizes. */
export interface CreateEventInput extends EventInput {
  organizer: Person;
  /** The meeting link kind to mint, resolved from the Settings. */
  meetingLink: MeetingLinkKind;
  customLink: string | null;
}

/** What updateEvent takes: any subset of the create input; absent fields keep their value. */
export type UpdateEventInput = { [K in keyof CreateEventInput]?: CreateEventInput[K] | undefined };

/**
 * A Provider's calendar API behind one interface (research 6, "Recommended
 * minimum surface for v1"): Google Calendar, Graph, CalDAV. Google, Graph
 * and a scheduling CalDAV server mail invitations and replies themselves;
 * `info().providerSendsInvites` says so and the calendar module then never
 * sends iMIP mail for the Account.
 */
export interface CalendarSession {
  info(): CalendarInfo;
  listCalendars(): Promise<ProviderCalendar[]>;
  syncEvents(
    calendarId: string,
    state: string | null,
    window: EventWindow,
  ): AsyncIterable<CalendarSyncEvent>;
  createEvent(calendarId: string, input: CreateEventInput): Promise<ProviderEvent>;
  updateEvent(
    calendarId: string,
    eventId: string,
    input: UpdateEventInput,
    etag: string | null,
  ): Promise<ProviderEvent>;
  deleteEvent(calendarId: string, eventId: string): Promise<void>;
  /**
   * One Event as the Provider holds it, by id: the series master of an
   * instance the Provider expanded, for "all events" and "this and
   * following". Absent where masters are never hidden (CalDAV).
   */
  readEvent?(calendarId: string, eventId: string): Promise<ProviderEvent>;
  /** The Account's own answer on an Event it was invited to; the Provider mails the reply. */
  rsvp(calendarId: string, eventId: string, response: RsvpResponse): Promise<ProviderEvent>;
  /**
   * Places an invitation the Provider did not add itself (a CalDAV server
   * without scheduling, or one that only adds known senders). Absent where
   * the Provider always auto-adds (Google, Graph).
   */
  importInvite?(calendarId: string, ical: string): Promise<ProviderEvent>;
  /**
   * Registers a webhook for changes on a calendar (Google events.watch, Graph
   * subscriptions). Absent on CalDAV, which is polled.
   */
  subscribe?(
    calendarId: string,
    address: string,
    token: string,
  ): Promise<{ id: string; expiresAt: IsoDate }>;
  unsubscribe?(subscription: { id: string; resourceId?: string }): Promise<void>;
  close(): Promise<void>;
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
  /**
   * The Account's calendar API (slice 18): Google Calendar for Gmail, Graph
   * for Graph. Null or absent on Providers without one; the calendar module
   * then uses a linked CalDAV calendar or the Local calendar.
   */
  calendar?(): CalendarSession | null;
  /**
   * True while the adapter runs slower than its configured rate because the
   * Provider refused calls for quota (Gmail's 429 and rate-limit 403s). The
   * first sync screen says so instead of showing a frozen bar. Absent means never.
   */
  pacing?(): boolean;
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

/**
 * The Message-ID a Draft mirror carries: `monday-draft.<draft id>@<domain>`.
 * The import pass skips a Drafts-folder message with it, so a Provider that
 * names drafts apart from their messages (Gmail) never gets its own mirror
 * imported back as a second Draft. The real send gets a fresh id.
 */
export const MIRROR_MESSAGE_ID_PREFIX = "monday-draft.";

export function isMirrorMessageId(value: string | null | undefined): boolean {
  return normalizeMessageId(value)?.startsWith(MIRROR_MESSAGE_ID_PREFIX) ?? false;
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
