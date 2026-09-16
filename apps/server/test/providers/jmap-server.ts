// An in-memory JMAP server behind a fetch function: enough of RFC 8620 and
// 8621 to exercise the adapter (session, Mailbox/get, Email/query, Email/get
// with result references, Email/changes, Email/queryChanges, Email/set,
// Thread/get, Identity/get, blob upload and download, Email/import,
// EmailSubmission/set with onSuccessUpdateEmail, and an EventSource).

import type { Fixture } from "../../src/providers/fake/fixture.ts";
import type { FetchLike } from "../../src/providers/jmap/client.ts";

interface Email {
  id: string;
  blobId: string;
  threadId: string;
  mailboxIds: Record<string, boolean>;
  keywords: Record<string, boolean>;
  size: number;
  receivedAt: string;
  sentAt: string;
  messageId: string[];
  inReplyTo: string[] | null;
  references: string[] | null;
  from: { name: string; email: string }[];
  to: { name: string; email: string }[];
  cc: { name: string; email: string }[];
  subject: string;
  hasAttachment: boolean;
  preview: string;
  text: string;
  html: string | null;
  headers: Record<string, string>;
  attachments: { name: string; type: string; bytes: Uint8Array }[];
}

interface LogEntry {
  state: number;
  id: string;
  kind: "created" | "updated" | "destroyed";
  before: string[];
  after: string[];
}

export interface JmapServer {
  fetch: FetchLike;
  sessionUrl: string;
  requests: { method: string; url: string; calls: string[] }[];
  emails: Map<string, Email>;
  mailboxId(role: string): string;
  /** Simulates another client. */
  setKeywords(id: string, patch: Record<string, boolean | null>): void;
  move(id: string, mailboxId: string): void;
  destroy(id: string): void;
  /** Makes every stored state uncontinuable. */
  forgetHistory(): void;
  /** Pushes a StateChange (or raw text) to open event streams. */
  push(text?: string): void;
  /** Closes open event streams. */
  dropStreams(): void;
  streams: number;
  submissions: { emailId: string; identityId: string }[];
  useLegacyTypeField: boolean;
}

