// Recommended actions on the Server (docs/spec/actions.md; slices 34 and 35).
// After every Signal request (and when the reader opens a Thread) this reads
// the Thread's current answers and Facts and works out which actions of the
// catalog it allows, with their arguments assembled by code: the time a
// snooze ends, the person a forward goes to. Only answers of the current
// Question version and the current Thread version are read (stale answers
// are shown in lists but never acted on, ADR 0014); a low-trust Thread gets
// nothing. The result is sealed per Thread (its arguments come from the
// text) and announced on the feed with headers only, like a Brief. The
// thresholds by risk, the switches and the mutes are applied where the chips
// show (chooseRecommended), so a changed Setting shows at once.

import type {
  AiLevel,
  Id,
  Person,
  Recommendation,
  RecommendationArgs,
  RecommendationEventsRequest,
  RecommendationOutcome,
  RecommendationStat,
  RecommendationsChange,
  RecommendedActionKind,
  SignalReading,
  ThreadRecommendations,
} from "@monday/shared";
import {
  actionable,
  chooseRecommended,
  companyOf,
  fillWords,
  isIanaZone,
  isSettingKey,
  RECOMMENDED_ACTIONS,
  recommendationLabel,
  recommendationRules,
  recommendationWords,
  senderMuted,
  settingsSchema,
  utcToZoned,
  zonedToUtc,
} from "@monday/shared";
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, type SQL, sql } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import {
  people,
  recommendationEvents,
  settings as settingsTable,
  threadFacts,
  threadRecommendations,
  threads,
} from "../../db/schema.ts";
import type { Mailstore } from "../../mailstore/index.ts";
import { readGlobalSettings } from "../../settings/read.ts";
import type { ActivityLog } from "../agent/activity.ts";
import type { CalendarSeam } from "../agent/tools/calendar.ts";
import type { WorkflowsSeam } from "../agent/tools/extensions.ts";
import { ACTION_TOOL, type RecommendationView } from "../agent/tools/recommended.ts";
import { assembleDeadline, type DeadlineParts, type SealedFacts } from "../signals/facts.ts";
import type { CandidateSource, SignalCandidates, Signals } from "../signals/index.ts";
import { learnThreshold, useRate } from "./learning.ts";
import { ACTION_SIGNAL, CALENDAR_PARTS, type CalendarPart, calendarPartId } from "./signals.ts";
import { listName, type UnsubscribePlan, unsubscribePlan } from "./unsubscribe.ts";

/* ------------------------------ The pure core ------------------------------ */

export interface RecommendSettings {
  noulLow: number;
  noulHigh: number;
  confidenceBelow: number;
  nonEnglish: "unsure" | "trust";
  /** The zone dates are assembled in. */
  zone: string;
  morningHour: number;
  afternoonHour: number;
  eveningHour: number;
  /** 0 Sunday to 6 Saturday: where "next week" starts. */
  weekStart: number;
  beforeDeadlineHours: number;
}

export interface RecommendInput {
  now: Date;
  /** Every stored answer of the Thread, stale ones marked. */
  answers: Readonly<Record<string, SignalReading>>;
  /** The Thread's clear Facts. */
  facts: Readonly<Record<string, unknown>>;
  /** What the judge picked in the per-Thread Choices, sealed. */
  picks: SealedFacts["picks"];
  /** The people a recipient could be, by address, for their names. */
  people: ReadonlyArray<{ email: string; name: string }>;
  settings: RecommendSettings;
  /** The action's recent use rate, 0 to 1; 1 before it has a history. */
  useRate?: ((kind: RecommendedActionKind) => number) | undefined;
  /** What code found beyond the answers, for the actions of slice 35. */
  context?: RecommendContext | undefined;
}

/** What code found about a Thread beyond its answers (slice 35): the Invite, the list, the subject, the rules. */
export interface RecommendContext {
  /** The Invite on the Thread, with whether the owner answered and what it clashes with. */
  invite?: {
    id: string;
    title: string;
    start: string;
    answered: boolean;
    clash: string | null;
  } | null;
  /** The subject, for an event's title. */
  subject?: string | undefined;
  /** The amount the judge picked, parsed by code (sealed Facts). */
  amount?: { span: string; value: number; currency: string } | null;
  /** The sender's domain and the payment sites a link may be on besides it. */
  senderDomain?: string | null;
  trustedDomains?: readonly string[];
  remindDaysBefore?: number;
  eventMinutes?: number;
  /** The list and how to leave it, when the owner left its latest issues unread. */
  unsubscribe?: {
    listId: string;
    listName: string;
    method: "one_click" | "mailto" | "browser";
    target: string;
    issues: number;
    streak: boolean;
  } | null;
  /** The carriers' tracking pages, {number} in each. */
  carrierUrls?: Readonly<Record<string, string>>;
  /** The Workflows offered, for the picked one's name. */
  workflows?: ReadonlyArray<{ id: string; name: string }>;
  /** Actions the user dismissed on this Thread version ("Not this"). */
  dismissed?: ReadonlySet<RecommendedActionKind>;
  /** The carrier a tracking number was found under (sealed Facts). */
  trackingCarrier?: ((number: string) => string | null) | undefined;
}

/** The registrable part of a domain, roughly: the last two labels, three under a short second level (co.uk). */
export function baseDomain(domain: string): string {
  const labels = domain.toLowerCase().replace(/\.$/, "").split(".");
  if (labels.length <= 2) return labels.join(".");
  const second = labels[labels.length - 2] ?? "";
  const take = second.length <= 3 && (labels[labels.length - 1] ?? "").length === 2 ? 3 : 2;
  return labels.slice(-take).join(".");
}

/**
 * Whether a payment link may be offered (docs/spec/actions.md, Pay or file):
 * on the sender's own domain (or one under the same registrable domain), or
 * on a trusted payment processor's. Anything else is never offered.
 */
