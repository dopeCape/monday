// Recommended action chips (docs/spec/actions.md; slices 34 and 35). The
// Server works out which actions a Thread allows (recommend.ts); this module
// chooses what shows from the Settings (the thresholds by risk, the switches,
// the mutes), builds the reader's one chip row (Custom actions first, then
// the meeting chips, then the Recommended actions, at most
// actions.recommended.max_in_reader) and a row's one hover chip, words each
// chip from the strings Settings, and runs a chip as its ordinary tool call
// with its Tier (ADR 0002): a reply, a forward or a hand-off opens compose
// and sends nothing; archive and snooze apply with Undo; an RSVP and an
// unsubscribe ask first with their exact payload; a payment page, a carrier's
// page open read-only in the browser; a Workflow runs with every Step keeping
// its own approval. Pure but for the runner, which acts through the seams it
// is handed.

import type { Person, Recommendation, RecommendationWords, Settings, Tier } from "@monday/shared";
import {
  chooseRecommended,
  recommendationLabel,
  recommendationRules,
  recommendationWords,
} from "@monday/shared";
import type { UndoToken } from "./actions.ts";

/** One chip of the reader's row, in its order. */
export type ReaderChip =
  | {
      key: string;
      kind: "custom";
      label: string;
      tier: Tier;
      title?: string | undefined;
      id: string;
    }
  | {
      key: string;
      kind: "meeting";
      label: string;
      title?: string | undefined;
      index: number;
      /** The meeting chip's own kind (offer_times, schedule, ...). */
      meeting: string;
    }
  | {
      key: string;
      kind: "recommended";
      label: string;
      tier: Tier;
      title?: string | undefined;
      rec: Recommendation;
      /** The chip's menu: "Not this", "Not for mail from stripe.com", and the action's own. */
      menu?: ReadonlyArray<{ key: string; label: string }> | undefined;
      /** An RSVP is one grouped control: its three answers, each a button. */
      options?: ReadonlyArray<{ key: string; label: string }> | undefined;
    }
  /** The follow-up a hand-off offers: snooze the Thread to check it was done. */
  | {
      key: string;
      kind: "follow_up";
      label: string;
      tier: Tier;
      title?: string | undefined;
      until: string;
    };

/** What a reply, forward or hand-off chip hands the compose surface; nothing is sent. */
export interface ComposeSeed {
  /** The Brief's proposed opening line. */
  opening?: string | undefined;
  /** The forward recipient. */
  to?: Person[] | undefined;
  /** People copied in: the person a hand-off goes to. */
  cc?: Person[] | undefined;
}

/** The Tier a Recommended action runs at (ADR 0002). */
export function recommendationTier(rec: Recommendation): Tier {
  switch (rec.kind) {
    case "archive":
    case "snooze":
    case "workflow":
      return "reversible";
    case "track":
      return "read-only";
    case "pay":
      // Opening the payment page is read-only; without a page the chip snoozes (reversible).
      return rec.link ? "read-only" : "reversible";
    default:
      // A reply, a forward and a hand-off open compose; sending is the user's and asks as always.
      return "always-ask";
  }
}

export interface ChooseInput {
  settings: Settings;
  recommendations: readonly Recommendation[];
  fromDomain: string | null;
  /** Actions dismissed on this Thread ("Not this"). */
  dismissed?: ReadonlySet<string> | undefined;
  /** A Custom action already archives this Thread. */
  customArchives?: boolean | undefined;
}

/** The Recommended actions a Thread shows under the Settings, likeliest first, no limit applied. */
export function shownRecommendations(input: ChooseInput): Recommendation[] {
  if (input.settings["ai.level"] === "off") return [];
  return chooseRecommended(input.recommendations, recommendationRules(input.settings), {
    fromDomain: input.fromDomain,
    ...(input.dismissed
      ? { dismissed: input.dismissed as ReadonlySet<Recommendation["kind"]> }
      : {}),
    ...(input.customArchives ? { customArchives: true } : {}),
  });
}

