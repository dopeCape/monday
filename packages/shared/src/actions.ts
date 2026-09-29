// Recommended actions (CONTEXT.md "Recommended action"; docs/spec/actions.md;
// slices 34 and 35): actions monday proposes for a Thread from a fixed
// catalog, because a Signal says it fits, with the arguments already chosen.
// The Server works out which actions a Thread's current answers and Facts
// allow (every gate, every argument, the dates) and keeps them sealed; the
// client applies what the Settings say at show time (the thresholds by risk,
// the per-action switches, the muted senders, the limits), so a changed
// Setting or a learnt threshold shows at once and offline. Runtime-neutral:
// types and pure rules only.

import { utcToZoned } from "./calendar.ts";
import type { Id, IsoDate, Person } from "./domain.ts";

/** The catalog, in the order the Settings page lists it. */
export const RECOMMENDED_ACTIONS = ["reply", "archive", "snooze", "forward", "delegate"] as const;
export type RecommendedActionKind = (typeof RECOMMENDED_ACTIONS)[number];

export function isRecommendedAction(value: unknown): value is RecommendedActionKind {
  return typeof value === "string" && (RECOMMENDED_ACTIONS as readonly string[]).includes(value);
}

/** The actions whose chip shows only when their fit clears a threshold (the rest rest on Facts). */
export const JUDGED_ACTIONS: readonly RecommendedActionKind[] = [
  "reply",
  "archive",
  "snooze",
  "forward",
  "delegate",
];

/** The arguments each action carries, code-assembled from the Signal answers and Facts. */
export type RecommendationArgs =
  | { kind: "reply" }
  | { kind: "archive" }
  | {
      kind: "snooze";
      /** When it comes back; null when the Thread points to no day, and the chip opens the picker. */
      until: IsoDate | null;
      /** What the time was read from: the anchor Choice, or `none`. */
      anchor: string;
    }
  | {
      kind: "forward" | "delegate";
      to: Person;
      /** The recipient Choice's confidence; the chip needs actions.recommended.forward.to_confidence. */
      confidence: number;
    };

/** One Recommended action for one Thread version. */
export type Recommendation = RecommendationArgs & {
  /** The fit Signal's probability (1 for an action that rests on Facts alone). */
  fit: number;
  /** The order among a Thread's actions: fit times the action's recent use rate. */
  rank: number;
};

/** A Thread's Recommended actions as the Server worked them out for one Thread version. */
export interface ThreadRecommendations {
  threadId: Id;
  messageCount: number;
  latestMessageId: string;
  computedAt: IsoDate;
  /** The newest sender's domain, for the per-sender mute. */
  fromDomain: string | null;
  actions: Recommendation[];
}

/**
 * The Changes feed's `recommendations` change: headers only (the arguments
 * are content, fetched through GET /threads/:id/recommendations as soon as
 * the row lands, the way a Brief's bullets are).
 */
export interface RecommendationsChange {
  threadId: Id;
  messageCount: number;
  computedAt: IsoDate;
  /** Which actions it holds, in rank order; the Signals page and a quick check read these. */
  kinds: RecommendedActionKind[];
  deleted?: boolean | undefined;
}

/** What became of a chip the user was shown (docs/spec/actions.md, "Learning from what the user does"). */
export type RecommendationOutcome = "used" | "dismissed" | "ignored" | "other_used";

/* ------------------------------ Choosing what to show ------------------------------ */

/** The Settings that choose what a Thread shows, read per action. */
export interface RecommendationRules {
  enabled: boolean;
  actions: Partial<
    Record<
      RecommendedActionKind,
      {
        enabled: boolean;
        /** The fit threshold (by risk); absent for an action resting on Facts. */
        threshold?: number | undefined;
        mutedSenders: readonly string[];
      }
    >
  >;
  /** actions.recommended.forward.to_confidence: the recipient floor for Forward and Hand to. */
  recipientConfidence: number;
}

