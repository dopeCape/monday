// Organizing mail by talking (slice 26; docs/spec/agent-composer.md,
// CONTEXT.md "Section rule", "Custom action"; ADR 0012): what the Agent's
// organization tools and the client's judged Sections act through.
//
// A user-defined Section is a Setting (sections.rules, ADR 0004); its
// deterministic conditions run on the client over the Cache. A Section that
// also carries a judge statement needs one Noul per Thread, and that is what
// this module answers: it asks the Judge under `judge.section` for the
// Threads that lack an answer, keeps every answer in `section_judgments`
// keyed by the rule id and the statement it was asked with (a reworded
// statement is asked again), and hands the client the numbers through
// POST /sections/judgments so the stream never waits on a model for the
// Threads it already knows. The same table holds judged custom actions.
//
// Counting what a new Section would hold, for the card that names how many
// Threads move, walks the newest Threads with the same evaluator the client
// uses (sectionRuleHolds) and judges only the Threads the conditions let
// through. Groups stay routing's; the seam re-exposes what the tools need.

import type {
  CustomActionSetting,
  GroupInput,
  GroupView,
  Id,
  JsonValue,
  NoulQuestion,
  ProposedMove,
  RoutingApplied,
  RoutingPreview,
  SectionFacts,
  SectionJudged,
  SectionJudgments,
  SectionRuleSetting,
  Thread,
} from "@monday/shared";
import {
  orderedSectionRules,
  sectionMatches,
  sectionRuleHolds,
  sectionsToJudge,
} from "@monday/shared";
import { and, desc, eq, inArray } from "drizzle-orm";
import { LockedError } from "../crypto/keys.ts";
import type { Db } from "../db/client.ts";
import {
  accounts,
  groups,
  messages,
  sectionJudgments,
  threadJudgments,
  workspaces,
} from "../db/schema.ts";
import { type Mailstore, NotFoundError } from "../mailstore/index.ts";
import { readGlobalSettings } from "../settings/read.ts";
import type { CandidateGroup, Routing } from "./routing/index.ts";
import type { HostedRuntime } from "./runtime/index.ts";
import { AiOffError, NoJudgeError } from "./runtime/index.ts";

/** One Thread's judged answers as POST /sections/judgments returns them. */
export interface SectionJudgmentView {
  threadId: Id;
  /** Probability per rule id (a Section or a custom action). */
  rules: Record<string, number>;
}

/** What a count over recent Threads came to. */
export interface SectionCount {
  /** How many of the newest Threads were looked at. */
  considered: number;
  /** How many the rule holds for. */
  holds: number;
  /** How many the conditions let through but no judged answer decided (the Judge was unavailable). */
  undecided: number;
  /** Whether the Judge answered during the count. */
  judged: boolean;
}

export interface OrganizeSettings {
  judgeThreshold: number;
  /** Threads judged per request from the client. */
  judgeBatch: number;
  /** The newest Threads a count looks at. */
  recent: number;
  /** Routing existing mail above this many Threads previews first. */
  previewAbove: number;
}

