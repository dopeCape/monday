// Why routing put a Thread where it is, in plain words, for the Routing
// page's "Recently routed": moved by the user (a correction), placed by the
// rule sentence with the model's Confidence, or matched by one of the
// Group's Predicate facts, which is found here over the Thread's headers
// (the same facts routing reads, never the body). The words are
// strings.routing.why.* Settings, and a Group's Predicate reads as chips
// from strings.routing.pred.*.

import type { Group, Person, Predicate, Settings, ThreadRoute } from "@monday/shared";
import { domainMatches, domainOf, subjectMatches } from "@monday/shared";
import { fill } from "../inbox/triage.ts";

type WhyStrings = Pick<
  Settings,
  | "strings.routing.why.predicate"
  | "strings.routing.why.model"
  | "strings.routing.why.user"
  | "strings.routing.why.rule"
>;

/** The first Predicate fact a Thread's headers meet: a sender, a domain, a subject pattern. */
export function matchedFact(
  predicate: Predicate,
  thread: { participants: readonly Person[]; subject: string },
): string | null {
  const emails = thread.participants.map((p) => p.email.toLowerCase());
  for (const sender of predicate.senders ?? []) {
    if (emails.includes(sender.toLowerCase())) return sender;
  }
  for (const domain of predicate.domains ?? []) {
    if (emails.some((e) => domainMatches(domainOf(e), domain))) return domain;
  }
  for (const pattern of predicate.subjectPatterns ?? []) {
    if (subjectMatches(thread.subject, pattern)) return `"${pattern}"`;
  }
  return null;
}

/** Why a Thread is in its Group: the user's correction, the rule's Confidence, a Predicate fact, or the rule. */
export function whyRouted(
  thread: {
    participants: readonly Person[];
    subject: string;
    group: string | null;
    subgroup: string | null;
  },
  groupsById: ReadonlyMap<string, Pick<Group, "rule">>,
  route: ThreadRoute | null,
  s: WhyStrings,
): string {
  if (route?.by === "user") return s["strings.routing.why.user"];
  for (const id of [thread.subgroup, thread.group]) {
    const g = id ? groupsById.get(id) : undefined;
    const fact = g ? matchedFact(g.rule.predicate, thread) : null;
    if (fact) return fill(s["strings.routing.why.predicate"], { fact });
  }
  const confidence = route?.subgroupConfidence ?? route?.confidence ?? null;
  if (route?.by === "model" && confidence !== null) {
    return fill(s["strings.routing.why.model"], { pct: Math.round(confidence * 100) });
  }
  return s["strings.routing.why.rule"];
}

type PredStrings = Pick<
  Settings,
  | "strings.routing.pred.domain"
  | "strings.routing.pred.sender"
  | "strings.routing.pred.subject"
  | "strings.routing.pred.list"
  | "strings.routing.pred.attachment"
>;

/** A Group's Predicate as worded chips: "Anyone at careers.example.com", "From billing@stripe.com". */
export function predicateChips(p: Predicate, s: PredStrings): string[] {
  return [
    ...(p.domains ?? []).map((value) => fill(s["strings.routing.pred.domain"], { value })),
    ...(p.senders ?? []).map((value) => fill(s["strings.routing.pred.sender"], { value })),
    ...(p.subjectPatterns ?? []).map((value) => fill(s["strings.routing.pred.subject"], { value })),
    ...(p.listIds ?? []).map((value) => fill(s["strings.routing.pred.list"], { value })),
    ...(p.hasAttachment ? [s["strings.routing.pred.attachment"]] : []),
  ];
}
