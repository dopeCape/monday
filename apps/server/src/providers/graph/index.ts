// The Microsoft Graph adapter (research, "Microsoft 365 and Outlook.com").
// Folders are the mailboxes; a sync state is the folder's delta link, or the
// next link while the first pass pages. Incremental sync follows the delta
// link, restarts on 410 Gone or a lost sync state, and treats every non-removed
// item as "added" (the engine already knows which ids it has). Bodies come
// from /$value as MIME. Sends under Graph's 4 MB write limit go through
// sendMail with a base64 MIME body; larger ones become a draft (a reply draft
// when the message answers something in the mailbox) plus attachments through
// upload sessions, then /send. Push in this process is a short delta poll of
// the hot folders; a Cloud server holds a change notification subscription
// instead (subscriptions.ts, registered by the push Jobs).

import type { Person } from "@monday/shared";
import type { Address } from "postal-mime";
import type { FetchLike } from "../jmap/client.ts";
import { parseMime, peopleOf, pickHeaders, rawMessageOf, snippetOf } from "../mime.ts";
import { base64 } from "../oauth/pkce.ts";
import { createTokenBroker, type TokenBroker } from "../oauth/tokens.ts";
import { asyncQueue } from "../queue.ts";
import {
  type CalendarSession,
  type Change,
  type ChangeTarget,
  type DraftResult,
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
  type WatchEvent,
} from "../types.ts";
import { createGraphCalendar } from "./calendar.ts";
import { GRAPH_BASE, GraphApiError, GraphClient } from "./client.ts";

export { GraphApiError, GraphClient } from "./client.ts";
export * from "./subscriptions.ts";

export const DEFAULT_PAGE = 100;
/** Graph write requests fail with 413 above 4 MB; base64 grows MIME by a third. */
export const SENDMAIL_MIME_LIMIT = 3 * 1024 * 1024;
/** Attachments up to this size go in one POST; larger ones through an upload session. */
export const SMALL_ATTACHMENT_LIMIT = 3 * 1024 * 1024;
/** Upload session ranges must stay under 4 MB. */
export const UPLOAD_RANGE = 10 * 320 * 1024;
/** Exchange Online's default send limit. */
export const GRAPH_MAX_SEND_BYTES = 35 * 1024 * 1024;
/** How often the poll fallback checks the hot folders. */
export const DEFAULT_POLL_MS = 90_000;

const WELL_KNOWN: Record<string, MailboxRole> = {
  inbox: "inbox",
  drafts: "drafts",
  sentitems: "sent",
  deleteditems: "trash",
  junkemail: "junk",
  archive: "archive",
};

const SELECT = [
  "id",
  "conversationId",
  "parentFolderId",
  "isRead",
  "isDraft",
  "flag",
  "from",
  "toRecipients",
  "ccRecipients",
  "subject",
  "sentDateTime",
  "receivedDateTime",
  "internetMessageId",
  "hasAttachments",
  "bodyPreview",
  "internetMessageHeaders",
].join(",");

interface Recipient {
  emailAddress: { name?: string; address?: string };
}

export interface GraphMessage {
  id: string;
  conversationId?: string;
  parentFolderId?: string;
  isRead?: boolean;
  isDraft?: boolean;
  flag?: { flagStatus?: string };
  from?: Recipient;
  toRecipients?: Recipient[];
  ccRecipients?: Recipient[];
  subject?: string;
  sentDateTime?: string;
  receivedDateTime?: string;
  internetMessageId?: string;
  hasAttachments?: boolean;
  bodyPreview?: string;
  internetMessageHeaders?: { name: string; value: string }[];
  "@removed"?: { reason: string };
}

interface GraphFolder {
  id: string;
  displayName: string;
  parentFolderId?: string | null;
  totalItemCount?: number;
  unreadItemCount?: number;
  "@removed"?: { reason: string };
}

