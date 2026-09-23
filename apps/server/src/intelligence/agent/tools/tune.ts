// The tuning tools (ADR 0012, ADR 0002, ADR 0004; docs/spec/agent-composer.md
// "Organizing mail by talking"): the Agent improves routing and the
// judgments behind it from what the user says is wrong. explain_placement
// and list_judgments read what is stored; test_judgment re-asks the judge
// on recent Threads with a proposed wording beside the current one and
// changes nothing; update_judgment writes the new wording or threshold
// through the host like change_setting (the same validation, the same
// monday.toml refusal, the same `settings` Undo) with the test's diff on its
// card; add_example records a Thread as an Example for a Group, the way a
// correction does, or for a judged Section, so a one-off mistake is fixed by
// showing instead of rewording. Every card's data is plain structured data
// (the result's `data`), so any tool UI can render it and the model reads
// the same facts in the text.

import type { SettingKey, ToolPreview } from "@monday/shared";
import { settingsSchema, validateSetting } from "@monday/shared";
import { z } from "zod";
import type {
  JudgmentFamily,
  JudgmentListing,
  JudgmentProposal,
  JudgmentTest,
  ListedJudgment,
  PlacementExplanation,
  ProposalSide,
  TuneSeam,
} from "../../tune.ts";
import { TuneRefusal } from "../../tune.ts";
import type { ToolContext, ToolDefinition, ToolPlan } from "./catalog.ts";

const REFUSED = "Tuning judgments is not available from this host.";
const PINNED = (key: string) =>
  `${key} is set in monday.toml; the file wins. Offer to edit the file only if the user says yes.`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const seamOf = (ctx: ToolContext): TuneSeam | null => ctx.extensions?.tune ?? null;

async function isPinned(ctx: ToolContext, key: string): Promise<boolean> {
  if (ctx.pinned.has(key)) return true;
  return (await ctx.host.readSetting(key)).pinned;
}

const clip = (text: string, max = 160) =>
  text.length > max ? `${text.slice(0, max - 3)}...` : text;
const show = (v: unknown) => (typeof v === "string" ? `"${clip(v)}"` : JSON.stringify(v));

/* ------------------------------ explain_placement ------------------------------ */

function explanationText(e: PlacementExplanation): string {
  const facts: Record<string, unknown> = {
    group: e.group?.name ?? null,
    section: e.section?.name ?? null,
    userPlaced: e.userPlaced,
    routing: e.routing
      ? {
          by: e.routing.by,
          confidence: e.routing.confidence,
          band: e.routing.band,
          thresholds: e.routing.thresholds,
          distribution: e.routing.distribution.map((d) => `${d.name} ${d.probability}`),
        }
      : null,
    needsDecision: e.needsDecision?.candidates.map((c) => `${c.name} ${c.confidence}`) ?? null,
    predicates: e.predicates.map((p) => p.name),
    examples: {
      thread: e.examples.thread.map((x) => `${x.positive ? "in" : "not in"} ${x.name}`),
      similar: e.examples.similar.map(
        (x) => `${x.positive ? "in" : "not in"} ${x.name}: ${x.from ?? "?"} "${x.subject}"`,
      ),
    },
    judgments: e.judgments
      ? {
          needsReply: e.judgments.needsReply,
          waitingOnOthers: e.judgments.waitingOnOthers,
          newsletter: e.judgments.newsletter,
          automated: e.judgments.automated,
          briefWorth: e.judgments.briefWorth,
          urgency: e.judgments.urgency,
          chips: e.judgments.chips,
          fresh: e.judgments.fresh,
        }
      : null,
    sections: e.sections.map((s) => ({
      id: s.id,
      holds: s.holds,
      conditions: s.conditions,
      ...(s.judgedBounds.length ? { judgedBounds: s.judgedBounds } : {}),
      ...(s.judge ? { judge: s.judge } : {}),
    })),
  };
  // The first line is the one a card shows alone: where it is and why, in brief.
  const where =
    [e.group?.name, e.section?.name].filter(Boolean).join(", ") || "no Group or Section";
  return [
    `"${e.thread.subject}" (${e.thread.from ?? "?"}) is in ${where}. ${e.why[0] ?? ""}`.trim(),
    ...e.why.slice(1),
    JSON.stringify(facts),
  ].join("\n");
}

