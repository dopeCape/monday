// The Gmail adapter (research, "Gmail (Gmail REST API)"). Labels are the
// mailboxes; a sync state is the account's historyId plus a page token while
// the first pass lists a label. Incremental sync is history.list filtered to
// the label, a full resync through messages.list plus batched messages.get
// on 404. Push is users.watch to the self-hoster's Pub/Sub topic with a pull
// subscription held in this process (renewed daily by a Job), or a push
// subscription to the Cloud webhook. Send is messages.send with raw MIME and
// the threadId of the message being answered; large messages use the
// resumable upload. Everything is paced by the per-user quota bucket.

import type { Person } from "@monday/shared";
import { addressParser, decodeWords } from "postal-mime";
import type { FetchLike } from "../jmap/client.ts";
import { parseMime, pickHeaders, rawMessageOf, snippetOf } from "../mime.ts";
import { base64url, decodeBase64url } from "../oauth/pkce.ts";
import { createTokenBroker, type TokenBroker } from "../oauth/tokens.ts";
import {
  type CalendarSession,
  type Change,
  type ChangeTarget,
  type Flags,
  type Mailbox,
  type MailboxRole,
  type MessageSummary,
  normalizeMessageId,
  type OAuthAuth,
  type Provider,
  type ProviderCapabilities,
  ProviderError,
  parseReferences,
  type RawMessage,
  type SendOptions,
  type SendResult,
  type Session,
  type SyncEvent,
  type SyncOptions,
  type Watch,
} from "../types.ts";
import { createGoogleCalendar } from "./calendar.ts";
import { GmailApiError, GmailClient } from "./client.ts";
import {
  ensurePullSubscription,
  ensurePushSubscription,
  type PullLoop,
  pullLoop,
} from "./pubsub.ts";
import { GMAIL_COST, gmailQuotaBucket, type TokenBucket } from "./quota.ts";

export { createGoogleCalendar, eventOfGoogle } from "./calendar.ts";
export { GmailApiError, GmailClient } from "./client.ts";
export * from "./pubsub.ts";
export * from "./quota.ts";

export const DEFAULT_PAGE = 100;
/** messages.list caps maxResults at 500. */
export const MAX_PAGE = 500;
/** Above this, send goes through the resumable upload (Google: simple upload is for 5 MB or less). */
export const SIMPLE_UPLOAD_LIMIT = 5 * 1024 * 1024;
/** Gmail's product limit on a message with attachments. */
export const GMAIL_MAX_SEND_BYTES = 25 * 1024 * 1024;
/** Gmail stops watch after 7 days; the renew Job asks for it once a day. */
export const WATCH_LIFETIME_MS = 7 * 86_400_000;

/** Labels that are flags or views rather than places a Message lives. */
const NOT_MAILBOXES = new Set(["UNREAD", "STARRED", "CHAT"]);
const SYSTEM_ROLES: Record<string, MailboxRole | null> = {
  INBOX: "inbox",
  SENT: "sent",
  DRAFT: "drafts",
  TRASH: "trash",
  SPAM: "junk",
  IMPORTANT: "important",
};
const SYSTEM_NAMES: Record<string, string> = {
  INBOX: "Inbox",
  SENT: "Sent",
  DRAFT: "Drafts",
  TRASH: "Trash",
  SPAM: "Spam",
  IMPORTANT: "Important",
  CATEGORY_PERSONAL: "Personal",
  CATEGORY_SOCIAL: "Social",
  CATEGORY_PROMOTIONS: "Promotions",
  CATEGORY_UPDATES: "Updates",
  CATEGORY_FORUMS: "Forums",
};

/** The fields a summary needs; `fields` keeps the response to those. */
const SUMMARY_FIELDS =
  "id,threadId,labelIds,historyId,internalDate,sizeEstimate,snippet,payload(headers,parts(filename,parts(filename,parts(filename))))";

interface GmailLabel {
  id: string;
  name: string;
  type: "system" | "user";
}

