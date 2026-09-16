// The JMAP adapter (RFC 8620, RFC 8621): Fastmail first, generic servers
// second. Sync is state strings per mailbox: Email/query plus Email/get for the
// first pass, Email/queryChanges plus Email/changes after that, a full refetch
// on cannotCalculateChanges or tooManyChanges. Push is the EventSource pump.
// Auth: a bearer API token (Fastmail) or basic (generic).

import type { Person } from "@monday/shared";
import { SUMMARY_HEADERS, snippetOf, textFromHtml } from "../mime.ts";
import {
  type Change,
  type ChangeTarget,
  type DraftResult,
  type Flags,
  type Mailbox,
  type MailboxRole,
  type MessageSummary,
  normalizeMessageId,
  type Provider,
  type ProviderCapabilities,
  ProviderError,
  type RawAttachment,
  type RawMessage,
  type SendOptions,
  type SendResult,
  type Session,
  type SyncEvent,
  type SyncOptions,
  type Watch,
  type WatchEvent,
} from "../types.ts";
import {
  basic,
  bearer,
  type JmapClient as Client,
  CORE,
  type FetchLike,
  JmapClient,
  JmapMethodError,
  MAIL,
  type MethodCall,
  SUBMISSION,
} from "./client.ts";
import { eventSourcePump, type StateChange, streamOfResponse } from "./eventsource.ts";

export { JmapClient, JmapMethodError } from "./client.ts";

/** Push types the watch subscribes to (research, "JMAP: Detecting new mail"). */
export const PUSH_TYPES = ["Email", "EmailDelivery", "Mailbox", "Thread"];
export const PING_SECONDS = 30;
export const DEFAULT_PAGE = 200;
const MAX_CHANGES = 500;

interface JmapMailbox {
  id: string;
  name: string;
  parentId: string | null;
  role: string | null;
  totalEmails: number;
  unreadEmails: number;
}

interface EmailAddress {
  name: string | null;
  email: string;
}

interface JmapEmail {
  id: string;
  blobId: string;
  threadId: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  size: number;
  receivedAt: string;
  messageId: string[] | null;
  inReplyTo: string[] | null;
  references: string[] | null;
  from: EmailAddress[] | null;
  to: EmailAddress[] | null;
  cc: EmailAddress[] | null;
  subject: string | null;
  sentAt: string | null;
  hasAttachment: boolean;
  preview: string;
  [header: `header:${string}`]: string | null;
}

interface JmapBodyPart {
  partId: string | null;
  blobId: string | null;
  size: number;
  name: string | null;
  type: string;
  charset: string | null;
  disposition: string | null;
  cid: string | null;
  subParts?: JmapBodyPart[] | null;
}

interface JmapEmailBody {
  id: string;
  bodyStructure: JmapBodyPart;
  bodyValues: Record<string, { value: string; isTruncated: boolean }>;
  textBody: JmapBodyPart[];
  htmlBody: JmapBodyPart[];
  attachments: JmapBodyPart[];
  [header: `header:${string}`]: string | null;
}

interface MailboxState {
  v: 1;
  emailState: string;
  queryState: string;
  /** Present while the first pass is paging. */
  position?: number;
}

const SUMMARY_PROPERTIES = [
  "id",
  "blobId",
  "threadId",
  "mailboxIds",
  "keywords",
  "size",
  "receivedAt",
  "messageId",
  "inReplyTo",
  "references",
  "from",
  "to",
  "cc",
  "subject",
  "sentAt",
  "hasAttachment",
  "preview",
  ...SUMMARY_HEADERS.filter((h) => !["message-id", "in-reply-to", "references"].includes(h)).map(
    (h) => `header:${h}:asText`,
  ),
];

const ROLES: Record<string, MailboxRole> = {
  inbox: "inbox",
  archive: "archive",
  drafts: "drafts",
  sent: "sent",
  trash: "trash",
  junk: "junk",
  all: "all",
  important: "important",
  flagged: "flagged",
  subscribed: "subscribed",
};

export function flagsOfKeywords(keywords: Record<string, boolean>): Flags {
  const custom: string[] = [];
  for (const key of Object.keys(keywords)) {
    if (!keywords[key]) continue;
    if (!["$seen", "$flagged", "$answered", "$draft"].includes(key)) custom.push(key);
  }
  return {
    seen: keywords.$seen === true,
    flagged: keywords.$flagged === true,
    answered: keywords.$answered === true,
    draft: keywords.$draft === true,
    keywords: custom,
  };
}