export function payLinkAllowed(
  linkDomain: string,
  senderDomain: string | null,
  trusted: readonly string[],
): boolean {
  const d = linkDomain.toLowerCase();
  const under = (base: string) => d === base || d.endsWith(`.${base}`);
  if (senderDomain && under(baseDomain(senderDomain))) return true;
  return trusted.some((t) => {
    const x = t.trim().toLowerCase();
    return x !== "" && under(x);
  });
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** The wall-clock date of an instant in a zone, as a UTC midnight to count days from. */
function dayOf(at: Date, zone: string): Date {
  const p = utcToZoned(zone, at);
  return new Date(Date.UTC(p.y, p.mo - 1, p.d));
}

/** A wall-clock day and hour in a zone as an instant. */
function at(day: Date, hour: number, zone: string): Date {
  return zonedToUtc(
    zone,
    day.getUTCFullYear(),
    day.getUTCMonth() + 1,
    day.getUTCDate(),
    hour,
    0,
    0,
  );
}

const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

/**
 * When a snooze ends, assembled by code from the anchor, weekday and part
 * Choices (docs/spec/actions.md, Snooze): relative days count from the day
 * the newest Message was written, in the Workspace's zone; a part of the day
 * maps to the snooze hours; `deadline` comes back before `deadline_at`. A
 * time already past, an unreadable anchor or one below the confidence floor
 * gives null, and the chip opens the picker.
 */
export function snoozeUntil(input: {
  anchor: { choice: string; confidence: number } | null;
  weekday: { choice: string; confidence: number } | null;
  part: { choice: string; confidence: number } | null;
  deadlineAt: string | null;
  written: Date;
  now: Date;
  settings: RecommendSettings;
}): { until: string | null; anchor: string } {
  const s = input.settings;
  const sure = (p: { choice: string; confidence: number } | null) =>
    p && p.choice !== "none" && p.confidence >= s.confidenceBelow ? p.choice : null;
  const anchor = sure(input.anchor);
  if (!anchor) return { until: null, anchor: "none" };
  const part = sure(input.part);
  const hour =
    part === "afternoon" ? s.afternoonHour : part === "evening" ? s.eveningHour : s.morningHour;
  const zone = s.zone;
  const base = dayOf(input.written, zone);
  let when: Date | null = null;
  if (anchor === "tomorrow") when = at(addDays(base, 1), hour, zone);
  else if (anchor === "weekday") {
    const weekday = sure(input.weekday);
    const want = weekday ? WEEKDAYS.indexOf(weekday) : -1;
    if (want >= 0) {
      const ahead = (want - base.getUTCDay() + 7) % 7 || 7;
      when = at(addDays(base, ahead), hour, zone);
    }
  } else if (anchor === "next_week") {
    const ahead = (s.weekStart - base.getUTCDay() + 7) % 7 || 7;
    when = at(addDays(base, ahead), hour, zone);
  } else if (anchor === "deadline" && input.deadlineAt) {
    when = new Date(Date.parse(input.deadlineAt) - s.beforeDeadlineHours * 3_600_000);
  } else if (anchor === "date" && input.deadlineAt) {
    when = at(dayOf(new Date(input.deadlineAt), zone), hour, zone);
  }
  if (!when || Number.isNaN(when.getTime()) || when.getTime() <= input.now.getTime()) {
    return { until: null, anchor };
  }
  return { until: when.toISOString(), anchor };
}

/**
 * The actions a Thread's current answers and Facts allow, each with its fit
 * and its arguments; no threshold applied (the chips do that). Stale and
 * low-trust answers are never read.
 */
export function recommendFor(input: RecommendInput): Recommendation[] {
  const s = input.settings;
  const read = (id: string): SignalReading | undefined => {
    const r = input.answers[id];
    return actionable(r, { nonEnglish: s.nonEnglish }) ? r : undefined;
  };
  const noul = (id: string): number | null => read(id)?.noul ?? null;
  const choice = (id: string) => {
    const r = read(id);
    return r?.choice ? { choice: r.choice, confidence: r.confidence ?? 0 } : null;
  };
  // A Thread whose text tries to instruct the reader, or that monday cannot read well, gets no judged action.
  const lowTrust = Object.values(input.answers).some(
    (r) =>
      !r.stale &&
      (r.lowTrust === "hidden_instructions" ||
        r.lowTrust === "image_only" ||
        (r.lowTrust === "not_english" && s.nonEnglish === "unsure")),
  );
  const screened = (noul("hidden_instructions") ?? 0) >= s.noulHigh;
  const rate = input.useRate ?? (() => 1);
  const ctx = input.context ?? {};
  const out: Recommendation[] = [];
  const push = (rec: RecommendationArgs & { fit: number }) => {
    if (rec.fit < s.noulLow) return;
    if (ctx.dismissed?.has(rec.kind)) return;
    out.push({ ...rec, rank: Math.round(rec.fit * rate(rec.kind) * 1000) / 1000 });
  };
  const facts = input.facts;

  /* RSVP and Unsubscribe rest on headers and the Invite alone, so low trust does not stop them. */
  const invite = ctx.invite;
  if (invite && !invite.answered && Date.parse(invite.start) > input.now.getTime()) {
    push({
      kind: "rsvp",
      fit: 1,
      inviteId: invite.id,
      title: invite.title,
      start: invite.start,
      clash: invite.clash,
    });
  }
  const list = ctx.unsubscribe;
  if (list?.streak) {
    const newsletter = input.answers.newsletter;
    const isNewsletter =
      (newsletter && !newsletter.stale && (newsletter.noul ?? 0) >= s.noulHigh) ||
      facts.precedence_bulk === true;
    if (isNewsletter) {
      push({
        kind: "unsubscribe",
        fit: 1,
        listId: list.listId,
        listName: list.listName,
        method: list.method,
        target: list.target,
        issues: list.issues,
      });
    }
  }
  if (lowTrust || screened) return out.sort((a, b) => b.rank - a.rank);
  const deadlineAt = typeof facts.deadline_at === "string" ? facts.deadline_at : null;
  const written =
    typeof facts.last_activity_at === "string" ? new Date(facts.last_activity_at) : input.now;

  /* Reply: the shipped needs_reply, no second question. */
  const reply = noul("needs_reply");
  if (reply !== null) push({ kind: "reply", fit: reply });

  /* Archive: nothing on the Thread may still want the owner. */
  const archive = noul(ACTION_SIGNAL.archiveFits);
  if (archive !== null) {
    const clear = (id: string) => {
      const v = noul(id);
      return v !== null && v < s.noulLow;
    };
    const deadlineAhead = deadlineAt !== null && Date.parse(deadlineAt) > input.now.getTime();
    const deadlineClear =
      !deadlineAhead || (noul("has_deadline") !== null && (noul("has_deadline") ?? 1) < s.noulLow);
    if (clear("needs_reply") && clear("waiting_on_me") && deadlineClear) {
      push({ kind: "archive", fit: archive });
    }
  }

  /* Snooze, with the time assembled by code. */
  const snooze = noul(ACTION_SIGNAL.snoozeFits);
  if (snooze !== null) {
    const when = snoozeUntil({
      anchor: choice(ACTION_SIGNAL.snoozeAnchor),
      weekday: choice(ACTION_SIGNAL.snoozeWeekday),
      part: choice(ACTION_SIGNAL.snoozePart),
      deadlineAt,
      written,
      now: input.now,
      settings: s,
    });
    push({ kind: "snooze", fit: snooze, until: when.until, anchor: when.anchor });
  }

  /* Forward and Hand to: the fit, and a person the judge picked among the ones code offered. */
  const to = choice(ACTION_SIGNAL.forwardTo);
  const pick = input.picks?.[ACTION_SIGNAL.forwardTo];
  if (to && to.choice !== "none" && pick) {
    const email = pick.value.toLowerCase();
    const known = input.people.find((p) => p.email.toLowerCase() === email);
    const person: Person = { name: known?.name ?? "", email: pick.value };
    const forward = noul(ACTION_SIGNAL.forwardFits);
    if (forward !== null)
      push({ kind: "forward", fit: forward, to: person, confidence: to.confidence });
    const delegate = noul(ACTION_SIGNAL.delegateFits);
    if (delegate !== null)
      push({ kind: "delegate", fit: delegate, to: person, confidence: to.confidence });
  }

  /* Add to calendar: the event's day and time from their parts, put together by code. */
  const calendar = noul(ACTION_SIGNAL.calendarFits);
  if (calendar !== null && facts.has_invite !== true) {
    const when = eventTime({
      part: (p) => choice(calendarPartId(p)),
      minute: choice(ACTION_SIGNAL.calendarMinute),
      written,
      now: input.now,
      settings: s,
      minutes: ctx.eventMinutes ?? 30,
    });
    if (when) {
      push({
        kind: "calendar",
        fit: calendar,
        ...when,
        title: eventTitle(ctx.subject ?? ""),
      });
    }
  }

  /* Pay or file: money the owner pays, an amount picked, and a link only on a safe domain. */
  const pay = noul(ACTION_SIGNAL.payFits);
  const involved = noul("money_involved");
  const direction = choice("money_direction");
  const amount = ctx.amount;
  const amountRead = read("money_amount");
  if (
    pay !== null &&
    involved !== null &&
    involved >= s.noulHigh &&
    direction?.choice === "owner_pays" &&
    direction.confidence >= s.confidenceBelow &&
    amount &&
    amountRead
  ) {
    const picked = input.picks?.[ACTION_SIGNAL.payLink];
    let link: { url: string; domain: string } | null = null;
    if (picked) {
      try {
        const domain = new URL(picked.value).hostname.toLowerCase();
        if (
          picked.confidence >= s.confidenceBelow &&
          /^https:/i.test(picked.value) &&
          payLinkAllowed(domain, ctx.senderDomain ?? null, ctx.trustedDomains ?? [])
        ) {
          link = { url: picked.value, domain };
        }
      } catch {
        link = null;
      }
    }
    const due = deadlineAt;
    const remind =
      due !== null ? new Date(Date.parse(due) - (ctx.remindDaysBefore ?? 2) * 86_400_000) : null;
    push({
      kind: "pay",
      fit: pay,
      amount: amount.span,
      value: amount.value,
      currency: amount.currency,
      amountConfidence: amountRead.confidence ?? 0,
      due,
      link,
      remindAt: remind && remind.getTime() > input.now.getTime() ? remind.toISOString() : null,
    });
  }

  /* Track a package: the number the judge picked among the ones code found, on its carrier's page. */
  const track = noul(ACTION_SIGNAL.trackFits);
  const number = input.picks?.[ACTION_SIGNAL.trackNumber];
  if (track !== null && number && number.confidence >= s.confidenceBelow) {
    const carrier = ctx.trackingCarrier?.(number.value) ?? null;
    const template = carrier ? ctx.carrierUrls?.[carrier] : undefined;
    if (carrier && template) {
      push({
        kind: "track",
        fit: track,
        url: template.replace("{number}", encodeURIComponent(number.value)),
        carrier,
        number: number.value,
        deliveryDay: deadlineAt,
      });
    }
  }

  /* Run a Workflow: the pick's probability is its fit; its confidence has its own floor. */
  const workflow = input.picks?.[ACTION_SIGNAL.workflowPick];
  const workflowRead = read(ACTION_SIGNAL.workflowPick);
  if (workflow && workflowRead) {
    const known = ctx.workflows?.find((w) => w.id === workflow.value);
    if (known) {
      push({
        kind: "workflow",
        fit: workflow.probability ?? workflow.confidence,
        workflowId: known.id,
        name: known.name,
        confidence: workflow.confidence,
      });
    }
  }
  return out.sort((a, b) => b.rank - a.rank);
}

/** "Re: Fwd: Lunch on Thursday" as an event's title: "Lunch on Thursday". */
export function eventTitle(subject: string): string {
  return subject.replace(/^\s*((re|fwd?|aw|wg)\s*:\s*)+/i, "").trim() || subject.trim();
}

/**
 * The event's day and start from its parts (docs/spec/actions.md, Add to
 * calendar): the day as the deadline parts are put together, in the
 * Workspace's zone, counted from the day the newest Message was written; the
 * hour and minute only when stated, with the lowest of their confidences.
 * A day already past gives nothing.
 */
export function eventTime(input: {
  part: (p: CalendarPart) => { choice: string; confidence: number } | null;
  minute: { choice: string; confidence: number } | null;
  written: Date;
  now: Date;
  settings: RecommendSettings;
  minutes: number;
}): { day: string; start: string | null; end: string | null; timeConfidence: number } | null {
  const s = input.settings;
  const parts: DeadlineParts = {};
  for (const p of CALENDAR_PARTS) {
    if (p === "hour") continue;
    const v = input.part(p);
    if (v) parts[p] = v;
  }
  const dated = assembleDeadline(parts, input.written.toISOString(), s.zone, s.confidenceBelow);
  if (!dated.at) return null;
  const at = utcToZoned(s.zone, new Date(dated.at));
  const day = `${at.y}-${String(at.mo).padStart(2, "0")}-${String(at.d).padStart(2, "0")}`;
  const today = utcToZoned(s.zone, input.now);
  const todayKey = `${today.y}-${String(today.mo).padStart(2, "0")}-${String(today.d).padStart(2, "0")}`;
  if (day < todayKey) return null;
  const hour = input.part("hour");
  if (!hour || hour.choice === "none" || !/^\d+$/.test(hour.choice)) {
    return { day, start: null, end: null, timeConfidence: 0 };
  }
  const m = input.minute;
  const minute = m && /^\d+$/.test(m.choice) ? Number(m.choice) : 0;
  const timeConfidence = Math.min(
    hour.confidence,
    m && m.choice !== "none" ? (m.choice === "other" ? 0 : m.confidence) : 1,
  );
  const start = zonedToUtc(s.zone, at.y, at.mo, at.d, Number(hour.choice), minute, 0);
  if (start.getTime() <= input.now.getTime()) return null;
  const end = new Date(start.getTime() + input.minutes * 60_000);
  return { day, start: start.toISOString(), end: end.toISOString(), timeConfidence };
}

/**
 * Whether the owner left a list's newest `streakOf` issues unread in a row
 * (docs/spec/actions.md, Unsubscribe), newest first. The issue being looked
 * at counts as unread whatever its flag says: opening it in the reader marks
 * it read, and that must not take away the very chip it came to show.
 */
export function unreadStreak(
  newest: ReadonlyArray<{ id: string; unread: boolean }>,
  threadId: string,
  streakOf: number,
): boolean {
  const run = newest.slice(0, Math.max(1, streakOf));
  return run.length >= streakOf && run.every((i) => i.unread || i.id === threadId);
}

/* ------------------------------ Candidates ------------------------------ */

/** "Priya Raman <priya@monday.test>" or a bare address, as a Person. */
export function parsePerson(text: string): Person | null {
  const m = /^\s*(.*?)\s*<([^>\s]+@[^>\s]+)>\s*$/.exec(text);
  if (m) return { name: (m[1] ?? "").replace(/^"|"$/g, ""), email: (m[2] ?? "").toLowerCase() };
  const bare = text.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bare) ? { name: "", email: bare } : null;
}

