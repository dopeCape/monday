// An in-memory Microsoft Graph behind a fetch function: the Entra token and
// discovery endpoints (code exchange with PKCE, refresh, the validation
// probe's AADSTS answers), /me, well-known folders, mailFolders/delta,
// per-folder messages/delta with skip and delta tokens (410 once history is
// forgotten), /$value MIME, PATCH and move, sendMail with the 4 MB limit,
// drafts with createReply, attachments and upload sessions, /send, and
// subscriptions with the validation handshake. Retry-After can be injected.

import type { Fixture, FixtureMessage } from "../../src/providers/fake/fixture.ts";
import type { FetchLike } from "../../src/providers/jmap/client.ts";
import { composeMime } from "../../src/providers/mime.ts";
import { challengeOf } from "../../src/providers/oauth/pkce.ts";

interface Message {
  id: string;
  conversationId: string;
  parentFolderId: string;
  isRead: boolean;
  isDraft: boolean;
  flagged: boolean;
  from: { name: string; email: string };
  to: { name: string; email: string }[];
  cc: { name: string; email: string }[];
  bcc: { name: string; email: string }[];
  subject: string;
  sentDateTime: string;
  receivedDateTime: string;
  internetMessageId: string;
  headers: Record<string, string>;
  text: string;
  html: string | null;
  attachments: {
    name: string;
    contentType: string;
    bytes: Uint8Array;
    isInline: boolean;
    contentId: string | null;
  }[];
  raw: Uint8Array | null;
}

interface LogEntry {
  seq: number;
  folderId: string;
  messageId: string;
  removed: boolean;
}

export interface GraphRequest {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
}

export interface GraphServerOptions {
  clientId?: string;
  tenant?: string;
  address?: string;
}

export interface GraphServer {
  fetch: FetchLike;
  requests: GraphRequest[];
  messages: Map<string, Message>;
  folders: {
    id: string;
    displayName: string;
    wellKnown: string | null;
    parentFolderId: string | null;
  }[];
  accessToken: string;
  refreshToken: string;
  refreshes: number;
  /** Answer 429 with Retry-After to the next n Graph calls. */
  throttleNext: number;
  retryAfterSeconds: number;
  /** Answer 401 to the next n Graph calls. */
  expireNext: number;
  /** Bytes of every upload session range PUT. */
  uploadRanges: number[];
  sent: {
    via: "sendMail" | "send";
    draftId: string | null;
    raw: Uint8Array | null;
    message: Message | null;
  }[];
  subscriptions: Map<string, Record<string, unknown>>;
  /** Highest concurrent in-flight Graph requests seen. */
  maxConcurrent: number;
  /** The handshake Graph performs against notificationUrl; tests point it at the app. */
  validate: ((url: string) => Promise<boolean>) | null;
  issueCode(redirectUri: string, challenge: string): string;
  deliver(message: FixtureMessage): void;
  setRead(id: string, isRead: boolean): void;
  move(id: string, folderId: string): void;
  destroy(id: string): void;
  forgetHistory(): void;
  folderId(wellKnown: "inbox" | "sentitems" | "deleteditems" | "archive" | "drafts"): string;
}

const FOLDER_OF_ROLE: Record<string, string> = {
  inbox: "inbox",
  sent: "sentitems",
  trash: "deleteditems",
  archive: "archive",
};

