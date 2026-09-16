// Sync tiers per mailbox (research, "Generic IMAP: Incremental sync"): QRESYNC
// when enabled, else CONDSTORE CHANGEDSINCE plus a UID scan for expunges, else
// the RFC 4549 full UID FETCH FLAGS scan. The per-mailbox state token holds
// UIDVALIDITY, HIGHESTMODSEQ and three UID sets (known, seen, flagged) as
// IMAP sequence-set strings, so a 50,000 message folder with contiguous UIDs
// is a few bytes and no server round trip is needed to remember what we saw.

import type { SyncTier } from "../types.ts";

export type ImapTier = Exclude<SyncTier, "state">;

export function chooseTier(
  capabilities: ReadonlySet<string> | ReadonlyMap<string, unknown>,
  enabled: ReadonlySet<string>,
): ImapTier {
  const has = (name: string) => enabled.has(name) || capabilities.has(name);
  if (enabled.has("QRESYNC")) return "qresync";
  if (has("CONDSTORE")) return "condstore";
  return "full-scan";
}

/* ------------------------------ UID sets ------------------------------ */

/** Sorted, deduplicated UIDs to an IMAP sequence set: 1:5,7,9:12. */
export function encodeUidSet(uids: Iterable<number>): string {
  const sorted = [...new Set(uids)].sort((a, b) => a - b);
  const parts: string[] = [];
  let start = -1;
  let prev = -1;
  for (const uid of sorted) {
    if (start < 0) {
      start = uid;
      prev = uid;
      continue;
    }
    if (uid === prev + 1) {
      prev = uid;
      continue;
    }
    parts.push(start === prev ? String(start) : `${start}:${prev}`);
    start = uid;
    prev = uid;
  }
  if (start >= 0) parts.push(start === prev ? String(start) : `${start}:${prev}`);
  return parts.join(",");
}

export function decodeUidSet(set: string): Set<number> {
  const out = new Set<number>();
  if (!set) return out;
  for (const part of set.split(",")) {
    const [a, b] = part.split(":");
    const lo = Number(a);
    const hi = b === undefined ? lo : Number(b);
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) continue;
    for (let uid = Math.min(lo, hi); uid <= Math.max(lo, hi); uid++) out.add(uid);
  }
  return out;
}

export function maxUid(uids: Iterable<number>): number {
  let max = 0;
  for (const uid of uids) if (uid > max) max = uid;
  return max;
}

/* ------------------------------ State token ------------------------------ */

export interface ImapMailboxState {
  v: 1;
  tier: ImapTier;
  uidValidity: string;
  /** HIGHESTMODSEQ as a decimal string; empty for full-scan. */
  modseq: string;
  known: string;
  seen: string;
  flagged: string;
  /** False while the first pass is still paging older mail. */
  complete: boolean;
}

export function decodeImapState(state: string | null): ImapMailboxState | null {
  if (!state) return null;
  try {
    const parsed = JSON.parse(state) as ImapMailboxState;
    return parsed.v === 1 && typeof parsed.uidValidity === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function encodeImapState(state: ImapMailboxState): string {
  return JSON.stringify(state);
}

export function messageIdOf(path: string, uidValidity: string | bigint, uid: number): string {
  return `${path}:${uidValidity}:${uid}`;
}

export function parseMessageId(id: string): { path: string; uidValidity: string; uid: number } {
  const last = id.lastIndexOf(":");
  const middle = id.lastIndexOf(":", last - 1);
  if (last < 0 || middle < 0) throw new RangeError(`not an IMAP message id: ${id}`);
  const uid = Number(id.slice(last + 1));
  if (!Number.isInteger(uid)) throw new RangeError(`not an IMAP message id: ${id}`);
  return { path: id.slice(0, middle), uidValidity: id.slice(middle + 1, last), uid };
}