export interface CandidateWords {
  named: string;
  handoff: string;
  forwarded: string;
  copied: string;
  colleague: string;
  frequent: string;
}

/** Someone the owner deals with, and how many times (forwards, copies, mails written). */
export interface Correspondent {
  email: string;
  name: string;
  count: number;
}

/**
 * The people a recipient Choice offers (docs/spec/actions.md, Forward): whom
 * the owner forwarded this sender's mail to, the owner's hand-off list, the
 * people the owner copies on mail to this sender's domain, colleagues at the
 * owner's own domain, the addresses named in the Thread and the people the
 * owner writes to most; never the owner, the sender or someone already on the
 * Thread, at most `max`, each with one line saying who they are and how they
 * relate to the owner. Code finds every one of them; the judge only picks.
 */
export function candidatePeople(input: {
  owner: string;
  sender: string;
  named: readonly string[];
  participants: readonly string[];
  handoff: readonly string[];
  forwarded: ReadonlyArray<Correspondent>;
  /** People the owner copied on mail to the sender's domain. */
  copied?: ReadonlyArray<Correspondent> | undefined;
  /** People at the owner's own (non-personal) domain the owner writes to. */
  colleagues?: ReadonlyArray<Correspondent> | undefined;
  /** The people the owner writes to most. */
  frequent?: ReadonlyArray<Correspondent> | undefined;
  /** Names by address, for a person a source knows only by address. */
  names?: ReadonlyMap<string, string> | undefined;
  max: number;
  words: CandidateWords;
}): SignalCandidates["people"] {
  const skip = new Set(
    [input.owner, input.sender, ...input.participants].map((a) => a.toLowerCase()),
  );
  const senderDomain = input.sender.split("@")[1] ?? "";
  const ownerDomain = input.owner.split("@")[1] ?? "";
  const out: SignalCandidates["people"] = [];
  const add = (email: string, name: string, line: string) => {
    const e = email.trim().toLowerCase();
    if (!e || skip.has(e) || out.some((p) => p.email === e) || out.length >= input.max) return;
    const known = (name || input.names?.get(e) || "").trim();
    out.push({ email: e, name: known, line: known ? `${known}, ${line}` : line });
  };
  for (const f of input.forwarded) {
    add(
      f.email,
      f.name,
      fillWords(input.words.forwarded, { count: f.count, sender: input.sender }),
    );
  }
  for (const text of input.handoff) {
    const p = parsePerson(text);
    if (p) add(p.email, p.name, input.words.handoff);
  }
  for (const c of input.copied ?? []) {
    add(c.email, c.name, fillWords(input.words.copied, { count: c.count, domain: senderDomain }));
  }
  for (const c of input.colleagues ?? []) {
    add(c.email, c.name, fillWords(input.words.colleague, { count: c.count, domain: ownerDomain }));
  }
  for (const a of input.named) add(a, "", input.words.named);
  for (const c of input.frequent ?? []) {
    add(c.email, c.name, fillWords(input.words.frequent, { count: c.count }));
  }
  return out;
}