interface GmailPayload {
  headers?: { name: string; value: string }[];
  filename?: string;
  parts?: GmailPayload[];
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  historyId?: string;
  internalDate?: string;
  sizeEstimate?: number;
  snippet?: string;
  payload?: GmailPayload;
  raw?: string;
}

interface HistoryMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
}

interface HistoryRecord {
  id: string;
  messages?: HistoryMessage[];
  messagesAdded?: { message: HistoryMessage }[];
  messagesDeleted?: { message: HistoryMessage }[];
  labelsAdded?: { message: HistoryMessage; labelIds: string[] }[];
  labelsRemoved?: { message: HistoryMessage; labelIds: string[] }[];
}

interface GmailState {
  v: 1;
  historyId: string;
  /** Present while the first pass is paging messages.list. */
  pageToken?: string;
}

function decodeState(state: string | null): GmailState | null {
  if (!state) return null;
  try {
    const parsed = JSON.parse(state) as GmailState;
    return parsed.v === 1 && typeof parsed.historyId === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function flagsOfLabels(labelIds: string[]): Flags {
  return {
    seen: !labelIds.includes("UNREAD"),
    flagged: labelIds.includes("STARRED"),
    answered: false,
    draft: labelIds.includes("DRAFT"),
    keywords: [],
  };
}

export function mailboxIdsOfLabels(labelIds: string[]): string[] {
  return labelIds.filter((id) => !NOT_MAILBOXES.has(id));
}

function people(value: string | undefined): Person[] {
  if (!value) return [];
  const out: Person[] = [];
  for (const a of addressParser(value)) {
    if (a.group) {
      for (const m of a.group) out.push({ name: m.name ?? "", email: m.address ?? "" });
    } else {
      out.push({ name: a.name ?? "", email: a.address ?? "" });
    }
  }
  return out.filter((p) => p.email);
}

function hasAttachmentParts(payload: GmailPayload | undefined): boolean {
  if (!payload) return false;
  if (payload.filename) return true;
  return (payload.parts ?? []).some(hasAttachmentParts);
}

export function summaryOfMessage(message: GmailMessage): MessageSummary {
  const all: Record<string, string> = {};
  for (const h of message.payload?.headers ?? []) {
    const name = h.name.toLowerCase();
    if (!(name in all)) all[name] = decodeWords(h.value);
  }
  const labelIds = message.labelIds ?? [];
  const received = new Date(Number(message.internalDate ?? 0) || Date.now());
  const parsedDate = all.date ? new Date(all.date) : received;
  const date = Number.isNaN(parsedDate.getTime()) ? received : parsedDate;
  const from = people(all.from)[0] ?? null;
  return {
    id: message.id,
    threadId: message.threadId,
    mailboxIds: mailboxIdsOfLabels(labelIds),
    flags: flagsOfLabels(labelIds),
    from,
    to: people(all.to),
    cc: people(all.cc),
    subject: all.subject ?? "",
    date: date.toISOString(),
    receivedAt: received.toISOString(),
    messageId: normalizeMessageId(all["message-id"]),
    inReplyTo: normalizeMessageId(all["in-reply-to"]),
    references: parseReferences(all.references),
    headers: pickHeaders(all),
    size: message.sizeEstimate ?? 0,
    hasAttachments: hasAttachmentParts(message.payload),
    preview: message.snippet ? snippetOf(decodeWords(message.snippet)) : null,
  };
}

export function mailboxOfLabel(label: GmailLabel, all: GmailLabel[]): Mailbox {
  if (label.type === "system") {
    return {
      id: label.id,
      name: SYSTEM_NAMES[label.id] ?? label.name,
      role: SYSTEM_ROLES[label.id] ?? null,
      parentId: null,
      totalMessages: null,
      unreadMessages: null,
    };
  }
  const slash = label.name.lastIndexOf("/");
  const parentName = slash > 0 ? label.name.slice(0, slash) : null;
  const parent = parentName ? all.find((l) => l.type === "user" && l.name === parentName) : null;
  return {
    id: label.id,
    name: slash > 0 ? label.name.slice(slash + 1) : label.name,
    role: null,
    parentId: parent?.id ?? null,
    totalMessages: null,
    unreadMessages: null,
  };
}

export interface GmailProviderOptions {
  fetch?: FetchLike;
  /** Defaults to a broker that refreshes through the stored client; tests pass a static one. */
  tokens?: TokenBroker;
  pageSize?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  /** A shared bucket for tests; by default each Session paces its own user. */
  quota?: () => TokenBucket;
  /** The per-user per-minute ceiling the default bucket paces to (the sync.gmail_units_per_minute Setting). */
  unitsPerMinute?: () => Promise<number>;
  simpleUploadLimit?: number;
  /** Pause after a failed Pub/Sub pull. */
  pullRetryMs?: number;
}

export function createGmailProvider(options: GmailProviderOptions = {}): Provider {
  const tokens =
    options.tokens ??
    createTokenBroker({
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
  return {
    kind: "gmail",
    async connect(credentials) {
      if (credentials.auth.kind !== "oauth") {
        throw new ProviderError("Gmail needs OAuth credentials", "auth");
      }
      const topic = credentials.endpoint.kind === "gmail" ? credentials.endpoint.pubsubTopic : null;
      const quota =
        options.quota?.() ??
        (options.unitsPerMinute
          ? gmailQuotaBucket({
              unitsPerMinute: await options.unitsPerMinute(),
              ...(options.now ? { now: options.now } : {}),
              ...(options.sleep ? { sleep: options.sleep } : {}),
            })
          : undefined);
      const client = new GmailClient({
        auth: credentials.auth,
        tokens,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(quota ? { quota } : {}),
        ...(options.sleep ? { sleep: options.sleep } : {}),
        ...(options.now ? { now: options.now } : {}),
        ...(options.random ? { random: options.random } : {}),
      });
      // One cheap call proves the token and the scope before any Job depends on it.
      await client.request("profile", { cost: "getProfile" });
      return new GmailSession(client, credentials.address, topic, options);
    },
  };
}

export function isGmailSession(session: Session): session is GmailSession {
  return session instanceof GmailSession;
}

export class GmailSession implements Session {
  private labelCache: GmailLabel[] | null = null;
  private readonly page: number;
  private readonly loops = new Set<PullLoop>();
  /** The label filter of the last watch, reused by renewals. */
  private watchLabelIds: string[] | null = null;
  private pullSubscription: string | null = null;
  private calendarSession: CalendarSession | null = null;

  constructor(
    readonly client: GmailClient,
    readonly address: string,
    readonly pubsubTopic: string | null,
    private readonly options: GmailProviderOptions,
  ) {
    this.page = Math.min(MAX_PAGE, options.pageSize ?? DEFAULT_PAGE);
  }

  /** Google Calendar over the same client and token (slice 18). */
  calendar(): CalendarSession {
    this.calendarSession ??= createGoogleCalendar(this.client, this.address, {
      ...(this.options.now ? { now: () => new Date(this.options.now?.() ?? Date.now()) } : {}),
      ...(this.options.random ? { random: this.options.random } : {}),
    });
    return this.calendarSession;
  }

  get auth(): OAuthAuth {
    return this.client.auth;
  }

  capabilities(): ProviderCapabilities {
    return {
      push: this.pubsubTopic !== null,
      labels: true,
      snooze: false,
      mute: false,
      calendar: true,
      meetingLink: "meet",
      syncTier: "state",
      threads: true,
      savesSentCopy: true,
      maxSendBytes: GMAIL_MAX_SEND_BYTES,
    };
  }

  private async labels(): Promise<GmailLabel[]> {
    if (this.labelCache) return this.labelCache;
    const result = await this.client.request<{ labels?: GmailLabel[] }>("labels", {
      cost: "labels.list",
    });
    this.labelCache = result.labels ?? [];
    return this.labelCache;
  }

  async listMailboxes(): Promise<Mailbox[]> {
    this.labelCache = null;
    const all = await this.labels();
    return all
      .filter((l) => !NOT_MAILBOXES.has(l.id) && !l.id.startsWith("CATEGORY_"))
      .map((l) => mailboxOfLabel(l, all));
  }

  private async currentHistoryId(): Promise<string> {
    const profile = await this.client.request<{ historyId: string | number }>("profile", {
      cost: "getProfile",
    });
    return String(profile.historyId);
  }

  private async getSummaries(ids: string[]): Promise<Map<string, GmailMessage>> {
    return this.client.batchGet<GmailMessage>(
      ids.map((id) => ({
        id,
        path: `messages/${encodeURIComponent(id)}?format=full&fields=${encodeURIComponent(SUMMARY_FIELDS)}`,
      })),
      GMAIL_COST["messages.get"],
    );
  }

  async *syncMailbox(
    mailboxId: string,
    state: string | null,
    options: SyncOptions = {},
  ): AsyncIterable<SyncEvent> {
    const limit = Math.min(MAX_PAGE, options.limit ?? this.page);
    const stored = decodeState(state);
    if (!stored || stored.pageToken !== undefined) {
      yield* this.fullSync(mailboxId, limit, stored);
      return;
    }
    try {
      yield* this.incrementalSync(mailboxId, stored);
    } catch (error) {
      if (error instanceof GmailApiError && error.status === 404) {
        yield { type: "reset" };
        yield* this.fullSync(mailboxId, limit, null);
        return;
      }
      throw error;
    }
  }

  private async *fullSync(
    mailboxId: string,
    limit: number,
    resume: GmailState | null,
  ): AsyncIterable<SyncEvent> {
    // The cursor is captured before listing so anything that changes while the
    // pages are fetched is replayed by the first incremental pass.
    const historyId = resume?.historyId ?? (await this.currentHistoryId());
    const list = await this.client.request<{
      messages?: { id: string; threadId: string }[];
      nextPageToken?: string;
    }>("messages", {
      cost: "messages.list",
      query: {
        labelIds: mailboxId,
        maxResults: String(limit),
        includeSpamTrash: "true",
        ...(resume?.pageToken ? { pageToken: resume.pageToken } : {}),
      },
    });
    const ids = (list.messages ?? []).map((m) => m.id);
    const found = await this.getSummaries(ids);
    for (const id of ids) {
      const message = found.get(id);
      if (message) yield { type: "added", message: summaryOfMessage(message) };
    }
    const next: GmailState = {
      v: 1,
      historyId,
      ...(list.nextPageToken ? { pageToken: list.nextPageToken } : {}),
    };
    yield { type: "state", state: JSON.stringify(next), complete: !list.nextPageToken };
  }

  private async *incrementalSync(mailboxId: string, stored: GmailState): AsyncIterable<SyncEvent> {
    const touched = new Set<string>();
    const deleted = new Set<string>();
    let historyId = stored.historyId;
    let pageToken: string | undefined;
    for (let guard = 0; guard < 200; guard++) {
      const page = await this.client.request<{
        history?: HistoryRecord[];
        historyId?: string | number;
        nextPageToken?: string;
      }>("history", {
        cost: "history.list",
        query: {
          startHistoryId: stored.historyId,
          labelId: mailboxId,
          maxResults: "500",
          ...(pageToken ? { pageToken } : {}),
        },
      });
      for (const record of page.history ?? []) {
        for (const m of record.messagesAdded ?? []) {
          touched.add(m.message.id);
          deleted.delete(m.message.id);
        }
        for (const m of record.messagesDeleted ?? []) {
          deleted.add(m.message.id);
          touched.delete(m.message.id);
        }
        for (const m of record.labelsAdded ?? []) touched.add(m.message.id);
        for (const m of record.labelsRemoved ?? []) touched.add(m.message.id);
        for (const m of record.messages ?? []) if (!deleted.has(m.id)) touched.add(m.id);
      }
      if (page.historyId !== undefined) historyId = String(page.historyId);
      if (!page.nextPageToken) break;
      pageToken = page.nextPageToken;
    }

    for (const id of deleted) yield { type: "removed", id };
    if (touched.size > 0) {
      const found = await this.getSummaries([...touched]);
      for (const id of touched) {
        const message = found.get(id);
        if (!message) {
          yield { type: "removed", id };
          continue;
        }
        const summary = summaryOfMessage(message);
        if (summary.mailboxIds.includes(mailboxId)) {
          yield { type: "added", message: summary };
        } else {
          yield { type: "changed", id, flags: summary.flags, mailboxIds: summary.mailboxIds };
        }
      }
    }
    const next: GmailState = { v: 1, historyId };
    yield { type: "state", state: JSON.stringify(next), complete: true };
  }

  async fetchMessage(id: string): Promise<RawMessage> {
    const message = await this.client.request<GmailMessage>(`messages/${encodeURIComponent(id)}`, {
      cost: "messages.get",
      query: { format: "raw" },
    });
    if (!message.raw) throw new ProviderError(`message ${id} has no raw body`, "protocol");
    const parsed = await parseMime(decodeBase64url(message.raw));
    return rawMessageOf(id, parsed);
  }

  private async messageIdsOf(target: ChangeTarget): Promise<string[]> {
    if ("messageIds" in target) return target.messageIds;
    const thread = await this.client.request<{ messages?: { id: string }[] }>(
      `threads/${encodeURIComponent(target.threadId)}`,
      { cost: "threads.get", query: { format: "minimal" } },
    );
    return (thread.messages ?? []).map((m) => m.id);
  }

  async applyChange(target: ChangeTarget, change: Change): Promise<void> {
    const ids = await this.messageIdsOf(target);
    if (ids.length === 0) return;
    const add: string[] = [];
    const remove: string[] = [];
    switch (change.kind) {
      case "archive":
        remove.push("INBOX");
        break;
      case "delete":
        add.push("TRASH");
        remove.push("INBOX");
        break;
      case "star":
        (change.value ? add : remove).push("STARRED");
        break;
      case "read":
        (change.value ? remove : add).push("UNREAD");
        break;
      case "move":
        add.push(change.mailboxId);
        if (change.mailboxId !== "INBOX") remove.push("INBOX");
        break;
      case "label":
        add.push(...change.add);
        remove.push(...change.remove);
        break;
    }
    const body = {
      ...(add.length > 0 ? { addLabelIds: add } : {}),
      ...(remove.length > 0 ? { removeLabelIds: remove } : {}),
    };
    if (ids.length === 1) {
      await this.client.request(`messages/${encodeURIComponent(ids[0] ?? "")}/modify`, {
        cost: "messages.modify",
        body,
      });
      return;
    }
    // batchModify takes up to 1000 ids for 50 units, cheaper than 5 each past ten.
    for (let i = 0; i < ids.length; i += 1000) {
      await this.client.request("messages/batchModify", {
        cost: "messages.batchModify",
        body: { ids: ids.slice(i, i + 1000), ...body },
      });
    }
  }

  /** The Gmail threadId of the message this MIME answers, when it is in the mailbox. */
  private async threadIdFor(mime: Uint8Array): Promise<string | null> {
    const head = new TextDecoder().decode(mime.subarray(0, 64 * 1024));
    const headerBlock = head.split(/\r?\n\r?\n/)[0] ?? "";
    const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, " ");
    const inReplyTo = normalizeMessageId(/^in-reply-to:\s*(.+)$/im.exec(unfolded)?.[1]);
    const references = parseReferences(/^references:\s*(.+)$/im.exec(unfolded)?.[1]);
    const candidate = inReplyTo ?? references.at(-1);
    if (!candidate) return null;
    const list = await this.client.request<{ messages?: { id: string; threadId: string }[] }>(
      "messages",
      {
        cost: "messages.list",
        query: { q: `rfc822msgid:${candidate}`, maxResults: "1", includeSpamTrash: "true" },
      },
    );
    return list.messages?.[0]?.threadId ?? null;
  }

  async send(mime: Uint8Array, options: SendOptions = {}): Promise<SendResult> {
    if (mime.byteLength > GMAIL_MAX_SEND_BYTES) {
      throw new ProviderError("message exceeds Gmail's 25 MB limit", "too-large");
    }
    const threadId = await this.threadIdFor(mime);
    const simpleLimit = this.options.simpleUploadLimit ?? SIMPLE_UPLOAD_LIMIT;
    const draftId = options.draftId ?? null;
    const path = draftId ? "drafts/send" : "messages/send";
    const cost = draftId ? GMAIL_COST["drafts.send"] : GMAIL_COST["messages.send"];
    // Both messages.send and drafts.send answer with the sent Message.
    let sent: GmailMessage;
    if (mime.byteLength <= simpleLimit) {
      const raw = base64url(mime);
      const message = { raw, ...(threadId ? { threadId } : {}) };
      sent = await this.client.request<GmailMessage>(path, {
        cost,
        body: draftId ? { id: draftId, message } : message,
      });
    } else {
      const metadata = draftId
        ? { id: draftId, message: threadId ? { threadId } : {} }
        : threadId
          ? { threadId }
          : {};
      sent = await this.client.resumableUpload<GmailMessage>(
        path,
        metadata,
        mime,
        "message/rfc822",
        cost,
      );
    }
    return { messageId: sent.id ?? null };
  }

  /* ------------------------------ Push ------------------------------ */

  /** Calls users.watch; returns when the watch expires (epoch ms). */
  async renewWatch(labelIds?: string[]): Promise<{ historyId: string; expiration: number }> {
    if (!this.pubsubTopic) throw new ProviderError("no Pub/Sub topic configured", "unsupported");
    const filter = labelIds ?? this.watchLabelIds;
    const result = await this.client.request<{
      historyId: string | number;
      expiration: string | number;
    }>("watch", {
      cost: "watch",
      body: {
        topicName: this.pubsubTopic,
        ...(filter && filter.length > 0
          ? { labelIds: filter, labelFilterBehavior: "INCLUDE" }
          : {}),
      },
    });
    return { historyId: String(result.historyId), expiration: Number(result.expiration) };
  }

  async stopWatch(): Promise<void> {
    await this.client.request("stop", { cost: "stop", method: "POST", body: {} });
  }

  /** Creates or updates the push subscription that delivers to the Cloud webhook. */
  async subscribePush(pushEndpoint: string): Promise<string> {
    if (!this.pubsubTopic) throw new ProviderError("no Pub/Sub topic configured", "unsupported");
    return ensurePushSubscription(this.client, this.pubsubTopic, pushEndpoint);
  }

  watch(mailboxIds: string[]): Watch {
    if (!this.pubsubTopic) {
      return { supported: false, events: (async function* () {})(), stop: async () => {} };
    }
    const topic = this.pubsubTopic;
    this.watchLabelIds = mailboxIds;
    const self = this;
    let loop: PullLoop | null = null;
    let stopped = false;
    const events = (async function* () {
      await self.renewWatch(mailboxIds);
      self.pullSubscription ??= await ensurePullSubscription(self.client, topic);
      if (stopped) return;
      loop = pullLoop({
        client: self.client,
        subscription: self.pullSubscription,
        emailAddress: self.address,
        ...(self.options.sleep ? { sleep: self.options.sleep } : {}),
        ...(self.options.pullRetryMs !== undefined ? { retryMs: self.options.pullRetryMs } : {}),
      });
      self.loops.add(loop);
      try {
        yield* loop.events;
      } finally {
        loop.stop();
        self.loops.delete(loop);
      }
    })();
    return {
      supported: true,
      events,
      stop: async () => {
        stopped = true;
        loop?.stop();
      },
    };
  }

  async close(): Promise<void> {
    for (const loop of this.loops) loop.stop();
    this.loops.clear();
  }
}
