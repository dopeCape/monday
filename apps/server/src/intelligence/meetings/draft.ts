// The reply a meeting chip opens (docs/spec/meetings.md, "The reply"): the
// language model writes a few sentences in the user's voice around times
// code chose, and code checks the result names only those times. Anything
// else (a time or day that is not offered, an offered time left out, no
// model at all) falls back to the Setting's template with the same slot
// lines. The text goes into a reply Draft; nothing here sends (ADR 0002).

import type { MeetingDraftKind, MeetingSlot, VoiceProfile } from "@monday/shared";
import type { HostedRuntime } from "../runtime/index.ts";
import { clockCandidates } from "./extract.ts";

export interface DraftWords {
  prompt: string;
  offer: string;
  suggest: string;
  accept: string;
  slot: string;
}

const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (all, key: string) => values[key] ?? all);

function parts(at: Date, zone: string) {
  const day = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: zone,
  }).format(at);
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: zone,
  }).format(at);
  const zoneName =
    new Intl.DateTimeFormat("en-GB", { timeZone: zone, timeZoneName: "short" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")?.value ?? zone;
  return { day, time, zone: zoneName };
}

/** One offered slot as its line: "- Thursday 1 October, 15:00 to 15:30 BST". */
export function slotLine(slot: MeetingSlot, zone: string, template: string): string {
  const s = parts(new Date(slot.start), zone);
  const e = parts(new Date(slot.end), zone);
  return fill(template, { day: s.day, start: s.time, end: e.time, zone: s.zone }).trim();
}

/** "Thursday 1 October at 15:00 BST". */
export function whenText(at: string, zone: string): string {
  const p = parts(new Date(at), zone);
  return `${p.day} at ${p.time} ${p.zone}`;
}

/** The template reply: the Setting's words with the slot lines, never a model. */
export function templateReply(
  kind: MeetingDraftKind,
  slots: readonly MeetingSlot[],
  zone: string,
  words: DraftWords,
  proposed: string | null,
): string {
  const lines = slots.map((s) => slotLine(s, zone, words.slot)).join("\n");
  if (kind === "accept") {
    const first = slots[0];
    return fill(words.accept, { when: first ? whenText(first.start, zone) : "" });
  }
  if (kind === "suggest") {
    return fill(words.suggest, {
      slots: lines,
      proposed: proposed ? whenText(proposed, zone) : "",
    });
  }
  return fill(words.offer, { slots: lines });
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const RELATIVE = /\b(today|tonight|tomorrow|next week|this week|yesterday)\b/i;

function minutesIn(at: string, zone: string): number {
  const t = parts(new Date(at), zone).time;
  const [h = "0", m = "0"] = t.split(":");
  return Number(h) * 60 + Number(m);
}

function weekdayIn(at: string, zone: string): string {
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: zone })
    .format(new Date(at))
    .toLowerCase();
}

/**
 * Whether a written reply names only the offered times: every clock time in
 * it is an offered start or end (or the proposed time a suggestion declines),
 * every weekday and month named is one of the offered ones, no relative day
 * word, and every offered start appears. Code, not the model, says so.
 */
export function groundedIn(
  text: string,
  slots: readonly MeetingSlot[],
  zone: string,
  proposed: string | null,
): boolean {
  const allowedTimes = new Set<number>();
  const allowedDays = new Set<string>();
  const allowedMonths = new Set<string>();
  const all = [...slots.flatMap((s) => [s.start, s.end]), ...(proposed ? [proposed] : [])];
  for (const at of all) {
    allowedTimes.add(minutesIn(at, zone));
    allowedDays.add(weekdayIn(at, zone));
    allowedMonths.add(
      new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: zone })
        .format(new Date(at))
        .toLowerCase(),
    );
  }
  if (RELATIVE.test(text)) return false;
  for (const c of clockCandidates(text, 50)) {
    const hours = c.hour24 !== null ? [c.hour24] : [c.hour % 12, (c.hour % 12) + 12];
    if (!hours.some((h) => allowedTimes.has(h * 60 + c.minute))) return false;
  }
  const lower = text.toLowerCase();
  for (const d of WEEKDAYS) {
    if (new RegExp(`\\b${d}\\b`).test(lower) && !allowedDays.has(d)) return false;
  }
  for (const m of MONTHS) {
    if (new RegExp(`\\b${m}\\b`).test(lower) && !allowedMonths.has(m)) return false;
  }
  for (const s of slots) {
    const p = parts(new Date(s.start), zone);
    const [h = "0", mi = "0"] = p.time.split(":");
    const hour = Number(h);
    const variants = [p.time, `${hour}:${mi}`, `${hour % 12 || 12}${mi === "00" ? "" : `:${mi}`}`];
    if (!variants.some((v) => lower.includes(v.toLowerCase()))) return false;
  }
  return true;
}

export interface WriteReplyInput {
  runtime: HostedRuntime;
  workspaceId: string;
  kind: MeetingDraftKind;
  slots: readonly MeetingSlot[];
  /** The proposed time a suggestion declines. */
  proposed: string | null;
  zone: string;
  words: DraftWords;
  voice: VoiceProfile | null;
  thread: { subject: string; from: string; text: string };
}

/** The reply text: the model's when it is grounded, the template's otherwise. Never throws for want of a model. */
export async function writeReply(
  input: WriteReplyInput,
): Promise<{ text: string; written: boolean; voice: boolean }> {
  const lines = input.slots.map((s) => slotLine(s, input.zone, input.words.slot));
  const template = templateReply(input.kind, input.slots, input.zone, input.words, input.proposed);
  const ask =
    input.kind === "accept"
      ? `Say that this time works for the owner: ${lines[0] ?? ""}`
      : input.kind === "suggest"
        ? `Say the owner is not free at ${input.proposed ? whenText(input.proposed, input.zone) : "the proposed time"} and offer these times instead, one per line exactly as written:\n${lines.join("\n")}`
        : `Offer these times, one per line exactly as written:\n${lines.join("\n")}`;
  const system = [
    input.words.prompt,
    input.voice
      ? `Write the way this person writes:\n${input.voice.description}${
          input.voice.excerpts.length
            ? `\nExamples of their writing:\n${input.voice.excerpts.map((e) => `- ${e}`).join("\n")}`
            : ""
        }`
      : "",
  ]
    .filter((p) => p.trim() !== "")
    .join("\n\n");
  const prompt = [
    ask,
    `Subject: ${input.thread.subject}`,
    `The message being answered, from ${input.thread.from}:\n<<<\n${input.thread.text}\n>>>`,
  ].join("\n\n");
  try {
    const result = await input.runtime.run(
      "draft-in-voice",
      { system, prompt },
      { workspaceId: input.workspaceId, jobId: null },
    );
    const text = result.output
      .trim()
      .replace(/^```[a-z]*\n?|\n?```$/g, "")
      .replace(/\s*\u2014\s*/g, ", ")
      .trim();
    if (text && groundedIn(text, input.slots, input.zone, input.proposed)) {
      return { text, written: true, voice: input.voice !== null };
    }
  } catch {
    // No model (no key, no Local runtime) or a failed call: the template still gives a usable draft.
  }
  return { text: template, written: false, voice: false };
}