/** A chip's words, from the strings Settings, dates in the Device's zone. */
export function recommendedChipLabel(
  rec: Recommendation,
  words: RecommendationWords,
  now: Date,
  options: { replyTemplate?: string | null; replyWith?: string; timeConfidence?: number } = {},
): string {
  // "Reply with Confirm the time" when a Template fits (docs/spec/templates.md, "On open").
  if (rec.kind === "reply" && options.replyTemplate && options.replyWith) {
    return options.replyWith.replace("{name}", options.replyTemplate);
  }
  return recommendationLabel(rec, words, now, null, options.timeConfidence ?? 0.7);
}

/** The menu items a Recommended chip carries, as the screen words them. */
export interface MenuWords {
  notThis: string;
  notFor: string;
  remindPay: string;
  file: string;
  trackSnooze: string;
}

/**
 * A chip's menu (docs/spec/actions.md): "Not this" hides it on this Thread,
 * "Not for mail from stripe.com" stops the action for the sender, and the
 * action's own: Remind me to pay and File on a pay chip, Snooze until the
 * delivery day on a tracking chip.
 */
export function chipMenu(
  rec: Recommendation,
  fromDomain: string | null,
  words: MenuWords,
  options: { fileAction?: boolean } = {},
): Array<{ key: string; label: string }> {
  const out: Array<{ key: string; label: string }> = [];
  if (rec.kind === "pay" && rec.link) out.push({ key: "remind", label: words.remindPay });
  if (rec.kind === "pay" && options.fileAction) out.push({ key: "file", label: words.file });
  if (rec.kind === "track" && rec.deliveryDay)
    out.push({ key: "delivery", label: words.trackSnooze });
  out.push({ key: "not_this", label: words.notThis });
  if (fromDomain) out.push({ key: "not_for", label: words.notFor.replace("{domain}", fromDomain) });
  return out;
}

export interface RowInput {
  custom: ReadonlyArray<{ id: string; label: string; tier: Tier; title?: string | undefined }>;
  meetings: ReadonlyArray<{ kind: string; label: string; title?: string | undefined }>;
  /** The meeting chips' own cap (meetings.max_in_reader). */
  meetingMax: number;
  recommended: readonly Recommendation[];
  followUp?: { label: string; until: string } | null | undefined;
  /** actions.recommended.max_in_reader */
  max: number;
  words: RecommendationWords;
  now: Date;
  replyTemplate?: string | null | undefined;
  replyWith?: string | undefined;
  /** actions.recommended.calendar.time_confidence, for the calendar chip's words. */
  timeConfidence?: number | undefined;
  /** Each Recommended chip's menu, by the screen. */
  menu?: ((rec: Recommendation) => ReadonlyArray<{ key: string; label: string }>) | undefined;
}

/**
 * The reader's chip row: Custom actions first (the user's own), then the
 * meeting chips (they take the place of Add to calendar), then the
 * Recommended actions likeliest first, never more than `max` in all. A
 * Custom action that does what a Recommended action would renders once, as
 * the Custom action (the caller filters those out of `recommended`).
 */
export function readerChips(input: RowInput): ReaderChip[] {
  const out: ReaderChip[] = [];
  const room = () => out.length < Math.max(0, input.max);
  for (const c of input.custom) {
    if (!room()) break;
    out.push({
      key: `custom:${c.id}`,
      kind: "custom",
      label: c.label,
      tier: c.tier,
      title: c.title,
      id: c.id,
    });
  }
  if (input.followUp && room()) {
    out.push({
      key: "follow_up",
      kind: "follow_up",
      label: input.followUp.label,
      tier: "reversible",
      until: input.followUp.until,
    });
  }
  input.meetings.slice(0, Math.max(0, input.meetingMax)).forEach((m, index) => {
    if (room())
      out.push({
        key: `meeting:${index}`,
        kind: "meeting",
        label: m.label,
        title: m.title,
        index,
        meeting: m.kind,
      });
  });
  for (const rec of input.recommended) {
    if (!room()) break;
    out.push({
      key: `rec:${rec.kind}`,
      kind: "recommended",
      label: recommendedChipLabel(rec, input.words, input.now, {
        replyTemplate: input.replyTemplate ?? null,
        ...(input.replyWith ? { replyWith: input.replyWith } : {}),
        ...(input.timeConfidence !== undefined ? { timeConfidence: input.timeConfidence } : {}),
      }),
      tier: recommendationTier(rec),
      rec,
      ...(input.menu ? { menu: input.menu(rec) } : {}),
      // monday does not guess the answer to an Invite: the three are the user's to pick.
      ...(rec.kind === "rsvp"
        ? {
            options: [
              { key: "accepted", label: input.words.accept },
              { key: "tentative", label: input.words.maybe },
              { key: "declined", label: input.words.decline },
            ],
          }
        : {}),
    });
  }
  return out;
}