function person(a: EmailAddress): Person {
  return { name: a.name ?? "", email: a.email };
}

function decodeState(state: string | null): MailboxState | null {
  if (!state) return null;
  try {
    const parsed = JSON.parse(state) as MailboxState;
    return parsed.v === 1 && parsed.emailState && parsed.queryState ? parsed : null;
  } catch {
    return null;
  }
}

export function summaryOfEmail(email: JmapEmail): MessageSummary {
  const headers: Record<string, string> = {};
  for (const name of SUMMARY_HEADERS) {
    const value = email[`header:${name}:asText`];
    if (typeof value === "string" && value.length > 0) headers[name] = value.trim();
  }
  const messageId = normalizeMessageId(email.messageId?.[0]);
  const inReplyTo = normalizeMessageId(email.inReplyTo?.[0]);
  const references = (email.references ?? [])
    .map((r) => normalizeMessageId(r))
    .filter((r): r is string => r !== null);
  if (messageId) headers["message-id"] = `<${messageId}>`;
  if (inReplyTo) headers["in-reply-to"] = `<${inReplyTo}>`;
  if (references.length > 0) headers.references = references.map((r) => `<${r}>`).join(" ");
  const from = email.from?.[0];
  return {
    id: email.id,
    threadId: email.threadId,
    mailboxIds: Object.keys(email.mailboxIds).filter((id) => email.mailboxIds[id]),
    flags: flagsOfKeywords(email.keywords),
    from: from ? person(from) : null,
    to: (email.to ?? []).map(person),
    cc: (email.cc ?? []).map(person),
    subject: email.subject ?? "",
    date: email.sentAt ?? email.receivedAt,
    receivedAt: email.receivedAt,
    messageId,
    inReplyTo,
    references,
    headers,
    size: email.size,
    hasAttachments: email.hasAttachment,
    preview: email.preview ? snippetOf(email.preview) : null,
  };
}

export interface JmapProviderOptions {
  fetch?: FetchLike;
  pageSize?: number;
  /** Silence before the push stream is considered dead. Fastmail pings every 30 s. */
  pushIdleMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export function createJmapProvider(options: JmapProviderOptions = {}): Provider {
  return {
    kind: "jmap",
    async connect(credentials) {
      if (credentials.endpoint.kind !== "jmap") {
        throw new ProviderError("JMAP needs a session URL", "unsupported");
      }
      const auth =
        credentials.auth.kind === "token"
          ? bearer(credentials.auth.token)
          : credentials.auth.kind === "password"
            ? basic(credentials.auth.user, credentials.auth.password)
            : bearer(credentials.auth.accessToken);
      const client = new JmapClient(credentials.endpoint.sessionUrl, auth, {
        ...(options.fetch ? { fetch: options.fetch } : {}),
        headers: { "User-Agent": "monday" },
      });
      await client.connect();
      return new JmapSession(client, credentials.address, options);
    },
  };
}

class JmapSession implements Session {
  private readonly accountId: string;
  private readonly page: number;
  private mailboxCache: JmapMailbox[] | null = null;
  private watches = new Set<{ stop(): void }>();

  constructor(
    private readonly client: Client,
    private readonly address: string,
    private readonly options: JmapProviderOptions,
  ) {
    this.accountId = client.mailAccountId();
    this.page = options.pageSize ?? DEFAULT_PAGE;
  }

  capabilities(): ProviderCapabilities {
    const limits = this.client.limits();
    return {
      push: Boolean(this.client.requireSession().eventSourceUrl),
      labels: true,
      snooze: false,
      mute: false,
      calendar: false,
      meetingLink: null,
      syncTier: "state",
      threads: true,
      savesSentCopy: true,
      maxSendBytes: limits.maxSizeUpload,
    };
  }

  private async mailboxes(): Promise<JmapMailbox[]> {
    if (this.mailboxCache) return this.mailboxCache;
    const result = await this.client.call<{ list: JmapMailbox[] }>("Mailbox/get", {
      accountId: this.accountId,
      ids: null,
      properties: ["id", "name", "parentId", "role", "totalEmails", "unreadEmails"],
    });
    this.mailboxCache = result.list;
    return result.list;
  }