interface DeltaPage<T> {
  value: T[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

interface GraphState {
  v: 1;
  link: string;
  kind: "next" | "delta";
}

function decodeState(state: string | null): GraphState | null {
  if (!state) return null;
  try {
    const parsed = JSON.parse(state) as GraphState;
    return parsed.v === 1 && typeof parsed.link === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function person(r: Recipient | undefined): Person | null {
  const address = r?.emailAddress?.address;
  if (!address) return null;
  return { name: r?.emailAddress?.name ?? "", email: address };
}

function people(list: Recipient[] | undefined): Person[] {
  return (list ?? []).map(person).filter((p): p is Person => p !== null);
}

export function flagsOfMessage(m: GraphMessage): Flags {
  return {
    seen: m.isRead === true,
    flagged: m.flag?.flagStatus === "flagged",
    answered: false,
    draft: m.isDraft === true,
    keywords: [],
  };
}

export function summaryOfMessage(m: GraphMessage): MessageSummary {
  const all: Record<string, string> = {};
  for (const h of m.internetMessageHeaders ?? []) {
    const name = h.name.toLowerCase();
    if (!(name in all)) all[name] = h.value;
  }
  const messageId = normalizeMessageId(m.internetMessageId ?? all["message-id"]);
  const received = m.receivedDateTime ?? m.sentDateTime ?? new Date(0).toISOString();
  return {
    id: m.id,
    threadId: m.conversationId ?? null,
    mailboxIds: m.parentFolderId ? [m.parentFolderId] : [],
    flags: flagsOfMessage(m),
    from: person(m.from),
    to: people(m.toRecipients),
    cc: people(m.ccRecipients),
    subject: m.subject ?? "",
    date: m.sentDateTime ?? received,
    receivedAt: received,
    messageId,
    inReplyTo: normalizeMessageId(all["in-reply-to"]),
    references: parseReferences(all.references),
    headers: pickHeaders({ ...all, ...(messageId ? { "message-id": `<${messageId}>` } : {}) }),
    size: 0,
    hasAttachments: m.hasAttachments === true,
    preview: m.bodyPreview ? snippetOf(m.bodyPreview) : null,
  };
}

function isStaleDelta(error: unknown): boolean {
  if (!(error instanceof GraphApiError)) return false;
  if (error.status === 410) return true;
  return /syncstatenotfound|syncstateinvalid|resyncrequired/i.test(error.odataCode);
}

export interface GraphProviderOptions {
  fetch?: FetchLike;
  tokens?: TokenBroker;
  pageSize?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** The poll interval for the watch fallback; a function so a Setting can drive it. */
  pollMs?: number | (() => number | Promise<number>);
  concurrency?: number;
}

export function createGraphProvider(options: GraphProviderOptions = {}): Provider {
  const tokens =
    options.tokens ??
    createTokenBroker({
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
  return {
    kind: "graph",
    async connect(credentials) {
      if (credentials.auth.kind !== "oauth") {
        throw new ProviderError("Microsoft Graph needs OAuth credentials", "auth");
      }
      const client = new GraphClient({
        auth: credentials.auth,
        tokens,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.sleep ? { sleep: options.sleep } : {}),
        ...(options.concurrency ? { concurrency: options.concurrency } : {}),
      });
      await client.request("me", { query: { $select: "id" } });
      return new GraphSession(client, credentials.address, options);
    },
  };
}

export function isGraphSession(session: Session): session is GraphSession {
  return session instanceof GraphSession;
}

export class GraphSession implements Session {
  private roleIds: Map<string, string> | null = null;
  private readonly page: number;
  private readonly watches = new Set<{ stop(): void }>();
  private calendarSession: CalendarSession | null = null;

  constructor(
    readonly client: GraphClient,
    readonly address: string,
    private readonly options: GraphProviderOptions,
  ) {
    this.page = options.pageSize ?? DEFAULT_PAGE;
  }

  /** Graph calendars over the same client and token (slice 18). */
  calendar(): CalendarSession {
    this.calendarSession ??= createGraphCalendar(this.client, this.address, {
      ...(this.options.now ? { now: () => new Date(this.options.now?.() ?? Date.now()) } : {}),
    });
    return this.calendarSession;
  }

  get auth(): OAuthAuth {
    return this.client.auth;
  }

  capabilities(): ProviderCapabilities {
    return {
      push: true,
      labels: false,
      snooze: false,
      mute: false,
      calendar: true,
      meetingLink: "teams",
      syncTier: "state",
      threads: true,
      savesSentCopy: true,
      maxSendBytes: GRAPH_MAX_SEND_BYTES,
    };
  }

  /** Well-known folder name to id, resolved once. */
  private async roles(): Promise<Map<string, string>> {
    if (this.roleIds) return this.roleIds;
    const map = new Map<string, string>();
    await Promise.all(
      Object.keys(WELL_KNOWN).map(async (name) => {
        try {
          const folder = await this.client.request<{ id: string }>(`me/mailFolders/${name}`, {
            query: { $select: "id" },
          });
          map.set(name, folder.id);
        } catch (error) {
          if ((error as ProviderError).code !== "not-found") throw error;
        }
      }),
    );
    this.roleIds = map;
    return map;
  }

  private async roleFolder(role: MailboxRole): Promise<string | null> {
    const name = Object.entries(WELL_KNOWN).find(([, r]) => r === role)?.[0];
    if (!name) return null;
    return (await this.roles()).get(name) ?? null;
  }

  async listMailboxes(): Promise<Mailbox[]> {
    this.roleIds = null;
    const roles = await this.roles();
    const roleOf = new Map<string, MailboxRole>();
    for (const [name, id] of roles) roleOf.set(id, WELL_KNOWN[name] as MailboxRole);
    const folders: GraphFolder[] = [];
    let url: string | null = "me/mailFolders/delta";
    let query: Record<string, string> | undefined = {
      $select: "id,displayName,parentFolderId,totalItemCount,unreadItemCount",
    };
    while (url) {
      const page: DeltaPage<GraphFolder> = await this.client.request<DeltaPage<GraphFolder>>(url, {
        ...(query ? { query } : {}),
      });
      query = undefined;
      folders.push(...page.value.filter((f) => !f["@removed"]));
      url = page["@odata.nextLink"] ?? null;
    }
    const ids = new Set(folders.map((f) => f.id));
    return folders.map((f) => ({
      id: f.id,
      name: f.displayName,
      role: roleOf.get(f.id) ?? null,
      parentId: f.parentFolderId && ids.has(f.parentFolderId) ? f.parentFolderId : null,
      totalMessages: f.totalItemCount ?? null,
      unreadMessages: f.unreadItemCount ?? null,
    }));
  }

  async *syncMailbox(
    mailboxId: string,
    state: string | null,
    options: SyncOptions = {},
  ): AsyncIterable<SyncEvent> {
    const limit = options.limit ?? this.page;
    const stored = decodeState(state);
    const start = `me/mailFolders/${encodeURIComponent(mailboxId)}/messages/delta`;
    let page: DeltaPage<GraphMessage>;
    try {
      page = await this.client.request<DeltaPage<GraphMessage>>(stored ? stored.link : start, {
        ...(stored ? {} : { query: { $select: SELECT } }),
        headers: { prefer: `odata.maxpagesize=${limit}` },
      });
    } catch (error) {
      if (!stored || !isStaleDelta(error)) throw error;
      yield { type: "reset" };
      page = await this.client.request<DeltaPage<GraphMessage>>(start, {
        query: { $select: SELECT },
        headers: { prefer: `odata.maxpagesize=${limit}` },
      });
    }
    for (const m of page.value) {
      if (m["@removed"]) {
        yield { type: "removed", id: m.id };
        continue;
      }
      const summary = summaryOfMessage(m);
      if (summary.mailboxIds.length > 0 && !summary.mailboxIds.includes(mailboxId)) {
        // Replayed after a move: it now lives elsewhere.
        yield { type: "changed", id: m.id, flags: summary.flags, mailboxIds: summary.mailboxIds };
        continue;
      }
      yield { type: "added", message: { ...summary, mailboxIds: [mailboxId] } };
    }
    const next = page["@odata.nextLink"];
    const delta = page["@odata.deltaLink"];
    const link = next ?? delta;
    if (!link)
      throw new ProviderError("delta page carries neither nextLink nor deltaLink", "protocol");
    const nextState: GraphState = { v: 1, link, kind: next ? "next" : "delta" };
    yield { type: "state", state: JSON.stringify(nextState), complete: !next };
  }

  async fetchMessage(id: string): Promise<RawMessage> {
    const response = await this.client.raw(
      `${GRAPH_BASE}/me/messages/${encodeURIComponent(id)}/$value`,
      { headers: { accept: "*/*" } },
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    return rawMessageOf(id, await parseMime(bytes));
  }

  private async messageIdsOf(target: ChangeTarget): Promise<string[]> {
    if ("messageIds" in target) return target.messageIds;
    const result = await this.client.request<{ value: { id: string }[] }>("me/messages", {
      query: {
        $filter: `conversationId eq '${target.threadId.replace(/'/g, "''")}'`,
        $select: "id",
        $top: "500",
      },
    });
    return result.value.map((m) => m.id);
  }

  async applyChange(target: ChangeTarget, change: Change): Promise<void> {
    const ids = await this.messageIdsOf(target);
    if (ids.length === 0) return;
    let destination: string | null = null;
    if (change.kind === "archive") destination = await this.roleFolder("archive");
    else if (change.kind === "delete") destination = await this.roleFolder("trash");
    else if (change.kind === "move") destination = change.mailboxId;
    else if (change.kind === "label") destination = change.add[0] ?? null;
    if (
      (change.kind === "archive" || change.kind === "delete" || change.kind === "label") &&
      !destination
    ) {
      if (change.kind === "label") return;
      throw new ProviderError(
        `no ${change.kind === "archive" ? "Archive" : "Deleted Items"} folder`,
        "unsupported",
      );
    }
    await Promise.all(
      ids.map(async (id) => {
        const path = `me/messages/${encodeURIComponent(id)}`;
        if (change.kind === "read") {
          await this.client.request(path, { method: "PATCH", body: { isRead: change.value } });
        } else if (change.kind === "star") {
          await this.client.request(path, {
            method: "PATCH",
            body: { flag: { flagStatus: change.value ? "flagged" : "notFlagged" } },
          });
        } else if (destination) {
          await this.client.request(`${path}/move`, { body: { destinationId: destination } });
        }
      }),
    );
  }

  /* ------------------------------ Send ------------------------------ */

  async send(mime: Uint8Array, options: SendOptions = {}): Promise<SendResult> {
    if (mime.byteLength > GRAPH_MAX_SEND_BYTES) {
      throw new ProviderError("message exceeds the mailbox send limit", "too-large");
    }
    if (mime.byteLength <= SENDMAIL_MIME_LIMIT) {
      await this.client.request("me/sendMail", {
        method: "POST",
        rawBody: base64(mime),
        headers: { "content-type": "text/plain" },
      });
      if (options.draftId) {
        await this.client
          .request(`me/messages/${encodeURIComponent(options.draftId)}`, { method: "DELETE" })
          .catch(() => {});
      }
      return { messageId: null };
    }
    return this.sendLarge(mime, options);
  }

  /** Draft plus upload sessions plus /send, for messages over the write limit. */
  private async sendLarge(mime: Uint8Array, options: SendOptions): Promise<SendResult> {
    const draftId = await this.draftOf(mime);
    await this.client.request(`me/messages/${encodeURIComponent(draftId)}/send`, {
      method: "POST",
      body: {},
    });
    if (options.draftId && options.draftId !== draftId) {
      await this.client
        .request(`me/messages/${encodeURIComponent(options.draftId)}`, { method: "DELETE" })
        .catch(() => {});
    }
    return { messageId: draftId };
  }

  /**
   * Mirrors a Server Draft into Drafts: the MIME posted as-is (Graph files a
   * MIME POST to me/messages as a draft), or over the write limit a draft
   * built from its parts with upload sessions for the attachments. Graph
   * cannot replace a message's MIME, so an update is a new draft and the
   * previous one removed.
   */
  async putDraft(mime: Uint8Array, previousId: string | null): Promise<DraftResult> {
    if (mime.byteLength > GRAPH_MAX_SEND_BYTES) {
      throw new ProviderError("draft exceeds the mailbox send limit", "too-large");
    }
    let id: string;
    if (mime.byteLength <= SENDMAIL_MIME_LIMIT) {
      const created = await this.client.request<{ id?: string }>("me/messages", {
        method: "POST",
        rawBody: base64(mime),
        headers: { "content-type": "text/plain" },
      });
      if (!created?.id) throw new ProviderError("me/messages returned no id", "protocol");
      id = created.id;
    } else {
      id = await this.draftOf(mime);
    }
    if (previousId && previousId !== id) await this.deleteDraft(previousId);
    return { id };
  }

  /** Removes a mirrored draft; one already gone (404) is not an error. */
  async deleteDraft(id: string): Promise<void> {
    try {
      await this.client.request(`me/messages/${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch (error) {
      if (error instanceof ProviderError && error.code === "not-found") return;
      throw error;
    }
  }

  /** A draft built from the MIME's parts: createReply for a reply, attachments by upload session. */
  private async draftOf(mime: Uint8Array): Promise<string> {
    const parsed = await parseMime(mime);
    const flatten = (list: Address[] | undefined) =>
      peopleOf(list).map((p) => ({ emailAddress: { name: p.name, address: p.email } }));
    const draftBody = {
      subject: parsed.subject ?? "",
      body: parsed.html
        ? { contentType: "html", content: parsed.html }
        : { contentType: "text", content: parsed.text ?? "" },
      toRecipients: flatten(parsed.to),
      ccRecipients: flatten(parsed.cc),
      bccRecipients: flatten(parsed.bcc),
    };
    // A reply to something in the mailbox: createReply keeps the thread headers.
    const inReplyTo = normalizeMessageId(parsed.inReplyTo);
    let draftId: string | null = null;
    if (inReplyTo) {
      const found = await this.client.request<{ value: { id: string }[] }>("me/messages", {
        query: {
          $filter: `internetMessageId eq '${`<${inReplyTo}>`.replace(/'/g, "''")}'`,
          $select: "id",
          $top: "1",
        },
      });
      const original = found.value[0]?.id;
      if (original) {
        const reply = await this.client.request<{ id: string }>(
          `me/messages/${encodeURIComponent(original)}/createReply`,
          { method: "POST", body: {} },
        );
        draftId = reply.id;
        await this.client.request(`me/messages/${encodeURIComponent(draftId)}`, {
          method: "PATCH",
          body: draftBody,
        });
      }
    }
    if (!draftId) {
      const created = await this.client.request<{ id: string }>("me/messages", { body: draftBody });
      draftId = created.id;
    }
    for (const attachment of parsed.attachments) {
      const bytes =
        typeof attachment.content === "string"
          ? new TextEncoder().encode(attachment.content)
          : new Uint8Array(attachment.content);
      const name = attachment.filename ?? "attachment";
      const contentType = attachment.mimeType || "application/octet-stream";
      const inline = attachment.disposition === "inline";
      const contentId = normalizeMessageId(attachment.contentId);
      if (bytes.byteLength <= SMALL_ATTACHMENT_LIMIT) {
        await this.client.request(`me/messages/${encodeURIComponent(draftId)}/attachments`, {
          body: {
            "@odata.type": "#microsoft.graph.fileAttachment",
            name,
            contentType,
            contentBytes: base64(bytes),
            isInline: inline,
            ...(contentId ? { contentId } : {}),
          },
        });
        continue;
      }
      const session = await this.client.request<{ uploadUrl: string }>(
        `me/messages/${encodeURIComponent(draftId)}/attachments/createUploadSession`,
        {
          body: {
            AttachmentItem: {
              attachmentType: "file",
              name,
              size: bytes.byteLength,
              contentType,
              isInline: inline,
              ...(contentId ? { contentId } : {}),
            },
          },
        },
      );
      for (let offset = 0; offset < bytes.byteLength; offset += UPLOAD_RANGE) {
        const end = Math.min(offset + UPLOAD_RANGE, bytes.byteLength);
        const chunk = bytes.subarray(offset, end);
        // Upload URLs are pre-authenticated; Graph rejects an Authorization header here.
        const response = await this.client.fetch(session.uploadUrl, {
          method: "PUT",
          headers: {
            "content-type": "application/octet-stream",
            "content-length": String(chunk.byteLength),
            "content-range": `bytes ${offset}-${end - 1}/${bytes.byteLength}`,
          },
          body: chunk,
        });
        if (!response.ok) {
          throw new ProviderError(`attachment upload failed with ${response.status}`, "protocol");
        }
      }
    }
    return draftId;
  }

  /* ------------------------------ Watch (poll fallback) ------------------------------ */

  watch(mailboxIds: string[]): Watch {
    const queue = asyncQueue<WatchEvent>();
    const sleep = this.options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const pollMs = this.options.pollMs ?? DEFAULT_POLL_MS;
    let stopped = false;
    const handle = {
      stop: () => {
        stopped = true;
        queue.close();
      },
    };
    this.watches.add(handle);
    (async () => {
      queue.push({ type: "connected" });
      while (!stopped) {
        const ms = typeof pollMs === "function" ? await pollMs() : pollMs;
        await sleep(ms);
        if (stopped) break;
        queue.push({ type: "changed", mailboxIds });
      }
      queue.close();
    })();
    return {
      supported: true,
      events: queue,
      stop: async () => {
        handle.stop();
        this.watches.delete(handle);
      },
    };
  }

  async close(): Promise<void> {
    for (const w of this.watches) w.stop();
    this.watches.clear();
  }
}
