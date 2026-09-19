// MIME in and out for the adapters that move raw RFC 5322 bytes: IMAP and the
// fake's send path. Parsing is postal-mime (pure JS, runs on Bun, Node and
// workers); building is nodemailer's MailComposer. Nothing here knows a wire
// protocol.

import type { Person } from "@monday/shared";
import MailComposer from "nodemailer/lib/mail-composer";
import PostalMime, { type Address, type Email } from "postal-mime";
import {
  type Flags,
  type MessageSummary,
  normalizeMessageId,
  parseReferences,
  type RawAttachment,
  type RawMessage,
} from "./types.ts";

/** Header names sync keeps in the clear on every MessageSummary (routing reads them). */
export const SUMMARY_HEADERS: readonly string[] = [
  "message-id",
  "in-reply-to",
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

export async function parseMime(bytes: Uint8Array | string): Promise<Email> {
  return PostalMime.parse(bytes, { attachmentEncoding: "arraybuffer" });
}

export function personOf(address: Address | undefined | null): Person | null {
  if (!address) return null;
  if (address.group) {
    const first = address.group[0];
    return first ? { name: first.name ?? "", email: first.address ?? "" } : null;
  }
  return { name: address.name ?? "", email: address.address ?? "" };
}

export function peopleOf(addresses: Address[] | undefined): Person[] {
  const out: Person[] = [];
  for (const a of addresses ?? []) {
    if (a.group) {
      for (const m of a.group) out.push({ name: m.name ?? "", email: m.address ?? "" });
    } else {
      out.push({ name: a.name ?? "", email: a.address ?? "" });
    }
  }
  return out;
}

/** Lowercased name to value; repeated headers keep the first occurrence except Received. */
export function headerMap(email: Email): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of email.headers) {
    if (h.key in out) continue;
    out[h.key] = h.value;
  }
  return out;
}

export function pickHeaders(all: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of SUMMARY_HEADERS) {
    const value = all[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

async function* once(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

function attachmentBytes(content: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof content === "string") return new TextEncoder().encode(content);
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

export function rawMessageOf(id: string, email: Email): RawMessage {
  const attachments: RawAttachment[] = email.attachments.map((a, index) => {
    const bytes = attachmentBytes(a.content);
    return {
      name: a.filename ?? `attachment-${index + 1}`,
      mediaType: a.mimeType || "application/octet-stream",
      size: bytes.byteLength,
      contentId: normalizeMessageId(a.contentId),
      inline: a.disposition === "inline",
      content: () => once(bytes),
    };
  });
  return {
    id,
    headers: headerMap(email),
    text: email.text ?? (email.html ? textFromHtml(email.html) : ""),
    html: email.html ?? null,
    attachments,
  };
}

/** A MessageSummary from a parsed message, for adapters that only have raw bytes (the fake's send). */
export function summaryOf(
  id: string,
  email: Email,
  mailboxIds: string[],
  flags: Flags,
  receivedAt: Date,
  size: number,
): MessageSummary {
  const all = headerMap(email);
  const date = email.date ? new Date(email.date) : receivedAt;
  return {
    id,
    threadId: null,
    mailboxIds,
    flags,
    from: personOf(email.from),
    to: peopleOf(email.to),
    cc: peopleOf(email.cc),
    subject: email.subject ?? "",
    date: (Number.isNaN(date.getTime()) ? receivedAt : date).toISOString(),
    receivedAt: receivedAt.toISOString(),
    messageId: normalizeMessageId(email.messageId),
    inReplyTo: normalizeMessageId(email.inReplyTo),
    references: parseReferences(email.references),
    headers: pickHeaders(all),
    size,
    hasAttachments: email.attachments.some((a) => a.disposition !== "inline" || !a.contentId),
    preview: email.text ? snippetOf(email.text) : null,
  };
}

/** Plain text from HTML, good enough for a snippet or a text alternative. */
export function textFromHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

export const SNIPPET_CHARS = 200;

export function snippetOf(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, SNIPPET_CHARS);
}

export interface ComposeInput {
  from: Person;
  to: Person[];
  cc?: Person[];
  bcc?: Person[];
  subject: string;
  text: string;
  html?: string | null;
  inReplyTo?: string | null;
  references?: string[];
  messageId?: string;
  date?: Date;
  attachments?: { name: string; mediaType: string; bytes: Uint8Array }[];
  /** An iTIP part (RFC 6047): text/calendar with its method, beside the text alternative. */
  icalEvent?: { method: string; content: string };
}

function formatPerson(p: Person): string {
  return p.name ? `"${p.name.replace(/"/g, "'")}" <${p.email}>` : p.email;
}

/** Builds RFC 5322 bytes. Used by tests and by callers that own a Draft. */
export async function composeMime(input: ComposeInput): Promise<Uint8Array> {
  const composer = new MailComposer({
    from: formatPerson(input.from),
    to: input.to.map(formatPerson),
    cc: input.cc?.map(formatPerson),
    bcc: input.bcc?.map(formatPerson),
    subject: input.subject,
    text: input.text,
    html: input.html ?? undefined,
    inReplyTo: input.inReplyTo ? `<${input.inReplyTo}>` : undefined,
    references: input.references?.map((r) => `<${r}>`).join(" "),
    messageId: input.messageId ? `<${input.messageId}>` : undefined,
    date: input.date,
    attachments: input.attachments?.map((a) => ({
      filename: a.name,
      contentType: a.mediaType,
      content: Buffer.from(a.bytes),
    })),
    icalEvent: input.icalEvent
      ? { method: input.icalEvent.method, content: input.icalEvent.content, filename: "invite.ics" }
      : undefined,
  });
  const buffer = await composer.compile().build();
  return new Uint8Array(buffer);
}
