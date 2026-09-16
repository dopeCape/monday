// The IMAP and SMTP adapter over imapflow and nodemailer. One connection does
// sync, fetch and changes; watch() opens one more per hot folder for IDLE.
// The sync tier is chosen per mailbox after ENABLE (tiers.ts); actions map to
// flags and moves per inbox.md; sent mail is appended to \Sent unless the host
// is one that copies it itself.

import type {
  FetchMessageObject,
  ListResponse,
  MailboxObject,
  MessageStructureObject,
} from "imapflow";
import { AuthenticationFailure, ImapFlow, type ImapFlowOptions } from "imapflow";
import { decodeWords } from "postal-mime";
import { parseMime, pickHeaders, rawMessageOf } from "../mime.ts";
import { asyncQueue } from "../queue.ts";
import {
  type Change,
  type ChangeTarget,
  type Credentials,
  type DraftResult,
  type Flags,
  type HostPort,
  type Mailbox,
  type MessageSummary,
  normalizeMessageId,
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
import { imapAuthOf } from "./auth.ts";
import { folderWithRole, roleOfFolder, serverSavesSentCopy } from "./folders.ts";
import { type IdleConnection, type IdleLoop, type IdleLoopOptions, idleLoop } from "./idle.ts";
import { createSmtpSender, type SmtpOptions, type SmtpSender } from "./smtp.ts";
import {
  chooseTier,
  decodeImapState,
  decodeUidSet,
  encodeImapState,
  encodeUidSet,
  type ImapMailboxState,
  type ImapTier,
  maxUid,
  messageIdOf,
  parseMessageId,
} from "./tiers.ts";

export { roleOfFolder, serverSavesSentCopy } from "./folders.ts";
export { IDLE_REISSUE_MS, idleLoop } from "./idle.ts";
export { chooseTier, decodeUidSet, encodeUidSet, messageIdOf, parseMessageId } from "./tiers.ts";

export const DEFAULT_PAGE = 200;
export const DEFAULT_HOT_FOLDERS = 3;
const FETCH_CHUNK = 100;

/** Headers fetched with every summary, beyond what ENVELOPE carries. */
const SUMMARY_HEADER_FIELDS = [
  "references",
  "list-id",
  "list-unsubscribe",
  "list-post",
  "precedence",
  "auto-submitted",
  "x-auto-response-suppress",
  "x-priority",
  "importance",
  "reply-to",
  "sender",
  "x-mailer",
  "x-github-reason",
  "feedback-id",
];

export interface ImapProviderOptions {
  pageSize?: number;
  hotFolders?: number;
  idle?: IdleLoopOptions;
  smtp?: SmtpOptions;
  /** Injected for tests; defaults to a real ImapFlow. */
  createClient?: (options: ImapFlowOptions) => ImapFlow;
}

function clientOptions(endpoint: HostPort, credentials: Credentials): ImapFlowOptions {
  return {
    host: endpoint.host,
    port: endpoint.port,
    secure: endpoint.tls === "tls",
    ...(endpoint.tls === "starttls" ? { doSTARTTLS: true } : {}),
    ...(endpoint.tls === "none" ? { doSTARTTLS: false } : {}),
    auth: imapAuthOf(credentials.auth),
    logger: false,
    disableAutoIdle: true,
    qresync: true,
    clientInfo: { name: "monday", vendor: "monday" },
  };
}

async function connectClient(
  create: (options: ImapFlowOptions) => ImapFlow,
  options: ImapFlowOptions,
): Promise<ImapFlow> {
  const client = create(options);
  // Without a listener an async socket error would be an unhandled event.
  client.on("error", () => {});
  try {
    await client.connect();
  } catch (cause) {
    if (cause instanceof AuthenticationFailure) {
      throw new ProviderError("IMAP server refused the credentials", "auth", { cause });
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new ProviderError(`cannot connect to ${options.host}: ${message}`, "network", {
      cause,
    });
  }
  return client;
}

export function createImapProvider(options: ImapProviderOptions = {}): Provider {
  return {
    kind: "imap",
    async connect(credentials) {
      if (credentials.endpoint.kind !== "imap") {
        throw new ProviderError("IMAP needs host and port", "unsupported");
      }
      const create = options.createClient ?? ((o) => new ImapFlow(o));
      const client = await connectClient(
        create,
        clientOptions(credentials.endpoint.imap, credentials),
      );
      return new ImapSession(client, credentials, credentials.endpoint, options, create);
    },
  };
}

/* ------------------------------ Header and structure helpers ------------------------------ */

/** Parses a raw header block (as FETCH BODY.PEEK[HEADER.FIELDS] returns it) into lowercased names. */
export function parseHeaderBlock(block: Uint8Array | string): Record<string, string> {
  const text = typeof block === "string" ? block : new TextDecoder("latin1").decode(block);
  const out: Record<string, string> = {};
  const unfolded = text.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (name in out) continue;
    out[name] = decodeWords(line.slice(colon + 1).trim());
  }
  return out;
}

export function hasAttachmentParts(structure: MessageStructureObject | undefined): boolean {
  if (!structure) return false;
  const walk = (node: MessageStructureObject): boolean => {
    if (node.childNodes && node.childNodes.length > 0) return node.childNodes.some(walk);
    const type = node.type.toLowerCase();
    if (node.disposition?.toLowerCase() === "attachment") return true;
    if (node.dispositionParameters?.filename || node.parameters?.name) return true;
    return !type.startsWith("text/") && !type.startsWith("multipart/");
  };
  return walk(structure);
}

export function flagsOfSet(flags: ReadonlySet<string> | undefined): Flags {
  const set = flags ?? new Set<string>();
  const keywords: string[] = [];
  for (const flag of set) {
    if (!["\\Seen", "\\Flagged", "\\Answered", "\\Draft", "\\Deleted", "\\Recent"].includes(flag)) {
      keywords.push(flag);
    }
  }
  return {
    seen: set.has("\\Seen"),
    flagged: set.has("\\Flagged"),
    answered: set.has("\\Answered"),
    draft: set.has("\\Draft"),
    keywords,
  };
}

function personOf(a: { name?: string | undefined; address?: string | undefined } | undefined) {
  return a ? { name: a.name ?? "", email: a.address ?? "" } : null;
}

export function summaryOfFetch(
  path: string,
  uidValidity: string,
  message: FetchMessageObject,
): MessageSummary {
  const envelope = message.envelope ?? {};
  const headers = message.headers ? parseHeaderBlock(message.headers) : {};
  const messageId = normalizeMessageId(envelope.messageId);
  const inReplyTo = normalizeMessageId(envelope.inReplyTo);
  if (messageId) headers["message-id"] = `<${messageId}>`;
  if (inReplyTo) headers["in-reply-to"] = `<${inReplyTo}>`;
  const received = message.internalDate ? new Date(message.internalDate) : new Date();
  const dateHeader = envelope.date ? new Date(envelope.date) : received;
  const date = Number.isNaN(dateHeader.getTime()) ? received : dateHeader;
  return {
    id: messageIdOf(path, uidValidity, message.uid),
    threadId: null,
    mailboxIds: [path],
    flags: flagsOfSet(message.flags),
    from: personOf(envelope.from?.[0]),
    to: (envelope.to ?? []).map((a) => personOf(a)).filter((p) => p !== null),
    cc: (envelope.cc ?? []).map((a) => personOf(a)).filter((p) => p !== null),
    subject: envelope.subject ?? "",
    date: date.toISOString(),
    receivedAt: received.toISOString(),
    messageId,
    inReplyTo,
    references: parseReferences(headers.references),
    headers: pickHeaders(headers),
    size: message.size ?? 0,
    hasAttachments: hasAttachmentParts(message.bodyStructure),
    preview: null,
  };
}

/* ------------------------------ The session ------------------------------ */

class ImapSession implements Session {
  private folders: ListResponse[] | null = null;
  private smtp: SmtpSender | null = null;
  private readonly page: number;
  private readonly watches = new Set<{ stop(): Promise<void> }>();
  private readonly tier: ImapTier;

  constructor(
    private client: ImapFlow,
    private readonly credentials: Credentials,
    private readonly endpoint: { imap: HostPort; smtp: HostPort },
    private readonly options: ImapProviderOptions,
    private readonly create: (options: ImapFlowOptions) => ImapFlow,
  ) {
    this.page = options.pageSize ?? DEFAULT_PAGE;
    this.tier = chooseTier(client.capabilities, client.enabled);
  }

  capabilities(): ProviderCapabilities {
    return {
      push: this.client.capabilities.has("IDLE"),
      labels: false,
      snooze: false,
      mute: false,
      calendar: false,
      meetingLink: null,
      syncTier: this.tier,
      threads: false,
      savesSentCopy: serverSavesSentCopy(this.endpoint.smtp.host),
      maxSendBytes: null,
    };
  }

  private async list(): Promise<ListResponse[]> {
    if (!this.folders) this.folders = await this.client.list();
    return this.folders;
  }

  async listMailboxes(): Promise<Mailbox[]> {
    this.folders = null;
    const folders = await this.list();
    return folders
      .filter((f) => !f.flags.has("\\Noselect") && !f.flags.has("\\NonExistent"))
      .map((f) => ({
        id: f.path,
        name: f.name,
        role: roleOfFolder(f),
        parentId: f.parentPath || null,
        totalMessages: f.status?.messages ?? null,
        unreadMessages: f.status?.unseen ?? null,
      }));
  }

  private async pathWithRole(
    role: "archive" | "trash" | "sent" | "drafts",
  ): Promise<string | null> {
    return folderWithRole(await this.list(), role)?.path ?? null;
  }

  private async fetchSummaries(
    path: string,
    uidValidity: string,
    uids: number[],
  ): Promise<MessageSummary[]> {
    const out: MessageSummary[] = [];
    for (let i = 0; i < uids.length; i += FETCH_CHUNK) {
      const chunk = uids.slice(i, i + FETCH_CHUNK);
      const messages = await this.client.fetchAll(
        chunk,
        {
          uid: true,
          flags: true,
          envelope: true,
          internalDate: true,
          size: true,
          bodyStructure: true,
          headers: SUMMARY_HEADER_FIELDS,
        },
        { uid: true },
      );
      for (const m of messages) out.push(summaryOfFetch(path, uidValidity, m));
    }
    // Newest first, as requested.
    const order = new Map(uids.map((uid, index) => [uid, index]));
    out.sort(
      (a, b) =>
        (order.get(parseMessageId(a.id).uid) ?? 0) - (order.get(parseMessageId(b.id).uid) ?? 0),
    );
    return out;
  }

  async *syncMailbox(
    mailboxId: string,
    state: string | null,
    options: SyncOptions = {},
  ): AsyncIterable<SyncEvent> {
    const limit = options.limit ?? this.page;
    const lock = await this.client.getMailboxLock(mailboxId);
    const vanished: number[] = [];
    const onExpunge = (event: { path: string; uid?: number | undefined; vanished: boolean }) => {
      if (event.path === mailboxId && event.uid !== undefined) vanished.push(event.uid);
    };
    this.client.on("expunge", onExpunge);
    try {
      const mailbox = this.client.mailbox as MailboxObject;
      const uidValidity = String(mailbox.uidValidity);
      let stored = decodeImapState(state);
      if (stored && stored.uidValidity !== uidValidity) {
        // RFC 9051 section 2.3.1.1: the cache for this mailbox is void.
        yield { type: "reset" };
        stored = null;
      }
      const tier: ImapTier = mailbox.noModseq ? "full-scan" : this.tier;
      const known = stored ? decodeUidSet(stored.known) : new Set<number>();
      const seen = stored ? decodeUidSet(stored.seen) : new Set<number>();
      const flagged = stored ? decodeUidSet(stored.flagged) : new Set<number>();
      const removed = new Set<number>();

      // 1. What the server has. QRESYNC with a complete first pass skips
      //    this: new mail is above the highest known UID and expunges arrive
      //    as VANISHED.
      let serverUids: number[] | null = null;
      const needScan = !stored?.complete || tier !== "qresync";
      if (needScan) {
        const found = await this.client.search({ all: true }, { uid: true });
        serverUids = Array.isArray(found) ? found : [];
      }

      // 2. New UIDs, newest first, paced by limit.
      let newUids: number[];
      let more = false;
      if (serverUids) {
        const fresh = serverUids.filter((uid) => !known.has(uid)).sort((a, b) => b - a);
        more = fresh.length > limit;
        newUids = fresh.slice(0, limit);
      } else {
        const top = maxUid(known);
        const above = await this.client.fetchAll(`${top + 1}:*`, { uid: true }, { uid: true });
        newUids = above
          .map((m) => m.uid)
          .filter((uid) => uid > top)
          .sort((a, b) => b - a);
        more = newUids.length > limit;
        newUids = newUids.slice(0, limit);
      }
      for (const summary of await this.fetchSummaries(mailboxId, uidValidity, newUids)) {
        const uid = parseMessageId(summary.id).uid;
        known.add(uid);
        if (summary.flags.seen) seen.add(uid);
        if (summary.flags.flagged) flagged.add(uid);
        yield { type: "added", message: summary };
      }

      // 3. Flag changes on what we already knew.
      if (stored && known.size > newUids.length) {
        const fresh = new Set(newUids);
        const changedSince =
          tier !== "full-scan" && stored.modseq ? BigInt(stored.modseq) : undefined;
        const flagRows = await this.client.fetchAll(
          "1:*",
          { uid: true, flags: true },
          { uid: true, ...(changedSince !== undefined ? { changedSince } : {}) },
        );
        for (const row of flagRows) {
          if (fresh.has(row.uid) || !known.has(row.uid)) continue;
          const flags = flagsOfSet(row.flags);
          const wasSeen = seen.has(row.uid);
          const wasFlagged = flagged.has(row.uid);
          if (
            changedSince === undefined &&
            flags.seen === wasSeen &&
            flags.flagged === wasFlagged
          ) {
            continue;
          }
          if (flags.seen) seen.add(row.uid);
          else seen.delete(row.uid);
          if (flags.flagged) flagged.add(row.uid);
          else flagged.delete(row.uid);
          yield {
            type: "changed",
            id: messageIdOf(mailboxId, uidValidity, row.uid),
            flags,
            mailboxIds: [mailboxId],
          };
        }
      }

      // 4. Expunges: the scan diff, or VANISHED under QRESYNC.
      if (serverUids) {
        const present = new Set(serverUids);
        for (const uid of known) if (!present.has(uid)) removed.add(uid);
      }
      for (const uid of vanished) if (known.has(uid)) removed.add(uid);
      for (const uid of removed) {
        known.delete(uid);
        seen.delete(uid);
        flagged.delete(uid);
        yield { type: "removed", id: messageIdOf(mailboxId, uidValidity, uid) };
      }

      const next: ImapMailboxState = {
        v: 1,
        tier,
        uidValidity,
        modseq: mailbox.highestModseq !== undefined ? mailbox.highestModseq.toString() : "",
        known: encodeUidSet(known),
        seen: encodeUidSet(seen),
        flagged: encodeUidSet(flagged),
        complete: !more,
      };
      yield { type: "state", state: encodeImapState(next), complete: !more };
    } finally {
      this.client.off("expunge", onExpunge);
      lock.release();
    }
  }

  async fetchMessage(id: string): Promise<RawMessage> {
    const { path, uid } = parseMessageId(id);
    const lock = await this.client.getMailboxLock(path);
    try {
      const message = await this.client.fetchOne(String(uid), { source: true }, { uid: true });
      const source = message ? message.source : undefined;
      if (!source) throw new ProviderError(`message ${id} not found`, "not-found");
      return rawMessageOf(id, await parseMime(new Uint8Array(source)));
    } finally {
      lock.release();
    }
  }

  async applyChange(target: ChangeTarget, change: Change): Promise<void> {
    if (!("messageIds" in target)) {
      throw new ProviderError("IMAP has no Threads; pass message ids", "unsupported");
    }
    if (change.kind === "label") {
      throw new ProviderError("IMAP folders are not labels; move instead", "unsupported");
    }
    const byPath = new Map<string, number[]>();
    for (const id of target.messageIds) {
      const { path, uid } = parseMessageId(id);
      byPath.set(path, [...(byPath.get(path) ?? []), uid]);
    }
    for (const [path, uids] of byPath) {
      const lock = await this.client.getMailboxLock(path);
      try {
        if (change.kind === "read" || change.kind === "star") {
          const flag = change.kind === "read" ? "\\Seen" : "\\Flagged";
          if (change.value) await this.client.messageFlagsAdd(uids, [flag], { uid: true });
          else await this.client.messageFlagsRemove(uids, [flag], { uid: true });
          continue;
        }
        let destination: string | null;
        if (change.kind === "move") destination = change.mailboxId;
        else if (change.kind === "delete") destination = await this.pathWithRole("trash");
        else destination = await this.ensureArchive();
        if (!destination) {
          throw new ProviderError(
            `no ${change.kind === "delete" ? "Trash" : "Archive"} folder`,
            "unsupported",
          );
        }
        if (destination === path) continue;
        await this.client.messageMove(uids, destination, { uid: true });
      } finally {
        lock.release();
      }
    }
  }

  private async ensureArchive(): Promise<string> {
    const existing = await this.pathWithRole("archive");
    if (existing) return existing;
    const created = await this.client.mailboxCreate("Archive");
    this.folders = null;
    return created.path;
  }

  async send(mime: Uint8Array, options: SendOptions = {}): Promise<SendResult> {
    this.smtp ??= createSmtpSender(
      this.endpoint.smtp,
      this.credentials.auth,
      this.credentials.address,
      this.options.smtp ?? {},
    );
    await this.smtp.send(mime, options.to);
    if (!this.capabilities().savesSentCopy) {
      const sent = await this.pathWithRole("sent");
      if (sent) {
        const appended = await this.client.append(sent, Buffer.from(mime), ["\\Seen"], new Date());
        if (appended && appended.uid !== undefined) {
          return { messageId: messageIdOf(sent, appended.uidValidity ?? "0", appended.uid) };
        }
      }
    }
    return { messageId: null };
  }

  async putDraft(mime: Uint8Array, previousId: string | null): Promise<DraftResult> {
    const drafts = await this.pathWithRole("drafts");
    if (!drafts) throw new ProviderError("no Drafts folder", "unsupported");
    if (previousId) await this.deleteDraft(previousId);
    const appended = await this.client.append(
      drafts,
      Buffer.from(mime),
      ["\\Draft", "\\Seen"],
      new Date(),
    );
    if (!appended || appended.uid === undefined) {
      throw new ProviderError("APPEND returned no uid", "protocol");
    }
    return { id: messageIdOf(drafts, appended.uidValidity ?? "0", appended.uid) };
  }

  async deleteDraft(id: string): Promise<void> {
    let parsed: ReturnType<typeof parseMessageId>;
    try {
      parsed = parseMessageId(id);
    } catch {
      return;
    }
    const lock = await this.client.getMailboxLock(parsed.path);
    try {
      await this.client.messageDelete([parsed.uid], { uid: true });
    } catch {
      // Already gone (or the folder changed): the copy is absent either way.
    } finally {
      lock.release();
    }
  }

  watch(mailboxIds: string[]): Watch {
    if (!this.client.capabilities.has("IDLE")) {
      return { supported: false, events: (async function* () {})(), stop: async () => {} };
    }
    const max = this.options.hotFolders ?? DEFAULT_HOT_FOLDERS;
    const ordered = [...new Set(mailboxIds)].sort((a, b) =>
      a.toUpperCase() === "INBOX" ? -1 : b.toUpperCase() === "INBOX" ? 1 : 0,
    );
    const hot = ordered.slice(0, max);
    const queue = asyncQueue<WatchEvent>();
    const loops: IdleLoop[] = hot.map((path) =>
      idleLoop(
        path,
        this.idleConnection(path),
        (event) => queue.push(event),
        this.options.idle ?? {},
      ),
    );
    const watch = {
      supported: true,
      events: queue,
      stop: async () => {
        await Promise.all(loops.map((loop) => loop.stop()));
        queue.close();
        this.watches.delete(watch);
      },
    };
    this.watches.add(watch);
    return watch;
  }

  private idleConnection(path: string): IdleConnection {
    const listeners = new Set<() => void>();
    let client: ImapFlow | null = null;
    const notify = () => {
      for (const l of listeners) l();
    };
    return {
      open: async () => {
        if (client) {
          client.close();
          client = null;
        }
        const opened = await connectClient(
          this.create,
          clientOptions(this.endpoint.imap, this.credentials),
        );
        opened.on("exists", notify);
        opened.on("expunge", notify);
        opened.on("flags", notify);
        await opened.mailboxOpen(path, { readOnly: true });
        client = opened;
      },
      idle: async () => {
        if (!client) throw new ProviderError("idle connection is closed", "network");
        await client.idle();
        if (client.isClosed || !client.usable)
          throw new ProviderError("idle connection dropped", "network");
      },
      wake: async () => {
        if (client?.usable) await client.noop();
      },
      close: async () => {
        const c = client;
        client = null;
        if (c) await c.logout().catch(() => c.close());
      },
      onChange: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  }

  async close(): Promise<void> {
    for (const w of [...this.watches]) await w.stop();
    this.smtp?.close();
    await this.client.logout().catch(() => this.client.close());
  }
}
