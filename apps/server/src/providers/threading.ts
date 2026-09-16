// Threading for Providers that have no Threads of their own (IMAP): by
// References and In-Reply-To first, then by normalized subject among recent
// Messages that share a participant, else a fresh Thread keyed by the
// Message's own id. Pure: the lookups are injected so the engine can back them
// with its sync table and tests with a Map.

import type { MessageSummary } from "./types.ts";

/** How far back the subject fallback looks for a Thread to join. */
export const SUBJECT_FALLBACK_DAYS = 90;

const PREFIX = /^\s*((re|fw|fwd|aw|wg|sv|vs|tr|r|rif)\s*(\[\d+\])?\s*:\s*)+/i;
const LIST_TAG = /^\s*\[[^\]]{1,40}\]\s*/;

/** Lowercases, strips reply and forward prefixes, list tags and whitespace. */
export function normalizeSubject(subject: string): string {
  let s = subject.trim();
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s.replace(PREFIX, "").replace(LIST_TAG, "");
    if (s === before) break;
  }
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** True when the subject carries a reply or forward prefix. */
export function isReplySubject(subject: string): boolean {
  return PREFIX.test(subject);
}

export interface ThreadLookup {
  /** The Thread key a Message-ID belongs to, when that Message is known. */
  threadOfMessageId(rfcMessageId: string): Promise<string | null>;
  /**
   * A Thread with this normalized subject whose Messages are newer than
   * `since` and include one of `participants` (lowercased addresses).
   */
  threadOfSubject(
    normalizedSubject: string,
    participants: string[],
    since: Date,
  ): Promise<string | null>;
}

export interface ThreadDecision {
  key: string;
  by: "provider" | "references" | "subject" | "new";
}

/** Lowercased addresses on the Message, minus the Account's own (it is on every Thread). */
export function participantsOf(summary: MessageSummary, ownAddress?: string): string[] {
  const own = ownAddress?.toLowerCase();
  const out = new Set<string>();
  if (summary.from?.email) out.add(summary.from.email.toLowerCase());
  for (const p of [...summary.to, ...summary.cc]) if (p.email) out.add(p.email.toLowerCase());
  if (own) out.delete(own);
  return [...out];
}

/** The key for a Thread that starts with this Message. */
export function freshThreadKey(summary: MessageSummary): string {
  return summary.messageId ? `mid:${summary.messageId}` : `pid:${summary.id}`;
}

export async function resolveThread(
  summary: MessageSummary,
  lookup: ThreadLookup,
  now: Date = new Date(),
  ownAddress?: string,
): Promise<ThreadDecision> {
  if (summary.threadId) return { key: summary.threadId, by: "provider" };

  // In-Reply-To is the most direct pointer; References runs newest to oldest
  // from the end, so a reply to a reply joins the right Thread even when the
  // immediate parent was never synced.
  const candidates: string[] = [];
  if (summary.inReplyTo) candidates.push(summary.inReplyTo);
  for (const ref of [...summary.references].reverse()) {
    if (!candidates.includes(ref)) candidates.push(ref);
  }
  for (const id of candidates) {
    if (summary.messageId && id === summary.messageId) continue;
    const key = await lookup.threadOfMessageId(id);
    if (key) return { key, by: "references" };
  }

  if (isReplySubject(summary.subject)) {
    const normalized = normalizeSubject(summary.subject);
    if (normalized.length > 0) {
      const since = new Date(now.getTime() - SUBJECT_FALLBACK_DAYS * 86_400_000);
      const key = await lookup.threadOfSubject(
        normalized,
        participantsOf(summary, ownAddress),
        since,
      );
      if (key) return { key, by: "subject" };
    }
  }

  return { key: freshThreadKey(summary), by: "new" };
}