/* ------------------------------ The module ------------------------------ */

/**
 * The version of the rules above. Raise it when a change in code changes what
 * a Thread's stored answers allow (2: an issue being read no longer breaks
 * its list's unread streak); stored rows of an older version are worked out
 * again in the background (recomputeOutdated), from their answers, without
 * asking the judge. Thresholds need no bump: the chips apply them at show time.
 */
export const RULES_VERSION = 2;

const SETTING_KEYS = [
  "actions.recommended.enabled",
  "signals.unsure.noul_low",
  "signals.unsure.noul_high",
  "signals.unsure.confidence_below",
  "signals.non_english",
  "signals.candidates.max",
  "calendar.time_zone",
  "inbox.snooze.morning_hour",
  "inbox.snooze.week_start",
  "actions.snooze.afternoon_hour",
  "actions.snooze.evening_hour",
  "actions.snooze.before_deadline_hours",
  "actions.delegate.people",
  "actions.calendar.default_minutes",
  "actions.pay.remind_days_before",
  "actions.pay.trusted_domains",
  "actions.unsubscribe.unread_streak",
  "actions.track.carrier_urls",
  "actions.learning.enabled",
  "actions.learning.window",
  "actions.learning.min_use_rate",
  "actions.learning.high_use_rate",
  "actions.learning.step",
  "actions.learning.max_threshold",
  "strings.actions.recommended.candidate.named",
  "strings.actions.recommended.candidate.handoff",
  "strings.actions.recommended.candidate.forwarded",
  "strings.actions.recommended.candidate.copied",
  "strings.actions.recommended.candidate.colleague",
  "strings.actions.recommended.candidate.frequent",
  "actions.recommended.forward.max_people",
  "actions.recommended.forward.min_written",
  "actions.recommended.recompute_days",
  "strings.actions.recommended.learned",
] as const;

/** What the Recommended actions read beyond the Signal store: the calendar, the Workflows, the Activity log. */
export interface RecommendationsOptions {
  db: Db;
  mailstore: Mailstore;
  signals: Signals;
  /** The calendar module, once it exists: the Invite on a Thread and what it clashes with. */
  calendar?: (() => CalendarSeam | null) | undefined;
  /** The Workflows module, once it exists: the ones a Thread can be run through by hand. */
  workflows?: (() => WorkflowsSeam | null) | undefined;
  /** Where learning records a threshold it moved, undoable (docs/spec/actions.md). */
  activity?: (() => ActivityLog | null) | undefined;
  /** Writes a Setting as the Agent's change_setting does, telling the clients. */
  writeSetting?: ((workspaceId: Id, key: string, value: unknown) => Promise<void>) | undefined;
  level?: () => Promise<AiLevel>;
  now?: () => Date;
  log?: (message: string) => void;
}

/** A threshold learning moved: the Activity row that shows it, with its Undo. */
export interface LearnedChange {
  action: RecommendedActionKind;
  key: string;
  from: number;
  to: number;
  activityId: string | null;
  text: string;
}

/** How to leave a Thread's list, and what the card names. */
export interface ListExit extends UnsubscribePlan {
  listId: string;
  listName: string;
  issues: number;
}

export interface Recommendations {
  /** Works the Thread's Recommended actions out again from its stored answers; null at AI level off. */
  refresh(workspaceId: Id, threadId: Id): Promise<ThreadRecommendations | null>;
  /** The stored ones, decrypted, or null. */
  get(threadId: Id): Promise<ThreadRecommendations | null>;
  /**
   * The reader opened the Thread: a Thread without current answers is asked
   * the Signal request once (it is outside the Signal scope, or the AI level
   * is assist), then its actions are worked out. `zone` is the Device's.
   */
  open(
    workspaceId: Id,
    threadId: Id,
    options?: { zone?: string },
  ): Promise<ThreadRecommendations | null>;
  /** The people and Workflows a per-Thread Choice offers (the Signal request's candidate source). */
  candidates: CandidateSource;
  /** The Agent's view (recommended_actions): what the reader shows and what is held back, in words. */
  view(workspaceId: Id, threadId: Id): Promise<RecommendationView | null>;
  /**
   * The chips a Thread showed, and what became of one (used, dismissed,
   * ignored, other_used). A dismissal takes the action off the Thread; every
   * outcome may move the action's threshold (learning).
   */
  record(request: RecommendationEventsRequest): Promise<{ learned: LearnedChange | null }>;
  /** Per action, how often shown and used since its threshold was last set, with the threshold. */
  stats(workspaceId: Id): Promise<RecommendationStat[]>;
  /** How the Thread's list is left (RFC 8058 one-click, mailto, or the browser), or null. */
  listExit(workspaceId: Id, threadId: Id): Promise<ListExit | null>;
  /**
   * Works out again, from their stored answers and without asking the judge,
   * the recent Threads whose actions an older RULES_VERSION worked out
   * (within actions.recommended.recompute_days), newest first. Returns how
   * many were worked out.
   */
  recomputeOutdated(): Promise<number>;
}