/** How a row shows its top suggestion: on hover (and the selected row), always, or not at all. */
export function listMode(settings: Settings): "hover" | "always" | "off" {
  if (settings["ai.level"] === "off" || !settings["actions.recommended.enabled"]) return "off";
  if (settings["actions.recommended.max_in_list"] < 1) return "off";
  return settings["actions.recommended.in_list"];
}

/** The words for a Settings snapshot, once per render. */
export function wordsOf(settings: Settings): RecommendationWords {
  return recommendationWords(settings as unknown as Record<string, unknown>);
}

/* ------------------------------ Keys ------------------------------ */

export interface KeyEventLike {
  key: string;
  code?: string | undefined;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/**
 * Which of actions.recommended.keys a key press is, by position (0 for the
 * first chip), or -1. "alt+1" matches the digit by its physical key too, so
 * Option+1 on a Mac (which types "¡") still runs the first chip.
 */
export function recommendedKeyIndex(keys: readonly string[], e: KeyEventLike): number {
  return keys.findIndex((chord) => {
    const parts = chord
      .toLowerCase()
      .split("+")
      .map((p) => p.trim());
    const key = parts[parts.length - 1] ?? "";
    const mods = new Set(parts.slice(0, -1));
    const mod = mods.has("mod") || mods.has("ctrl") || mods.has("cmd") || mods.has("meta");
    if (mods.has("alt") !== e.altKey) return false;
    if (mod !== (e.ctrlKey || e.metaKey)) return false;
    if (mods.has("shift") !== e.shiftKey && !/^\d$/.test(key)) return false;
    if (e.key.toLowerCase() === key) return true;
    return /^\d$/.test(key) && e.code === `Digit${key}`;
  });
}

/* ------------------------------ Running a chip ------------------------------ */

/** What running a Recommended action came to. */
export type RecommendationOutcome =
  | {
      ok: true;
      applied:
        | "compose"
        | "picker"
        | "card"
        | "opened"
        | "rsvp"
        | "calendar"
        | "editor"
        | "workflow";
    }
  | { ok: true; applied: "archive" | "snooze"; undo: UndoToken | null; until?: string | undefined }
  | { ok: false; reason: "unavailable" | "calendar_unavailable" };

export interface RecommendationRunner {
  /** `option` is the RSVP answer the user picked on the grouped control. */
  run(rec: Recommendation, threadId: string, option?: string): Promise<RecommendationOutcome>;
}

export interface RecommendationRunnerDeps {
  /** Opens the reply with the Brief's proposed opening line; the user sends (ADR 0002). */
  reply(threadId: string, opening: string | null): void;
  /** Opens a forward with the person filled; nothing is sent. */
  forward(threadId: string, to: Person): void;
  /** Opens the hand-off reply (the "Handing this over" Template) with the person copied in; nothing is sent. */
  handOff(threadId: string, to: Person): void;
  archive(threadId: string): Promise<UndoToken | null>;
  snooze(threadId: string, until: Date): Promise<UndoToken | null>;
  /** The snooze picker, for a snooze with no time. */
  pickSnooze(threadId: string): void;
  /** The Brief's proposed reply line for the Thread, when it has one. */
  replyLine(threadId: string): string | null;
  /** The Invite's answer, through the calendar's RSVP (it asks as always); absent without a calendar. */
  rsvp?:
    | ((inviteId: string, response: "accepted" | "tentative" | "declined") => Promise<void>)
    | undefined;
  /** The owner's own Event, no invitees; absent without a calendar. */
  createEvent?:
    | ((event: { title: string; start: string; end: string }) => Promise<void>)
    | undefined;
  /** The event editor on a day, for a time not read with confidence. */
  openEditor?: ((event: { day: string; title: string }) => void) | undefined;
  /** Opens a page in the browser (read-only). */
  openLink(url: string): void | Promise<void>;
  /** Shows the unsubscribe card with the exact request; it asks before anything is sent. */
  unsubscribe?:
    | ((threadId: string, rec: Extract<Recommendation, { kind: "unsubscribe" }>) => void)
    | undefined;
  /** Starts a Workflow on the Thread; each Step keeps its own approval. */
  runWorkflow?: ((workflowId: string, threadId: string) => Promise<void>) | undefined;
  /** actions.recommended.calendar.time_confidence */
  timeConfidence?: number | undefined;
}

export function createRecommendationRunner(deps: RecommendationRunnerDeps): RecommendationRunner {
  /** A snooze until a time, or the picker when there is none. */
  const remind = async (at: string | null, threadId: string): Promise<RecommendationOutcome> => {
    const until = at ? new Date(at) : null;
    if (!until || Number.isNaN(until.getTime()) || until.getTime() <= Date.now()) {
      deps.pickSnooze(threadId);
      return { ok: true, applied: "picker" };
    }
    return {
      ok: true,
      applied: "snooze",
      undo: await deps.snooze(threadId, until),
      until: until.toISOString(),
    };
  };
  return {
    async run(rec, threadId, option) {
      switch (rec.kind) {
        case "rsvp": {
          if (!deps.rsvp) return { ok: false, reason: "calendar_unavailable" };
          if (option !== "accepted" && option !== "tentative" && option !== "declined")
            return { ok: false, reason: "unavailable" };
          await deps.rsvp(rec.inviteId, option);
          return { ok: true, applied: "rsvp" };
        }
        case "calendar": {
          const timed =
            rec.start !== null &&
            rec.end !== null &&
            rec.timeConfidence >= (deps.timeConfidence ?? 0.7);
          if (timed && deps.createEvent) {
            await deps.createEvent({
              title: rec.title,
              start: rec.start as string,
              end: rec.end as string,
            });
            return { ok: true, applied: "calendar" };
          }
          if (deps.openEditor) {
            deps.openEditor({ day: rec.day, title: rec.title });
            return { ok: true, applied: "editor" };
          }
          return { ok: false, reason: "calendar_unavailable" };
        }
        case "pay": {
          if (rec.link) {
            await deps.openLink(rec.link.url);
            return { ok: true, applied: "opened" };
          }
          return remind(rec.remindAt, threadId);
        }
        case "unsubscribe":
          if (!deps.unsubscribe) return { ok: false, reason: "unavailable" };
          deps.unsubscribe(threadId, rec);
          return { ok: true, applied: "card" };
        case "track":
          await deps.openLink(rec.url);
          return { ok: true, applied: "opened" };
        case "workflow":
          if (!deps.runWorkflow) return { ok: false, reason: "unavailable" };
          await deps.runWorkflow(rec.workflowId, threadId);
          return { ok: true, applied: "workflow" };
        case "reply":
          deps.reply(threadId, deps.replyLine(threadId));
          return { ok: true, applied: "compose" };
        case "forward":
          deps.forward(threadId, rec.to);
          return { ok: true, applied: "compose" };
        case "delegate":
          deps.handOff(threadId, rec.to);
          return { ok: true, applied: "compose" };
        case "archive":
          return { ok: true, applied: "archive", undo: await deps.archive(threadId) };
        case "snooze":
          return remind(rec.until, threadId);
      }
    },
  };
}

/** When a hand-off's follow-up snooze would end: `days` from now at the morning hour, or null when off. */
export function followUpUntil(now: Date, days: number, morningHour: number): Date | null {
  if (days <= 0) return null;
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  d.setHours(morningHour, 0, 0, 0);
  return d;
}
