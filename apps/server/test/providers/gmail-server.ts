// An in-memory Gmail behind a fetch function: the OAuth token endpoint (code
// exchange with PKCE, refresh, the validation probe's answers), enough of the
// Gmail REST API to exercise the adapter (profile, labels, messages.list,
// messages.get in every format, multipart batch, history.list with a
// retention window, modify and batchModify, send and drafts.send with the
// resumable upload, threads.get, watch and stop) and the Pub/Sub subscription
// endpoints with a pull queue tests can push notifications into. Every call
// is logged with its quota cost so pacing can be asserted.

import type { Fixture, FixtureMessage } from "../../src/providers/fake/fixture.ts";
import { GMAIL_COST } from "../../src/providers/gmail/quota.ts";
import type { FetchLike } from "../../src/providers/jmap/client.ts";
import { composeMime } from "../../src/providers/mime.ts";
import { base64url, challengeOf, decodeBase64url } from "../../src/providers/oauth/pkce.ts";

interface Email {
  id: string;
  threadId: string;
  labelIds: string[];
  internalDate: number;
  historyId: number;
  headers: Record<string, string>;
  from: { name: string; email: string };
  to: { name: string; email: string }[];
  cc: { name: string; email: string }[];
  subject: string;
  text: string;
  html: string | null;
  attachments: { name: string; mediaType: string; text: string }[];
  raw: Uint8Array | null;
}

interface HistoryEntry {
  id: number;
  messageId: string;
  threadId: string;
  kind: "messageAdded" | "messageDeleted" | "labelAdded" | "labelRemoved";
  /** Labels involved (added or removed), or the message's labels for added. */
  labelIds: string[];
  /** The message's labels after this record. */
  after: string[];
}

export interface GmailRequest {
  method: string;
  url: string;
  path: string;
  cost: number;
}

export interface GmailServerOptions {
  clientId?: string;
  clientSecret?: string;
  address?: string;
}

export interface GmailServer {
  fetch: FetchLike;
  requests: GmailRequest[];
  emails: Map<string, Email>;
  /** Units spent so far, by method. */
  quota: Record<string, number>;
  /** The access token currently accepted. */
  accessToken: string;
  refreshToken: string;
  refreshes: number;
  /** Answer 429 to the next n Gmail calls. */
  rateLimitNext: number;
  /**
   * Refuse the next n messages.get parts inside a batch with Google's per-user
   * quota answer: a 403 whose reason is rateLimitExceeded, the way "Units per
   * minute per user" comes back.
   */
  quotaRefuseParts: number;
  /** Refuse the next n batch parts with Gmail's "Too many concurrent requests" 429. */
  concurrencyRefuseParts: number;
  /** The part count of every batch request, in order. */
  batchSizes: number[];
  /** Answer 401 to the next n Gmail calls (an expired token). */
  expireNext: number;
  watches: { topicName: string; labelIds?: string[]; labelFilterBehavior?: string }[];
  subscriptions: Map<string, Record<string, unknown>>;
  /** Pending Pub/Sub messages for the pull queue. */
  pullQueue: { data: string; messageId: string }[];
  acked: string[];
  sent: {
    raw: Uint8Array;
    threadId: string | null;
    draftId: string | null;
    via: "simple" | "resumable";
  }[];
  uploadChunks: number[];
  /** Gmail drafts: draft id to the id of its current message (DRAFT label). */
  drafts: Map<string, string>;
  /** Every drafts.create and drafts.update, in order. */
  draftWrites: {
    draftId: string;
    raw: Uint8Array;
    threadId: string | null;
    via: "simple" | "resumable";
    update: boolean;
  }[];
  /** Answer the next n Gmail calls with a 403 rateLimitExceeded (the per-user quota refusal). */
  quotaRefuseNext: number;
  /** The code the fake authorization endpoint would hand back for `state`. */
  issueCode(redirectUri: string, challenge: string): string;
  /** Simulates another client. */
  deliver(message: FixtureMessage): void;
  setLabels(id: string, add: string[], remove: string[]): void;
  destroy(id: string): void;
  /** Drops history so every stored historyId is too old (404). */
  forgetHistory(): void;
  /** Queues a Pub/Sub notification for the address. */
  notify(address?: string): void;
  labelId(role: "inbox" | "sent" | "trash" | "archive"): string;
  historyId: number;
}