export interface OrganizeSeam {
  settings(): Promise<OrganizeSettings>;
  /** The rules and their order as the global Settings hold them. */
  sectionRules(): Promise<{ rules: SectionRuleSetting[]; order: string[] }>;
  customActions(): Promise<CustomActionSetting[]>;
  listGroups(workspaceId: Id): Promise<GroupView[]>;
  getGroup(groupId: Id): Promise<GroupView | null>;
  createGroup(workspaceId: Id, input: GroupInput): Promise<GroupView>;
  updateGroup(groupId: Id, patch: Partial<GroupInput>): Promise<GroupView>;
  deleteGroup(groupId: Id): Promise<void>;
  /** Routing's dry run over the newest Threads, with candidates scored beside the stored Groups. */
  previewGroups(
    workspaceId: Id,
    candidates: readonly CandidateGroup[],
    recent: number,
  ): Promise<RoutingPreview>;
  applyMoves(workspaceId: Id, moves: readonly ProposedMove[]): Promise<RoutingApplied>;
  /** Whether the Judge would answer now. */
  judgeAvailable(): Promise<boolean>;
  /**
   * The judged answers for these Threads over the current rules and actions,
   * asking the Judge for what is missing when it is available. Threads the
   * conditions settle without the Judge are left out.
   */
  judge(workspaceId: Id, threadIds: readonly Id[]): Promise<SectionJudgmentView[]>;
  /** How many of the newest Threads a rule would hold, judging what the conditions let through. */
  countSection(workspaceId: Id, rule: SectionRuleSetting, recent?: number): Promise<SectionCount>;
  /** Drops every cached answer for a rule (Undo of an organize pass, or a deleted rule). */
  forget(workspaceId: Id, ruleId: string): Promise<number>;
  /**
   * Everything sectionOf reads for these Threads under the current rules,
   * with the cached answers to each judge statement as they would decide
   * now, and the state a judge statement is asked with. The newest Threads
   * when `threadIds` is a count. For explaining and testing (tune.ts).
   */
  sectionContext(workspaceId: Id, threadIds: readonly Id[] | number): Promise<SectionContext>;
  /**
   * Stores the owner's own answer to a Section's judge statement for one
   * Thread (an Example), under the key the statement is asked with now.
   */
  pinAnswer(workspaceId: Id, threadId: Id, ruleId: string, holds: boolean): Promise<void>;
}

/** One Thread the user said belongs in a judged Section, or does not (the Setting sections.examples). */
export interface SectionExample {
  threadId: Id;
  holds: boolean;
  /** The newest sender's address. */
  from: string | null;
  subject: string;
  at: string;
}

/** What sectionOf reads for a set of Threads, as the stream would decide now. */
export interface SectionContext {
  threads: Thread[];
  facts: Map<Id, SectionFacts>;
  rules: SectionRuleSetting[];
  order: string[];
  threshold: number;
  /** The question each judged rule is asked with now, by rule id. */
  questions: Map<string, { key: string; question: NoulQuestion }>;
  examples: Record<string, SectionExample[]>;
  examplesMax: number;
  /** The state one Noul request reads for a Thread, as the judged Sections ask it. */
  state(thread: Thread): Promise<JsonValue>;
}

const EXAMPLES_NOTE =
  "The owner's own past decisions about similar threads; they outrank the statement.";

/** A short stable fingerprint, so the cache key changes when the Examples do. */
function fingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/**
 * A Section's judge statement as the Judge is asked it: the statement alone,
 * or with the owner's Examples (newest first, up to `max` of each answer)
 * as past decisions, the way the routing Choice carries a Group's. The key
 * is what the cache stores beside the answer: the statement, plus a
 * fingerprint of the Examples when there are any, so new Examples ask again.
 */
export function sectionQuestion(
  statement: string,
  examples: readonly SectionExample[] | undefined,
  max: number,
): { key: string; question: NoulQuestion } {
  const sorted = [...(examples ?? [])].sort((a, b) => b.at.localeCompare(a.at));
  const used = [
    ...sorted.filter((e) => e.holds).slice(0, max),
    ...sorted.filter((e) => !e.holds).slice(0, max),
  ];
  if (used.length === 0)
    return { key: statement, question: { type: "noul", instructions: statement } };
  const shown: JsonValue[] = used.map((e) => ({
    holds: e.holds,
    from: e.from,
    subject: e.subject,
  }));
  return {
    key: `${statement}\n[examples ${fingerprint(JSON.stringify(shown))}]`,
    question: {
      type: "noul",
      instructions: { statement, examples_note: EXAMPLES_NOTE, examples: shown },
    },
  };
}

/** The state one judge-statement request reads: headers, never a body. */
export function sectionJudgeState(
  thread: Thread,
  subject: string,
  lastSender: string | null,
  groupNames: Record<string, string>,
): JsonValue {
  return {
    subject,
    from: lastSender ?? thread.participants[0]?.email ?? "",
    participants: thread.participants.map((p) => (p.name ? `${p.name} <${p.email}>` : p.email)),
    messages: thread.messageCount,
    unread: thread.unread,
    hasAttachments: thread.hasAttachments,
    listMail: thread.bulk ?? false,
    lastActivity: thread.lastActivity,
    group: thread.group ? (groupNames[thread.group] ?? thread.group) : null,
    subgroup: thread.subgroup ? (groupNames[thread.subgroup] ?? thread.subgroup) : null,
  };
}

