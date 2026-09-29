// The Signal request's state (docs/spec/signals.md, "The Signal request"):
// one Thread, built by code, nothing else. The newest Message's own words
// (quoted history and signatures removed), the earlier Messages newest first
// in what room is left, dates in words so the model reads "tomorrow" in
// context without computing with it, and the sender's history as counts code
// computed. Pure, so the state and the text cleaning are testable alone.

import type { JsonValue, Person } from "@monday/shared";

export interface StateMessage {
  from: Person;
  to: Person[];
  cc: Person[];
  /** ISO date. */
  date: string;
  /** The Message's plain text, as stored. */
  text: string;
}

/** What code knows about the sender's past with the owner (Facts, slice 32). */
export interface SenderHistory {
  threadsFromSender: number;
  ownerReplied: number;
  ownerArchivedUnread: number;
  ownerForwardedTo: string[];
}

export interface StateInput {
  owner: Person;
  subject: string;
  /** Oldest first, as the Thread holds them. */
  messages: StateMessage[];
  attachmentNames: string[];
  /** Lowercased list and automation headers of the newest Message. */
  listHeaders: Record<string, string>;
  senderHistory?: SenderHistory | null | undefined;
  /** The Workspace's zone (calendar.time_zone); empty is UTC. */
  timeZone: string;
}

export interface StateLimits {
  /** signals.state.newest_chars */
  newestChars: number;
  /** signals.state.thread_chars */
  threadChars: number;
  /** signals.state.earlier_chars */
  earlierChars: number;
}

const QUOTE_HEADERS = [
  /^On .{4,200}wrote:\s*$/im,
  /^-{2,}\s*Original Message\s*-{2,}\s*$/im,
  /^-{2,}\s*Forwarded message\s*-{2,}\s*$/im,
  /^From: .+\n(?:.*\n){0,3}?(?:Sent|Date): .+$/im,
  /^_{8,}\s*$/m,
];

/**
 * A Message's own words: everything from the first quote header on is cut,
 * `>` lines go, and so does a signature after the `-- ` delimiter. Blank runs
 * collapse. Nothing is summarised or rewritten.
 */
export function ownWords(text: string): string {
  let out = text.replace(/\r\n?/g, "\n");
  let cut = out.length;
  for (const pattern of QUOTE_HEADERS) {
    const m = pattern.exec(out);
    if (m && m.index < cut && m.index > 0) cut = m.index;
  }
  out = out.slice(0, cut);
  const signature = /^-- ?$/m.exec(out);
  if (signature && signature.index > 0) out = out.slice(0, signature.index);
  return out
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A date in words in the Workspace's zone: "Tuesday 29 September 2026". */
export function dateInWords(iso: string, timeZone: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: timeZone || "UTC",
    })
      .format(at)
      .replace(",", "");
  } catch {
    return new Intl.DateTimeFormat("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    })
      .format(at)
      .replace(",", "");
  }
}

const person = (p: Person): JsonValue => ({ name: p.name || null, email: p.email });

/** The state for one Thread, cut to the limits. */
export function signalState(input: StateInput, limits: StateLimits): JsonValue {
  const ownerAddress = input.owner.email.toLowerCase();
  const newest = input.messages[input.messages.length - 1] ?? null;
  const newestText = newest ? ownWords(newest.text).slice(0, Math.max(0, limits.newestChars)) : "";
  let room = Math.max(0, limits.threadChars - newestText.length);
  const earlier: JsonValue[] = [];
  for (let i = input.messages.length - 2; i >= 0 && room > 0; i--) {
    const m = input.messages[i] as StateMessage;
    const text = ownWords(m.text).slice(0, Math.min(limits.earlierChars, room));
    if (!text) continue;
    room -= text.length;
    earlier.push({ from: person(m.from), written: dateInWords(m.date, input.timeZone), text });
  }
  const thread: Record<string, JsonValue> = {
    subject: input.subject,
    message_count: input.messages.length,
    owner_wrote_last: newest !== null && newest.from.email.toLowerCase() === ownerAddress,
    attachment_names: input.attachmentNames,
    list_headers: input.listHeaders,
    newest_message: newest
      ? {
          from: person(newest.from),
          to: newest.to.map(person),
          cc: newest.cc.map(person),
          written: dateInWords(newest.date, input.timeZone),
          text: newestText,
        }
      : null,
    earlier_messages: earlier,
  };
  const state: Record<string, JsonValue> = {
    owner: { name: input.owner.name || null, address: input.owner.email },
    thread,
  };
  if (input.senderHistory) {
    state.sender_history = {
      threads_from_sender: input.senderHistory.threadsFromSender,
      owner_replied: input.senderHistory.ownerReplied,
      owner_archived_unread: input.senderHistory.ownerArchivedUnread,
      owner_forwarded_to: input.senderHistory.ownerForwardedTo,
    };
  }
  return state;
}
