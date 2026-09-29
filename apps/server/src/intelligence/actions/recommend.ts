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
  RecommendationsChange,
  RecommendedActionKind,
  SignalReading,
  ThreadRecommendations,
} from "@monday/shared";
import {
  actionable,
  chooseRecommended,
  isIanaZone,
  recommendationLabel,
  recommendationRules,
  recommendationWords,
  senderMuted,
  settingsSchema,
  utcToZoned,
  zonedToUtc,
} from "@monday/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { threadFacts, threadRecommendations, threads } from "../../db/schema.ts";
import type { Mailstore } from "../../mailstore/index.ts";
import { readGlobalSettings } from "../../settings/read.ts";
import { ACTION_TOOL, type RecommendationView } from "../agent/tools/recommended.ts";
import type { SealedFacts } from "../signals/facts.ts";
import type { CandidateSource, SignalCandidates, Signals } from "../signals/index.ts";
import { ACTION_SIGNAL } from "./signals.ts";

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
  if (lowTrust || screened) return [];
  const rate = input.useRate ?? (() => 1);
  const out: Recommendation[] = [];
  const push = (rec: RecommendationArgs & { fit: number }) => {
    if (rec.fit < s.noulLow) return;
    out.push({ ...rec, rank: Math.round(rec.fit * rate(rec.kind) * 1000) / 1000 });
  };
  const facts = input.facts;
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
  return out.sort((a, b) => b.rank - a.rank);
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
}

/**
 * The people a recipient Choice offers (docs/spec/actions.md, Forward): whom
 * the owner forwarded this sender's mail to, the addresses named in the
 * Thread, and the owner's hand-off list, never the owner, the sender or
 * someone already on the Thread, at most `max`, each with one line of Facts.
 */
export function candidatePeople(input: {
  owner: string;
  sender: string;
  named: readonly string[];
  participants: readonly string[];
  handoff: readonly string[];
  forwarded: ReadonlyArray<{ email: string; name: string; count: number }>;
  max: number;
  words: CandidateWords;
}): SignalCandidates["people"] {
  const skip = new Set(
    [input.owner, input.sender, ...input.participants].map((a) => a.toLowerCase()),
  );
  const out: SignalCandidates["people"] = [];
  const add = (email: string, name: string, line: string) => {
    const e = email.toLowerCase();
    if (!e || skip.has(e) || out.some((p) => p.email === e) || out.length >= input.max) return;
    out.push({ email: e, name, line });
  };
  for (const f of input.forwarded) {
    add(
      f.email,
      f.name,
      input.words.forwarded.replace("{count}", String(f.count)).replace("{sender}", input.sender),
    );
  }
  for (const text of input.handoff) {
    const p = parsePerson(text);
    if (p) add(p.email, p.name, input.words.handoff);
  }
  for (const a of input.named) add(a, "", input.words.named);
  return out;
}

/* ------------------------------ The module ------------------------------ */

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
  "strings.actions.recommended.candidate.named",
  "strings.actions.recommended.candidate.handoff",
  "strings.actions.recommended.candidate.forwarded",
] as const;

export interface RecommendationsOptions {
  db: Db;
  mailstore: Mailstore;
  signals: Signals;
  level?: () => Promise<AiLevel>;
  now?: () => Date;
  log?: (message: string) => void;
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
  /** The people a recipient Choice offers (the Signal request's candidate source). */
  candidates: CandidateSource;
  /** The Agent's view (recommended_actions): what the reader shows and what is held back, in words. */
  view(workspaceId: Id, threadId: Id): Promise<RecommendationView | null>;
}

/** Every Setting the chips are chosen and worded by: the switches, thresholds, mutes and words. */
const CHOOSE_KEYS = Object.keys(settingsSchema).filter(
  (k) => k.startsWith("actions.recommended.") || k.startsWith("strings.actions.recommended."),
) as Array<keyof typeof settingsSchema>;

export function createRecommendations(options: RecommendationsOptions): Recommendations {
  const { db, mailstore, signals } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const level = options.level ?? (async (): Promise<AiLevel> => "automate");
  /** The zone a Device last reported, per Workspace, for a Workspace with no calendar zone set. */
  const deviceZones = new Map<Id, string>();

  const settings = () => readGlobalSettings(db, SETTING_KEYS);

  const candidates: CandidateSource = async (input) => {
    const s = await settings();
    const people = candidatePeople({
      owner: input.owner,
      sender: input.sender,
      named: input.named,
      participants: input.participants,
      handoff: s["actions.delegate.people"],
      forwarded: [],
      max: s["signals.candidates.max"],
      words: {
        named: s["strings.actions.recommended.candidate.named"],
        handoff: s["strings.actions.recommended.candidate.handoff"],
        forwarded: s["strings.actions.recommended.candidate.forwarded"],
      },
    });
    return { people, forwardedTo: [] };
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
    const zoneSetting = s["calendar.time_zone"];
    const zone =
      zoneSetting && isIanaZone(zoneSetting)
        ? zoneSetting
        : (deviceZones.get(workspaceId) ?? "UTC");
    const version = await signals.version(threadId);
    // The names of the people a recipient may be: the ones code offered this Thread.
    const people =
      sealed?.picks?.[ACTION_SIGNAL.forwardTo] !== undefined
        ? (
            await candidates({
              workspaceId,
              threadId,
              owner: "",
              sender: typeof facts.from_address === "string" ? facts.from_address : "",
              named: sealed.addresses ?? [],
              participants: [],
            })
          ).people
        : [];
    const actions = s["actions.recommended.enabled"]
      ? recommendFor({
          now: now(),
          answers,
          facts,
          picks: sealed?.picks,
          people,
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
    const label = (r: Recommendation) => recommendationLabel(r, words, now(), zone);
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

  return {
    refresh,
    get,
    candidates,
    view,
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