const LABELS: { id: string; name: string; type: "system" | "user" }[] = [
  { id: "INBOX", name: "INBOX", type: "system" },
  { id: "SENT", name: "SENT", type: "system" },
  { id: "DRAFT", name: "DRAFT", type: "system" },
  { id: "TRASH", name: "TRASH", type: "system" },
  { id: "SPAM", name: "SPAM", type: "system" },
  { id: "UNREAD", name: "UNREAD", type: "system" },
  { id: "STARRED", name: "STARRED", type: "system" },
  { id: "IMPORTANT", name: "IMPORTANT", type: "system" },
  { id: "CATEGORY_PROMOTIONS", name: "CATEGORY_PROMOTIONS", type: "system" },
  { id: "Label_1", name: "Receipts", type: "user" },
  { id: "Label_2", name: "Receipts/2026", type: "user" },
];

const ROLE_LABEL: Record<string, string> = {
  inbox: "INBOX",
  sent: "SENT",
  trash: "TRASH",
  archive: "Label_1",
};

export function createGmailServer(fixture: Fixture, options: GmailServerOptions = {}): GmailServer {
  const clientId = options.clientId ?? "1234-abc.apps.googleusercontent.com";
  const clientSecret = options.clientSecret ?? "GOCSPX-secret";
  const address = options.address ?? fixture.address;
  const emails = new Map<string, Email>();
  let history: HistoryEntry[] = [];
  let historyId = 1000;
  let oldestHistory = historyId;
  let counter = 0;
  const encoder = new TextEncoder();
  const codes = new Map<string, { redirectUri: string; challenge: string }>();
  const pullWaiters = new Set<() => void>();
  const uploads = new Map<
    string,
    { metadata: Record<string, unknown>; received: Uint8Array[]; total: number; path: string }
  >();

  const record = (
    e: Pick<Email, "id" | "threadId">,
    kind: HistoryEntry["kind"],
    labelIds: string[],
    after: string[],
  ) => {
    historyId += 1;
    history.push({ id: historyId, messageId: e.id, threadId: e.threadId, kind, labelIds, after });
    const email = emails.get(e.id);
    if (email) email.historyId = historyId;
  };

  function add(m: FixtureMessage, extraLabels: string[] = []): Email {
    const labelIds = [
      ROLE_LABEL[m.mailbox] ?? "INBOX",
      ...(m.seen ? [] : ["UNREAD"]),
      ...(m.flagged ? ["STARRED"] : []),
      ...extraLabels,
    ];
    const email: Email = {
      id: m.id,
      threadId: m.threadKey,
      labelIds,
      internalDate: Date.parse(m.date),
      historyId,
      headers: {
        ...m.headers,
        "message-id": `<${m.messageId}>`,
        ...(m.inReplyTo ? { "in-reply-to": `<${m.inReplyTo}>` } : {}),
        ...(m.references.length > 0
          ? { references: m.references.map((r) => `<${r}>`).join(" ") }
          : {}),
        date: new Date(m.date).toUTCString(),
        from: m.from.name ? `${m.from.name} <${m.from.email}>` : m.from.email,
        to: m.to.map((p) => (p.name ? `${p.name} <${p.email}>` : p.email)).join(", "),
        cc: m.cc.map((p) => (p.name ? `${p.name} <${p.email}>` : p.email)).join(", "),
        subject: m.subject,
      },
      from: m.from,
      to: m.to,
      cc: m.cc,
      subject: m.subject,
      text: m.text,
      html: m.html,
      attachments: m.attachments,
      raw: null,
    };
    emails.set(email.id, email);
    return email;
  }

  for (const m of fixture.messages) add(m);
  // History begins after the fixture is loaded: the first watch sees an empty log.
  oldestHistory = historyId;

  async function rawOf(e: Email): Promise<Uint8Array> {
    if (e.raw) return e.raw;
    e.raw = await composeMime({
      from: e.from,
      to: e.to,
      cc: e.cc,
      subject: e.subject,
      text: e.text,
      html: e.html,
      messageId: e.headers["message-id"]?.replace(/^<|>$/g, "") ?? `${e.id}@fake.gmail`,
      inReplyTo: e.headers["in-reply-to"]?.replace(/^<|>$/g, "") ?? null,
      date: new Date(e.internalDate),
      attachments: e.attachments.map((a) => ({
        name: a.name,
        mediaType: a.mediaType,
        bytes: encoder.encode(a.text),
      })),
    });
    return e.raw;
  }

  function payloadOf(e: Email, format: string) {
    const headers = Object.entries(e.headers).map(([name, value]) => ({
      name: name.replace(/(^|-)([a-z])/g, (_, d, c) => `${d}${c.toUpperCase()}`),
      value,
    }));
    const parts = e.attachments.map((a) => ({ filename: a.name, mimeType: a.mediaType }));
    return format === "full"
      ? { headers, mimeType: parts.length > 0 ? "multipart/mixed" : "text/plain", parts }
      : { headers };
  }

  async function resource(e: Email, format: string): Promise<Record<string, unknown>> {
    const base = {
      id: e.id,
      threadId: e.threadId,
      labelIds: e.labelIds,
      historyId: String(e.historyId),
      internalDate: String(e.internalDate),
      sizeEstimate: e.text.length + 500,
      snippet: e.text.slice(0, 80),
    };
    if (format === "minimal") return base;
    if (format === "raw") return { ...base, raw: base64url(await rawOf(e)) };
    return { ...base, payload: payloadOf(e, format) };
  }

  const server: GmailServer = {
    requests: [],
    emails,
    quota: {},
    accessToken: "access-0",
    refreshToken: "refresh-0",
    refreshes: 0,
    rateLimitNext: 0,
    quotaRefuseParts: 0,
    concurrencyRefuseParts: 0,
    batchSizes: [],
    expireNext: 0,
    watches: [],
    subscriptions: new Map(),
    pullQueue: [],
    acked: [],
    sent: [],
    uploadChunks: [],
    drafts: new Map(),
    draftWrites: [],
    quotaRefuseNext: 0,
    get historyId() {
      return historyId;
    },
    issueCode(redirectUri, challenge) {
      counter += 1;
      const code = `code-${counter}`;
      codes.set(code, { redirectUri, challenge });
      return code;
    },
    deliver(message) {
      const e = add(message);
      record(e, "messageAdded", e.labelIds, e.labelIds);
    },
    setLabels(id, addIds, removeIds) {
      const e = emails.get(id);
      if (!e) throw new Error(id);
      const added = addIds.filter((l) => !e.labelIds.includes(l));
      const removed = removeIds.filter((l) => e.labelIds.includes(l));
      e.labelIds = [...e.labelIds.filter((l) => !removeIds.includes(l)), ...added];
      if (added.length > 0) record(e, "labelAdded", added, e.labelIds);
      if (removed.length > 0) record(e, "labelRemoved", removed, e.labelIds);
    },
    destroy(id) {
      const e = emails.get(id);
      if (!e) throw new Error(id);
      emails.delete(id);
      record(e, "messageDeleted", e.labelIds, []);
    },
    forgetHistory() {
      history = [];
      historyId += 1;
      oldestHistory = historyId;
    },
    notify(who = address) {
      counter += 1;
      server.pullQueue.push({
        data: btoa(JSON.stringify({ emailAddress: who, historyId })),
        messageId: `pm-${counter}`,
      });
      for (const wake of [...pullWaiters]) {
        pullWaiters.delete(wake);
        wake();
      }
    },
    labelId(role) {
      return ROLE_LABEL[role] ?? "INBOX";
    },
    fetch: async (url, init) => handle(url, init),
  };

  function labelsOfHistory(entry: HistoryEntry): string[] {
    return [...new Set([...entry.labelIds, ...entry.after])];
  }

  async function gmail(
    method: string,
    u: URL,
    init: RequestInit | undefined,
    _headers: Headers,
    log: (cost: number) => void,
  ): Promise<Response> {
    const path = u.pathname.replace(/^\/gmail\/v1\/users\/me\/?/, "");
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const err = (status: number, reason: string, message = reason) =>
      Response.json({ error: { code: status, message, errors: [{ reason }] } }, { status });

    if (path === "profile") {
      log(GMAIL_COST.getProfile);
      return Response.json({ emailAddress: address, historyId: String(historyId) });
    }
    if (path === "labels") {
      log(GMAIL_COST["labels.list"]);
      return Response.json({ labels: LABELS });
    }
    if (path === "messages" && method === "GET") {
      log(GMAIL_COST["messages.list"]);
      const label = u.searchParams.get("labelIds");
      const q = u.searchParams.get("q");
      let list = [...emails.values()];
      if (label) list = list.filter((e) => e.labelIds.includes(label));
      if (q) {
        const m = /rfc822msgid:(\S+)/.exec(q);
        list = m ? list.filter((e) => e.headers["message-id"] === `<${m[1]}>`) : [];
      }
      list.sort((a, b) => b.internalDate - a.internalDate);
      const max = Number(u.searchParams.get("maxResults") ?? 100);
      const start = Number(u.searchParams.get("pageToken") ?? 0);
      const page = list.slice(start, start + max);
      return Response.json({
        messages: page.map((e) => ({ id: e.id, threadId: e.threadId })),
        ...(start + max < list.length ? { nextPageToken: String(start + max) } : {}),
        resultSizeEstimate: list.length,
      });
    }
    if (path === "history") {
      log(GMAIL_COST["history.list"]);
      const start = Number(u.searchParams.get("startHistoryId"));
      if (Number.isNaN(start) || start < oldestHistory)
        return err(404, "notFound", "Requested entity was not found.");
      const label = u.searchParams.get("labelId");
      const records = history
        .filter((h) => h.id > start)
        .filter((h) => !label || labelsOfHistory(h).includes(label));
      const max = Number(u.searchParams.get("maxResults") ?? 100);
      const offset = Number(u.searchParams.get("pageToken") ?? 0);
      const page = records.slice(offset, offset + max);
      const out = page.map((h) => {
        const message = { id: h.messageId, threadId: h.threadId, labelIds: h.after };
        const base = { id: String(h.id), messages: [{ id: h.messageId, threadId: h.threadId }] };
        switch (h.kind) {
          case "messageAdded":
            return { ...base, messagesAdded: [{ message }] };
          case "messageDeleted":
            return { ...base, messagesDeleted: [{ message }] };
          case "labelAdded":
            return { ...base, labelsAdded: [{ message, labelIds: h.labelIds }] };
          default:
            return { ...base, labelsRemoved: [{ message, labelIds: h.labelIds }] };
        }
      });
      return Response.json({
        history: out,
        historyId: String(historyId),
        ...(offset + max < records.length ? { nextPageToken: String(offset + max) } : {}),
      });
    }
    const messageMatch = /^messages\/([^/]+)$/.exec(path);
    if (messageMatch && method === "GET") {
      log(GMAIL_COST["messages.get"]);
      const e = emails.get(decodeURIComponent(messageMatch[1] ?? ""));
      if (!e) return err(404, "notFound");
      return Response.json(await resource(e, u.searchParams.get("format") ?? "full"));
    }
    const modifyMatch = /^messages\/([^/]+)\/modify$/.exec(path);
    if (modifyMatch) {
      log(GMAIL_COST["messages.modify"]);
      const e = emails.get(decodeURIComponent(modifyMatch[1] ?? ""));
      if (!e) return err(404, "notFound");
      server.setLabels(
        e.id,
        (body.addLabelIds as string[]) ?? [],
        (body.removeLabelIds as string[]) ?? [],
      );
      return Response.json(await resource(e, "minimal"));
    }
    if (path === "messages/batchModify") {
      log(GMAIL_COST["messages.batchModify"]);
      for (const id of body.ids as string[]) {
        if (!emails.has(id)) continue;
        server.setLabels(
          id,
          (body.addLabelIds as string[]) ?? [],
          (body.removeLabelIds as string[]) ?? [],
        );
      }
      return new Response(null, { status: 204 });
    }
    const threadMatch = /^threads\/([^/]+)$/.exec(path);
    if (threadMatch) {
      log(GMAIL_COST["threads.get"]);
      const id = decodeURIComponent(threadMatch[1] ?? "");
      const messages = [...emails.values()].filter((e) => e.threadId === id);
      if (messages.length === 0) return err(404, "notFound");
      return Response.json({
        id,
        messages: messages.map((e) => ({ id: e.id, threadId: e.threadId })),
      });
    }
    if (path === "messages/send" || path === "drafts/send") {
      log(path === "messages/send" ? GMAIL_COST["messages.send"] : GMAIL_COST["drafts.send"]);
      const message = (path === "drafts/send" ? body.message : body) as {
        raw?: string;
        threadId?: string;
      };
      if (!message?.raw) return err(400, "invalidArgument", "raw is required");
      return Response.json(
        recordSend(
          decodeBase64url(message.raw),
          message.threadId ?? null,
          path === "drafts/send" ? String(body.id) : null,
          "simple",
        ),
      );
    }
    if (path === "watch") {
      log(GMAIL_COST.watch);
      server.watches.push(
        body as { topicName: string; labelIds?: string[]; labelFilterBehavior?: string },
      );
      return Response.json({
        historyId: String(historyId),
        expiration: String(Date.now() + 7 * 86_400_000),
      });
    }
    if (path === "stop") {
      log(GMAIL_COST.stop);
      return new Response(null, { status: 204 });
    }
    if (path === "drafts" && method === "POST") {
      log(GMAIL_COST["drafts.create"]);
      const message = body.message as { raw?: string; threadId?: string } | undefined;
      if (!message?.raw) return err(400, "invalidArgument", "message.raw is required");
      return Response.json(
        writeDraft(decodeBase64url(message.raw), message.threadId ?? null, null, "simple"),
      );
    }
    const draftMatch = /^drafts\/([^/]+)$/.exec(path);
    if (draftMatch && draftMatch[1] !== "send") {
      const id = decodeURIComponent(draftMatch[1] ?? "");
      const held = server.drafts.get(id);
      if (method === "PUT") {
        log(GMAIL_COST["drafts.update"]);
        if (!held) return err(404, "notFound", "Requested entity was not found.");
        const message = body.message as { raw?: string; threadId?: string } | undefined;
        if (!message?.raw) return err(400, "invalidArgument", "message.raw is required");
        return Response.json(
          writeDraft(decodeBase64url(message.raw), message.threadId ?? null, id, "simple"),
        );
      }
      if (method === "DELETE") {
        log(GMAIL_COST["drafts.delete"]);
        if (!held) return err(404, "notFound", "Requested entity was not found.");
        server.drafts.delete(id);
        if (emails.has(held)) server.destroy(held);
        return new Response(null, { status: 204 });
      }
      log(GMAIL_COST["drafts.get"]);
      const e = held ? emails.get(held) : undefined;
      if (!e) return err(404, "notFound", "Requested entity was not found.");
      return Response.json({ id, message: await resource(e, "minimal") });
    }
    return err(404, "notFound", `no route for ${method} ${path}`);
  }

  function recordSend(
    raw: Uint8Array,
    threadId: string | null,
    draftId: string | null,
    via: "simple" | "resumable",
  ) {
    server.sent.push({ raw, threadId, draftId, via });
    // drafts.send removes the draft and its message, like Gmail.
    const held = draftId ? server.drafts.get(draftId) : undefined;
    if (draftId && held) {
      server.drafts.delete(draftId);
      if (emails.has(held)) server.destroy(held);
    }
    const email = storeRaw(raw, threadId, ["SENT"], "sent");
    return { id: email.id, threadId: email.threadId, labelIds: email.labelIds };
  }

  /** A message from raw MIME, stored under a fresh id with the given labels. */
  function storeRaw(
    raw: Uint8Array,
    threadId: string | null,
    labelIds: string[],
    prefix: string,
  ): Email {
    counter += 1;
    const id = `${prefix}-${counter}`;
    const text = new TextDecoder().decode(raw);
    const head = (text.split(/\r?\n\r?\n/)[0] ?? "").replace(/\r?\n[ \t]+/g, " ");
    const header = (name: string) => new RegExp(`^${name}:\\s*(.*)$`, "im").exec(head)?.[1];
    const subject = header("subject") ?? "";
    const messageId = /<([^>]+)>/.exec(header("message-id") ?? "")?.[1] ?? `${id}@fake`;
    const optional: Record<string, string> = {};
    for (const name of ["in-reply-to", "references"]) {
      const value = header(name);
      if (value) optional[name] = value;
    }
    const email: Email = {
      id,
      threadId: threadId ?? `t-${id}`,
      labelIds,
      internalDate: Date.now(),
      historyId,
      headers: {
        subject,
        from: address,
        to: address,
        "message-id": `<${messageId}>`,
        ...optional,
        date: new Date().toUTCString(),
      },
      from: { name: "", email: address },
      to: [{ name: "", email: address }],
      cc: [],
      subject,
      text: text
        .split(/\r?\n\r?\n/)
        .slice(1)
        .join("\n"),
      html: null,
      attachments: [],
      raw,
    };
    emails.set(id, email);
    record(email, "messageAdded", email.labelIds, email.labelIds);
    return email;
  }

  /** drafts.create and drafts.update: the draft id stays, the message is new each time. */
  function writeDraft(
    raw: Uint8Array,
    threadId: string | null,
    draftId: string | null,
    via: "simple" | "resumable",
  ): Record<string, unknown> {
    let id = draftId;
    if (id) {
      const previous = server.drafts.get(id);
      if (previous && emails.has(previous)) server.destroy(previous);
    } else {
      counter += 1;
      id = `r-${counter}`;
    }
    const email = storeRaw(raw, threadId, ["DRAFT"], "draft-msg");
    server.drafts.set(id, email.id);
    server.draftWrites.push({ draftId: id, raw, threadId, via, update: draftId !== null });
    return { id, message: { id: email.id, threadId: email.threadId, labelIds: email.labelIds } };
  }

  async function handle(url: string, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? "GET";
    const u = new URL(url);
    const headers = new Headers(init?.headers);
    const entry: GmailRequest = { method, url, path: u.pathname, cost: 0 };
    server.requests.push(entry);
    const log = (cost: number) => {
      entry.cost = cost;
      const key = u.pathname.replace(/^\/gmail\/v1\/users\/me\//, "");
      server.quota[key] = (server.quota[key] ?? 0) + cost;
    };

    // OAuth
    if (u.host === "accounts.google.com" && u.pathname === "/.well-known/openid-configuration") {
      return Response.json({
        issuer: "https://accounts.google.com",
        authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        token_endpoint: "https://oauth2.googleapis.com/token",
      });
    }
    if (u.host === "oauth2.googleapis.com" && u.pathname === "/token") {
      const form = new URLSearchParams(String(init?.body ?? ""));
      const oauthError = (status: number, error: string, description: string) =>
        Response.json({ error, error_description: description }, { status });
      if (form.get("client_id") !== clientId) {
        return oauthError(401, "invalid_client", "The OAuth client was not found.");
      }
      if (!form.get("client_secret")) {
        return oauthError(400, "invalid_request", "client_secret is missing.");
      }
      if (form.get("client_secret") !== clientSecret) {
        return oauthError(401, "invalid_client", "Unauthorized");
      }
      const grant = form.get("grant_type");
      if (grant === "authorization_code") {
        const issued = codes.get(form.get("code") ?? "");
        if (!issued) return oauthError(400, "invalid_grant", "Malformed auth code.");
        if (issued.redirectUri !== form.get("redirect_uri")) {
          return oauthError(400, "invalid_grant", "redirect_uri mismatch");
        }
        const verifier = form.get("code_verifier") ?? "";
        if ((await challengeOf(verifier)) !== issued.challenge) {
          return oauthError(400, "invalid_grant", "Invalid code_verifier.");
        }
        codes.delete(form.get("code") ?? "");
        counter += 1;
        server.accessToken = `access-${counter}`;
        server.refreshToken = `refresh-${counter}`;
        return Response.json({
          access_token: server.accessToken,
          refresh_token: server.refreshToken,
          expires_in: 3599,
          scope: form.get("scope") ?? "",
          token_type: "Bearer",
        });
      }
      if (grant === "refresh_token") {
        if (form.get("refresh_token") !== server.refreshToken) {
          return oauthError(400, "invalid_grant", "Token has been expired or revoked.");
        }
        server.refreshes += 1;
        counter += 1;
        server.accessToken = `access-${counter}`;
        return Response.json({
          access_token: server.accessToken,
          expires_in: 3599,
          token_type: "Bearer",
        });
      }
      return oauthError(400, "unsupported_grant_type", grant ?? "");
    }

    // Everything else is bearer-authenticated.
    const bearer = headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    const authenticated = bearer === server.accessToken;
    if (u.host === "pubsub.googleapis.com") {
      if (!authenticated) return new Response("unauthorized", { status: 401 });
      const m = /^\/v1\/(projects\/[^/]+\/subscriptions\/[^/:]+)(?::(\w+))?$/.exec(u.pathname);
      if (!m) return new Response("not found", { status: 404 });
      const name = m[1] ?? "";
      const action = m[2];
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (method === "PUT") {
        if (server.subscriptions.has(name)) {
          return Response.json({ error: { code: 409, status: "ALREADY_EXISTS" } }, { status: 409 });
        }
        server.subscriptions.set(name, { name, ...body });
        return Response.json({ name, ...body });
      }
      if (method === "DELETE") {
        server.subscriptions.delete(name);
        return new Response(null, { status: 200 });
      }
      if (action === "modifyPushConfig") {
        const sub = server.subscriptions.get(name);
        if (!sub) return new Response("not found", { status: 404 });
        sub.pushConfig = body.pushConfig;
        return Response.json({});
      }
      if (action === "pull") {
        if (!server.subscriptions.has(name)) return new Response("not found", { status: 404 });
        const max = Number(body.maxMessages ?? 10);
        // Like the real endpoint, a pull waits a while for a message before answering empty.
        if (server.pullQueue.length === 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              pullWaiters.delete(wake);
              resolve();
            }, 100);
            const wake = () => {
              clearTimeout(timer);
              resolve();
            };
            pullWaiters.add(wake);
          });
        }
        const batch = server.pullQueue.splice(0, max);
        return Response.json({
          receivedMessages: batch.map((msg) => ({
            ackId: `ack-${msg.messageId}`,
            message: { data: msg.data, messageId: msg.messageId },
          })),
        });
      }
      if (action === "acknowledge") {
        server.acked.push(...((body.ackIds as string[]) ?? []));
        return Response.json({});
      }
      return new Response("not found", { status: 404 });
    }

    if (u.host !== "gmail.googleapis.com") return new Response("not found", { status: 404 });
    if (server.expireNext > 0) {
      server.expireNext -= 1;
      return Response.json(
        { error: { code: 401, message: "Invalid Credentials", errors: [{ reason: "authError" }] } },
        { status: 401 },
      );
    }
    if (!authenticated) {
      return Response.json(
        { error: { code: 401, message: "Invalid Credentials", errors: [{ reason: "authError" }] } },
        { status: 401 },
      );
    }
    if (server.rateLimitNext > 0) {
      server.rateLimitNext -= 1;
      return Response.json(
        {
          error: {
            code: 429,
            message: "Too many requests",
            errors: [{ reason: "rateLimitExceeded" }],
          },
        },
        { status: 429 },
      );
    }
    if (server.quotaRefuseNext > 0) {
      server.quotaRefuseNext -= 1;
      return Response.json(
        {
          error: {
            code: 403,
            message:
              "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user'",
            errors: [{ reason: "rateLimitExceeded" }],
          },
        },
        { status: 403 },
      );
    }

    // Multipart batch.
    if (u.pathname === "/batch/gmail/v1") {
      const boundary = /boundary=([^;]+)/.exec(headers.get("content-type") ?? "")?.[1] ?? "";
      const text = String(init?.body ?? "");
      const responses: string[] = [];
      server.batchSizes.push(
        text.split(`--${boundary}`).filter((p) => /^(GET|POST) \S+ HTTP\/1\.1/m.test(p)).length,
      );
      for (const part of text.split(`--${boundary}`)) {
        const request = /^(GET|POST) (\S+) HTTP\/1\.1/m.exec(part);
        if (!request) continue;
        const id = /Content-ID:\s*<([^>]+)>/i.exec(part)?.[1] ?? "";
        const inner = new URL(`https://gmail.googleapis.com${request[2]}`);
        if (server.concurrencyRefuseParts > 0 && /\/messages\/[^/]+$/.test(inner.pathname)) {
          server.concurrencyRefuseParts -= 1;
          responses.push(
            `--batch_out\r\nContent-Type: application/http\r\nContent-ID: <response-${id}>\r\n\r\nHTTP/1.1 429 Too Many Requests\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ error: { code: 429, message: "Too many concurrent requests for user.", errors: [{ message: "Too many concurrent requests for user.", domain: "global", reason: "rateLimitExceeded" }], status: "RESOURCE_EXHAUSTED" } })}\r\n`,
          );
          continue;
        }
        if (server.quotaRefuseParts > 0 && /\/messages\/[^/]+$/.test(inner.pathname)) {
          server.quotaRefuseParts -= 1;
          responses.push(
            `--batch_out\r\nContent-Type: application/http\r\nContent-ID: <response-${id}>\r\n\r\nHTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ error: { code: 403, message: "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user'", errors: [{ reason: "rateLimitExceeded" }] } })}\r\n`,
          );
          continue;
        }
        const response = await gmail(request[1] ?? "GET", inner, undefined, headers, log);
        responses.push(
          `--batch_out\r\nContent-Type: application/http\r\nContent-ID: <response-${id}>\r\n\r\nHTTP/1.1 ${response.status} OK\r\nContent-Type: application/json\r\n\r\n${await response.text()}\r\n`,
        );
      }
      return new Response(`${responses.join("")}--batch_out--\r\n`, {
        status: 200,
        headers: { "content-type": "multipart/mixed; boundary=batch_out" },
      });
    }

    // Resumable upload.
    const uploadStart =
      /^\/upload\/gmail\/v1\/users\/me\/(messages\/send|drafts\/send|drafts(?:\/[^/]+)?)$/.exec(
        u.pathname,
      );
    if (uploadStart && u.searchParams.get("uploadType") === "resumable") {
      const target = uploadStart[1] ?? "";
      if (target.startsWith("drafts/") && target !== "drafts/send") {
        if (method !== "PUT") return new Response("method", { status: 405 });
        if (!server.drafts.has(decodeURIComponent(target.slice(7)))) {
          return Response.json(
            { error: { code: 404, message: "not found", errors: [{ reason: "notFound" }] } },
            { status: 404 },
          );
        }
      }
      counter += 1;
      const session = `https://gmail.googleapis.com/upload/session/${counter}`;
      uploads.set(session, {
        metadata: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
        received: [],
        total: Number(headers.get("x-upload-content-length") ?? 0),
        path: target,
      });
      log(
        target === "messages/send"
          ? GMAIL_COST["messages.send"]
          : target === "drafts/send"
            ? GMAIL_COST["drafts.send"]
            : target === "drafts"
              ? GMAIL_COST["drafts.create"]
              : GMAIL_COST["drafts.update"],
      );
      return new Response(null, { status: 200, headers: { location: session } });
    }
    if (u.pathname.startsWith("/upload/session/")) {
      const session = uploads.get(`https://gmail.googleapis.com${u.pathname}`);
      if (!session) return new Response("no session", { status: 404 });
      const chunk = new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer());
      session.received.push(chunk);
      server.uploadChunks.push(chunk.byteLength);
      const range = /bytes (\d+)-(\d+)\/(\d+)/.exec(headers.get("content-range") ?? "");
      const end = Number(range?.[2] ?? 0);
      const total = Number(range?.[3] ?? session.total);
      if (end + 1 < total)
        return new Response(null, { status: 308, headers: { range: `bytes=0-${end}` } });
      const all = new Uint8Array(session.received.reduce((n, c) => n + c.byteLength, 0));
      let offset = 0;
      for (const c of session.received) {
        all.set(c, offset);
        offset += c.byteLength;
      }
      const meta = session.metadata;
      const threadId =
        (meta.threadId as string | undefined) ??
        (meta.message as { threadId?: string } | undefined)?.threadId ??
        null;
      if (session.path === "drafts") {
        return Response.json(writeDraft(all, threadId, null, "resumable"));
      }
      if (session.path.startsWith("drafts/") && session.path !== "drafts/send") {
        return Response.json(
          writeDraft(all, threadId, decodeURIComponent(session.path.slice(7)), "resumable"),
        );
      }
      const draftId = session.path === "drafts/send" ? String(meta.id) : null;
      return Response.json(recordSend(all, threadId, draftId, "resumable"));
    }

    return gmail(method, u, init, headers, log);
  }

  return server;
}