/** The rules as the Settings hold them (actions.recommended.*). */
export function recommendationRules(s: Readonly<Record<string, unknown>>): RecommendationRules {
  const num = (key: string, fallback: number) =>
    typeof s[key] === "number" ? (s[key] as number) : fallback;
  const actions: RecommendationRules["actions"] = {};
  for (const kind of RECOMMENDED_ACTIONS) {
    const base = `actions.recommended.${kind}`;
    const muted = s[`${base}.muted_senders`];
    const threshold = s[`${base}.threshold`];
    actions[kind] = {
      enabled: s[`${base}.enabled`] !== false,
      ...(typeof threshold === "number" ? { threshold } : {}),
      mutedSenders: Array.isArray(muted) ? (muted as string[]) : [],
    };
  }
  return {
    enabled: s["actions.recommended.enabled"] !== false,
    actions,
    recipientConfidence: num("actions.recommended.forward.to_confidence", 0.8),
  };
}

/** Whether a sender's domain is on a mute list: the domain itself or any domain under it. */
export function senderMuted(domain: string | null, muted: readonly string[]): boolean {
  if (!domain) return false;
  const d = domain.toLowerCase();
  return muted.some((m) => {
    const x = m.trim().toLowerCase().replace(/^@/, "");
    return x !== "" && (d === x || d.endsWith(`.${x}`));
  });
}

export interface ChooseContext {
  /** The newest sender's domain. */
  fromDomain: string | null;
  /** Actions the user dismissed on this Thread ("Not this"). */
  dismissed?: ReadonlySet<RecommendedActionKind> | undefined;
  /** A Custom action already archives this Thread: the Recommended archive is not shown. */
  customArchives?: boolean | undefined;
  /** A Custom action with the same tool and arguments renders instead (it renders once, as the Custom action). */
  customCovers?: ((rec: Recommendation) => boolean) | undefined;
}

/**
 * The Recommended actions a Thread shows, likeliest first: each one enabled,
 * not muted for the sender, not dismissed here, past its threshold, and with
 * every argument it needs confident. Ties go by rank (fit times use rate),
 * then by the catalog's order. The caller applies the chip limits.
 */
