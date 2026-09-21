// Judgments on arrival (CONTEXT.md "Judgment", "Judge"; ADR 0012; slice 25).
// One request to the judge per Thread version answers everything the stream,
// the brief policy and the reader want before a Brief exists: whether a
// reply is needed, whether the owner is waiting, whether it is a newsletter
// or automated mail (Nouls), how much a Brief would help and how urgent it
// is (Scores), and one Noul per action chip. The answers are probabilities,
// stored in thread_judgments keyed by Thread with the version they were
// asked for, and carried on the Changes feed as `judgments` so the client's
// Section rules and chips read them from the Cache.
//
// The sync engine's thread observer enqueues a `judge` Job (never inline);
// the Job asks only when the judge is available (a TypeSafe key and the
// Setting), and only at level `automate`; at `assist` the brief Job asks on
// open, like Briefs. Without a judge nothing is stored and the header rules
// stay in charge. Every question's text is a Setting (judgments.questions.*).
//
// The state is headers, counts, list headers and the newest snippet: bodies
// are not sent for these questions (docs/research/typesafe-system-one.md).

import type {
  AiLevel,
  ChipName,
  Id,
  JsonValue,
  JudgeAnswers,
  JudgmentsChange,
  NoulQuestion,
  Person,
  ScoreQuestion,
  ThreadJudgments,
} from "@monday/shared";
import { CHIP_NAMES } from "@monday/shared";
import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { accounts, messages, threadJudgments, threads, workspaces } from "../db/schema.ts";
import type { Job, Jobs } from "../jobs/index.ts";
import { type Mailstore, NotFoundError } from "../mailstore/index.ts";
import { type HostedRuntime, NoJudgeError } from "./runtime/index.ts";

export const JUDGE_STEP = "judge";

export interface JudgeJobPayload {
  workspaceId: Id;
  threadId: Id;
}

/** The questions as the Settings word them (judgments.questions.*). */
export interface JudgmentQuestionSettings {
  needsReply: string;
  waitingOnOthers: string;
  newsletter: string;
  automated: string;
  briefWorth: string;
  briefWorthLevels: string[];
  urgency: string;
  urgencyLevels: string[];
  chips: Record<ChipName, string>;
}

export interface JudgmentSettings {
  /** Judge every arriving Thread (judgments.on_arrival). */
  onArrival: boolean;
  questions: JudgmentQuestionSettings;
  /** How much of the newest snippet the state carries (routing.classify.snippet_chars). */
  snippetChars: number;
}

/** What the arrival request reads about a Thread: headers, counts, list headers, the newest snippet. */
export interface JudgmentFacts {
  owner: string;
  subject: string;
  from: Person | null;
  to: Person[];
  participants: Person[];
  /** Lowercased header names to values, from the newest Message. */
  headers: Record<string, string>;
  snippet: string;
  hasAttachments: boolean;
  attachmentNames: string[];
  messageCount: number;
  /** Whether the newest Message is the owner's. */
  ownerWroteLast: boolean;
}

/** The Thread version a judgment was asked for. */
export interface JudgedVersion {
  messageCount: number;
  latestMessageId: string;
}