const explainPlacement: ToolDefinition<{ thread_id: string }> = {
  name: "explain_placement",
  description:
    "Why a Thread is where it is: its Group and how routing got there (the routing judgment's distribution, the route threshold and ask band it crossed, a Group's Predicate, Examples from the same sender, or the user's own placement), its arrival Judgments (needs a reply, waiting, newsletter, automated, Brief worth, urgency, chips), and the Section rule that claims it with the judged value that decided. Call it first when the user says a thread is in the wrong place.",
  tier: "read",
  input: z.object({ thread_id: z.string().min(1) }),
  summarize: (i) => i.thread_id,
  async run(input, ctx): Promise<ToolPlan> {
    const seam = seamOf(ctx);
    if (!seam) return { kind: "refused", text: REFUSED };
    const [found] = await ctx.host.threadsById([input.thread_id]);
    if (!found) return { kind: "refused", text: `Thread ${input.thread_id} not found.` };
    const explanation = await seam.explain(ctx.host.workspaceId, input.thread_id);
    return { kind: "result", text: explanationText(explanation), data: explanation };
  },
};

/* ------------------------------ list_judgments ------------------------------ */

const FAMILIES = [
  "routing",
  "arrival",
  "sections",
  "brief_policy",
  "palette",
  "guard",
  "verification",
  "workflows",
] as const satisfies readonly JudgmentFamily[];

type PinnedListing = Omit<JudgmentListing, "families"> & {
  families: Array<
    Omit<JudgmentListing["families"][number], "judgments"> & {
      judgments: Array<ListedJudgment & { pinned: boolean }>;
    }
  >;
};

function listingText(listing: PinnedListing): string {
  const lines = [
    `Judgments monday asks${listing.judge ? "" : " (no judge answering now: the header rules and the language model decide)"}; behavior over the last ${plural(listing.windowDays, "day")}.`,
  ];
  for (const f of listing.families) {
    if (f.judgments.length === 0) continue;
    lines.push(`${f.label}:`);
    for (const item of f.judgments) {
      const parts = [`- ${item.ref} [${item.kind}]`];
      if (item.value !== null && item.value !== undefined) parts.push(`= ${show(item.value)}`);
      if (item.kind !== "statement" && item.kind !== "group_rule") {
        parts.push(item.isDefault ? "(default)" : "(changed)");
      }
      if (item.pinned) parts.push("(pinned in monday.toml)");
      if (item.threshold)
        parts.push(`threshold ${item.threshold.key} = ${JSON.stringify(item.threshold.value)}`);
      if (item.editWith !== "update_judgment") parts.push(`edit with ${item.editWith}`);
      else if (!item.testable) parts.push("not testable on threads");
      const b = item.behavior;
      if (b) {
        const dist = Object.entries(b.distribution)
          .map(([k, n]) => `${k} ${n}`)
          .join(", ");
        const more = [
          `answered ${b.answered}`,
          dist ? `(${dist})` : "",
          b.undecided !== null ? `undecided ${b.undecided}` : "",
          b.corrections
            ? `corrections: ${b.corrections.examples} examples, ${b.corrections.userPlacements} placed by the user${
                b.corrections.contradicting !== null
                  ? `, ${b.corrections.contradicting} contradicting`
                  : ""
              }`
            : "",
        ]
          .filter(Boolean)
          .join(" ");
        parts.push(`| ${more}`);
      }
      lines.push(parts.join(" "));
    }
  }
  return lines.join("\n");
}

const listJudgments: ToolDefinition<{ family?: (typeof FAMILIES)[number] | undefined }> = {
  name: "list_judgments",
  description:
    "Every judgment monday asks the judge, grouped: routing into Groups, the questions asked on arrival (needs a reply, waiting, newsletter, automated, Brief worth, urgency, the action chips), each Section's judge statement, the brief policy thresholds, the palette, screening and Brief verification. Each has its Setting key (or sections.rules[<id>].judge), its current wording or threshold, the default, whether monday.toml pins it, whether test_judgment can re-run it, and how it answered over the last week: how many threads, the split of answers, how many went to Needs a decision or were unsure, and how many the user corrected.",
  tier: "read",
  input: z.object({
    family: z.enum(FAMILIES).optional().describe("Only this group of judgments"),
  }),
  summarize: (i) => i.family ?? "all",
  async run(input, ctx): Promise<ToolPlan> {
    const seam = seamOf(ctx);
    if (!seam) return { kind: "refused", text: REFUSED };
    const listing = await seam.list(ctx.host.workspaceId);
    const families: PinnedListing["families"] = [];
    for (const f of listing.families) {
      if (input.family && f.family !== input.family) continue;
      const judgments = [];
      for (const j of f.judgments) {
        const keys = [j.key, j.threshold?.key].filter((k): k is string => !!k);
        let pinned = false;
        for (const k of keys) if (await isPinned(ctx, k)) pinned = true;
        judgments.push({ ...j, pinned });
      }
      families.push({ ...f, judgments });
    }
    const data: PinnedListing = { ...listing, families };
    return { kind: "result", text: listingText(data), data };
  },
};