/** Every Setting the chips are chosen and worded by: the switches, thresholds, mutes and words. */
const CHOOSE_KEYS = Object.keys(settingsSchema).filter(
  (k) => k.startsWith("actions.recommended.") || k.startsWith("strings.actions.recommended."),
) as Array<keyof typeof settingsSchema>;

const newId = () => crypto.randomUUID();

export function createRecommendations(options: RecommendationsOptions): Recommendations {
  const { db, mailstore, signals } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const level = options.level ?? (async (): Promise<AiLevel> => "automate");
  /** The zone a Device last reported, per Workspace, for a Workspace with no calendar zone set. */
  const deviceZones = new Map<Id, string>();

  const settings = () => readGlobalSettings(db, SETTING_KEYS);

  /** The Workflows a Thread can be run through by hand: enabled, with a manual or a Thread trigger. */
  const manualWorkflows = async (workspaceId: Id, max: number) => {
    const seam = options.workflows?.() ?? null;
    if (!seam) return [];
    try {
      return (await seam.list(workspaceId))
        .filter(
          (w) => w.enabled && (w.trigger.kind === "manual" || w.trigger.kind === "thread_event"),
        )
        .slice(0, max)
        .map((w) => ({ id: w.id, name: w.name, sentence: w.sentence ?? "" }));
    } catch {
      return [];
    }
  };

  /** Whom the owner forwarded or handed this sender's mail to, from the chips' outcomes. */
  const forwardedFor = async (workspaceId: Id, sender: string) => {
    if (!sender) return [];
    const rows = await db
      .select({
        to: sql<string>`${recommendationEvents.args}->>'to'`,
        n: sql<number>`count(*)::int`,
      })
      .from(recommendationEvents)
      .where(
        and(
          eq(recommendationEvents.workspaceId, workspaceId),
          eq(recommendationEvents.sender, sender.toLowerCase()),
          inArray(recommendationEvents.action, ["forward", "delegate"]),
          inArray(recommendationEvents.outcome, ["used", "other_used"]),
        ),
      )
      .groupBy(sql`${recommendationEvents.args}->>'to'`);
    return rows
      .filter((r) => typeof r.to === "string" && r.to !== "")
      .sort((a, b) => Number(b.n) - Number(a.n))
      .map((r) => ({ email: r.to, name: "", count: Number(r.n) }));
  };

  /**
   * The people the owner copied on their own mail to the sender: to the
   * sender's domain, or to the sender alone when the domain is a personal one
   * (gmail.com is not a company).
   */
  const copiedFor = async (
    workspaceId: Id,
    owner: string,
    sender: string,
    max: number,
  ): Promise<Correspondent[]> => {
    if (!owner || !sender) return [];
    const domain = sender.split("@")[1] ?? "";
    const company = companyOf(sender) !== null;
    const match = company
      ? sql`split_part(lower(t->>'email'), '@', 2) = ${domain}`
      : sql`lower(t->>'email') = ${sender}`;
    const rows = (await db.execute<{ email: string; name: string | null; n: number }>(sql`
      select lower(c->>'email') as email, max(c->>'name') as name, count(*)::int as n
      from messages m, jsonb_array_elements(m.cc) c
      where m.workspace_id = ${workspaceId}
        and lower(m."from"->>'email') = ${owner}
        and exists (select 1 from jsonb_array_elements(m."to") t where ${match})
      group by 1
      order by n desc
      limit ${max}`)) as unknown as Array<{ email: string; name: string | null; n: number }>;
    return rows
      .filter((r) => typeof r.email === "string" && r.email.includes("@"))
      .map((r) => ({ email: r.email, name: r.name ?? "", count: Number(r.n) }));
  };

  /** The people the owner writes to most, at least `min` times; colleagues are those at the owner's own company domain. */
  const writtenFor = async (workspaceId: Id, owner: string, min: number, max: number) => {
    const domain = owner.split("@")[1] ?? "";
    const top = async (where: SQL | undefined) =>
      (
        await db
          .select({ email: people.address, name: people.name, count: people.sentCount })
          .from(people)
          .where(and(eq(people.workspaceId, workspaceId), gte(people.sentCount, min), where))
          .orderBy(desc(people.sentCount), desc(people.lastAt))
          .limit(max)
      ).map((r) => ({ email: r.email, name: r.name, count: Number(r.count) }));
    const colleagues =
      domain && companyOf(owner) !== null
        ? await top(sql`${people.address} like ${`%@${domain}`}`)
        : [];
    return { colleagues, frequent: await top(undefined) };
  };

  /** The names the people table holds for these addresses. */
  const namesOf = async (workspaceId: Id, addresses: readonly string[]) => {
    const list = [...new Set(addresses.map((a) => a.toLowerCase()).filter((a) => a !== ""))];
    if (list.length === 0) return new Map<string, string>();
    const rows = await db
      .select({ address: people.address, name: people.name })
      .from(people)
      .where(and(eq(people.workspaceId, workspaceId), inArray(people.address, list)));
    return new Map(rows.filter((r) => r.name.trim() !== "").map((r) => [r.address, r.name]));
  };

  const candidates: CandidateSource = async (input) => {
    const s = await settings();
    const owner = input.owner.toLowerCase();
    const sender = input.sender.toLowerCase();
    const max = s["actions.recommended.forward.max_people"];
    const forwarded = await forwardedFor(input.workspaceId, sender);
    const copied = await copiedFor(input.workspaceId, owner, sender, max);
    const written = owner
      ? await writtenFor(
          input.workspaceId,
          owner,
          s["actions.recommended.forward.min_written"],
          max,
        )
      : { colleagues: [], frequent: [] };
    const names = await namesOf(input.workspaceId, [
      ...forwarded.map((f) => f.email),
      ...input.named,
    ]);
    const people = candidatePeople({
      owner,
      sender,
      named: input.named,
      participants: input.participants,
      handoff: s["actions.delegate.people"],
      forwarded,
      copied,
      colleagues: written.colleagues,
      frequent: written.frequent,
      names,
      max,
      words: {
        named: s["strings.actions.recommended.candidate.named"],
        handoff: s["strings.actions.recommended.candidate.handoff"],
        forwarded: s["strings.actions.recommended.candidate.forwarded"],
        copied: s["strings.actions.recommended.candidate.copied"],
        colleague: s["strings.actions.recommended.candidate.colleague"],
        frequent: s["strings.actions.recommended.candidate.frequent"],
      },
    });
    return {
      people,
      forwardedTo: forwarded.map((f) => f.email),
      workflows: await manualWorkflows(input.workspaceId, s["signals.candidates.max"]),
    };
  };

  const readSealed = async (workspaceId: Id, row: typeof threadFacts.$inferSelect) => {
    if (!row.contentEnc || !row.contentKey) return null;
    try {
      return JSON.parse(
        await mailstore.readText({
          workspaceId,
          kind: "facts",
          key: row.contentKey,
          chunks: [row.contentEnc],
          size: -1,
        }),
      ) as SealedFacts;
    } catch {
      return null;
    }
  };

  const record = (workspaceId: Id, payload: RecommendationsChange) =>
    mailstore.recordChange(db, {
      workspaceId,
      kind: "recommendations",
      entityId: payload.threadId,
      payload,
    });

  const zoneOf = (workspaceId: Id, setting: string) =>
    setting && isIanaZone(setting) ? setting : (deviceZones.get(workspaceId) ?? "UTC");

  /** The Invite on a Thread, whether it is answered, and the busy Event it clashes with. */
  const inviteOf = async (workspaceId: Id, threadId: Id) => {
    const seam = options.calendar?.() ?? null;
    if (!seam) return null;
    try {
      const invite = (await seam.invitesOfThread(threadId))
        .filter((i) => i.method === "REQUEST")
        .at(-1);
      if (!invite) return null;
      const busy = invite.allDay
        ? []
        : (await seam.busy(workspaceId, invite.start, invite.end)).filter(
            (b) => b.eventId !== invite.eventId,
          );
      return {
        id: invite.id,
        title: invite.title,
        start: invite.start,
        answered: invite.response !== "needs-action",
        clash: busy[0]?.title ?? null,
      };
    } catch (error) {
      log(
        `recommendations invite ${threadId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  };

  /** The list a Thread came from, how to leave it, and whether its newest issues went unread. */
  const listExitOf = async (
    workspaceId: Id,
    threadId: Id,
    facts: Record<string, unknown>,
    streakOf: number,
  ): Promise<(ListExit & { streak: boolean }) | null> => {
    const listId = typeof facts.list_id === "string" ? facts.list_id : null;
    const unsub = facts.list_unsubscribe as { mailto?: boolean; https?: boolean } | undefined;
    if (!listId || !(unsub?.mailto || unsub?.https)) return null;
    const headers = (await mailstore.listMessages(threadId)).at(-1);
    if (!headers) return null;
    const plan = unsubscribePlan(headers.headers);
    if (!plan) return null;
    const issues = await db
      .select({ id: threads.id, unread: threads.unread, archived: threads.archived })
      .from(threads)
      .innerJoin(threadFacts, eq(threadFacts.threadId, threads.id))
      .where(
        and(
          eq(threads.workspaceId, workspaceId),
          eq(threads.deleted, false),
          sql`${threadFacts.facts}->>'list_id' = ${listId}`,
        ),
      )
      .orderBy(desc(threads.lastActivity))
      .limit(1000);
    const newest = issues.slice(0, Math.max(1, streakOf));
    return {
      ...plan,
      listId,
      listName: listName(headers.headers, headers.from.name || headers.from.email),
      issues: issues.filter((i) => !i.archived).length,
      streak: unreadStreak(newest, threadId, streakOf),
    };
  };

  /** Per action, its outcomes newest first over the last few months, for the order of the chips. */
  const recentOutcomes = async (workspaceId: Id) => {
    const rows = await db
      .select({ action: recommendationEvents.action, outcome: recommendationEvents.outcome })
      .from(recommendationEvents)
      .where(
        and(
          eq(recommendationEvents.workspaceId, workspaceId),
          isNotNull(recommendationEvents.outcome),
          gte(recommendationEvents.outcomeAt, new Date(now().getTime() - 90 * 86_400_000)),
        ),
      )
      .orderBy(desc(recommendationEvents.outcomeAt))
      .limit(2000);
    const out = new Map<RecommendedActionKind, RecommendationOutcome[]>();
    for (const r of rows) {
      const list = out.get(r.action) ?? [];
      list.push(r.outcome as RecommendationOutcome);
      out.set(r.action, list);
    }
    return out;
  };

  const refresh = async (workspaceId: Id, threadId: Id): Promise<ThreadRecommendations | null> => {
    if ((await level()) === "off") return null;
    const s = await settings();
    const thread = await db.query.threads.findFirst({
      where: eq(threads.id, threadId),
      columns: { id: true, participants: true },
    });
    if (!thread) return null;
    const answers = (await signals.readings([threadId])).get(threadId) ?? {};
    const factsRow = await db.query.threadFacts.findFirst({
      where: eq(threadFacts.threadId, threadId),
    });
    const facts = (factsRow?.facts ?? {}) as Record<string, unknown>;
    const sealed = factsRow ? await readSealed(workspaceId, factsRow) : null;
    const zone = zoneOf(workspaceId, s["calendar.time_zone"]);
    const version = await signals.version(threadId);
    const picks = sealed?.picks;
    // The picked person's name, and the Workflows, as code offered them.
    const pickedTo = picks?.[ACTION_SIGNAL.forwardTo]?.value;
    const pickedNames = pickedTo
      ? await namesOf(workspaceId, [pickedTo])
      : new Map<string, string>();
    const offered = {
      people: [...pickedNames].map(([email, name]) => ({ email, name })),
      workflows: picks?.[ACTION_SIGNAL.workflowPick]
        ? await manualWorkflows(workspaceId, s["signals.candidates.max"])
        : [],
    };
    const dismissedRows = await db
      .select({ action: recommendationEvents.action })
      .from(recommendationEvents)
      .where(
        and(
          eq(recommendationEvents.threadId, threadId),
          eq(recommendationEvents.outcome, "dismissed"),
          eq(recommendationEvents.messageCount, version.messageCount),
        ),
      );
    const outcomes = await recentOutcomes(workspaceId);
    const subject = await mailstore.readThreadSubject(threadId).catch(() => "");
    const actions = s["actions.recommended.enabled"]
      ? recommendFor({
          now: now(),
          answers,
          facts,
          picks,
          people: offered.people,
          useRate: (kind) => useRate(outcomes.get(kind) ?? []),
          settings: {
            noulLow: s["signals.unsure.noul_low"],
            noulHigh: s["signals.unsure.noul_high"],
            confidenceBelow: s["signals.unsure.confidence_below"],
            nonEnglish: s["signals.non_english"],
            zone,
            morningHour: s["inbox.snooze.morning_hour"],
            afternoonHour: s["actions.snooze.afternoon_hour"],
            eveningHour: s["actions.snooze.evening_hour"],
            weekStart: s["inbox.snooze.week_start"],
            beforeDeadlineHours: s["actions.snooze.before_deadline_hours"],
          },
          context: {
            invite: facts.has_invite === true ? await inviteOf(workspaceId, threadId) : null,
            subject,
            amount: sealed?.amount ?? null,
            senderDomain: typeof facts.from_domain === "string" ? facts.from_domain : null,
            trustedDomains: s["actions.pay.trusted_domains"],
            remindDaysBefore: s["actions.pay.remind_days_before"],
            eventMinutes: s["actions.calendar.default_minutes"],
            unsubscribe: await listExitOf(
              workspaceId,
              threadId,
              facts,
              s["actions.unsubscribe.unread_streak"],
            ),
            carrierUrls: s["actions.track.carrier_urls"],
            workflows: offered.workflows ?? [],
            dismissed: new Set(dismissedRows.map((r) => r.action)),
            trackingCarrier: (number) =>
              sealed?.tracking_numbers.find((t) => t.number === number)?.carrier ?? null,
          },
        })
      : [];
    const computedAt = now();
    const fromDomain = typeof facts.from_domain === "string" ? facts.from_domain : null;
    const content = JSON.stringify({ actions, fromDomain });
    const stored = await mailstore.storeContent(workspaceId, "recommendation", content);
    const contentEnc = stored.chunks[0];
    if (!contentEnc) throw new RangeError("recommendation envelope missing");
    const kinds = actions.map((a) => a.kind);
    const values = {
      workspaceId,
      messageCount: version.messageCount,
      latestMessageId: version.latestMessageId,
      kinds,
      contentEnc,
      contentKey: stored.key,
      computedAt,
      rules: RULES_VERSION,
    };
    await db
      .insert(threadRecommendations)
      .values({ threadId, ...values })
      .onConflictDoUpdate({ target: threadRecommendations.threadId, set: values });
    await record(workspaceId, {
      threadId,
      messageCount: version.messageCount,
      computedAt: computedAt.toISOString(),
      kinds,
    });
    return {
      threadId,
      messageCount: version.messageCount,
      latestMessageId: version.latestMessageId,
      computedAt: computedAt.toISOString(),
      fromDomain,
      actions,
    };
  };

  const get = async (threadId: Id): Promise<ThreadRecommendations | null> => {
    const row = await db.query.threadRecommendations.findFirst({
      where: eq(threadRecommendations.threadId, threadId),
    });
    if (!row) return null;
    const parsed = JSON.parse(
      await mailstore.readText({
        workspaceId: row.workspaceId,
        kind: "recommendation",
        key: row.contentKey,
        chunks: [row.contentEnc],
        size: -1,
      }),
    ) as { actions: Recommendation[]; fromDomain: string | null };
    return {
      threadId,
      messageCount: row.messageCount,
      latestMessageId: row.latestMessageId,
      computedAt: row.computedAt.toISOString(),
      fromDomain: parsed.fromDomain ?? null,
      actions: parsed.actions ?? [],
    };
  };

  const view = async (workspaceId: Id, threadId: Id): Promise<RecommendationView | null> => {
    if ((await level()) === "off") return null;
    const thread = await db.query.threads.findFirst({
      where: eq(threads.id, threadId),
      columns: { id: true, workspaceId: true },
    });
    if (!thread || thread.workspaceId !== workspaceId) return null;
    const recs = (await get(threadId)) ?? (await refresh(workspaceId, threadId));
    if (!recs) return null;
    const s = (await readGlobalSettings(db, CHOOSE_KEYS)) as Record<string, unknown>;
    const zoneSetting = String(
      (await readGlobalSettings(db, ["calendar.time_zone"] as const))["calendar.time_zone"],
    );
    const zone =
      zoneSetting && isIanaZone(zoneSetting) ? zoneSetting : (deviceZones.get(workspaceId) ?? null);
    const rules = recommendationRules(s);
    const words = recommendationWords(s);
    const label = (r: Recommendation) =>
      recommendationLabel(r, words, now(), zone, rules.timeConfidence);
    const chosen = chooseRecommended(recs.actions, rules, { fromDomain: recs.fromDomain });
    const max =
      typeof s["actions.recommended.max_in_reader"] === "number"
        ? (s["actions.recommended.max_in_reader"] as number)
        : 3;
    const shown = chosen.slice(0, max);
    const version = await signals.version(threadId);
    const why = (r: Recommendation): string => {
      const rule = rules.actions[r.kind];
      if (!rules.enabled || !rule?.enabled) return "switched off in Settings";
      if (senderMuted(recs.fromDomain, rule.mutedSenders))
        return `muted for mail from ${recs.fromDomain}`;
      if (rule.threshold !== undefined && r.fit < rule.threshold)
        return `below its threshold of ${rule.threshold}`;
      if (
        (r.kind === "forward" || r.kind === "delegate") &&
        r.confidence < rules.recipientConfidence
      )
        return "not sure enough of the person";
      if (r.kind === "pay" && r.amountConfidence < rules.amountConfidence)
        return "not sure enough of the amount";
      if (r.kind === "workflow" && r.confidence < rules.workflowConfidence)
        return "not sure enough which Workflow";
      if (chosen.includes(r)) return "past the reader's limit of chips";
      return "another chip asks the same";
    };
    return {
      threadId,
      stale:
        version.messageCount !== recs.messageCount ||
        version.latestMessageId !== recs.latestMessageId,
      shown: shown.map((r) => ({
        kind: r.kind,
        label: label(r),
        fit: r.fit,
        tool: ACTION_TOOL[r.kind],
      })),
      held: recs.actions
        .filter((r) => !shown.includes(r))
        .map((r) => ({ kind: r.kind, label: label(r), fit: r.fit, why: why(r) })),
    };
  };

  /** When a Setting was last written (by learning or the user); outcomes before it no longer count. */
  const settingSetAt = async (key: string): Promise<Date | null> => {
    const rows = await db
      .select({ at: settingsTable.updatedAt })
      .from(settingsTable)
      .where(
        and(
          eq(settingsTable.scope, "global"),
          isNull(settingsTable.deviceId),
          eq(settingsTable.key, key),
        ),
      );
    return rows[0]?.at ?? null;
  };

  const actionName = (s: Record<string, unknown>, action: RecommendedActionKind) => {
    const v = s[`strings.actions.recommended.name.${action}`];
    return typeof v === "string" ? v : action;
  };

  /** Moves an action's threshold when its outcomes say so; a Setting write the Activity log shows, undoable. */
  const learn = async (
    workspaceId: Id,
    action: RecommendedActionKind,
  ): Promise<LearnedChange | null> => {
    const key = `actions.recommended.${action}.threshold`;
    if (!isSettingKey(key) || !options.writeSetting) return null;
    const s = await settings();
    const setAt = await settingSetAt(key);
    const rows = await db
      .select({ outcome: recommendationEvents.outcome })
      .from(recommendationEvents)
      .where(
        and(
          eq(recommendationEvents.workspaceId, workspaceId),
          eq(recommendationEvents.action, action),
          isNotNull(recommendationEvents.outcome),
          ...(setAt ? [gt(recommendationEvents.outcomeAt, setAt)] : []),
        ),
      )
      .orderBy(desc(recommendationEvents.outcomeAt))
      .limit(s["actions.learning.window"]);
    const current = (await readGlobalSettings(db, [key]))[key] as number;
    const shipped = settingsSchema[key].default as number;
    const step = learnThreshold({
      outcomes: rows.map((r) => r.outcome as RecommendationOutcome),
      current,
      shipped,
      settings: {
        enabled: s["actions.learning.enabled"],
        window: s["actions.learning.window"],
        minUseRate: s["actions.learning.min_use_rate"],
        highUseRate: s["actions.learning.high_use_rate"],
        step: s["actions.learning.step"],
        maxThreshold: s["actions.learning.max_threshold"],
      },
    });
    if (!step) return null;
    const words = (await readGlobalSettings(db, CHOOSE_KEYS)) as Record<string, unknown>;
    const text = s["strings.actions.recommended.learned"]
      .replace("{action}", actionName(words, action))
      .replace("{shown}", String(step.shown))
      .replace("{used}", String(step.used))
      .replace("{percent}", `${Math.round(step.next * 100)}%`);
    await options.writeSetting(workspaceId, key, step.next);
    let activityId: string | null = null;
    const activity = options.activity?.() ?? null;
    if (activity) {
      const row = await activity.start({
        workspaceId,
        sessionId: null,
        callId: null,
        tool: "change_setting",
        tier: "reversible",
        input: { key, value: step.next },
        summary: text,
        preview: { kind: "setting", key, from: current, to: step.next },
        status: "done",
        decision: "auto",
      });
      await activity.update(row.id, {
        resultText: text,
        undo: { kind: "settings", entries: [{ key, previous: current }] },
      });
      activityId = row.id;
    }
    return { action, key, from: current, to: step.next, activityId, text };
  };

  const recordEvents = async (
    request: RecommendationEventsRequest,
  ): Promise<{ learned: LearnedChange | null }> => {
    const { workspace: workspaceId, threadId } = request;
    const thread = await db.query.threads.findFirst({
      where: eq(threads.id, threadId),
      columns: { id: true, workspaceId: true },
    });
    if (!thread || thread.workspaceId !== workspaceId) return { learned: null };
    const version = await signals.version(threadId);
    const facts = await db.query.threadFacts.findFirst({
      where: eq(threadFacts.threadId, threadId),
      columns: { facts: true },
    });
    const from = (facts?.facts as { from_address?: unknown } | undefined)?.from_address;
    const sender = typeof from === "string" ? from.toLowerCase() : null;
    const at = now();
    for (const shown of request.shown ?? []) {
      // One pending row per action and Thread version: showing it again adds nothing.
      const pending = await db
        .select({ id: recommendationEvents.id })
        .from(recommendationEvents)
        .where(
          and(
            eq(recommendationEvents.threadId, threadId),
            eq(recommendationEvents.action, shown.kind),
            eq(recommendationEvents.messageCount, version.messageCount),
            isNull(recommendationEvents.outcome),
          ),
        )
        .limit(1);
      if (pending.length > 0) continue;
      await db.insert(recommendationEvents).values({
        id: newId(),
        workspaceId,
        threadId,
        action: shown.kind,
        fit: shown.fit,
        args: shown.args ?? {},
        sender,
        messageCount: version.messageCount,
        shownAt: at,
      });
    }
    const outcome = request.outcome;
    if (!outcome) return { learned: null };
    const [pending] = await db
      .select({ id: recommendationEvents.id })
      .from(recommendationEvents)
      .where(
        and(
          eq(recommendationEvents.threadId, threadId),
          eq(recommendationEvents.action, outcome.kind),
          isNull(recommendationEvents.outcome),
        ),
      )
      .orderBy(desc(recommendationEvents.shownAt))
      .limit(1);
    // The arguments of what the user did (another recipient) replace the offered ones.
    const args = outcome.args ?? {};
    if (pending) {
      await db
        .update(recommendationEvents)
        .set({
          outcome: outcome.outcome,
          outcomeAt: at,
          ...(outcome.outcome === "other_used" || outcome.outcome === "used" ? { args } : {}),
        })
        .where(eq(recommendationEvents.id, pending.id));
    } else if (outcome.outcome === "ignored" || outcome.outcome === "other_used") {
      // A chip that was never shown cannot have been ignored: nothing to learn from.
      return { learned: null };
    } else {
      await db.insert(recommendationEvents).values({
        id: newId(),
        workspaceId,
        threadId,
        action: outcome.kind,
        fit: 0,
        args,
        sender,
        messageCount: version.messageCount,
        shownAt: at,
        outcome: outcome.outcome,
        outcomeAt: at,
      });
    }
    // "Not this" takes the action off this Thread at once.
    if (outcome.outcome === "dismissed") await refresh(workspaceId, threadId);
    const learned = await learn(workspaceId, outcome.kind).catch((error: unknown) => {
      log(`learning ${outcome.kind}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    });
    return { learned };
  };

  const stats = async (workspaceId: Id): Promise<RecommendationStat[]> => {
    const out: RecommendationStat[] = [];
    for (const action of RECOMMENDED_ACTIONS) {
      const key = `actions.recommended.${action}.threshold`;
      const known = isSettingKey(key);
      const setAt = known ? await settingSetAt(key) : null;
      const rows = await db
        .select({ outcome: recommendationEvents.outcome })
        .from(recommendationEvents)
        .where(
          and(
            eq(recommendationEvents.workspaceId, workspaceId),
            eq(recommendationEvents.action, action),
            ...(setAt ? [gt(recommendationEvents.shownAt, setAt)] : []),
          ),
        );
      const threshold = known ? ((await readGlobalSettings(db, [key]))[key] as number) : null;
      out.push({
        action,
        shown: rows.length,
        used: rows.filter((r) => r.outcome === "used").length,
        threshold,
        shipped: known ? (settingsSchema[key].default as number) : null,
      });
    }
    return out;
  };

  const listExit = async (workspaceId: Id, threadId: Id): Promise<ListExit | null> => {
    const s = await settings();
    const row = await db.query.threadFacts.findFirst({
      where: eq(threadFacts.threadId, threadId),
    });
    if (!row || row.workspaceId !== workspaceId) return null;
    const exit = await listExitOf(
      workspaceId,
      threadId,
      row.facts as Record<string, unknown>,
      s["actions.unsubscribe.unread_streak"],
    );
    if (!exit) return null;
    const { streak: _streak, ...rest } = exit;
    return rest;
  };

  /** One walk at a time: a second unlock while one runs joins it. */
  let recomputing: Promise<number> | null = null;
  const recomputeOutdated = (): Promise<number> => {
    if (recomputing) return recomputing;
    recomputing = (async () => {
      if ((await level()) === "off") return 0;
      const days = (await settings())["actions.recommended.recompute_days"];
      if (days <= 0) return 0;
      const since = new Date(now().getTime() - days * 86_400_000);
      const rows = await db
        .select({
          threadId: threadRecommendations.threadId,
          workspaceId: threadRecommendations.workspaceId,
        })
        .from(threadRecommendations)
        .innerJoin(threads, eq(threads.id, threadRecommendations.threadId))
        .where(
          and(
            lt(threadRecommendations.rules, RULES_VERSION),
            gte(threads.lastActivity, since),
            eq(threads.deleted, false),
          ),
        )
        .orderBy(desc(threads.lastActivity));
      let done = 0;
      for (const r of rows) {
        try {
          if (await refresh(r.workspaceId, r.threadId)) done += 1;
        } catch (error) {
          log(
            `recommendations recompute ${r.threadId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return done;
    })().finally(() => {
      recomputing = null;
    });
    return recomputing;
  };

  return {
    refresh,
    get,
    candidates,
    view,
    record: recordEvents,
    stats,
    listExit,
    recomputeOutdated,
    async open(workspaceId, threadId, opts = {}) {
      if (opts.zone && isIanaZone(opts.zone)) deviceZones.set(workspaceId, opts.zone);
      if ((await level()) === "off") return null;
      // Once per Thread version: the same version is never asked the same questions twice.
      const missing = await signals.missing(workspaceId, threadId);
      if (missing.length > 0) {
        try {
          await signals.ask(workspaceId, threadId, { reason: "arrival" });
          // The answered listener has worked them out already.
          return (await get(threadId)) ?? (await refresh(workspaceId, threadId));
        } catch (error) {
          log(
            `recommendations ${threadId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      return refresh(workspaceId, threadId);
    },
  };
}