export function chooseRecommended(
  recs: readonly Recommendation[],
  rules: RecommendationRules,
  ctx: ChooseContext,
): Recommendation[] {
  if (!rules.enabled) return [];
  const out = recs.filter((r) => {
    const rule = rules.actions[r.kind];
    if (!rule?.enabled) return false;
    if (senderMuted(ctx.fromDomain, rule.mutedSenders)) return false;
    if (ctx.dismissed?.has(r.kind)) return false;
    if (rule.threshold !== undefined && r.fit < rule.threshold) return false;
    if ((r.kind === "forward" || r.kind === "delegate") && r.confidence < rules.recipientConfidence)
      return false;
    if (r.kind === "archive" && ctx.customArchives) return false;
    if (ctx.customCovers?.(r)) return false;
    return true;
  });
  // One recipient chip per Thread: a hand-off and a forward to the same person, the likelier wins.
  const seen = new Set<string>();
  const order = (k: RecommendedActionKind) => RECOMMENDED_ACTIONS.indexOf(k);
  return out
    .sort((a, b) => b.rank - a.rank || b.fit - a.fit || order(a.kind) - order(b.kind))
    .filter((r) => {
      if (r.kind !== "forward" && r.kind !== "delegate") return true;
      const key = r.to.email.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/* ------------------------------ Words ------------------------------ */

/** The words a chip is made of (strings.actions.recommended.*). */
export interface RecommendationWords {
  reply: string;
  archive: string;
  snooze: string;
  snoozeUntil: string;
  forwardTo: string;
  handTo: string;
}

export function recommendationWords(s: Readonly<Record<string, unknown>>): RecommendationWords {
  const w = (key: string, fallback: string) =>
    typeof s[`strings.actions.recommended.${key}`] === "string"
      ? (s[`strings.actions.recommended.${key}`] as string)
      : fallback;
  return {
    reply: w("reply", "Reply"),
    archive: w("archive", "Archive"),
    snooze: w("snooze", "Snooze"),
    snoozeUntil: w("snooze_until", "Snooze until {when}"),
    forwardTo: w("forward_to", "Forward to {name}"),
    handTo: w("hand_to", "Hand to {name}"),
  };
}

export const fillWords = (template: string, vars: Record<string, string | number>): string =>
  template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** An instant's wall clock in a zone (the device's when none is named). */
function wall(at: Date, zone: string | null) {
  if (zone) {
    try {
      const p = utcToZoned(zone, at);
      const weekday = new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay();
      return { y: p.y, mo: p.mo, d: p.d, h: p.h, mi: p.mi, weekday };
    } catch {
      /* the device's clock below */
    }
  }
  return {
    y: at.getFullYear(),
    mo: at.getMonth() + 1,
    d: at.getDate(),
    h: at.getHours(),
    mi: at.getMinutes(),
    weekday: at.getDay(),
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * "Mon 09:00" within the coming week, "Oct 3 09:00" beyond it; without a
 * time, "Thu" or "Oct 3". Days are counted in the zone given.
 */
export function formatWhen(
  at: IsoDate,
  now: Date,
  options: { zone?: string | null; time?: boolean } = {},
): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  const zone = options.zone ?? null;
  const w = wall(d, zone);
  const n = wall(now, zone);
  const days = Math.round(
    (Date.UTC(w.y, w.mo - 1, w.d) - Date.UTC(n.y, n.mo - 1, n.d)) / 86_400_000,
  );
  const day = days >= 0 && days < 7 ? WEEKDAY_SHORT[w.weekday] : `${MONTH_SHORT[w.mo - 1]} ${w.d}`;
  return options.time === false ? `${day}` : `${day} ${pad(w.h)}:${pad(w.mi)}`;
}

/** "Oct 3": a date in words, always the month and the day. */
export function formatDay(at: IsoDate, zone: string | null = null): string {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return at;
  const w = wall(d, zone);
  return `${MONTH_SHORT[w.mo - 1]} ${w.d}`;
}

/** A person's first name for a chip ("Forward to Priya"), else the address. */
export function shortName(p: Person): string {
  const name = p.name.trim();
  if (name) return name.split(/\s+/)[0] ?? name;
  return p.email;
}

/** A chip's words, from the Settings strings: "Snooze until Mon 09:00", "Forward to Priya". */
export function recommendationLabel(
  rec: RecommendationArgs,
  words: RecommendationWords,
  now: Date,
  zone: string | null = null,
): string {
  switch (rec.kind) {
    case "reply":
      return words.reply;
    case "archive":
      return words.archive;
    case "snooze":
      return rec.until
        ? fillWords(words.snoozeUntil, { when: formatWhen(rec.until, now, { zone }) })
        : words.snooze;
    case "forward":
      return fillWords(words.forwardTo, { name: shortName(rec.to) });
    case "delegate":
      return fillWords(words.handTo, { name: shortName(rec.to) });
  }
}

/** Whether two sets of arguments ask the same thing (a chip used as offered, or with other arguments). */
export function sameArguments(a: RecommendationArgs, b: RecommendationArgs): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "snooze": {
      const until = (b as typeof a).until;
      if (!a.until || !until) return a.until === until;
      // A snooze within the hour of the one offered is the one offered.
      return Math.abs(Date.parse(a.until) - Date.parse(until)) < 3_600_000;
    }
    case "forward":
    case "delegate":
      return a.to.email.toLowerCase() === (b as typeof a).to.email.toLowerCase();
    default:
      return true;
  }
}

/**
 * What a user's own action on a Thread makes of a chip it showed: the same
 * action with the same arguments is `used`, with other ones `other_used`
 * (a different recipient), and any other action that dealt with the Thread
 * (archive, snooze, a reply) leaves the chip `ignored`.
 */
export function outcomeOf(
  shown: RecommendationArgs,
  done: RecommendationArgs,
): RecommendationOutcome {
  const kindOf = (r: RecommendationArgs) => (r.kind === "delegate" ? "forward" : r.kind);
  if (kindOf(shown) !== kindOf(done)) return "ignored";
  return sameArguments(shown, { ...done, kind: shown.kind } as RecommendationArgs)
    ? "used"
    : "other_used";
}