/* ------------------------------ test_judgment ------------------------------ */

const proposalInput = {
  key: z
    .string()
    .min(1)
    .describe(
      'The Setting key from list_judgments (judgments.questions.needs_reply, routing.judge.instructions, routing.threshold.route, chips.threshold, ...), or "sections.rules[<id>].judge" for a Section\'s judge statement',
    ),
  section: z.string().min(1).optional().describe('A Section id or name, with key "sections.rules"'),
  text: z.string().min(1).max(2000).optional().describe("The proposed wording of the question"),
  levels: z
    .array(z.string().min(1))
    .min(2)
    .max(10)
    .optional()
    .describe("Proposed levels for a Score's levels key, lowest first"),
  threshold: z
    .number()
    .min(0)
    .max(3)
    .optional()
    .describe(
      "A proposed threshold: the key itself when it is one, else the question's own threshold",
    ),
};

type ProposalInput = {
  key: string;
  section?: string | undefined;
  text?: string | undefined;
  levels?: string[] | undefined;
  threshold?: number | undefined;
};

const toProposal = (i: ProposalInput): JudgmentProposal => ({
  key: i.key,
  ...(i.section !== undefined ? { section: i.section } : {}),
  ...(i.text !== undefined ? { text: i.text } : {}),
  ...(i.levels !== undefined ? { levels: i.levels } : {}),
  ...(i.threshold !== undefined ? { threshold: i.threshold } : {}),
});

const sideText = (s: ProposalSide): string =>
  [
    s.text !== undefined ? (s.text === null ? "no statement" : show(s.text)) : "",
    s.levels ? `levels ${JSON.stringify(s.levels)}` : "",
    s.threshold ? `${s.threshold.key} ${s.threshold.value}` : "",
  ]
    .filter(Boolean)
    .join(", ");

function testText(t: JudgmentTest): string {
  const lines = [
    `${t.label}: ${sideText(t.before)} compared with ${sideText(t.after)}.`,
    t.summary,
    t.asked
      ? `${plural(t.requests, "judge request")} (metered)${t.skipped ? `; ${t.skipped} placed by the user left out` : ""}.`
      : `Over stored answers, no request${t.skipped ? `; ${t.skipped} without a stored answer left out` : ""}.`,
  ];
  for (const c of t.changes) {
    const answer = (o: { answer: number | string | null }) =>
      o.answer === null ? "" : ` ${o.answer}`;
    lines.push(
      `- "${clip(c.subject, 80)}" (${c.from ?? "?"}): ${c.before.placement}${answer(c.before)} -> ${c.after.placement}${answer(c.after)}`,
    );
  }
  if (t.more > 0) lines.push(`and ${t.more} more.`);
  return lines.join("\n");
}

const testJudgment: ToolDefinition<ProposalInput & { sample?: number | undefined }> = {
  name: "test_judgment",
  description:
    "Test a reworded judgment question, new levels or a new threshold before changing anything: asks the judge about the newest matching threads once with the current version and once with the proposed one (tune.sample threads, metered), or re-applies a threshold to the stored answers, and returns the threads whose answer or placement would change with their before and after probabilities and the Group or Section they would land in. Nothing is stored. Run it before update_judgment and show the user the diff.",
  tier: "read",
  input: z.object({
    ...proposalInput,
    sample: z
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe("How many newest threads; tune.sample by default"),
  }),
  summarize: (i) => i.key,
  async run(input, ctx): Promise<ToolPlan> {
    const seam = seamOf(ctx);
    if (!seam) return { kind: "refused", text: REFUSED };
    const proposal = toProposal(input);
    let result: JudgmentTest;
    try {
      result = await seam.test(ctx.host.workspaceId, proposal, input.sample);
    } catch (error) {
      if (error instanceof TuneRefusal) {
        if (error.reason === "no_judge") {
          return {
            kind: "result",
            text: error.message,
            data: { judge: false, message: error.message },
          };
        }
        return { kind: "refused", text: error.message };
      }
      throw error;
    }
    if (ctx.sessionId) seam.remember(ctx.sessionId, ctx.host.workspaceId, proposal, result);
    return { kind: "result", text: testText(result), data: result };
  },
};

/* ------------------------------ update_judgment ------------------------------ */

