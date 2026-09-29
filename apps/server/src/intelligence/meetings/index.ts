// Meetings from mail (docs/spec/meetings.md): the module behind the meeting
// chips and the agent's meeting_options tool. One meeting request per Thread
// version (the newest Message decides), asked on arrival at `automate` as a
// `meeting` Job and on open otherwise, through the judge when TypeSafe
// answers and the language model's prompt path when it does not (the same
// questions), stored per Thread with the Message it read. What the chips
// are is computed from that reading and the calendar as it is now, so a
// changed calendar changes the chip without asking the model again.
//
// Code owns every date, zone, free or busy decision and slot; the judge picks
// among spans and closed sets; the language model writes only the reply
// prose, which code checks names only the offered times.

import type {
  AiLevel,
  CalendarEvent,
  JudgeAnswers,
  JudgeQuestions,
  MeetingChange,
  MeetingChip,
  MeetingDraftKind,
  MeetingDraftResult,
  MeetingJudgedBy,
  MeetingOptions,
  MeetingSlot,
  Person,
  VoiceProfile,
} from "@monday/shared";
import { isIanaZone } from "@monday/shared";
import type { Job, Jobs } from "../../jobs/index.ts";
import { quoteStart } from "../../mail/text.ts";
import { type CalendarSeam, instancesIn } from "../agent/tools/calendar.ts";
import { promptJudge } from "../prompt-judge.ts";
import {
  AiOffError,
  type HostedRuntime,
  NoJudgeError,
  NoProviderKeyError,
} from "../runtime/index.ts";
import { type DraftWords, writeReply } from "./draft.ts";
import {
  clockCandidates,
  hasGateWord,
  looksEnglish,
  mentionsTime,
  offsetOfDateHeader,
  ownText,
  zoneCandidates,
} from "./extract.ts";
import { type BusySpan, type PlanSettings, planMeeting, planWindow, stillFree } from "./plan.ts";
import {
  type MeetingQuestionWords,
  meetingQuestions,
  meetingState,
  NONE,
  NOT_STATED,
  partIds,
  writtenIn,
} from "./questions.ts";
import type { MeetingReading, PartAnswer, ProposalParts } from "./resolve.ts";

export type { BusySpan, PlanInput, PlanSettings } from "./plan.ts";
export { planMeeting, planWindow } from "./plan.ts";
export type { MeetingQuestionWords } from "./questions.ts";
export { meetingQuestions, meetingState } from "./questions.ts";
export type { MeetingReading, PartAnswer, ProposalParts, ResolveContext } from "./resolve.ts";
export { resolveReading, resolveWeekday, resolveYear } from "./resolve.ts";

export const MEETING_STEP = "meeting";

export interface MeetingJobPayload {
  workspaceId: string;
  threadId: string;
}

/** The Settings the module reads, gathered by the caller (meetings.*, calendar.*, strings.meetings.*). */
export interface MeetingSettings {
  enabled: boolean;
  onArrival: boolean;
  llmFallback: boolean;
  proposalsMax: number;
  candidatesMax: number;
  newestChars: number;
  earlierChars: number;
  gateWords: string[];
  busyCalendars: "own" | "shown";
  /** calendar.time_zone; empty means the Device's, else UTC. */
  timeZone: string;
  questions: MeetingQuestionWords;
  draft: DraftWords;
  /** strings.meetings.event_title, "Meeting with {name}". */
  titleFallback: string;
  plan: PlanSettings;
}

/** One Message of a Thread as the module reads it: headers here, text on demand. */
export interface MeetingMessage {
  id: string;
  from: Person;
  to: Person[];
  cc: Person[];
  date: string;
  headers: Record<string, string>;
  attachments: Array<{ mediaType: string }>;
}

export interface MeetingThread {
  workspaceId: string;
  subject: string;
  owner: Person;
  participants: Person[];
  /** Oldest first. */
  messages: MeetingMessage[];
}

/** Where the Thread comes from: the mailstore on the Server, a fixture in tests. */
export interface MeetingThreadSource {
  read(threadId: string): Promise<MeetingThread | null>;
  /** A Message's plain text. Decrypts, so it needs the root key. */
  text(messageId: string): Promise<string>;
}

export interface StoredMeeting {
  reading: MeetingReading;
  chip: MeetingChip | null;
}

