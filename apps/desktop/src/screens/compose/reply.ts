// The reply, reply-all and forward rules (ADR 0010), pure so they can be
// tested as data. Reply-all is the default when the last Message had more
// than one recipient besides me; one toggle changes it and the choice is
// remembered per Thread. Quoted history is the answered Message, folded.

import type { DraftAttachment, DraftContent, Message, Person } from "@monday/shared";

export interface ReplyStrings {
  /** "On {date}, {name} wrote:" */
  wrote: string;
  forwarded: string;
}

const sameAddress = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Everyone on a Message other than me, without duplicates. */
export function othersOn(message: Message, me: string): Person[] {
  const seen = new Set<string>();
  const out: Person[] = [];
  for (const p of [message.from, ...message.to, ...message.cc]) {
    const key = p.email.trim().toLowerCase();
    if (!key || sameAddress(p.email, me) || seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/**
 * Whether a reply to `last` should answer everyone: the remembered choice for
 * the Thread wins; else the Setting; else the rule, more than one other
 * recipient on the last Message.
 */
export function shouldReplyAll(
  last: Message,
  me: string,
  options: { remembered: boolean | null; settingDefault: boolean },
): boolean {
  if (options.remembered !== null) return options.remembered;
  if (options.settingDefault) return true;
  return othersOn(last, me).length > 1;
}

export interface ReplyRecipients {
  to: Person[];
  cc: Person[];
}

/** To and Cc for a reply: the sender (or me, when I sent it) to To, the rest to Cc on reply-all. */
export function replyRecipients(last: Message, me: string, replyAll: boolean): ReplyRecipients {
  const mine = sameAddress(last.from.email, me);
  const to: Person[] = mine ? last.to.filter((p) => !sameAddress(p.email, me)) : [last.from];
  if (mine && to.length === 0) to.push(...last.to);
  if (!replyAll) return { to: to.slice(0, 1), cc: [] };
  const inTo = new Set(to.map((p) => p.email.toLowerCase()));
  const cc = othersOn(last, me).filter((p) => !inTo.has(p.email.toLowerCase()));
  return { to, cc };
}

const RE = /^\s*(re|aw|sv|antw)\s*:\s*/i;
const FWD = /^\s*(fwd?|wg|tr)\s*:\s*/i;

export function replySubject(subject: string): string {
  return RE.test(subject) ? subject.trim() : `Re: ${subject.trim()}`;
}

export function forwardSubject(subject: string): string {
  return FWD.test(subject) ? subject.trim() : `Fwd: ${subject.trim()}`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Plain text to the simplest HTML: paragraphs on blank lines, breaks inside. */
export function plainToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .filter((p) => p.trim() !== "")
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function bodyAsHtml(message: Message): string {
  if (message.bodyHtml) return message.bodyHtml;
  return plainToHtml(message.bodyText ?? "");
}

function bodyAsText(message: Message): string {
  if (message.bodyText) return message.bodyText;
  return (message.bodyHtml ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .trim();
}

function personLine(p: Person): string {
  return p.name ? `${p.name} <${p.email}>` : p.email;
}

export interface QuotedHistory {
  html: string;
  text: string;
}

/** The answered Message as folded history, in html and text. */
export function quotedReply(
  message: Message,
  strings: ReplyStrings,
  formatDate: (iso: string) => string,
): QuotedHistory {
  const line = strings.wrote
    .replace("{date}", formatDate(message.date))
    .replace("{name}", personLine(message.from));
  const html = `<div class="quoted"><p>${escapeHtml(line)}</p><blockquote>${bodyAsHtml(message)}</blockquote></div>`;
  const text = `${line}\n${bodyAsText(message)
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n")}`;
  return { html, text };
}

/** The forwarded Message with its header block. */
export function quotedForward(
  message: Message,
  subject: string,
  strings: ReplyStrings,
  formatDate: (iso: string) => string,
): QuotedHistory {
  const headers = [
    `From: ${personLine(message.from)}`,
    `Date: ${formatDate(message.date)}`,
    `Subject: ${subject}`,
    `To: ${message.to.map(personLine).join(", ")}`,
    ...(message.cc.length ? [`Cc: ${message.cc.map(personLine).join(", ")}`] : []),
  ];
  const html = `<div class="quoted"><p>${escapeHtml(`---------- ${strings.forwarded} ----------`)}<br>${headers
    .map(escapeHtml)
    .join("<br>")}</p>${bodyAsHtml(message)}</div>`;
  const text = `---------- ${strings.forwarded} ----------\n${headers.join("\n")}\n\n${bodyAsText(message)}`;
  return { html, text };
}

/** The signature for an Account: its own, else the shared one; as html and text. */
export function signatureFor(
  address: string,
  signatures: Record<string, string>,
  shared: string,
): { html: string; text: string } {
  const key = Object.keys(signatures).find((k) => sameAddress(k, address));
  const text = (key ? signatures[key] : undefined) ?? shared;
  if (!text.trim()) return { html: "", text: "" };
  const html = text
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
  return { html, text };
}

export interface NewDraftOptions {
  threadId: string | null;
  kind: DraftContent["kind"];
  last: Message | null;
  subject: string;
  me: string;
  replyAll: boolean;
  signature: { html: string; text: string };
  strings: ReplyStrings;
  formatDate: (iso: string) => string;
  /** Forward: the original attachments to carry, as uploaded blobs. */
  attachments?: DraftAttachment[];
  /** A Brief chip's proposed opening line; the Draft starts with it, still unsent. */
  opening?: string | undefined;
  /** A Brief chip's forward recipient. */
  to?: Person[] | undefined;
}

/** The content a fresh Draft starts with, per kind. */
export function initialContent(o: NewDraftOptions): DraftContent {
  const opening = o.opening?.trim() ?? "";
  const openingHtml = opening ? `<p>${escapeHtml(opening)}</p>` : "<p></p>";
  const openingText = opening ? `${opening}\n` : "";
  const empty: DraftContent = {
    threadId: o.threadId,
    kind: o.kind,
    inReplyToMessageId: o.last?.id ?? null,
    to: o.to ?? [],
    cc: [],
    bcc: [],
    subject: "",
    bodyHtml: o.signature.html ? `${openingHtml}${o.signature.html}` : opening ? openingHtml : "",
    bodyText: o.signature.text ? `${openingText}\n\n${o.signature.text}` : openingText,
    attachments: o.attachments ?? [],
  };
  if (o.kind === "new" || !o.last) return empty;
  if (o.kind === "reply") {
    const { to, cc } = replyRecipients(o.last, o.me, o.replyAll);
    const quoted = quotedReply(o.last, o.strings, o.formatDate);
    return {
      ...empty,
      to: o.to ?? to,
      cc,
      subject: replySubject(o.subject),
      bodyHtml: `${openingHtml}${o.signature.html}${quoted.html}`,
      bodyText: `${openingText}${o.signature.text ? `\n\n${o.signature.text}` : ""}\n\n${quoted.text}`,
    };
  }
  const subject = forwardSubject(o.subject);
  const quoted = quotedForward(o.last, o.subject, o.strings, o.formatDate);
  return {
    ...empty,
    subject,
    bodyHtml: `${openingHtml}${o.signature.html}${quoted.html}`,
    bodyText: `${openingText}${o.signature.text ? `\n\n${o.signature.text}` : ""}\n\n${quoted.text}`,
  };
}

/** Loose address validation for a typed recipient. */
export function looksLikeAddress(value: string): boolean {
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value.trim());
}

/** "Aoife Brennan <aoife@x.y>" or "aoife@x.y" to a Person, or null. */
export function parseRecipient(value: string): Person | null {
  const m = value.trim().match(/^(?:"?([^"<]*)"?\s*)?<([^<>\s]+)>$/);
  if (m?.[2] && looksLikeAddress(m[2])) return { name: (m[1] ?? "").trim(), email: m[2] };
  if (looksLikeAddress(value)) return { name: "", email: value.trim() };
  return null;
}