const FOLLOW_UP: Record<string, string> = {
  routing:
    "Nothing is re-sorted by this change: new mail is routed with it. organize_existing on a Group re-runs routing on the mail already there, with a preview.",
  arrival:
    "Stored answers stay until a thread changes; new mail is asked the new question. explain_placement shows what a thread was judged.",
  sections:
    "The Section asks the new statement as threads are shown; organize_existing on the Section judges the newest threads now.",
  brief_policy: "New Briefs follow the new thresholds; Briefs already written stay.",
};

const updateJudgment: ToolDefinition<ProposalInput> = {
  name: "update_judgment",
  description:
    "Change a judgment's question text, levels or threshold (a key from list_judgments, or sections.rules[<id>].judge), validated against the schema. A key monday.toml pins is refused. The card shows the before and after and the test_judgment diff (it runs one if none ran in this conversation for the same proposal). It re-sorts nothing on its own; offer organize_existing afterwards. Reversible: undo restores the previous value.",
  tier: "reversible",
  input: z.object(proposalInput),
  summarize: (i) => i.key,
  async run(input, ctx): Promise<ToolPlan> {
    const seam = seamOf(ctx);
    if (!seam) return { kind: "refused", text: REFUSED };
    const workspaceId = ctx.host.workspaceId;
    const proposal = toProposal(input);
    let planned: Awaited<ReturnType<TuneSeam["plan"]>>;
    try {
      planned = await seam.plan(workspaceId, proposal);
    } catch (error) {
      if (error instanceof TuneRefusal) return { kind: "refused", text: error.message };
      throw error;
    }
    for (const w of planned.writes) {
      if (await isPinned(ctx, w.key)) return { kind: "refused", text: PINNED(w.key) };
    }
    // The diff: this Session's test of the same proposal, or one now.
    let tested: JudgmentTest | null = ctx.sessionId
      ? seam.remembered(ctx.sessionId, workspaceId, proposal)
      : null;
    let untested: string | null = null;
    if (!tested) {
      try {
        tested = await seam.test(workspaceId, proposal);
        if (ctx.sessionId) seam.remember(ctx.sessionId, workspaceId, proposal, tested);
      } catch (error) {
        if (!(error instanceof TuneRefusal)) throw error;
        untested = error.message;
      }
    }
    const entry = planned.entry;
    const followUp = FOLLOW_UP[entry.family] ?? null;
    const diff = tested
      ? {
          summary: tested.summary,
          considered: tested.considered,
          moved: tested.moved,
          flipped: tested.flipped,
          moves: tested.moves,
          requests: tested.requests,
          changes: tested.changes,
          more: tested.more,
        }
      : null;
    const lines = [
      `Change ${entry.label} (${entry.ref}).`,
      `Before: ${sideText(planned.before)}`,
      `After: ${sideText(planned.after)}`,
      tested ? tested.summary : `Not tested: ${untested ?? "no test ran"}`,
    ];
    const first = planned.writes[0];
    const preview: ToolPreview =
      planned.writes.length === 1 && first
        ? { kind: "setting", key: first.key, from: first.previous, to: first.value }
        : { kind: "text", text: lines.join("\n") };
    const writes = planned.writes;
    return {
      kind: "action",
      preview,
      count: 1,
      apply: async () => {
        for (const w of writes) {
          const valid = validateSetting(w.key, w.value);
          if (!valid.ok) throw new Error(`${w.key}: ${valid.error}`);
          await ctx.host.writeSetting(w.key, valid.value);
        }
        return {
          text: [
            // The first line is the one a card shows alone.
            `${entry.label} changed. ${tested ? tested.summary : `Not tested: ${untested ?? "no test ran"}`}`,
            `Before: ${sideText(planned.before)}`,
            `After: ${sideText(planned.after)}`,
            followUp ?? "",
          ]
            .filter(Boolean)
            .join("\n"),
          data: {
            ref: entry.ref,
            key: entry.key,
            ...(entry.section ? { section: entry.section } : {}),
            label: entry.label,
            family: entry.family,
            before: planned.before,
            after: planned.after,
            changed: writes.map((w) => ({
              key: w.key,
              label: (settingsSchema as Record<string, { label: string }>)[w.key]?.label ?? w.key,
              from: w.previous,
              to: w.value,
            })),
            test: diff,
            untested,
            followUp: followUp
              ? {
                  text: followUp,
                  tool:
                    entry.family === "routing" || entry.family === "sections"
                      ? "organize_existing"
                      : null,
                }
              : null,
          },
          undo: {
            kind: "settings",
            entries: writes.map((w) => ({ key: w.key as SettingKey, previous: w.previous })),
          },
        };
      },
    };
  },
};

/* ------------------------------ add_example ------------------------------ */