export function createGraphServer(fixture: Fixture, options: GraphServerOptions = {}): GraphServer {
  const clientId = options.clientId ?? "12345678-1234-1234-1234-123456789abc";
  const tenant = options.tenant ?? "consumers";
  const address = options.address ?? fixture.address;
  const messages = new Map<string, Message>();
  let log: LogEntry[] = [];
  let seq = 0;
  let oldest = 0;
  let counter = 0;
  let inFlight = 0;
  const encoder = new TextEncoder();
  const codes = new Map<string, { redirectUri: string; challenge: string }>();
  const uploadSessions = new Map<
    string,
    {
      messageId: string;
      name: string;
      contentType: string;
      received: Uint8Array[];
      isInline: boolean;
      contentId: string | null;
    }
  >();

  const folders: GraphServer["folders"] = [
    { id: "f-inbox", displayName: "Inbox", wellKnown: "inbox", parentFolderId: null },
    { id: "f-drafts", displayName: "Drafts", wellKnown: "drafts", parentFolderId: null },
    { id: "f-sent", displayName: "Sent Items", wellKnown: "sentitems", parentFolderId: null },
    {
      id: "f-deleted",
      displayName: "Deleted Items",
      wellKnown: "deleteditems",
      parentFolderId: null,
    },
    { id: "f-junk", displayName: "Junk Email", wellKnown: "junkemail", parentFolderId: null },
    { id: "f-archive", displayName: "Archive", wellKnown: "archive", parentFolderId: null },
    { id: "f-projects", displayName: "Projects", wellKnown: null, parentFolderId: null },
    { id: "f-projects-2026", displayName: "2026", wellKnown: null, parentFolderId: "f-projects" },
  ];
  const folderId = (wellKnown: string) => {
    const f = folders.find((x) => x.wellKnown === wellKnown);
    if (!f) throw new Error(wellKnown);
    return f.id;
  };

  const record = (m: Pick<Message, "id" | "parentFolderId">, removed: boolean) => {
    seq += 1;
    log.push({ seq, folderId: m.parentFolderId, messageId: m.id, removed });
  };

  function add(m: FixtureMessage): Message {
    const message: Message = {
      id: m.id,
      conversationId: m.threadKey,
      parentFolderId: folderId(FOLDER_OF_ROLE[m.mailbox] ?? "inbox"),
      isRead: m.seen,
      isDraft: false,
      flagged: m.flagged,
      from: m.from,
      to: m.to,
      cc: m.cc,
      bcc: [],
      subject: m.subject,
      sentDateTime: m.date,
      receivedDateTime: m.date,
      internetMessageId: `<${m.messageId}>`,
      headers: {
        ...m.headers,
        ...(m.inReplyTo ? { "in-reply-to": `<${m.inReplyTo}>` } : {}),
        ...(m.references.length > 0
          ? { references: m.references.map((r) => `<${r}>`).join(" ") }
          : {}),
      },
      text: m.text,
      html: m.html,
      attachments: m.attachments.map((a) => ({
        name: a.name,
        contentType: a.mediaType,
        bytes: encoder.encode(a.text),
        isInline: false,
        contentId: null,
      })),
      raw: null,
    };
    messages.set(message.id, message);
    return message;
  }
  for (const m of fixture.messages) add(m);

  async function rawOf(m: Message): Promise<Uint8Array> {
    if (m.raw) return m.raw;
    m.raw = await composeMime({
      from: m.from,
      to: m.to,
      cc: m.cc,
      subject: m.subject,
      text: m.text,
      html: m.html,
      messageId: m.internetMessageId.replace(/^<|>$/g, ""),
      inReplyTo: m.headers["in-reply-to"]?.replace(/^<|>$/g, "") ?? null,
      date: new Date(m.sentDateTime),
      attachments: m.attachments.map((a) => ({
        name: a.name,
        mediaType: a.contentType,
        bytes: a.bytes,
      })),
    });
    return m.raw;
  }

  const recipient = (p: { name: string; email: string }) => ({
    emailAddress: { name: p.name, address: p.email },
  });

  function resource(m: Message): Record<string, unknown> {
    return {
      id: m.id,
      conversationId: m.conversationId,
      parentFolderId: m.parentFolderId,
      isRead: m.isRead,
      isDraft: m.isDraft,
      flag: { flagStatus: m.flagged ? "flagged" : "notFlagged" },
      from: recipient(m.from),
      toRecipients: m.to.map(recipient),
      ccRecipients: m.cc.map(recipient),
      subject: m.subject,
      sentDateTime: m.sentDateTime,
      receivedDateTime: m.receivedDateTime,
      internetMessageId: m.internetMessageId,
      hasAttachments: m.attachments.some((a) => !a.isInline),
      bodyPreview: m.text.slice(0, 100),
      internetMessageHeaders: [
        { name: "Message-ID", value: m.internetMessageId },
        ...Object.entries(m.headers).map(([name, value]) => ({ name, value })),
      ],
    };
  }

  const server: GraphServer = {
    requests: [],
    messages,
    folders,
    accessToken: "ms-access-0",
    refreshToken: "ms-refresh-0",
    refreshes: 0,
    throttleNext: 0,
    retryAfterSeconds: 2,
    expireNext: 0,
    uploadRanges: [],
    sent: [],
    subscriptions: new Map(),
    maxConcurrent: 0,
    validate: null,
    issueCode(redirectUri, challenge) {
      counter += 1;
      const code = `ms-code-${counter}`;
      codes.set(code, { redirectUri, challenge });
      return code;
    },
    deliver(message) {
      record(add(message), false);
    },
    setRead(id, isRead) {
      const m = messages.get(id);
      if (!m) throw new Error(id);
      m.isRead = isRead;
      record(m, false);
    },
    move(id, target) {
      const m = messages.get(id);
      if (!m) throw new Error(id);
      record(m, true);
      m.parentFolderId = target;
      record(m, false);
    },
    destroy(id) {
      const m = messages.get(id);
      if (!m) throw new Error(id);
      messages.delete(id);
      record(m, true);
    },
    forgetHistory() {
      log = [];
      seq += 1;
      oldest = seq;
    },
    folderId: (wellKnown) => folderId(wellKnown),
    fetch: async (url, init) => {
      inFlight += 1;
      server.maxConcurrent = Math.max(server.maxConcurrent, inFlight);
      try {
        // Let concurrent callers overlap so the semaphore is observable.
        await new Promise((r) => setTimeout(r, 1));
        return await handle(url, init);
      } finally {
        inFlight -= 1;
      }
    },
  };

  const odataError = (
    status: number,
    code: string,
    message = code,
    headers: Record<string, string> = {},
  ) => Response.json({ error: { code, message } }, { status, headers });

  function deltaPage(folder: string, u: URL, pageSize: number): Response {
    const skip = u.searchParams.get("$skiptoken");
    const delta = u.searchParams.get("$deltatoken");
    const base = `https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages/delta`;
    if (delta !== null) {
      const since = Number(delta);
      if (Number.isNaN(since) || since < oldest) {
        return odataError(410, "SyncStateNotFound", "The sync state is no longer valid.", {
          location: `${base}?$deltatoken=`,
        });
      }
      // Coalesce per message: the latest entry wins.
      const latest = new Map<string, LogEntry>();
      for (const entry of log)
        if (entry.seq > since && entry.folderId === folder) latest.set(entry.messageId, entry);
      const value = [...latest.values()].map((entry) => {
        const m = messages.get(entry.messageId);
        if (entry.removed || !m || m.parentFolderId !== folder) {
          return { id: entry.messageId, "@removed": { reason: "deleted" } };
        }
        return resource(m);
      });
      return Response.json({ value, "@odata.deltaLink": `${base}?$deltatoken=${seq}` });
    }
    // First pass: page through the folder's messages newest first.
    const [snapshot, offset] = skip ? (skip.split(":").map(Number) as [number, number]) : [seq, 0];
    const list = [...messages.values()]
      .filter((m) => m.parentFolderId === folder)
      .sort((a, b) => b.receivedDateTime.localeCompare(a.receivedDateTime));
    const page = list.slice(offset, offset + pageSize).map(resource);
    const more = offset + pageSize < list.length;
    return Response.json({
      value: page,
      ...(more
        ? { "@odata.nextLink": `${base}?$skiptoken=${snapshot}:${offset + pageSize}` }
        : { "@odata.deltaLink": `${base}?$deltatoken=${snapshot}` }),
    });
  }

  function recordSent(
    via: "sendMail" | "send",
    draftId: string | null,
    raw: Uint8Array | null,
    message: Message | null,
  ) {
    server.sent.push({ via, draftId, raw, message });
    if (message) {
      message.isDraft = false;
      message.parentFolderId = folderId("sentitems");
      record(message, false);
      return;
    }
    if (raw) {
      // saveToSentItems defaults to true: a copy lands in Sent Items.
      counter += 1;
      const text = new TextDecoder().decode(raw);
      const subject = /^subject:\s*(.*)$/im.exec(text)?.[1] ?? "";
      const copy = draftFrom(`sent-${counter}`, {
        subject,
        body: { contentType: "text", content: text },
      });
      copy.isDraft = false;
      copy.parentFolderId = folderId("sentitems");
      copy.raw = raw;
      messages.set(copy.id, copy);
      record(copy, false);
    }
  }

  async function graph(
    method: string,
    u: URL,
    init: RequestInit | undefined,
    headers: Headers,
  ): Promise<Response> {
    const path = u.pathname.replace(/^\/v1\.0\//, "");
    const text = init?.body === undefined ? "" : typeof init.body === "string" ? init.body : "";
    const json = (): Record<string, unknown> =>
      text && headers.get("content-type")?.includes("json")
        ? (JSON.parse(text) as Record<string, unknown>)
        : {};

    if (path === "me")
      return Response.json({ id: "u1", mail: address, userPrincipalName: address });

    const wellKnown = /^me\/mailFolders\/([a-z]+)$/.exec(path);
    if (wellKnown && wellKnown[1] !== "delta") {
      const f = folders.find((x) => x.wellKnown === wellKnown[1]);
      return f
        ? Response.json({ id: f.id, displayName: f.displayName })
        : odataError(404, "ErrorFolderNotFound");
    }
    if (path === "me/mailFolders/delta") {
      return Response.json({
        value: folders.map((f) => ({
          id: f.id,
          displayName: f.displayName,
          parentFolderId: f.parentFolderId,
          totalItemCount: [...messages.values()].filter((m) => m.parentFolderId === f.id).length,
          unreadItemCount: [...messages.values()].filter(
            (m) => m.parentFolderId === f.id && !m.isRead,
          ).length,
        })),
        "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/mailFolders/delta?$deltatoken=1",
      });
    }
    const delta = /^me\/mailFolders\/([^/]+)\/messages\/delta$/.exec(path);
    if (delta) {
      const folder = decodeURIComponent(delta[1] ?? "");
      if (!folders.some((f) => f.id === folder)) return odataError(404, "ErrorFolderNotFound");
      const pageSize = Number(/maxpagesize=(\d+)/.exec(headers.get("prefer") ?? "")?.[1] ?? 50);
      return deltaPage(folder, u, pageSize);
    }
    if (path === "me/messages" && method === "GET") {
      const filter = u.searchParams.get("$filter") ?? "";
      const conv = /conversationId eq '([^']+)'/.exec(filter)?.[1];
      const imid = /internetMessageId eq '([^']+)'/.exec(filter)?.[1];
      const list = [...messages.values()].filter(
        (m) =>
          (!conv || m.conversationId === conv) &&
          (!imid || m.internetMessageId === imid.replace(/''/g, "'")),
      );
      return Response.json({ value: list.map((m) => ({ id: m.id })) });
    }
    if (
      path === "me/messages" &&
      method === "POST" &&
      headers.get("content-type")?.startsWith("text/plain")
    ) {
      // A MIME POST files the message in Drafts as a draft (the 4 MB request limit applies).
      if (text.length > 4 * 1024 * 1024)
        return odataError(413, "ErrorMessageSizeExceeded", "Request too large");
      const raw = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
      const mime = new TextDecoder().decode(raw);
      const head = (mime.split(/\r?\n\r?\n/)[0] ?? "").replace(/\r?\n[ \t]+/g, " ");
      const header = (name: string) =>
        new RegExp(`^${name}:\\s*(.*)$`, "im").exec(head)?.[1]?.trim() ?? "";
      const recipients = (value: string) =>
        value
          .split(",")
          .map((s) => /<([^>]+)>/.exec(s)?.[1] ?? s.trim())
          .filter((email) => email !== "")
          .map((email) => ({ emailAddress: { address: email } }));
      counter += 1;
      const draft = draftFrom(`draft-${counter}`, {
        subject: header("subject"),
        body: {
          contentType: "text",
          content: mime
            .split(/\r?\n\r?\n/)
            .slice(1)
            .join("\n"),
        },
        toRecipients: recipients(header("to")),
        ccRecipients: recipients(header("cc")),
      });
      const messageId = header("message-id");
      if (messageId) draft.internetMessageId = messageId;
      draft.raw = raw;
      messages.set(draft.id, draft);
      record(draft, false);
      return Response.json(resource(draft), { status: 201 });
    }
    if (path === "me/messages" && method === "POST") {
      const body = json();
      counter += 1;
      const draft = draftFrom(`draft-${counter}`, body);
      messages.set(draft.id, draft);
      return Response.json(resource(draft), { status: 201 });
    }
    if (path === "me/sendMail") {
      if (text.length > 4 * 1024 * 1024)
        return odataError(413, "ErrorMessageSizeExceeded", "Request too large");
      if (headers.get("content-type")?.startsWith("text/plain")) {
        const raw = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
        recordSent("sendMail", null, raw, null);
        return new Response(null, { status: 202 });
      }
      return odataError(400, "ErrorInvalidRequest", "JSON sendMail is not modelled here");
    }
    const value = /^me\/messages\/([^/]+)\/\$value$/.exec(path);
    if (value) {
      const m = messages.get(decodeURIComponent(value[1] ?? ""));
      if (!m) return odataError(404, "ErrorItemNotFound");
      return new Response(await rawOf(m), { headers: { "content-type": "text/plain" } });
    }
    const one = /^me\/messages\/([^/]+)$/.exec(path);
    if (one) {
      const m = messages.get(decodeURIComponent(one[1] ?? ""));
      if (!m) return odataError(404, "ErrorItemNotFound");
      if (method === "PATCH") {
        const body = json();
        if (typeof body.isRead === "boolean") m.isRead = body.isRead;
        const flag = body.flag as { flagStatus?: string } | undefined;
        if (flag?.flagStatus) m.flagged = flag.flagStatus === "flagged";
        if (typeof body.subject === "string") m.subject = body.subject;
        const bodyPart = body.body as { contentType?: string; content?: string } | undefined;
        if (bodyPart?.content !== undefined) {
          if (bodyPart.contentType === "html") m.html = bodyPart.content;
          else m.text = bodyPart.content;
        }
        for (const key of ["toRecipients", "ccRecipients", "bccRecipients"] as const) {
          const list = body[key] as
            | { emailAddress: { name?: string; address?: string } }[]
            | undefined;
          if (list) {
            const people = list.map((r) => ({
              name: r.emailAddress.name ?? "",
              email: r.emailAddress.address ?? "",
            }));
            if (key === "toRecipients") m.to = people;
            else if (key === "ccRecipients") m.cc = people;
            else m.bcc = people;
          }
        }
        record(m, false);
        return Response.json(resource(m));
      }
      if (method === "DELETE") {
        messages.delete(m.id);
        record(m, true);
        return new Response(null, { status: 204 });
      }
      return Response.json(resource(m));
    }
    const action =
      /^me\/messages\/([^/]+)\/(move|createReply|send|attachments|attachments\/createUploadSession)$/.exec(
        path,
      );
    if (action) {
      const m = messages.get(decodeURIComponent(action[1] ?? ""));
      if (!m) return odataError(404, "ErrorItemNotFound");
      const body = json();
      switch (action[2]) {
        case "move": {
          const dest = String(body.destinationId ?? "");
          const target = folders.find((f) => f.id === dest || f.wellKnown === dest);
          if (!target) return odataError(404, "ErrorFolderNotFound");
          server.move(m.id, target.id);
          return Response.json(resource(m), { status: 201 });
        }
        case "createReply": {
          counter += 1;
          const reply = draftFrom(`draft-${counter}`, {});
          reply.conversationId = m.conversationId;
          reply.subject = `RE: ${m.subject}`;
          reply.to = [m.from];
          reply.headers["in-reply-to"] = m.internetMessageId;
          messages.set(reply.id, reply);
          return Response.json(resource(reply), { status: 201 });
        }
        case "send": {
          if (!m.isDraft) return odataError(400, "ErrorInvalidRequest", "not a draft");
          recordSent("send", m.id, null, m);
          return new Response(null, { status: 202 });
        }
        case "attachments": {
          const bytes = Uint8Array.from(atob(String(body.contentBytes ?? "")), (c) =>
            c.charCodeAt(0),
          );
          if (text.length > 4 * 1024 * 1024)
            return odataError(413, "ErrorMessageSizeExceeded", "Request too large");
          m.attachments.push({
            name: String(body.name ?? "attachment"),
            contentType: String(body.contentType ?? "application/octet-stream"),
            bytes,
            isInline: body.isInline === true,
            contentId: typeof body.contentId === "string" ? body.contentId : null,
          });
          return Response.json({ id: `att-${m.attachments.length}` }, { status: 201 });
        }
        case "attachments/createUploadSession": {
          const item = body.AttachmentItem as {
            name: string;
            contentType?: string;
            isInline?: boolean;
            contentId?: string;
          };
          counter += 1;
          const uploadUrl = `https://outlook.office.com/api/upload/${counter}`;
          uploadSessions.set(uploadUrl, {
            messageId: m.id,
            name: item.name,
            contentType: item.contentType ?? "application/octet-stream",
            received: [],
            isInline: item.isInline === true,
            contentId: item.contentId ?? null,
          });
          return Response.json(
            { uploadUrl, expirationDateTime: new Date(Date.now() + 3600_000).toISOString() },
            { status: 201 },
          );
        }
      }
    }
    if (path === "subscriptions" && method === "POST") {
      const body = json();
      const notificationUrl = String(body.notificationUrl ?? "");
      const lifecycleUrl = body.lifecycleNotificationUrl
        ? String(body.lifecycleNotificationUrl)
        : null;
      if (!notificationUrl.startsWith("https://")) {
        return odataError(400, "InvalidRequest", "notificationUrl must be https");
      }
      if (server.validate) {
        const ok =
          (await server.validate(notificationUrl)) &&
          (!lifecycleUrl || (await server.validate(lifecycleUrl)));
        if (!ok)
          return odataError(400, "InvalidRequest", "Subscription validation request failed.");
      }
      counter += 1;
      const subscription = { id: `sub-${counter}`, ...body };
      server.subscriptions.set(subscription.id, subscription);
      return Response.json(subscription, { status: 201 });
    }
    const sub = /^subscriptions\/([^/]+)$/.exec(path);
    if (sub) {
      const existing = server.subscriptions.get(decodeURIComponent(sub[1] ?? ""));
      if (!existing) return odataError(404, "ResourceNotFound");
      if (method === "PATCH") {
        const body = json();
        existing.expirationDateTime = body.expirationDateTime;
        existing.renewed = Number(existing.renewed ?? 0) + 1;
        return Response.json(existing);
      }
      if (method === "DELETE") {
        server.subscriptions.delete(String(existing.id));
        return new Response(null, { status: 204 });
      }
      return Response.json(existing);
    }
    return odataError(404, "ResourceNotFound", `no route for ${method} ${path}`);
  }

  function draftFrom(id: string, body: Record<string, unknown>): Message {
    const people = (list: unknown) =>
      ((list as { emailAddress: { name?: string; address?: string } }[] | undefined) ?? []).map(
        (r) => ({
          name: r.emailAddress.name ?? "",
          email: r.emailAddress.address ?? "",
        }),
      );
    const bodyPart = body.body as { contentType?: string; content?: string } | undefined;
    const now = new Date().toISOString();
    return {
      id,
      conversationId: `conv-${id}`,
      parentFolderId: folderId("drafts"),
      isRead: true,
      isDraft: true,
      flagged: false,
      from: { name: "", email: address },
      to: people(body.toRecipients),
      cc: people(body.ccRecipients),
      bcc: people(body.bccRecipients),
      subject: String(body.subject ?? ""),
      sentDateTime: now,
      receivedDateTime: now,
      internetMessageId: `<${id}@fake.graph>`,
      headers: {},
      text: bodyPart?.contentType === "html" ? "" : (bodyPart?.content ?? ""),
      html: bodyPart?.contentType === "html" ? (bodyPart.content ?? null) : null,
      attachments: [],
      raw: null,
    };
  }

  async function handle(url: string, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? "GET";
    const u = new URL(url);
    const headers = new Headers(init?.headers);
    const logged: Record<string, string> = {};
    headers.forEach((v, k) => {
      logged[k] = v;
    });
    server.requests.push({ method, url, path: u.pathname, headers: logged });

    if (u.host === "login.microsoftonline.com") {
      const tenantIn = decodeURIComponent(u.pathname.split("/")[1] ?? "");
      if (u.pathname.endsWith("/.well-known/openid-configuration")) {
        if (tenantIn !== tenant && tenantIn !== "common" && tenantIn !== "organizations") {
          return Response.json(
            {
              error: "invalid_tenant",
              error_description: `AADSTS90002: Tenant '${tenantIn}' not found.`,
            },
            { status: 400 },
          );
        }
        return Response.json({
          issuer: `https://login.microsoftonline.com/${tenantIn}/v2.0`,
          token_endpoint: `https://login.microsoftonline.com/${tenantIn}/oauth2/v2.0/token`,
        });
      }
      if (u.pathname.endsWith("/oauth2/v2.0/token")) {
        const form = new URLSearchParams(String(init?.body ?? ""));
        const fail = (status: number, error: string, description: string) =>
          Response.json({ error, error_description: description }, { status });
        if (tenantIn !== tenant && tenantIn !== "common" && tenantIn !== "organizations") {
          return fail(400, "invalid_request", `AADSTS90002: Tenant '${tenantIn}' not found.`);
        }
        if (form.get("client_id") !== clientId) {
          return fail(
            400,
            "unauthorized_client",
            `AADSTS700016: Application with identifier '${form.get("client_id")}' was not found in the directory.`,
          );
        }
        if (form.get("client_secret")) {
          return fail(
            401,
            "invalid_client",
            "AADSTS7000218: The request body must contain the following parameter: 'client_assertion' or 'client_secret'.",
          );
        }
        const grant = form.get("grant_type");
        if (grant === "authorization_code") {
          const issued = codes.get(form.get("code") ?? "");
          if (!issued)
            return fail(
              400,
              "invalid_grant",
              "AADSTS70000: The provided authorization code is malformed or invalid.",
            );
          if (issued.redirectUri !== form.get("redirect_uri"))
            return fail(400, "invalid_grant", "AADSTS50011: redirect_uri mismatch");
          if ((await challengeOf(form.get("code_verifier") ?? "")) !== issued.challenge) {
            return fail(
              400,
              "invalid_grant",
              "AADSTS501481: The Code_Verifier does not match the code_challenge supplied in the authorization request.",
            );
          }
          codes.delete(form.get("code") ?? "");
          counter += 1;
          server.accessToken = `ms-access-${counter}`;
          server.refreshToken = `ms-refresh-${counter}`;
          return Response.json({
            access_token: server.accessToken,
            refresh_token: server.refreshToken,
            expires_in: 3600,
            scope: form.get("scope") ?? "",
            token_type: "Bearer",
          });
        }
        if (grant === "refresh_token") {
          if (form.get("refresh_token") !== server.refreshToken)
            return fail(400, "invalid_grant", "AADSTS70008: The refresh token has expired.");
          server.refreshes += 1;
          counter += 1;
          server.accessToken = `ms-access-${counter}`;
          server.refreshToken = `ms-refresh-${counter}`;
          return Response.json({
            access_token: server.accessToken,
            refresh_token: server.refreshToken,
            expires_in: 3600,
            token_type: "Bearer",
          });
        }
        return fail(400, "unsupported_grant_type", grant ?? "");
      }
      return new Response("not found", { status: 404 });
    }

    // Upload session ranges carry no bearer token.
    if (u.host === "outlook.office.com" && u.pathname.startsWith("/api/upload/")) {
      const session = uploadSessions.get(`https://outlook.office.com${u.pathname}`);
      if (!session) return new Response("no session", { status: 404 });
      if (headers.has("authorization"))
        return new Response("no auth allowed here", { status: 400 });
      const chunk = new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer());
      if (chunk.byteLength >= 4 * 1024 * 1024)
        return new Response("range too large", { status: 413 });
      session.received.push(chunk);
      server.uploadRanges.push(chunk.byteLength);
      const range = /bytes (\d+)-(\d+)\/(\d+)/.exec(headers.get("content-range") ?? "");
      const end = Number(range?.[2] ?? 0);
      const total = Number(range?.[3] ?? 0);
      if (end + 1 < total)
        return Response.json({ nextExpectedRanges: [`${end + 1}-${total - 1}`] });
      const all = new Uint8Array(session.received.reduce((n, c) => n + c.byteLength, 0));
      let offset = 0;
      for (const c of session.received) {
        all.set(c, offset);
        offset += c.byteLength;
      }
      messages.get(session.messageId)?.attachments.push({
        name: session.name,
        contentType: session.contentType,
        bytes: all,
        isInline: session.isInline,
        contentId: session.contentId,
      });
      return new Response(null, { status: 201, headers: { location: `${u.toString()}/done` } });
    }

    if (u.host !== "graph.microsoft.com") return new Response("not found", { status: 404 });
    if (server.expireNext > 0) {
      server.expireNext -= 1;
      return odataError(401, "InvalidAuthenticationToken", "Access token has expired.");
    }
    const bearer = headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    if (bearer !== server.accessToken)
      return odataError(401, "InvalidAuthenticationToken", "Bad token");
    if (server.throttleNext > 0) {
      server.throttleNext -= 1;
      return odataError(429, "TooManyRequests", "Too many requests", {
        "retry-after": String(server.retryAfterSeconds),
      });
    }
    return graph(method, u, init, headers);
  }

  return server;
}