  private async mailboxWithRole(role: string): Promise<string | null> {
    const found = (await this.mailboxes()).find((m) => m.role === role);
    return found?.id ?? null;
  }

  async listMailboxes(): Promise<Mailbox[]> {
    this.mailboxCache = null;
    return (await this.mailboxes()).map((m) => ({
      id: m.id,
      name: m.name,
      role: m.role ? (ROLES[m.role] ?? null) : null,
      parentId: m.parentId,
      totalMessages: m.totalEmails,
      unreadMessages: m.unreadEmails,
    }));
  }

  private async getEmails(ids: string[], properties: string[]): Promise<JmapEmail[]> {
    const out: JmapEmail[] = [];
    const chunk = this.client.limits().maxObjectsInGet;
    for (let i = 0; i < ids.length; i += chunk) {
      const result = await this.client.call<{ list: JmapEmail[] }>("Email/get", {
        accountId: this.accountId,
        ids: ids.slice(i, i + chunk),
        properties,
      });
      out.push(...result.list);
    }
    return out;
  }

  async *syncMailbox(
    mailboxId: string,
    state: string | null,
    options: SyncOptions = {},
  ): AsyncIterable<SyncEvent> {
    const limit = options.limit ?? this.page;
    const stored = decodeState(state);
    if (!stored) {
      yield* this.fullSync(mailboxId, limit, null);
      return;
    }
    if (stored.position !== undefined) {
      // The first pass is still paging; continue it under the same states.
      yield* this.fullSync(mailboxId, limit, stored);
      return;
    }
    try {
      yield* this.incrementalSync(mailboxId, stored);
    } catch (error) {
      if (
        error instanceof JmapMethodError &&
        (error.type === "cannotCalculateChanges" || error.type === "tooManyChanges")
      ) {
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
    resume: MailboxState | null,
  ): AsyncIterable<SyncEvent> {
    const position = resume?.position ?? 0;
    const queryId = this.client.nextId();
    const getId = this.client.nextId();
    const calls: MethodCall[] = [
      [
        "Email/query",
        {
          accountId: this.accountId,
          filter: { inMailbox: mailboxId },
          sort: [{ property: "receivedAt", isAscending: false }],
          position,
          limit,
          calculateTotal: true,
        },
        queryId,
      ],
      [
        "Email/get",
        {
          accountId: this.accountId,
          "#ids": { resultOf: queryId, name: "Email/query", path: "/ids" },
          properties: SUMMARY_PROPERTIES,
        },
        getId,
      ],
    ];
    const results = await this.client.batch(calls);
    const query = results.get(queryId) as { ids: string[]; queryState: string; total?: number };
    const got = results.get(getId) as { list: JmapEmail[]; state: string };
    for (const email of got.list) yield { type: "added", message: summaryOfEmail(email) };
    const more =
      query.ids.length >= limit &&
      (query.total === undefined || position + query.ids.length < query.total);
    const next: MailboxState = {
      v: 1,
      // States are captured on the first page; changes during paging are
      // picked up by the first incremental pass. Duplicates are idempotent.
      emailState: resume?.emailState ?? got.state,
      queryState: resume?.queryState ?? query.queryState,
      ...(more ? { position: position + query.ids.length } : {}),
    };
    yield { type: "state", state: JSON.stringify(next), complete: !more };
  }

  private async *incrementalSync(
    mailboxId: string,
    stored: MailboxState,
  ): AsyncIterable<SyncEvent> {
    const added = new Set<string>();
    const removed = new Set<string>();
    let queryState = stored.queryState;
    for (let guard = 0; guard < 50; guard++) {
      const result = await this.client.call<{
        newQueryState: string;
        added: { id: string; index: number }[];
        removed: string[];
      }>("Email/queryChanges", {
        accountId: this.accountId,
        filter: { inMailbox: mailboxId },
        sort: [{ property: "receivedAt", isAscending: false }],
        sinceQueryState: queryState,
        maxChanges: MAX_CHANGES,
      });
      for (const r of result.removed) {
        removed.add(r);
        added.delete(r);
      }
      for (const a of result.added) {
        added.add(a.id);
        removed.delete(a.id);
      }
      if (result.newQueryState === queryState) break;
      queryState = result.newQueryState;
      if (result.added.length + result.removed.length < MAX_CHANGES) break;
    }

    const updated = new Set<string>();
    const destroyed = new Set<string>();
    let emailState = stored.emailState;
    for (let guard = 0; guard < 50; guard++) {
      const result = await this.client.call<{
        newState: string;
        hasMoreChanges: boolean;
        created: string[];
        updated: string[];
        destroyed: string[];
      }>("Email/changes", {
        accountId: this.accountId,
        sinceState: emailState,
        maxChanges: MAX_CHANGES,
      });
      for (const id of result.updated) updated.add(id);
      for (const id of result.destroyed) {
        destroyed.add(id);
        updated.delete(id);
      }
      emailState = result.newState;
      if (!result.hasMoreChanges) break;
    }

    // Removed from this mailbox's query: gone entirely, or moved elsewhere.
    for (const id of destroyed) if (removed.has(id)) yield { type: "removed", id };
    const stillExist = [...removed].filter((id) => !destroyed.has(id));
    if (stillExist.length > 0) {
      const found = new Set<string>();
      for (const email of await this.getEmails(stillExist, ["id", "keywords", "mailboxIds"])) {
        found.add(email.id);
        yield {
          type: "changed",
          id: email.id,
          flags: flagsOfKeywords(email.keywords),
          mailboxIds: Object.keys(email.mailboxIds).filter((m) => email.mailboxIds[m]),
        };
      }
      for (const id of stillExist) if (!found.has(id)) yield { type: "removed", id };
    }

    if (added.size > 0) {
      for (const email of await this.getEmails([...added], SUMMARY_PROPERTIES)) {
        yield { type: "added", message: summaryOfEmail(email) };
      }
    }

    const onlyUpdated = [...updated].filter((id) => !added.has(id) && !removed.has(id));
    if (onlyUpdated.length > 0) {
      for (const email of await this.getEmails(onlyUpdated, ["id", "keywords", "mailboxIds"])) {
        const mailboxIds = Object.keys(email.mailboxIds).filter((m) => email.mailboxIds[m]);
        if (!mailboxIds.includes(mailboxId)) continue;
        yield { type: "changed", id: email.id, flags: flagsOfKeywords(email.keywords), mailboxIds };
      }
    }

    const next: MailboxState = { v: 1, emailState, queryState };
    yield { type: "state", state: JSON.stringify(next), complete: true };
  }

  async fetchMessage(id: string): Promise<RawMessage> {
    const result = await this.client.call<{ list: JmapEmailBody[]; notFound: string[] }>(
      "Email/get",
      {
        accountId: this.accountId,
        ids: [id],
        properties: [
          "id",
          "bodyStructure",
          "bodyValues",
          "textBody",
          "htmlBody",
          "attachments",
          "header:*:asText",
        ],
        bodyProperties: [
          "partId",
          "blobId",
          "size",
          "name",
          "type",
          "charset",
          "disposition",
          "cid",
        ],
        fetchTextBodyValues: true,
        fetchHTMLBodyValues: true,
        maxBodyValueBytes: 10_000_000,
      },
    );
    const email = result.list[0];
    if (!email) throw new ProviderError(`email ${id} not found`, "not-found");
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(email)) {
      if (!key.startsWith("header:") || typeof value !== "string") continue;
      const name = key
        .slice("header:".length)
        .replace(/:asText$/, "")
        .toLowerCase();
      if (!(name in headers)) headers[name] = value.trim();
    }
    const text = email.textBody
      .map((p) => (p.partId ? (email.bodyValues[p.partId]?.value ?? "") : ""))
      .join("\n");
    const html = email.htmlBody
      .map((p) => (p.partId ? (email.bodyValues[p.partId]?.value ?? "") : ""))
      .join("\n");
    const attachments: RawAttachment[] = email.attachments
      .filter((p): p is JmapBodyPart & { blobId: string } => Boolean(p.blobId))
      .map((p, index) => ({
        name: p.name ?? `attachment-${index + 1}`,
        mediaType: p.type || "application/octet-stream",
        size: p.size,
        contentId: normalizeMessageId(p.cid),
        inline: p.disposition === "inline",
        content: () =>
          this.client.download(this.accountId, p.blobId, p.type, p.name ?? "attachment"),
      }));
    return {
      id,
      headers,
      text: text || (html ? textFromHtml(html) : ""),
      html: html || null,
      attachments,
    };
  }

  private async emailIdsOf(target: ChangeTarget): Promise<string[]> {
    if ("messageIds" in target) return target.messageIds;
    const result = await this.client.call<{ list: { id: string; emailIds: string[] }[] }>(
      "Thread/get",
      { accountId: this.accountId, ids: [target.threadId] },
    );
    return result.list[0]?.emailIds ?? [];
  }

  async applyChange(target: ChangeTarget, change: Change): Promise<void> {
    const ids = await this.emailIdsOf(target);
    if (ids.length === 0) return;
    const update: Record<string, Record<string, unknown>> = {};
    if (change.kind === "read" || change.kind === "star") {
      const keyword = change.kind === "read" ? "$seen" : "$flagged";
      for (const id of ids) update[id] = { [`keywords/${keyword}`]: change.value ? true : null };
    } else if (change.kind === "delete" || change.kind === "move") {
      const dest = change.kind === "move" ? change.mailboxId : await this.mailboxWithRole("trash");
      if (!dest) throw new ProviderError("no Trash mailbox", "unsupported");
      for (const id of ids) update[id] = { mailboxIds: { [dest]: true } };
    } else if (change.kind === "archive") {
      const inbox = await this.mailboxWithRole("inbox");
      const archive = await this.mailboxWithRole("archive");
      const current = await this.getEmails(ids, ["id", "mailboxIds"]);
      for (const email of current) {
        const remaining = Object.keys(email.mailboxIds).filter(
          (m) => email.mailboxIds[m] && m !== inbox,
        );
        const patch: Record<string, unknown> = {};
        if (inbox) patch[`mailboxIds/${inbox}`] = null;
        if (remaining.length === 0) {
          if (!archive) throw new ProviderError("no Archive mailbox", "unsupported");
          patch[`mailboxIds/${archive}`] = true;
        }
        update[email.id] = patch;
      }
    } else {
      for (const id of ids) {
        const patch: Record<string, unknown> = {};
        for (const m of change.add) patch[`mailboxIds/${m}`] = true;
        for (const m of change.remove) patch[`mailboxIds/${m}`] = null;
        update[id] = patch;
      }
    }
    const result = await this.client.call<{ notUpdated?: Record<string, { type: string }> }>(
      "Email/set",
      { accountId: this.accountId, update },
    );
    const failed = Object.entries(result.notUpdated ?? {});
    if (failed.length > 0) {
      const [id, err] = failed[0] as [string, { type: string }];
      throw new ProviderError(`Email/set ${id}: ${err.type}`, "protocol");
    }
  }

  async send(mime: Uint8Array, options: SendOptions = {}): Promise<SendResult> {
    if (!this.client.hasCapability(SUBMISSION)) {
      throw new ProviderError("server has no EmailSubmission capability", "unsupported");
    }
    const limits = this.client.limits();
    if (mime.byteLength > limits.maxSizeUpload) {
      throw new ProviderError("message exceeds the server's upload limit", "too-large");
    }
    const identities = await this.client.call<{ list: { id: string; email: string }[] }>(
      "Identity/get",
      { accountId: this.accountId, ids: null },
      [CORE, MAIL, SUBMISSION],
    );
    const identity =
      identities.list.find((i) => i.email.toLowerCase() === this.address.toLowerCase()) ??
      identities.list[0];
    if (!identity) throw new ProviderError("no sending identity", "unsupported");
    const drafts = await this.mailboxWithRole("drafts");
    const sent = await this.mailboxWithRole("sent");
    if (!sent) throw new ProviderError("no Sent mailbox", "unsupported");

    let emailId = options.draftId ?? null;
    const calls: MethodCall[] = [];
    if (!emailId) {
      const blob = await this.client.upload(this.accountId, mime, "message/rfc822");
      calls.push([
        "Email/import",
        {
          accountId: this.accountId,
          emails: {
            draft: {
              blobId: blob.blobId,
              mailboxIds: { [drafts ?? sent]: true },
              keywords: { $draft: true, $seen: true },
            },
          },
        },
        "import",
      ]);
      emailId = "#draft";
    }
    const onSuccess: Record<string, unknown> = {
      [`mailboxIds/${sent}`]: true,
      "keywords/$draft": null,
      "keywords/$seen": true,
    };
    if (drafts) onSuccess[`mailboxIds/${drafts}`] = null;
    calls.push([
      "EmailSubmission/set",
      {
        accountId: this.accountId,
        create: {
          sub: {
            emailId,
            identityId: identity.id,
            ...(options.to ? { envelope: envelopeOf(identity.email, options.to) } : {}),
          },
        },
        onSuccessUpdateEmail: { "#sub": onSuccess },
      },
      "submit",
    ]);
    const results = await this.client.batch(calls, [CORE, MAIL, SUBMISSION]);
    const imported = results.get("import") as
      | { created?: Record<string, { id: string }>; notCreated?: Record<string, { type: string }> }
      | undefined;
    if (imported?.notCreated?.draft) {
      throw new ProviderError(`Email/import: ${imported.notCreated.draft.type}`, "protocol");
    }
    const submitted = results.get("submit") as {
      created?: Record<string, { id: string }>;
      notCreated?: Record<string, { type: string; description?: string }>;
    };
    if (submitted.notCreated?.sub) {
      const err = submitted.notCreated.sub;
      throw new ProviderError(
        `EmailSubmission/set: ${err.type}${err.description ? ` (${err.description})` : ""}`,
        err.type === "tooLarge" ? "too-large" : "protocol",
      );
    }
    return { messageId: imported?.created?.draft?.id ?? options.draftId ?? null };
  }

  async putDraft(mime: Uint8Array, previousId: string | null): Promise<DraftResult> {
    const drafts = await this.mailboxWithRole("drafts");
    if (!drafts) throw new ProviderError("no Drafts mailbox", "unsupported");
    const blob = await this.client.upload(this.accountId, mime, "message/rfc822");
    const calls: MethodCall[] = [
      [
        "Email/import",
        {
          accountId: this.accountId,
          emails: {
            draft: {
              blobId: blob.blobId,
              mailboxIds: { [drafts]: true },
              keywords: { $draft: true, $seen: true },
            },
          },
        },
        "import",
      ],
    ];
    if (previousId) {
      calls.push(["Email/set", { accountId: this.accountId, destroy: [previousId] }, "destroy"]);
    }
    const results = await this.client.batch(calls, [CORE, MAIL]);
    const imported = results.get("import") as {
      created?: Record<string, { id: string }>;
      notCreated?: Record<string, { type: string }>;
    };
    if (imported.notCreated?.draft) {
      throw new ProviderError(`Email/import: ${imported.notCreated.draft.type}`, "protocol");
    }
    const id = imported.created?.draft?.id;
    if (!id) throw new ProviderError("Email/import returned no id", "protocol");
    return { id };
  }

  async deleteDraft(id: string): Promise<void> {
    // notDestroyed (already gone) is not an error: the copy is absent either way.
    await this.client.call("Email/set", { accountId: this.accountId, destroy: [id] });
  }

  watch(_mailboxIds: string[]): Watch {
    const session = this.client.requireSession();
    if (!session.eventSourceUrl) {
      return { supported: false, events: (async function* () {})(), stop: async () => {} };
    }
    const accountId = this.accountId;
    const pump = eventSourcePump({
      open: async () => {
        const response = await this.client.openEventSource(PUSH_TYPES, PING_SECONDS);
        if (!response.ok) throw new ProviderError(`event source ${response.status}`, "network");
        return streamOfResponse(response);
      },
      onChange: (change: StateChange): WatchEvent | null => {
        const forAccount = change.changed[accountId];
        if (!forAccount) return null;
        const relevant = PUSH_TYPES.some((t) => t in forAccount);
        return relevant ? { type: "changed", mailboxIds: [] } : null;
      },
      idleTimeoutMs: this.options.pushIdleMs ?? PING_SECONDS * 1000 * 3,
      ...(this.options.sleep ? { sleep: this.options.sleep } : {}),
    });
    this.watches.add(pump);
    return {
      supported: true,
      events: pump.events,
      stop: async () => {
        pump.stop();
        this.watches.delete(pump);
      },
    };
  }

  async close(): Promise<void> {
    for (const w of this.watches) w.stop();
    this.watches.clear();
  }
}

function envelopeOf(from: string, to: string[]) {
  return { mailFrom: { email: from }, rcptTo: to.map((email) => ({ email })) };
}