export interface JudgmentsOptions {
  db: Db;
  mailstore: Mailstore;
  runtime: HostedRuntime;
  settings: () => Promise<JudgmentSettings>;
  /** The AI level (CONTEXT.md): judging on arrival only at `automate`. Absent means `automate`. */
  level?: () => Promise<AiLevel>;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface Judgments {
  /**
   * Asks the arrival request for one Thread and stores the answers; returns
   * the stored row untouched when it already covers the Thread's version
   * (unless `force`). Throws NoJudgeError when the judge is unavailable and
   * AiOffError at level off, so callers keep their header rules.
   */
  judgeThread(
    workspaceId: Id,
    threadId: Id,
    options?: { jobId?: string | null; force?: boolean },
  ): Promise<ThreadJudgments>;
  /** The stored Judgments for a Thread, whatever version they were asked for, or null. */
  get(threadId: Id): Promise<ThreadJudgments | null>;
  /** The stored Judgments when they cover the Thread's current version, else null. */
  fresh(threadId: Id): Promise<ThreadJudgments | null>;
  /**
   * The sync engine's hook: the Thread's Messages or bodies changed. Enqueues
   * one judge Job per Thread version, at level `automate`, when the Setting
   * and the judge allow. Never throws.
   */
  threadReady(workspaceId: Id, threadId: Id): Promise<void>;
  /** Removes a Thread's Judgments and tells the feed; false when there were none. */
  remove(threadId: Id): Promise<boolean>;
  registerSteps(jobs: Jobs): void;
}

/* ------------------------------ The questions ------------------------------ */

const LIST_HEADERS = [
  "list-id",
  "list-unsubscribe",
  "precedence",
  "auto-submitted",
  "x-auto-response-suppress",
  "reply-to",
] as const;

const chipQuestionId = (chip: ChipName): `chip_${ChipName}` => `chip_${chip}`;

type ArrivalQuestions = {
  needs_reply: NoulQuestion;
  waiting_on_others: NoulQuestion;
  newsletter: NoulQuestion;
  automated: NoulQuestion;
  brief_worth: ScoreQuestion;
  urgency: ScoreQuestion;
} & Record<`chip_${ChipName}`, NoulQuestion>;

/** The arrival request's questions, one per Setting: four Nouls, two Scores, one Noul per chip. */
export function judgmentQuestions(q: JudgmentQuestionSettings): ArrivalQuestions {
  const noul = (instructions: string): NoulQuestion => ({ type: "noul", instructions });
  const chips = Object.fromEntries(
    CHIP_NAMES.map((chip) => [chipQuestionId(chip), noul(q.chips[chip])]),
  ) as Record<`chip_${ChipName}`, NoulQuestion>;
  return {
    needs_reply: noul(q.needsReply),
    waiting_on_others: noul(q.waitingOnOthers),
    newsletter: noul(q.newsletter),
    automated: noul(q.automated),
    brief_worth: { type: "score", instructions: q.briefWorth, criteria: q.briefWorthLevels },
    urgency: { type: "score", instructions: q.urgency, criteria: q.urgencyLevels },
    ...chips,
  };
}

const personJson = (p: Person | null): JsonValue =>
  p ? { name: p.name || null, email: p.email } : null;

/** The state the judge reads: the owner and the Thread's headers, counts and newest snippet, nothing else. */
export function judgmentState(facts: JudgmentFacts, snippetChars: number): JsonValue {
  const list: Record<string, JsonValue> = {};
  for (const name of LIST_HEADERS) {
    const value = facts.headers[name];
    if (value) list[name] = value;
  }
  return {
    owner: facts.owner,
    thread: {
      subject: facts.subject,
      from: personJson(facts.from),
      to: facts.to.map(personJson),
      also_on_thread: facts.participants
        .filter((p) => p.email !== facts.from?.email && !facts.to.some((t) => t.email === p.email))
        .map(personJson),
      message_count: facts.messageCount,
      owner_wrote_last: facts.ownerWroteLast,
      has_attachments: facts.hasAttachments,
      attachment_names: facts.attachmentNames,
      list_headers: list,
      newest_message_snippet: facts.snippet.trim().slice(0, snippetChars),
    },
  };
}

const clamp = (value: number, max: number) =>
  Math.round(Math.min(max, Math.max(0, Number.isFinite(value) ? value : 0)) * 1000) / 1000;

/** The answers as a ThreadJudgments row: Nouls clamped to [0, 1], Scores to their levels. */
export function readJudgments(
  answers: JudgeAnswers<ArrivalQuestions>,
  meta: {
    threadId: Id;
    model: string;
    judgedAt: string;
    levels: { briefWorth: number; urgency: number };
  },
): ThreadJudgments {
  const chips: Record<string, number> = {};
  for (const chip of CHIP_NAMES) chips[chip] = clamp(answers[chipQuestionId(chip)].noul, 1);
  return {
    threadId: meta.threadId,
    needsReply: clamp(answers.needs_reply.noul, 1),
    waitingOnOthers: clamp(answers.waiting_on_others.noul, 1),
    newsletter: clamp(answers.newsletter.noul, 1),
    automated: clamp(answers.automated.noul, 1),
    briefWorth: clamp(answers.brief_worth.score, Math.max(0, meta.levels.briefWorth - 1)),
    urgency: clamp(answers.urgency.score, Math.max(0, meta.levels.urgency - 1)),
    chips,
    model: meta.model,
    judgedAt: meta.judgedAt,
  };
}

/** The Job id for one Thread version, so the same version is queued once. */
export function judgeJobId(threadId: Id, version: JudgedVersion): string {
  return `${JUDGE_STEP}:${threadId}:${version.messageCount}:${version.latestMessageId}`;
}

/* ------------------------------ Module ------------------------------ */

type JudgmentRow = typeof threadJudgments.$inferSelect;

function rowToJudgments(row: JudgmentRow): ThreadJudgments {
  return {
    threadId: row.threadId,
    needsReply: row.needsReply,
    waitingOnOthers: row.waitingOnOthers,
    newsletter: row.newsletter,
    automated: row.automated,
    briefWorth: row.briefWorth,
    urgency: row.urgency,
    chips: row.chips,
    model: row.model,
    judgedAt: row.judgedAt.toISOString(),
  };
}

export function createJudgments(options: JudgmentsOptions): Judgments {
  const { db, mailstore, runtime } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const level = options.level ?? (async (): Promise<AiLevel> => "automate");
  let jobs: Jobs | null = null;

  const versionOf = async (threadId: Id): Promise<JudgedVersion> => {
    const rows = await db
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.threadId, threadId))
      .orderBy(desc(messages.date), desc(messages.id));
    return { messageCount: rows.length, latestMessageId: rows[0]?.id ?? "" };
  };

  const sameVersion = (row: JudgedVersion, version: JudgedVersion) =>
    row.messageCount === version.messageCount && row.latestMessageId === version.latestMessageId;

  const ownerOf = async (workspaceId: Id): Promise<string> => {
    const [row] = await db
      .select({ address: accounts.address })
      .from(workspaces)
      .innerJoin(accounts, eq(accounts.id, workspaces.accountId))
      .where(eq(workspaces.id, workspaceId));
    return (row?.address ?? "").toLowerCase();
  };

  /** Headers plus the newest snippet. Decrypts the subject and snippet, so it needs the root key. */
  const readFacts = async (threadId: Id): Promise<{ facts: JudgmentFacts; workspaceId: Id }> => {
    const row = await db.query.threads.findFirst({ where: eq(threads.id, threadId) });
    if (!row) throw new NotFoundError("thread", threadId);
    const owner = await ownerOf(row.workspaceId);
    const subject = await mailstore.readThreadSubject(threadId);
    const headers = await mailstore.listMessages(threadId);
    const newest = headers[headers.length - 1] ?? null;
    const snippet = newest ? (await mailstore.readMessageBody(newest.id)).snippet : "";
    const from = newest?.from ?? row.participants[0] ?? null;
    return {
      workspaceId: row.workspaceId,
      facts: {
        owner,
        subject,
        from,
        to: newest?.to ?? [],
        participants: row.participants,
        headers: newest?.headers ?? {},
        snippet,
        hasAttachments: row.hasAttachments,
        attachmentNames: headers.flatMap((h) => h.attachments.map((a) => a.name)).slice(0, 10),
        messageCount: headers.length,
        ownerWroteLast: from !== null && owner !== "" && from.email.toLowerCase() === owner,
      },
    };
  };

  const recordJudgments = (workspaceId: Id, payload: JudgmentsChange) =>
    mailstore.recordChange(db, {
      workspaceId,
      kind: "judgments",
      entityId: payload.threadId,
      payload,
    });

  const api: Judgments = {
    async judgeThread(workspaceId, threadId, opts = {}) {
      const version = await versionOf(threadId);
      const existing = await db.query.threadJudgments.findFirst({
        where: eq(threadJudgments.threadId, threadId),
      });
      if (existing && !opts.force && sameVersion(existing, version)) {
        return rowToJudgments(existing);
      }
      const settings = await options.settings();
      const read = await readFacts(threadId);
      const questions = judgmentQuestions(settings.questions);
      const result = await runtime.judge(
        "judge.section",
        judgmentState(read.facts, settings.snippetChars),
        questions,
        { workspaceId, jobId: opts.jobId ?? null },
      );
      const judgedAt = now();
      const judged = readJudgments(result.answers, {
        threadId,
        model: result.model,
        judgedAt: judgedAt.toISOString(),
        levels: {
          briefWorth: settings.questions.briefWorthLevels.length,
          urgency: settings.questions.urgencyLevels.length,
        },
      });
      const values = {
        workspaceId: read.workspaceId,
        needsReply: judged.needsReply,
        waitingOnOthers: judged.waitingOnOthers,
        newsletter: judged.newsletter,
        automated: judged.automated,
        briefWorth: judged.briefWorth,
        urgency: judged.urgency,
        chips: judged.chips,
        model: judged.model,
        judgedAt,
        messageCount: version.messageCount,
        latestMessageId: version.latestMessageId,
      };
      await db
        .insert(threadJudgments)
        .values({ threadId, ...values })
        .onConflictDoUpdate({ target: threadJudgments.threadId, set: values });
      await recordJudgments(read.workspaceId, judged);
      return judged;
    },

    async get(threadId) {
      const row = await db.query.threadJudgments.findFirst({
        where: eq(threadJudgments.threadId, threadId),
      });
      return row ? rowToJudgments(row) : null;
    },

    async fresh(threadId) {
      const row = await db.query.threadJudgments.findFirst({
        where: eq(threadJudgments.threadId, threadId),
      });
      if (!row) return null;
      return sameVersion(row, await versionOf(threadId)) ? rowToJudgments(row) : null;
    },

    async threadReady(workspaceId, threadId) {
      try {
        // Judging unasked is an `automate` thing; at `assist` the brief Job asks on open.
        if ((await level()) !== "automate") return;
        if (!jobs) return;
        if (!(await options.settings()).onArrival) return;
        if (!(await runtime.judgeAvailable())) return;
        const version = await versionOf(threadId);
        if (version.messageCount === 0) return;
        const existing = await db.query.threadJudgments.findFirst({
          where: eq(threadJudgments.threadId, threadId),
          columns: { messageCount: true, latestMessageId: true },
        });
        if (existing && sameVersion(existing, version)) return;
        const payload: JudgeJobPayload = { workspaceId, threadId };
        await jobs.enqueue(JUDGE_STEP, payload, { id: judgeJobId(threadId, version) });
      } catch (error) {
        log(`judge hook ${threadId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    async remove(threadId) {
      const removed = await db
        .delete(threadJudgments)
        .where(eq(threadJudgments.threadId, threadId))
        .returning();
      const row = removed[0];
      if (!row) return false;
      await recordJudgments(row.workspaceId, { ...rowToJudgments(row), deleted: true });
      return true;
    },

    registerSteps(target) {
      jobs = target;
      target.registerStep<JudgeJobPayload>(JUDGE_STEP, async (job: Job<JudgeJobPayload>) => {
        const { workspaceId, threadId } = job.payload;
        try {
          await api.judgeThread(workspaceId, threadId, { jobId: job.id });
        } catch (error) {
          // A Thread that vanished, or a judge that went away, is done, not failed: the header rules decide.
          if (error instanceof NotFoundError || error instanceof NoJudgeError) {
            log(`judge ${threadId}: ${error.message}`);
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