export function createJmapServer(fixture: Fixture, options: { token?: string } = {}): JmapServer {
  const token = options.token ?? "secret-token";
  const base = "https://jmap.example.test";
  const accountId = "a1";
  const mailboxes = fixture.mailboxes.map((m) => ({
    id: `mb-${m.role}`,
    name: m.name,
    parentId: null,
    role: m.role,
  }));
  const mailboxId = (role: string) => {
    const found = mailboxes.find((m) => m.role === role);
    if (!found) throw new Error(`no mailbox ${role}`);
    return found.id;
  };
  const emails = new Map<string, Email>();
  const blobs = new Map<string, { bytes: Uint8Array; type: string }>();
  let state = 0;
  let log: LogEntry[] = [];
  let counter = 0;
  const record = (id: string, kind: LogEntry["kind"], before: string[], after: string[]) => {
    state += 1;
    log.push({ state, id, kind, before, after });
  };
  const encoder = new TextEncoder();

  for (const m of fixture.messages) {
    const attachments = m.attachments.map((a) => ({
      name: a.name,
      type: a.mediaType,
      bytes: encoder.encode(a.text),
    }));
    const email: Email = {
      id: m.id,
      blobId: `blob-${m.id}`,
      threadId: m.threadKey,
      mailboxIds: { [mailboxId(m.mailbox)]: true },
      keywords: { ...(m.seen ? { $seen: true } : {}), ...(m.flagged ? { $flagged: true } : {}) },
      size: m.text.length + 400,
      receivedAt: m.date,
      sentAt: m.date,
      messageId: [m.messageId],
      inReplyTo: m.inReplyTo ? [m.inReplyTo] : null,
      references: m.references.length > 0 ? m.references : null,
      from: [{ name: m.from.name, email: m.from.email }],
      to: m.to.map((p) => ({ name: p.name, email: p.email })),
      cc: m.cc.map((p) => ({ name: p.name, email: p.email })),
      subject: m.subject,
      hasAttachment: attachments.length > 0,
      preview: m.text.slice(0, 100),
      text: m.text,
      html: m.html,
      headers: m.headers,
      attachments,
    };
    emails.set(m.id, email);
    record(m.id, "created", [], Object.keys(email.mailboxIds));
  }

  const mailboxesOf = (e: Email) => Object.keys(e.mailboxIds).filter((k) => e.mailboxIds[k]);
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const server: JmapServer = {
    sessionUrl: `${base}/.well-known/jmap`,
    requests: [],
    emails,
    mailboxId,
    submissions: [],
    useLegacyTypeField: false,
    get streams() {
      return streams.size;
    },
    setKeywords(id, patch) {
      const e = emails.get(id);
      if (!e) throw new Error(id);
      for (const [k, v] of Object.entries(patch)) {
        if (v) e.keywords[k] = true;
        else delete e.keywords[k];
      }
      record(id, "updated", mailboxesOf(e), mailboxesOf(e));
    },
    move(id, target) {
      const e = emails.get(id);
      if (!e) throw new Error(id);
      const before = mailboxesOf(e);
      e.mailboxIds = { [target]: true };
      record(id, "updated", before, [target]);
    },
    destroy(id) {
      const e = emails.get(id);
      if (!e) throw new Error(id);
      emails.delete(id);
      record(id, "destroyed", mailboxesOf(e), []);
    },
    forgetHistory() {
      log = [];
      state += 1;
    },
    push(text) {
      const change =
        text ??
        JSON.stringify({
          [server.useLegacyTypeField ? "type" : "@type"]: "StateChange",
          changed: { [accountId]: { Email: String(state), EmailDelivery: String(state) } },
        });
      const frame = encoder.encode(`event: state\ndata: ${change}\n\n`);
      for (const c of streams) c.enqueue(frame);
    },
    dropStreams() {
      for (const c of streams) c.close();
      streams.clear();
    },
    fetch: async (url, init) => {
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      const entry = { method, url, calls: [] as string[] };
      server.requests.push(entry);
      if (headers.get("authorization") !== `Bearer ${token}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const u = new URL(url);
      if (u.pathname === "/.well-known/jmap") {
        return Response.json({
          capabilities: {
            "urn:ietf:params:jmap:core": {
              maxSizeUpload: 50_000_000,
              maxConcurrentUpload: 4,
              maxSizeRequest: 10_000_000,
              maxConcurrentRequests: 4,
              maxCallsInRequest: 16,
              maxObjectsInGet: 500,
              maxObjectsInSet: 500,
            },
            "urn:ietf:params:jmap:mail": {},
            "urn:ietf:params:jmap:submission": { maxDelayedSend: 0, submissionExtensions: {} },
          },
          accounts: {
            [accountId]: { name: fixture.address, isPersonal: true, accountCapabilities: {} },
          },
          primaryAccounts: {
            "urn:ietf:params:jmap:mail": accountId,
            "urn:ietf:params:jmap:submission": accountId,
          },
          username: fixture.address,
          apiUrl: `${base}/api`,
          downloadUrl: `${base}/download/{accountId}/{blobId}/{name}?type={type}`,
          uploadUrl: `${base}/upload/{accountId}`,
          eventSourceUrl: `${base}/events?types={types}&closeafter={closeafter}&ping={ping}`,
          state: "s0",
        });
      }
      if (u.pathname.startsWith("/upload/")) {
        counter += 1;
        const blobId = `up-${counter}`;
        const bytes = new Uint8Array(await new Response(init?.body as BodyInit).arrayBuffer());
        blobs.set(blobId, {
          bytes,
          type: headers.get("content-type") ?? "application/octet-stream",
        });
        return Response.json({
          accountId,
          blobId,
          type: blobs.get(blobId)?.type,
          size: bytes.length,
        });
      }
      if (u.pathname.startsWith("/download/")) {
        const [, , , blobId] = u.pathname.split("/");
        for (const e of emails.values()) {
          for (const [index, a] of e.attachments.entries()) {
            if (`${e.blobId}-att-${index}` === blobId) return new Response(a.bytes);
          }
        }
        const blob = blobs.get(blobId ?? "");
        return blob ? new Response(blob.bytes) : new Response("no", { status: 404 });
      }
      if (u.pathname === "/events") {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            streams.add(controller);
            controller.enqueue(encoder.encode("event: ping\ndata: {}\n\n"));
          },
          cancel() {},
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (u.pathname !== "/api") return new Response("not found", { status: 404 });

      const body = JSON.parse(String(init?.body)) as {
        methodCalls: [string, Record<string, unknown>, string][];
      };
      const responses: [string, Record<string, unknown>, string][] = [];
      const created: Record<string, { id: string }> = {};
      const resolveRefs = (args: Record<string, unknown>) => {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(args)) {
          if (k.startsWith("#")) {
            const ref = v as { resultOf: string; name: string; path: string };
            const source = responses.find((r) => r[2] === ref.resultOf && r[0] === ref.name);
            const path = ref.path.replace(/^\//, "");
            out[k.slice(1)] = source ? (source[1] as Record<string, unknown>)[path] : null;
          } else out[k] = v;
        }
        return out;
      };
      for (const [name, rawArgs, callId] of body.methodCalls) {
        entry.calls.push(name);
        const args = resolveRefs(rawArgs);
        const reply = (result: Record<string, unknown>) => responses.push([name, result, callId]);
        const error = (type: string) => responses.push(["error", { type }, callId]);
        switch (name) {
          case "Mailbox/get":
            reply({
              accountId,
              state: String(state),
              list: mailboxes.map((m) => ({
                ...m,
                totalEmails: [...emails.values()].filter((e) => e.mailboxIds[m.id]).length,
                unreadEmails: [...emails.values()].filter(
                  (e) => e.mailboxIds[m.id] && !e.keywords.$seen,
                ).length,
              })),
              notFound: [],
            });
            break;
          case "Email/query": {
            const filter = args.filter as { inMailbox?: string };
            const list = [...emails.values()]
              .filter((e) => !filter.inMailbox || e.mailboxIds[filter.inMailbox])
              .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
            const position = Number(args.position ?? 0);
            const limit = Number(args.limit ?? list.length);
            reply({
              accountId,
              queryState: `q${state}`,
              canCalculateChanges: true,
              position,
              ids: list.slice(position, position + limit).map((e) => e.id),
              total: list.length,
            });
            break;
          }
          case "Email/get": {
            const ids = (args.ids as string[] | null) ?? [...emails.keys()];
            const properties = (args.properties as string[] | undefined) ?? [];
            const list: Record<string, unknown>[] = [];
            const notFound: string[] = [];
            for (const id of ids) {
              const e = emails.get(id);
              if (!e) {
                notFound.push(id);
                continue;
              }
              list.push(projectEmail(e, properties, args));
            }
            reply({ accountId, state: String(state), list, notFound });
            break;
          }
          case "Email/changes": {
            const since = Number(String(args.sinceState));
            const oldest = log[0]?.state ?? state + 1;
            if (Number.isNaN(since) || since < oldest - 1) {
              error("cannotCalculateChanges");
              break;
            }
            const createdIds = new Set<string>();
            const updated = new Set<string>();
            const destroyed = new Set<string>();
            for (const l of log) {
              if (l.state <= since) continue;
              if (l.kind === "created") createdIds.add(l.id);
              else if (l.kind === "destroyed") {
                destroyed.add(l.id);
                createdIds.delete(l.id);
                updated.delete(l.id);
              } else if (!createdIds.has(l.id)) updated.add(l.id);
            }
            reply({
              accountId,
              oldState: String(since),
              newState: String(state),
              hasMoreChanges: false,
              created: [...createdIds],
              updated: [...updated],
              destroyed: [...destroyed],
            });
            break;
          }
          case "Email/queryChanges": {
            const since = Number(String(args.sinceQueryState).replace(/^q/, ""));
            const oldest = log[0]?.state ?? state + 1;
            if (Number.isNaN(since) || since < oldest - 1) {
              error("cannotCalculateChanges");
              break;
            }
            const filter = args.filter as { inMailbox?: string };
            const mb = filter.inMailbox ?? "";
            const added: { id: string; index: number }[] = [];
            const removed: string[] = [];
            const touched = new Set(log.filter((l) => l.state > since).map((l) => l.id));
            for (const id of touched) {
              const entries = log.filter((l) => l.id === id);
              const before = entries.filter((l) => l.state <= since).at(-1);
              const wasIn = before ? before.after.includes(mb) : false;
              const now = emails.get(id);
              const nowIn = now ? Boolean(now.mailboxIds[mb]) : false;
              if (wasIn && !nowIn) removed.push(id);
              else if (!wasIn && nowIn) added.push({ id, index: 0 });
            }
            reply({
              accountId,
              oldQueryState: `q${since}`,
              newQueryState: `q${state}`,
              added,
              removed,
            });
            break;
          }
          case "Email/set": {
            const update =
              (args.update as Record<string, Record<string, unknown>> | undefined) ?? {};
            const updatedIds: string[] = [];
            const notUpdated: Record<string, { type: string }> = {};
            for (const [id, patch] of Object.entries(update)) {
              const e = emails.get(id);
              if (!e) {
                notUpdated[id] = { type: "notFound" };
                continue;
              }
              const before = mailboxesOf(e);
              applyPatch(e, patch);
              record(id, "updated", before, mailboxesOf(e));
              updatedIds.push(id);
            }
            reply({
              accountId,
              newState: String(state),
              updated: Object.fromEntries(updatedIds.map((id) => [id, null])),
              notUpdated,
            });
            break;
          }
          case "Thread/get": {
            const ids = args.ids as string[];
            reply({
              accountId,
              state: String(state),
              list: ids.map((id) => ({
                id,
                emailIds: [...emails.values()].filter((e) => e.threadId === id).map((e) => e.id),
              })),
              notFound: [],
            });
            break;
          }
          case "Identity/get":
            reply({
              accountId,
              state: "i1",
              list: [{ id: "id1", name: fixture.owner.name, email: fixture.address }],
              notFound: [],
            });
            break;
          case "Email/import": {
            const input = args.emails as Record<
              string,
              {
                blobId: string;
                mailboxIds: Record<string, boolean>;
                keywords: Record<string, boolean>;
              }
            >;
            const out: Record<string, { id: string }> = {};
            for (const [cid, spec] of Object.entries(input)) {
              const blob = blobs.get(spec.blobId);
              if (!blob) continue;
              counter += 1;
              const id = `imp-${counter}`;
              const text = new TextDecoder().decode(blob.bytes);
              const subject = /^subject:\s*(.*)$/im.exec(text)?.[1] ?? "";
              const email: Email = {
                id,
                blobId: spec.blobId,
                threadId: `t-${id}`,
                mailboxIds: { ...spec.mailboxIds },
                keywords: { ...spec.keywords },
                size: blob.bytes.length,
                receivedAt: new Date().toISOString(),
                sentAt: new Date().toISOString(),
                messageId: [`${id}@example.test`],
                inReplyTo: null,
                references: null,
                from: [{ name: fixture.owner.name, email: fixture.address }],
                to: [],
                cc: [],
                subject,
                hasAttachment: false,
                preview: "",
                text,
                html: null,
                headers: {},
                attachments: [],
              };
              emails.set(id, email);
              record(id, "created", [], mailboxesOf(email));
              out[cid] = { id };
              created[`#${cid}`] = { id };
            }
            reply({ accountId, newState: String(state), created: out, notCreated: {} });
            break;
          }
          case "EmailSubmission/set": {
            const create = args.create as Record<string, { emailId: string; identityId: string }>;
            const onSuccess =
              (args.onSuccessUpdateEmail as Record<string, Record<string, unknown>> | undefined) ??
              {};
            const out: Record<string, { id: string }> = {};
            for (const [cid, spec] of Object.entries(create)) {
              const emailId = spec.emailId.startsWith("#")
                ? created[spec.emailId]?.id
                : spec.emailId;
              const e = emailId ? emails.get(emailId) : undefined;
              if (!e) {
                responses.push([
                  name,
                  { accountId, notCreated: { [cid]: { type: "invalidEmail" } } },
                  callId,
                ]);
                continue;
              }
              counter += 1;
              server.submissions.push({ emailId: e.id, identityId: spec.identityId });
              out[cid] = { id: `sub-${counter}` };
              const patch = onSuccess[`#${cid}`];
              if (patch) {
                const before = mailboxesOf(e);
                applyPatch(e, patch);
                record(e.id, "updated", before, mailboxesOf(e));
              }
            }
            reply({ accountId, newState: String(state), created: out });
            break;
          }
          default:
            error("unknownMethod");
        }
      }
      return Response.json({ methodResponses: responses, sessionState: "s0" });
    },
  };
  return server;

  function applyPatch(e: Email, patch: Record<string, unknown>) {
    for (const [key, value] of Object.entries(patch)) {
      if (key === "mailboxIds") e.mailboxIds = { ...(value as Record<string, boolean>) };
      else if (key === "keywords") e.keywords = { ...(value as Record<string, boolean>) };
      else if (key.startsWith("mailboxIds/")) {
        const id = key.slice("mailboxIds/".length);
        if (value === null || value === false) delete e.mailboxIds[id];
        else e.mailboxIds[id] = true;
      } else if (key.startsWith("keywords/")) {
        const k = key.slice("keywords/".length);
        if (value === null || value === false) delete e.keywords[k];
        else e.keywords[k] = true;
      }
    }
  }

  function projectEmail(
    e: Email,
    properties: string[],
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = { id: e.id };
    const want = (p: string) => properties.length === 0 || properties.includes(p);
    for (const p of [
      "blobId",
      "threadId",
      "mailboxIds",
      "keywords",
      "size",
      "receivedAt",
      "sentAt",
      "messageId",
      "inReplyTo",
      "references",
      "from",
      "to",
      "cc",
      "subject",
      "hasAttachment",
      "preview",
    ]) {
      if (want(p)) out[p] = (e as unknown as Record<string, unknown>)[p];
    }
    for (const p of properties) {
      if (p.startsWith("header:")) {
        const name = p
          .slice("header:".length)
          .replace(/:asText$/, "")
          .toLowerCase();
        if (name === "*") {
          out[p] = null;
          for (const [h, v] of Object.entries(e.headers)) out[`header:${h}:asText`] = v;
          out["header:subject:asText"] = e.subject;
          out["header:message-id:asText"] = `<${e.messageId[0]}>`;
        } else out[p] = e.headers[name] ?? null;
      }
    }
    if (
      want("bodyStructure") ||
      want("textBody") ||
      want("htmlBody") ||
      want("bodyValues") ||
      want("attachments")
    ) {
      const textPart = {
        partId: "1",
        blobId: `${e.blobId}-1`,
        size: e.text.length,
        name: null,
        type: "text/plain",
        charset: "utf-8",
        disposition: null,
        cid: null,
      };
      const htmlPart = e.html
        ? {
            partId: "2",
            blobId: `${e.blobId}-2`,
            size: e.html.length,
            name: null,
            type: "text/html",
            charset: "utf-8",
            disposition: null,
            cid: null,
          }
        : null;
      const attachments = e.attachments.map((a, index) => ({
        partId: null,
        blobId: `${e.blobId}-att-${index}`,
        size: a.bytes.length,
        name: a.name,
        type: a.type,
        charset: null,
        disposition: "attachment",
        cid: null,
      }));
      out.textBody = [textPart];
      out.htmlBody = htmlPart ? [htmlPart] : [];
      out.attachments = attachments;
      out.bodyStructure = {
        partId: null,
        blobId: null,
        size: 0,
        name: null,
        type: "multipart/mixed",
        charset: null,
        disposition: null,
        cid: null,
        subParts: [textPart, ...(htmlPart ? [htmlPart] : []), ...attachments],
      };
      const values: Record<string, { value: string; isTruncated: boolean }> = {};
      if (args.fetchTextBodyValues || args.fetchAllBodyValues)
        values["1"] = { value: e.text, isTruncated: false };
      if ((args.fetchHTMLBodyValues || args.fetchAllBodyValues) && e.html)
        values["2"] = { value: e.html, isTruncated: false };
      out.bodyValues = values;
    }
    return out;
  }
}
