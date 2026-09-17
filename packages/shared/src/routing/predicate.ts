// The Predicate (CONTEXT.md): the structured, model-free part of a rule that
// runs on every Thread at no cost. Matching is over headers only, so the same
// function runs on the Server before the classify call and on a client over
// the Cache. Runtime-neutral.

import type { Person, Predicate } from "../domain.ts";

/** The header facts a Predicate can see. Nothing here is body content. */
export interface PredicateFacts {
  /** The sender of the newest Message, or of the first when that is all that is known. */
  from: Person | null;
  participants: readonly Person[];
  /** The plaintext subject prefix (Thread.subject in the header projection). */
  subject: string;
  hasAttachments: boolean;
  /** Lowercased header names to values, from the Messages routing reads. */
  headers: Readonly<Record<string, string>>;
}

const lower = (s: string) => s.trim().toLowerCase();

export function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at < 0 ? "" : lower(email.slice(at + 1));
}

/** "northwind.test" matches itself and every subdomain. */
export function domainMatches(candidate: string, wanted: string): boolean {
  const c = lower(candidate);
  const w = lower(wanted).replace(/^@/, "");
  return c === w || c.endsWith(`.${w}`);
}

/** A subject pattern is a case-insensitive substring, or a /regex/ when written as one. */
export function subjectMatches(subject: string, pattern: string): boolean {
  const m = /^\/(.+)\/([a-z]*)$/.exec(pattern.trim());
  if (m?.[1] !== undefined) {
    try {
      const flags = m[2] ?? "";
      return new RegExp(m[1], flags.includes("i") ? flags : `${flags}i`).test(subject);
    } catch {
      return false;
    }
  }
  return lower(subject).includes(lower(pattern));
}

function listIdOf(headers: Readonly<Record<string, string>>): string | null {
  const raw = headers["list-id"];
  if (!raw) return null;
  const angled = /<([^>]+)>/.exec(raw);
  return lower(angled?.[1] ?? raw);
}

/** A Predicate with nothing in it matches nothing: an empty rule is not a wildcard. */
export function predicateIsEmpty(p: Predicate): boolean {
  return (
    !p.senders?.length &&
    !p.domains?.length &&
    !p.subjectPatterns?.length &&
    !p.listIds?.length &&
    p.hasAttachment === undefined &&
    !Object.keys(p.headers ?? {}).length
  );
}

/**
 * Whether a Thread satisfies a Predicate. The identity clauses (senders,
 * domains, subject patterns, list ids) are alternatives: "from billing@,
 * receipts@, Stripe or Hetzner" is one Predicate, and a correction that adds
 * a domain widens it. The modifiers (hasAttachment, headers) must hold when
 * set. Senders and domains look at the sender and the other participants,
 * since a Group like Investors is about who is on the Thread, not only who
 * wrote last.
 */
export function matchesPredicate(p: Predicate, facts: PredicateFacts): boolean {
  if (predicateIsEmpty(p)) return false;
  const people = [facts.from, ...facts.participants].filter((x): x is Person => x !== null);
  const emails = people.map((x) => lower(x.email)).filter((e) => e.length > 0);
  const identities: boolean[] = [];
  if (p.senders?.length) {
    const wanted = p.senders.map(lower);
    identities.push(emails.some((e) => wanted.includes(e)));
  }
  if (p.domains?.length) {
    const domains = emails.map(domainOf);
    identities.push(domains.some((d) => p.domains?.some((w) => domainMatches(d, w))));
  }
  if (p.subjectPatterns?.length) {
    identities.push(p.subjectPatterns.some((pat) => subjectMatches(facts.subject, pat)));
  }
  if (p.listIds?.length) {
    const id = listIdOf(facts.headers);
    identities.push(
      id !== null && p.listIds.some((w) => domainMatches(id, w) || id.includes(lower(w))),
    );
  }
  if (identities.length > 0 && !identities.some(Boolean)) return false;
  if (p.hasAttachment !== undefined && facts.hasAttachments !== p.hasAttachment) return false;
  if (p.headers) {
    for (const [name, value] of Object.entries(p.headers)) {
      const have = facts.headers[lower(name)];
      if (have === undefined) return false;
      if (value !== "" && !lower(have).includes(lower(value))) return false;
    }
  }
  return true;
}

/** Whether the headers mark list mail: List-Id, List-Unsubscribe or Precedence bulk/list. */
export function isBulk(headers: Readonly<Record<string, string>>): boolean {
  if (headers["list-id"] || headers["list-unsubscribe"]) return true;
  const precedence = lower(headers.precedence ?? "");
  return precedence === "bulk" || precedence === "list";
}

/** Two Predicates merged: lists unioned without duplicates, scalars from `extra` when set. */
export function mergePredicates(base: Predicate, extra: Predicate): Predicate {
  const union = (a: string[] | undefined, b: string[] | undefined): string[] | undefined => {
    const out = [...new Set([...(a ?? []), ...(b ?? [])].map((s) => s.trim()).filter(Boolean))];
    return out.length ? out : undefined;
  };
  const out: Predicate = {};
  const senders = union(base.senders, extra.senders);
  const domains = union(base.domains, extra.domains);
  const subjectPatterns = union(base.subjectPatterns, extra.subjectPatterns);
  const listIds = union(base.listIds, extra.listIds);
  if (senders) out.senders = senders;
  if (domains) out.domains = domains;
  if (subjectPatterns) out.subjectPatterns = subjectPatterns;
  if (listIds) out.listIds = listIds;
  const hasAttachment = extra.hasAttachment ?? base.hasAttachment;
  if (hasAttachment !== undefined) out.hasAttachment = hasAttachment;
  const headers = { ...(base.headers ?? {}), ...(extra.headers ?? {}) };
  if (Object.keys(headers).length) out.headers = headers;
  return out;
}