export interface OrganizeOptions {
  db: Db;
  mailstore: Mailstore;
  runtime: HostedRuntime;
  routing: Routing;
  now?: () => Date;
  log?: (message: string) => void;
}

const SETTING_KEYS = [
  "sections.rules",
  "sections.order",
  "sections.judge_threshold",
  "sections.judge_batch",
  "actions.custom",
  "actions.organize_recent",
  "actions.organize_preview_above",
  "sections.examples",
  "routing.examples_in_prompt",
] as const;

/**
 * A judged rule as the Noul is built: the Section's or the action's
 * statement. `statement` is the cache key (sectionQuestion); `question` is
 * what the Judge is asked.
 */
interface JudgedRule {
  id: string;
  statement: string;
  question: NoulQuestion;
}

const plainRule = (id: string, statement: string): JudgedRule => ({
  id,
  statement,
  question: { type: "noul", instructions: statement },
});

export function createOrganize(options: OrganizeOptions): OrganizeSeam {
  const { db, mailstore, runtime, routing } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});

  const readSettings = () => readGlobalSettings(db, SETTING_KEYS);

  const ownerOf = async (workspaceId: Id): Promise<string> => {
    const rows = await db
      .select({ address: accounts.address })
      .from(workspaces)
      .innerJoin(accounts, eq(accounts.id, workspaces.accountId))
      .where(eq(workspaces.id, workspaceId));
    return (rows[0]?.address ?? "").toLowerCase();
  };

  const groupNamesOf = async (workspaceId: Id): Promise<Record<string, string>> => {
    const rows = await db
      .select({ id: groups.id, name: groups.name })
      .from(groups)
      .where(eq(groups.workspaceId, workspaceId));
    return Object.fromEntries(rows.map((g) => [g.id, g.name]));
  };

  /** The newest sender per Thread, lowercased, for the `lastFrom` condition. */
  const lastSenders = async (threadIds: readonly Id[]): Promise<Map<Id, string>> => {
    const out = new Map<Id, string>();
    if (threadIds.length === 0) return out;
    const rows = await db
      .select({ threadId: messages.threadId, from: messages.from, date: messages.date })
      .from(messages)
      .where(inArray(messages.threadId, [...threadIds]))
      .orderBy(desc(messages.date));
    for (const r of rows) {
      if (!out.has(r.threadId)) out.set(r.threadId, r.from.email.toLowerCase());
    }
    return out;
  };

  /**
   * The arrival Judgments (slice 25, thread_judgments) for these Threads, so
   * the judged bounds in a rule's `when` decide here exactly as on the client
   * and a Thread they settle is never asked the rule's judge statement.
   */
  const arrivalJudgments = async (threadIds: readonly Id[]): Promise<Map<Id, SectionJudgments>> => {
    const out = new Map<Id, SectionJudgments>();
    if (threadIds.length === 0) return out;
    const rows = await db
      .select({
        threadId: threadJudgments.threadId,
        needsReply: threadJudgments.needsReply,
        waitingOnOthers: threadJudgments.waitingOnOthers,
        newsletter: threadJudgments.newsletter,
        automated: threadJudgments.automated,
        urgency: threadJudgments.urgency,
      })
      .from(threadJudgments)
      .where(inArray(threadJudgments.threadId, [...threadIds]));
    for (const { threadId, ...judgments } of rows) out.set(threadId, judgments);
    return out;
  };

  /** The cached answers for these Threads whose statement still matches the rule's. */
  const cached = async (
    workspaceId: Id,
    threadIds: readonly Id[],
    rules: readonly JudgedRule[],
  ): Promise<Map<Id, Record<string, number>>> => {
    const out = new Map<Id, Record<string, number>>();
    if (threadIds.length === 0 || rules.length === 0) return out;
    const wanted = new Map(rules.map((r) => [r.id, r.statement]));
    const rows = await db
      .select()
      .from(sectionJudgments)
      .where(
        and(
          eq(sectionJudgments.workspaceId, workspaceId),
          inArray(sectionJudgments.threadId, [...threadIds]),
          inArray(sectionJudgments.ruleId, [...wanted.keys()]),
        ),
      );
    for (const r of rows) {
      if (wanted.get(r.ruleId) !== r.statement) continue;
      const entry = out.get(r.threadId) ?? {};
      entry[r.ruleId] = r.probability;
      out.set(r.threadId, entry);
    }
    return out;
  };

  /** The state one Noul request reads: headers, never a body. */
  const stateOf = async (
    thread: Thread,
    lastSender: string | null,
    groupNames: Record<string, string>,
  ): Promise<JsonValue> => {
    let subject = thread.subject;
    try {
      subject = await mailstore.readThreadSubject(thread.id);
    } catch (error) {
      if (!(error instanceof LockedError) && !(error instanceof NotFoundError)) throw error;
    }
    return sectionJudgeState(thread, subject, lastSender, groupNames);
  };

  /** The judged Sections as they are asked now: each statement with its Examples. */
  const judgedSectionsOf = (s: Awaited<ReturnType<typeof readSettings>>): JudgedRule[] =>
    s["sections.rules"].flatMap((r) => {
      const statement = r.judge?.trim();
      if (!statement) return [];
      const asked = sectionQuestion(
        statement,
        s["sections.examples"][r.id],
        s["routing.examples_in_prompt"],
      );
      return [{ id: r.id, statement: asked.key, question: asked.question }];
    });

  /** Asks the Judge for `rules` over these Threads and stores every answer. Returns what it learned. */
  const ask = async (
    workspaceId: Id,
    threads: readonly Thread[],
    need: ReadonlyMap<Id, JudgedRule[]>,
    senders: ReadonlyMap<Id, string>,
    groupNames: Record<string, string>,
  ): Promise<Map<Id, Record<string, number>>> => {
    const out = new Map<Id, Record<string, number>>();
    for (const thread of threads) {
      const rules = need.get(thread.id);
      if (!rules?.length) continue;
      const questions: Record<string, NoulQuestion> = Object.fromEntries(
        rules.map((r) => [r.id, r.question]),
      );
      const state = await stateOf(thread, senders.get(thread.id) ?? null, groupNames);
      const result = await runtime.judge("judge.section", state, questions, { workspaceId });
      const learned: Record<string, number> = {};
      for (const r of rules) {
        const answer = result.answers[r.id];
        if (answer?.type !== "noul") continue;
        learned[r.id] = answer.noul;
        await db
          .insert(sectionJudgments)
          .values({
            workspaceId,
            threadId: thread.id,
            ruleId: r.id,
            statement: r.statement,
            probability: answer.noul,
            model: result.model,
            judgedAt: now(),
          })
          .onConflictDoUpdate({
            target: [sectionJudgments.threadId, sectionJudgments.ruleId],
            set: {
              statement: r.statement,
              probability: answer.noul,
              model: result.model,
              judgedAt: now(),
            },
          });
      }
      out.set(thread.id, learned);
    }
    return out;
  };

  const judgeAvailable = async () => {
    try {
      return await runtime.judgeAvailable();
    } catch {
      return false;
    }
  };

  /** The newest Threads of a Workspace still in the Inbox. */
  const recentThreads = async (workspaceId: Id, limit: number): Promise<Thread[]> => {
    const page = await mailstore.listThreads(workspaceId, { limit, includeArchived: false });
    return page.threads;
  };

  const threadsById = async (workspaceId: Id, ids: readonly Id[]): Promise<Thread[]> => {
    if (ids.length === 0) return [];
    const page = await mailstore.listThreads(workspaceId, {
      ids: [...ids],
      limit: Math.max(1, ids.length),
      includeArchived: true,
    });
    return page.threads;
  };

  const factsFor = (
    thread: Thread,
    senders: ReadonlyMap<Id, string>,
    owner: string,
    groupNames: Record<string, string>,
    judged: SectionJudged | undefined,
    threshold: number,
    arrival?: ReadonlyMap<Id, SectionJudgments>,
  ): SectionFacts => ({
    lastSender: senders.get(thread.id) ?? null,
    owner,
    groupNames,
    judgments: arrival?.get(thread.id) ?? null,
    judged,
    judgeThreshold: threshold,
  });

  const seam: OrganizeSeam = {
    async settings() {
      const s = await readSettings();
      return {
        judgeThreshold: s["sections.judge_threshold"],
        judgeBatch: s["sections.judge_batch"],
        recent: s["actions.organize_recent"],
        previewAbove: s["actions.organize_preview_above"],
      };
    },

    async sectionRules() {
      const s = await readSettings();
      return { rules: s["sections.rules"], order: s["sections.order"] };
    },

    async customActions() {
      return (await readSettings())["actions.custom"];
    },

    listGroups: (workspaceId) => routing.listGroups(workspaceId),
    getGroup: (groupId) => routing.getGroup(groupId),
    createGroup: (workspaceId, input) => routing.createGroup(workspaceId, input),
    updateGroup: (groupId, patch) => routing.updateGroup(groupId, patch),
    deleteGroup: (groupId) => routing.deleteGroup(groupId),
    previewGroups: (workspaceId, candidates, recent) =>
      routing.preview(workspaceId, { candidates, recent }),
    applyMoves: (workspaceId, moves) => routing.apply(workspaceId, moves),
    judgeAvailable,

    async judge(workspaceId, threadIds) {
      const s = await readSettings();
      const rules = s["sections.rules"];
      const order = s["sections.order"];
      const threshold = s["sections.judge_threshold"];
      const judgedSections = judgedSectionsOf(s);
      const judgedActions: JudgedRule[] = s["actions.custom"].flatMap((a) =>
        a.on.judge?.trim() ? [plainRule(a.id, a.on.judge.trim())] : [],
      );
      const all = [...judgedSections, ...judgedActions];
      if (all.length === 0) return [];
      const ids = threadIds.slice(0, s["sections.judge_batch"]);
      const threads = await threadsById(workspaceId, ids);
      const known = await cached(
        workspaceId,
        threads.map((t) => t.id),
        all,
      );
      const [senders, owner, groupNames, arrival] = await Promise.all([
        lastSenders(threads.map((t) => t.id)),
        ownerOf(workspaceId),
        groupNamesOf(workspaceId),
        arrivalJudgments(threads.map((t) => t.id)),
      ]);
      // What each Thread still needs: the judged Sections its conditions let
      // through and no answer decided, plus every judged action.
      const need = new Map<Id, JudgedRule[]>();
      const byId = new Map(judgedSections.map((r) => [r.id, r]));
      for (const t of threads) {
        const have = known.get(t.id);
        const facts = factsFor(t, senders, owner, groupNames, have, threshold, arrival);
        const wanted = sectionsToJudge(t, facts, rules, order).flatMap((id) => {
          const r = byId.get(id);
          return r ? [r] : [];
        });
        for (const a of judgedActions) if (have?.[a.id] === undefined) wanted.push(a);
        if (wanted.length) need.set(t.id, wanted);
      }
      if (need.size > 0 && (await judgeAvailable())) {
        try {
          const learned = await ask(workspaceId, threads, need, senders, groupNames);
          for (const [id, answers] of learned) {
            known.set(id, { ...(known.get(id) ?? {}), ...answers });
          }
        } catch (error) {
          if (!(error instanceof NoJudgeError) && !(error instanceof AiOffError)) throw error;
          log(`judge sections: ${error.message}`);
        }
      }
      return threads.flatMap((t) => {
        const answers = known.get(t.id);
        return answers && Object.keys(answers).length ? [{ threadId: t.id, rules: answers }] : [];
      });
    },

    async countSection(workspaceId, rule, recent) {
      const s = await readSettings();
      const threshold = s["sections.judge_threshold"];
      // The rule counts where it will sit: in front of the existing rules when
      // it is new, so a Thread an earlier rule claims first is not counted.
      const existing = orderedSectionRules(s["sections.rules"], s["sections.order"]);
      const at = existing.findIndex((r) => r.id === rule.id);
      const before = at >= 0 ? existing.slice(0, at) : [];
      const threads = await recentThreads(workspaceId, recent ?? s["actions.organize_recent"]);
      const [senders, owner, groupNames, arrival] = await Promise.all([
        lastSenders(threads.map((t) => t.id)),
        ownerOf(workspaceId),
        groupNamesOf(workspaceId),
        arrivalJudgments(threads.map((t) => t.id)),
      ]);
      const statement = rule.judge?.trim() ?? "";
      const judgedRule: JudgedRule[] = [];
      if (statement) {
        const asked = sectionQuestion(
          statement,
          s["sections.examples"][rule.id],
          s["routing.examples_in_prompt"],
        );
        judgedRule.push({ id: rule.id, statement: asked.key, question: asked.question });
      }
      const known = await cached(
        workspaceId,
        threads.map((t) => t.id),
        judgedRule,
      );
      const passing = threads.filter((t) => {
        const facts = factsFor(t, senders, owner, groupNames, known.get(t.id), threshold, arrival);
        if (before.some((r) => sectionRuleHolds(r, t, facts))) return false;
        return sectionMatches(rule.when, t, facts);
      });
      let judged = false;
      if (statement) {
        const need = new Map<Id, JudgedRule[]>();
        for (const t of passing)
          if (known.get(t.id)?.[rule.id] === undefined) need.set(t.id, judgedRule);
        if (need.size > 0 && (await judgeAvailable())) {
          try {
            const learned = await ask(workspaceId, passing, need, senders, groupNames);
            for (const [id, answers] of learned) known.set(id, answers);
            judged = true;
          } catch (error) {
            if (!(error instanceof NoJudgeError) && !(error instanceof AiOffError)) throw error;
            log(`count section ${rule.id}: ${error.message}`);
          }
        }
      }
      let holds = 0;
      let undecided = 0;
      for (const t of passing) {
        if (!statement) {
          holds += 1;
          continue;
        }
        const p = known.get(t.id)?.[rule.id];
        if (p === undefined) undecided += 1;
        else if (p >= threshold) holds += 1;
      }
      return { considered: threads.length, holds, undecided, judged };
    },

    async forget(workspaceId, ruleId) {
      const rows = await db
        .delete(sectionJudgments)
        .where(
          and(eq(sectionJudgments.workspaceId, workspaceId), eq(sectionJudgments.ruleId, ruleId)),
        )
        .returning({ threadId: sectionJudgments.threadId });
      return rows.length;
    },

    async sectionContext(workspaceId, threadIds) {
      const s = await readSettings();
      const threshold = s["sections.judge_threshold"];
      const threads =
        typeof threadIds === "number"
          ? await recentThreads(workspaceId, threadIds)
          : await threadsById(workspaceId, threadIds);
      const ids = threads.map((t) => t.id);
      const judged = judgedSectionsOf(s);
      const [senders, owner, groupNames, arrival, known] = await Promise.all([
        lastSenders(ids),
        ownerOf(workspaceId),
        groupNamesOf(workspaceId),
        arrivalJudgments(ids),
        cached(workspaceId, ids, judged),
      ]);
      const facts = new Map<Id, SectionFacts>();
      for (const t of threads) {
        facts.set(
          t.id,
          factsFor(t, senders, owner, groupNames, known.get(t.id), threshold, arrival),
        );
      }
      return {
        threads,
        facts,
        rules: s["sections.rules"],
        order: s["sections.order"],
        threshold,
        questions: new Map(judged.map((r) => [r.id, { key: r.statement, question: r.question }])),
        examples: s["sections.examples"],
        examplesMax: s["routing.examples_in_prompt"],
        state: (thread) => stateOf(thread, senders.get(thread.id) ?? null, groupNames),
      };
    },

    async pinAnswer(workspaceId, threadId, ruleId, holds) {
      const s = await readSettings();
      const rule = s["sections.rules"].find((r) => r.id === ruleId);
      const statement = rule?.judge?.trim();
      if (!statement) return;
      const { key } = sectionQuestion(
        statement,
        s["sections.examples"][ruleId],
        s["routing.examples_in_prompt"],
      );
      const values = {
        statement: key,
        probability: holds ? 1 : 0,
        model: "owner",
        judgedAt: now(),
      };
      await db
        .insert(sectionJudgments)
        .values({ workspaceId, threadId, ruleId, ...values })
        .onConflictDoUpdate({
          target: [sectionJudgments.threadId, sectionJudgments.ruleId],
          set: values,
        });
    },
  };
  return seam;
}