/** Where readings live: thread_meetings on the Server, a map in tests. */
export interface MeetingStore {
  get(threadId: string): Promise<StoredMeeting | null>;
  put(reading: MeetingReading, chip: MeetingChip | null): Promise<void>;
  /** Replaces only the chip, when the calendar moved it. */
  setChip(threadId: string, chip: MeetingChip | null): Promise<void>;
}

export interface MeetingsOptions {
  runtime: HostedRuntime;
  thread: MeetingThreadSource;
  store: MeetingStore;
  /** The calendar module, once the app attached it; null means no calendar can be read. */
  calendar: () => CalendarSeam | null;
  voice: (workspaceId: string) => Promise<VoiceProfile | null>;
  settings: () => Promise<MeetingSettings>;
  level: () => Promise<AiLevel>;
  /** Tells the Changes feed a Thread's meeting chip changed. */
  record?: ((workspaceId: string, change: MeetingChange) => Promise<void>) | undefined;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface MeetingOptionsRequest {
  /** The Device's zone, used when calendar.time_zone is empty. */
  zone?: string | undefined;
  /** Ask the judge when there is no reading of the newest Message yet (on open). Default true. */
  judge?: boolean | undefined;
  /** The agent's own window, length and count. */
  override?: {
    from?: Date | undefined;
    to?: Date | undefined;
    lengthMinutes?: number | undefined;
    count?: number | undefined;
  };
}

export interface Meetings {
  /** Asks the meeting request for the Thread's newest Message and stores it; null when nothing can answer. */
  judge(
    workspaceId: string,
    threadId: string,
    options?: { force?: boolean; jobId?: string | null; zone?: string | undefined },
  ): Promise<MeetingReading | null>;
  /** The case, times, slots and chips now. Throws AiOffError at level off. */
  options(
    workspaceId: string,
    threadId: string,
    request?: MeetingOptionsRequest,
  ): Promise<MeetingOptions>;
  /** The reply text for an offer, suggest or accept chip, with the slots re-checked. Never sends. */
  draft(
    workspaceId: string,
    threadId: string,
    request: {
      kind: MeetingDraftKind;
      slots: Array<{ start: string; end: string }>;
      zone?: string | undefined;
    },
  ): Promise<MeetingDraftResult>;
  /** The sync engine's hook: queues a meeting Job at `automate`. Never throws. */
  threadReady(workspaceId: string, threadId: string): Promise<void>;
  registerSteps(jobs: Jobs): void;
}

export class MeetingThreadNotFoundError extends Error {
  readonly status = 404;
  readonly code = "not_found";
  constructor(threadId: string) {
    super(`thread ${threadId} not found`);
    this.name = "MeetingThreadNotFoundError";
  }
}

const DAY = 86_400_000;

/** Whether two chips say the same thing, whatever order their keys were stored in. */
export function sameChip(a: MeetingChip | null, b: MeetingChip | null): boolean {
  if (!a || !b) return a === b;
  const key = (c: MeetingChip) =>
    [
      c.kind,
      c.start ?? "",
      c.end ?? "",
      c.day ?? "",
      [...c.flags].sort().join(","),
      (c.slots ?? []).map((s) => `${s.start}/${s.end}`).join(","),
    ].join("|");
  return key(a) === key(b);
}

/** The Job id for one Thread version, so the same Message is read once. */
export function meetingJobId(threadId: string, messageId: string): string {
  return `${MEETING_STEP}:${threadId}:${messageId}`;
}

function part(answer: unknown): PartAnswer {
  const a = answer as { choice?: unknown; confidence?: unknown } | undefined;
  return {
    choice: typeof a?.choice === "string" ? a.choice : NONE,
    confidence: typeof a?.confidence === "number" ? a.confidence : 0,
  };
}

function noul(answer: unknown): number | null {
  const n = (answer as { noul?: unknown } | undefined)?.noul;
  return typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null;
}

/** An Invite attached to the Thread: the invite bar handles it (case d). */
const INVITE_TYPE = /^(text|application)\/(calendar|ics)\b/i;

export function createMeetings(options: MeetingsOptions): Meetings {
  const { runtime } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  /** The zone each Workspace's Device last reported, for background plans when the Setting is empty. */
  const deviceZones = new Map<string, string>();
  let jobs: Jobs | null = null;

  const zoneFor = (workspaceId: string, s: MeetingSettings, given?: string): string => {
    if (given && isIanaZone(given)) deviceZones.set(workspaceId, given);
    if (s.timeZone && isIanaZone(s.timeZone)) return s.timeZone;
    return deviceZones.get(workspaceId) ?? "UTC";
  };

  const newestOf = (t: MeetingThread) =>
    [...t.messages].sort(
      (a, b) => Date.parse(a.date) - Date.parse(b.date) || a.id.localeCompare(b.id),
    );

  const hasInvite = async (threadId: string, t: MeetingThread): Promise<boolean> => {
    if (t.messages.some((m) => m.attachments.some((a) => INVITE_TYPE.test(a.mediaType))))
      return true;
    const calendar = options.calendar();
    if (!calendar) return false;
    try {
      return (await calendar.invitesOfThread(threadId)).length > 0;
    } catch {
      return false;
    }
  };

  /** The owner's busy spans over a window, by find_free_time's rules. Null without a calendar. */
  const busyIn = async (
    workspaceId: string,
    s: MeetingSettings,
    window: { from: Date; to: Date },
  ): Promise<BusySpan[] | null> => {
    const calendar = options.calendar();
    if (!calendar) return null;
    let calendars: Awaited<ReturnType<CalendarSeam["listCalendars"]>>;
    try {
      calendars = await calendar.listCalendars(workspaceId);
    } catch {
      return null;
    }
    const counted = calendars.filter((c) => (s.busyCalendars === "own" ? !c.sharedBy : c.visible));
    if (counted.length === 0) return null;
    const events: CalendarEvent[] = await calendar.listEvents(workspaceId, {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      calendarIds: counted.map((c) => c.id),
    });
    return instancesIn(
      events.filter((e) => e.response !== "declined" && e.status !== "cancelled" && !e.allDay),
      window,
    ).map((i) => ({
      start: i.start,
      end: i.end,
      title: i.event.title,
      attendees: i.event.attendees.map((a) => a.email.toLowerCase()),
    }));
  };

  const readThread = async (threadId: string): Promise<MeetingThread> => {
    const t = await options.thread.read(threadId);
    if (!t) throw new MeetingThreadNotFoundError(threadId);
    return t;
  };

  /** The judge's answers, or the language model's to the same questions; null when neither can answer. */
  const ask = async (
    workspaceId: string,
    state: Parameters<typeof promptJudge>[2],
    questions: JudgeQuestions,
    s: MeetingSettings,
    jobId: string | null,
  ): Promise<{
    answers: JudgeAnswers<JudgeQuestions>;
    model: string;
    by: MeetingJudgedBy;
  } | null> => {
    if (await runtime.judgeAvailable()) {
      try {
        const result = await runtime.judge("judge.meeting", state, questions, {
          workspaceId,
          jobId,
        });
        return { answers: result.answers, model: result.model, by: "typesafe" };
      } catch (error) {
        if (!(error instanceof NoJudgeError)) throw error;
      }
    }
    if (!s.llmFallback) return null;
    try {
      const result = await promptJudge(runtime, "classify", state, questions, {
        workspaceId,
        jobId,
      });
      return { answers: result.answers, model: result.model, by: "llm" };
    } catch (error) {
      if (error instanceof NoProviderKeyError || error instanceof AiOffError) return null;
      throw error;
    }
  };

  const plan = async (
    workspaceId: string,
    threadId: string,
    t: MeetingThread,
    reading: MeetingReading | null,
    s: MeetingSettings,
    zone: string,
    override?: MeetingOptionsRequest["override"],
  ): Promise<MeetingOptions> => {
    const at = now();
    const window = planWindow(reading, at, s.plan, override);
    const busy = await busyIn(workspaceId, s, window);
    return planMeeting({
      reading,
      threadId,
      now: at,
      ownerZone: zone,
      busy: busy ?? [],
      calendar: busy !== null,
      hasInvite: await hasInvite(threadId, t),
      subject: t.subject,
      titleFallback: s.titleFallback.replaceAll(
        "{name}",
        t.participants.find((p) => p.email.toLowerCase() !== t.owner.email.toLowerCase())?.name ||
          t.participants[0]?.email ||
          "",
      ),
      owner: t.owner,
      people: t.participants,
      settings: s.plan,
      ...(override ? { override } : {}),
    });
  };

  const tell = async (workspaceId: string, reading: MeetingReading, chip: MeetingChip | null) => {
    await options.record?.(workspaceId, {
      threadId: reading.threadId,
      messageId: reading.messageId,
      chip,
      judgedAt: reading.judgedAt,
    });
  };

  const api: Meetings = {
    async judge(workspaceId, threadId, opts = {}) {
      const s = await options.settings();
      const t = await readThread(threadId);
      const ordered = newestOf(t);
      const newest = ordered[ordered.length - 1];
      if (!newest) return null;
      const existing = await options.store.get(threadId);
      if (existing && existing.reading.messageId === newest.id && !opts.force)
        return existing.reading;

      const zone = zoneFor(workspaceId, s, opts.zone);
      const owner = t.owner.email.toLowerCase();
      const ownerWroteNewest = newest.from.email.toLowerCase() === owner;
      const text = ownText(await options.thread.text(newest.id), quoteStart).slice(
        0,
        s.newestChars,
      );
      const earlierMessage = ordered[ordered.length - 2] ?? null;
      const earlierText =
        earlierMessage && s.earlierChars > 0
          ? ownText(await options.thread.text(earlierMessage.id), quoteStart).slice(
              0,
              s.earlierChars,
            )
          : "";
      const clocks = clockCandidates(text, s.candidatesMax);
      const zones = zoneCandidates(text, s.candidatesMax);
      const judgedAt = now().toISOString();
      const base: MeetingReading = {
        threadId,
        workspaceId,
        messageId: newest.id,
        messageCount: t.messages.length,
        judgedBy: "gate",
        model: "",
        judgedAt,
        ownerWroteNewest,
        writtenAt: newest.date,
        senderOffsetMinutes: offsetOfDateHeader(newest.headers.date),
        notEnglish: !looksEnglish(text),
        asksToMeet: null,
        ownerAsked: null,
        proposesTime: null,
        recurring: null,
        length: null,
        zone: null,
        clocks,
        proposals: [],
      };

      // The gate: mailing lists, Invites and mail with no meeting words are never sent to a model.
      const bulk = Boolean(newest.headers["list-id"] || newest.headers["list-unsubscribe"]);
      const worded =
        hasGateWord(`${t.subject}\n${text}`, s.gateWords) ||
        (clocks.length > 0 && mentionsTime(text.replace(/\d{1,2}[:.]\d{2}/g, "")));
      const gated = bulk || !worded || (await hasInvite(threadId, t));
      let reading = base;
      if (!gated) {
        const questions = meetingQuestions(s.questions, { clocks, zones }, s.proposalsMax);
        const state = meetingState({
          owner: t.owner,
          subject: t.subject,
          ownerWroteNewest,
          newest: {
            from: newest.from,
            to: newest.to,
            written: writtenIn(new Date(newest.date), zone),
            text,
          },
          earlier:
            earlierMessage && earlierText
              ? {
                  from: earlierMessage.from,
                  written: writtenIn(new Date(earlierMessage.date), zone),
                  text: earlierText,
                }
              : null,
          clocks,
          zones,
        });
        const answered = await ask(workspaceId, state, questions, s, opts.jobId ?? null);
        if (!answered) return null;
        const a = answered.answers as Record<string, unknown>;
        const zonePart = a.zone ? part(a.zone) : null;
        const proposals: ProposalParts[] = [];
        for (let n = 0; n < Math.min(3, Math.max(1, s.proposalsMax)); n++) {
          const id = partIds(n);
          proposals.push({
            form: part(a[id.form]),
            relative: part(a[id.relative]),
            weekday: part(a[id.weekday]),
            week: part(a[id.week]),
            month: part(a[id.month]),
            day: part(a[id.day]),
            clock: a[id.clock] ? part(a[id.clock]) : null,
            meridiem: a[id.meridiem] ? part(a[id.meridiem]) : null,
            part: part(a[id.part]),
          });
        }
        reading = {
          ...base,
          judgedBy: answered.by,
          model: answered.model,
          asksToMeet: noul(a.asks_to_meet),
          ownerAsked: noul(a.owner_asked),
          proposesTime: noul(a.proposes_time),
          recurring: noul(a.recurring),
          length: a.length ? part(a.length) : null,
          zone: zonePart
            ? {
                ...zonePart,
                iana:
                  zonePart.choice === NOT_STATED
                    ? null
                    : (zones.find((z) => z.text === zonePart.choice)?.zone ?? null),
              }
            : null,
          proposals,
        };
      }
      const planned = await plan(workspaceId, threadId, t, reading, s, zone);
      const chip = planned.chips[0] ?? null;
      await options.store.put(reading, chip);
      await tell(workspaceId, reading, chip);
      return reading;
    },

    async options(workspaceId, threadId, request = {}) {
      if ((await options.level()) === "off") throw new AiOffError("classify");
      const s = await options.settings();
      const zone = zoneFor(workspaceId, s, request.zone);
      const t = await readThread(threadId);
      let stored = await options.store.get(threadId);
      const ordered = newestOf(t);
      const newestId = ordered[ordered.length - 1]?.id ?? "";
      const fresh = stored && stored.reading.messageId === newestId ? stored : null;
      let reading = fresh?.reading ?? null;
      if (!reading && s.enabled && request.judge !== false) {
        reading = await api.judge(workspaceId, threadId, { zone });
        stored = reading ? await options.store.get(threadId) : stored;
      }
      if (!s.enabled && !request.override) {
        return { ...(await plan(workspaceId, threadId, t, null, s, zone)), chips: [] };
      }
      const planned = await plan(workspaceId, threadId, t, reading, s, zone, request.override);
      // The calendar moved the chip since it was judged: the list's copy follows.
      const chip = planned.chips[0] ?? null;
      if (reading && stored && !sameChip(stored.chip, chip)) {
        await options.store.setChip(threadId, chip);
        await tell(workspaceId, reading, chip);
      }
      return planned;
    },

    async draft(workspaceId, threadId, request) {
      if ((await options.level()) === "off") throw new AiOffError("draft-in-voice");
      const s = await options.settings();
      const zone = zoneFor(workspaceId, s, request.zone);
      const t = await readThread(threadId);
      const stored = await options.store.get(threadId);
      const planned = await plan(workspaceId, threadId, t, stored?.reading ?? null, s, zone);
      const at = now();
      const starts = request.slots.map((x) => Date.parse(x.start)).filter(Number.isFinite);
      const window = {
        from: new Date(Math.min(at.getTime(), ...starts) - DAY),
        to: new Date(Math.max(at.getTime() + DAY, ...starts) + 2 * DAY),
      };
      const busy = (await busyIn(workspaceId, s, window)) ?? [];
      const slots = request.slots
        .map((x) => stillFree(x, busy, at, zone, s.plan.work))
        .filter((x): x is MeetingSlot => x !== null);
      if (slots.length === 0) return { text: "", slots: [], written: false, voice: false };
      const proposed =
        request.kind === "suggest"
          ? (planned.chips.find((c) => c.kind === "suggest_time")?.start ?? null)
          : null;
      const ordered = newestOf(t);
      const newest = ordered[ordered.length - 1];
      const text = newest
        ? ownText(await options.thread.text(newest.id), quoteStart).slice(0, s.newestChars)
        : "";
      let voice: VoiceProfile | null = null;
      try {
        voice = await options.voice(workspaceId);
      } catch {
        voice = null;
      }
      const written = await writeReply({
        runtime,
        workspaceId,
        kind: request.kind,
        slots,
        proposed,
        zone,
        words: s.draft,
        voice,
        thread: {
          subject: t.subject,
          from: newest ? newest.from.name || newest.from.email : "",
          text,
        },
      });
      return { ...written, slots };
    },

    async threadReady(workspaceId, threadId) {
      try {
        if ((await options.level()) !== "automate") return;
        if (!jobs) return;
        const s = await options.settings();
        if (!s.enabled || !s.onArrival) return;
        if (!(await runtime.judgeAvailable()) && !s.llmFallback) return;
        const t = await options.thread.read(threadId);
        if (!t) return;
        const ordered = newestOf(t);
        const newest = ordered[ordered.length - 1];
        if (!newest) return;
        const existing = await options.store.get(threadId);
        if (existing?.reading.messageId === newest.id) return;
        const payload: MeetingJobPayload = { workspaceId, threadId };
        await jobs.enqueue(MEETING_STEP, payload, { id: meetingJobId(threadId, newest.id) });
      } catch (error) {
        log(`meeting hook ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    registerSteps(target) {
      jobs = target;
      target.registerStep<MeetingJobPayload>(MEETING_STEP, async (job: Job<MeetingJobPayload>) => {
        const { workspaceId, threadId } = job.payload;
        try {
          await api.judge(workspaceId, threadId, { jobId: job.id });
        } catch (error) {
          // A Thread that went away, or a judge that did, is done: the reader asks again on open.
          if (error instanceof MeetingThreadNotFoundError || error instanceof NoJudgeError) {
            log(`meeting ${threadId}: ${error.message}`);
            return "done";
          }
          throw error;
        }
        return "done";
      });
    },
  };
  return api;
}