const addExample: ToolDefinition<{
  thread_id: string;
  group?: string | undefined;
  section?: string | undefined;
  belongs: boolean;
}> = {
  name: "add_example",
  description:
    "Record a thread as an Example for a Group or a judged Section: belongs true for a thread that should be in it, false for one that should not. The routing question (or the Section's judge statement) reads Examples as the owner's own past decisions, which outrank its description, so this fixes a one-off mistake by showing rather than rewording. It moves nothing now. Reversible: undo removes the Example.",
  tier: "reversible",
  input: z.object({
    thread_id: z.string().min(1),
    group: z.string().min(1).optional().describe("A Group id or name"),
    section: z.string().min(1).optional().describe("A Section id or name with a judge statement"),
    belongs: z.boolean(),
  }),
  summarize: (i) => `${i.thread_id} ${i.belongs ? "in" : "not in"} ${i.group ?? i.section ?? ""}`,
  async run(input, ctx): Promise<ToolPlan> {
    const seam = seamOf(ctx);
    if (!seam) return { kind: "refused", text: REFUSED };
    const workspaceId = ctx.host.workspaceId;
    if ((input.group ? 1 : 0) + (input.section ? 1 : 0) !== 1) {
      return { kind: "refused", text: "Name one group or one section." };
    }
    const [thread] = await ctx.host.threadsById([input.thread_id]);
    if (!thread) return { kind: "refused", text: `Thread ${input.thread_id} not found.` };
    const word = input.belongs ? "belongs in" : "does not belong in";

    if (input.group) {
      const group = await seam.findGroup(workspaceId, input.group);
      if (!group) return { kind: "refused", text: `No Group "${input.group}".` };
      return {
        kind: "action",
        preview: {
          kind: "text",
          text: `Record "${thread.subject}" (${thread.from}) as an Example that ${word} ${group.name}. The routing question reads it as your past decision from now on; nothing moves now.`,
        },
        count: 1,
        apply: async () => {
          const { previous } = await seam.recordExample(thread.id, group.id, input.belongs);
          return {
            text: `Example recorded: "${thread.subject}" ${word} ${group.name}. New mail like it is routed with it; organize_existing on ${group.name} re-runs routing on the mail already there.`,
            data: {
              threadId: thread.id,
              subject: thread.subject,
              group: { id: group.id, name: group.name },
              belongs: input.belongs,
              previous,
            },
            undo: { kind: "example", threadId: thread.id, groupId: group.id, previous },
          };
        },
      };
    }

    const found = await seam.findSection(input.section ?? "");
    if (!found) return { kind: "refused", text: `No section "${input.section}".` };
    const { rule, examples } = found;
    if (!rule.judge?.trim()) {
      return {
        kind: "refused",
        text: `"${rule.name ?? rule.id}" has no judge statement: its conditions decide alone, so an Example would not be read. update_section changes its conditions.`,
      };
    }
    if (await isPinned(ctx, "sections.examples")) {
      return { kind: "refused", text: PINNED("sections.examples") };
    }
    const facts = await seam.exampleFacts(thread.id);
    const list = (examples[rule.id] ?? []).filter((e) => e.threadId !== thread.id);
    const next = {
      ...examples,
      [rule.id]: [
        {
          threadId: thread.id,
          holds: input.belongs,
          from: facts?.from ?? null,
          subject: facts?.subject ?? thread.subject,
          at: ctx.now().toISOString(),
        },
        ...list,
      ].slice(0, 200),
    };
    const valid = validateSetting("sections.examples", next);
    if (!valid.ok) return { kind: "refused", text: `sections.examples: ${valid.error}` };
    const name = rule.name?.trim() || rule.id;
    return {
      kind: "action",
      preview: {
        kind: "text",
        text: `Record "${thread.subject}" (${thread.from}) as an Example that ${word} ${name}. The judge reads it beside "${rule.judge.trim()}", so the Section's threads are asked again as they are shown.`,
      },
      count: 1,
      apply: async () => {
        await ctx.host.writeSetting("sections.examples", valid.value);
        await seam.pinSectionAnswer(workspaceId, thread.id, rule.id, input.belongs);
        return {
          text: `Example recorded: "${thread.subject}" ${word} ${name}.`,
          data: {
            threadId: thread.id,
            subject: thread.subject,
            section: { id: rule.id, name },
            belongs: input.belongs,
          },
          undo: { kind: "settings", entries: [{ key: "sections.examples", previous: examples }] },
        };
      },
    };
  },
};

export const TUNE_TOOLS: readonly ToolDefinition<never>[] = [
  explainPlacement,
  listJudgments,
  testJudgment,
  updateJudgment,
  addExample,
] as unknown as readonly ToolDefinition<never>[];
