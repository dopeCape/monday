// The organization tools (slice 26; docs/spec/agent-composer.md "Organizing
// mail by talking"; CONTEXT.md "Section rule", "Custom action"; ADR 0002,
// ADR 0004): Sections, Groups and custom actions from a sentence. A Section
// and a custom action are Settings (sections.rules, sections.order,
// actions.custom), written through the host like change_setting, so the
// same pinning rule and the same `settings` Undo record apply; a Group goes
// through routing with a `group` Undo record. Every card names what will
// exist and, where the seam can count, how many Threads it holds; a judge
// statement is shown on the card in the words the Judge will be asked with.
// organize_existing routes the mail already there into a new Group (routing's
// preview and apply) or fills the judged cache for a new Section, and
// previews above the Setting's threshold.

import type {
  CustomActionSetting,
  GroupInput,
  IntentArgs,
  ProposedMove,
  SectionRuleSetting,
  SectionWhen,
  ToolPreview,
} from "@monday/shared";
import {
  customActionIdFor,
  sectionIdFor,
  sectionLabel,
  TOOL_TIERS,
  validateSetting,
} from "@monday/shared";
import { z } from "zod";
import type { OrganizeSeam } from "../../organize.ts";
import type { ToolContext, ToolDefinition, ToolPlan } from "./catalog.ts";

const text = (t: string): ToolPreview => ({ kind: "text", text: t });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** Above every preview threshold: the card asks. */
const ALWAYS_ASK = Number.MAX_SAFE_INTEGER;

const seamOf = (ctx: ToolContext): OrganizeSeam | null => ctx.extensions?.organize ?? null;

/* ------------------------------ Settings through the host ------------------------------ */

async function readList<T>(ctx: ToolContext, key: string): Promise<{ list: T[]; pinned: boolean }> {
  const current = await ctx.host.readSetting(key);
  const pinned = ctx.pinned.has(key) || current.pinned;
  return { list: Array.isArray(current.value) ? (current.value as T[]) : [], pinned };
}

const PINNED = (key: string) =>
  `${key} is set in monday.toml; the file wins. Offer to edit the file only if the user says yes.`;

/* ------------------------------ Sections ------------------------------ */

const whenInput = z
  .object({
    unread: z.boolean().optional(),
    starred: z.boolean().optional(),
    has_attachments: z.boolean().optional(),
    bulk: z.boolean().optional().describe("List mail: newsletters, digests, notifications"),
    min_messages: z.int().min(1).optional(),
    last_from: z.enum(["me", "others"]).optional().describe("Who wrote the newest message"),
    groups: z.array(z.string().min(1)).optional().describe("In one of these Groups (id or name)"),
    not_groups: z.array(z.string().min(1)).optional(),
    ungrouped: z.boolean().optional(),
  })
  .describe("Deterministic conditions; every one set must hold");
type WhenInput = z.output<typeof whenInput>;

function toWhen(w: WhenInput | undefined): SectionWhen {
  if (!w) return {};
  return {
    ...(w.unread !== undefined ? { unread: w.unread } : {}),
    ...(w.starred !== undefined ? { starred: w.starred } : {}),
    ...(w.has_attachments !== undefined ? { hasAttachments: w.has_attachments } : {}),
    ...(w.bulk !== undefined ? { bulk: w.bulk } : {}),
    ...(w.min_messages !== undefined ? { minMessages: w.min_messages } : {}),
    ...(w.last_from !== undefined ? { lastFrom: w.last_from } : {}),
    ...(w.groups?.length ? { groups: w.groups } : {}),
    ...(w.not_groups?.length ? { notGroups: w.not_groups } : {}),
    ...(w.ungrouped !== undefined ? { ungrouped: w.ungrouped } : {}),
  };
}

function describeWhen(when: SectionWhen): string {
  const parts: string[] = [];
  if (when.unread !== undefined) parts.push(when.unread ? "unread" : "read");
  if (when.starred !== undefined) parts.push(when.starred ? "starred" : "not starred");
  if (when.hasAttachments !== undefined)
    parts.push(when.hasAttachments ? "with attachments" : "without attachments");
  if (when.bulk !== undefined) parts.push(when.bulk ? "list mail" : "not list mail");
  if (when.minMessages !== undefined) parts.push(`at least ${plural(when.minMessages, "message")}`);
  if (when.lastFrom !== undefined)
    parts.push(when.lastFrom === "me" ? "you wrote last" : "someone else wrote last");
  if (when.groups?.length) parts.push(`in ${when.groups.join(" or ")}`);
  if (when.notGroups?.length) parts.push(`not in ${when.notGroups.join(" or ")}`);
  if (when.ungrouped !== undefined) parts.push(when.ungrouped ? "in no group" : "in a group");
  return parts.length ? parts.join(", ") : "every thread";
}

const placementWord = (p: SectionRuleSetting["placement"]) =>
  p === "nav" ? "in the nav" : p === "both" ? "in the stream and the nav" : "in the stream";

/** The card's line for a Section: what will exist, its conditions, the judge statement, the count. */
async function sectionLine(
  ctx: ToolContext,
  rule: SectionRuleSetting,
  verb: "Create" | "Change",
): Promise<string> {
  const lines = [
    `${verb} section "${sectionLabel(rule)}" ${placementWord(rule.placement)}${rule.hidden ? ", hidden" : ""}.`,
    `Holds threads that are ${describeWhen(rule.when)}${rule.judge ? `, and for which the judge says yes to: "${rule.judge}"` : ""}.`,
  ];
  if (rule.sentence) lines.push(`In your words: ${rule.sentence}`);
  const seam = seamOf(ctx);
  if (seam) {
    try {
      const count = await seam.countSection(ctx.host.workspaceId, rule);
      lines.push(
        `${plural(count.holds, "thread")} of the newest ${count.considered} would be in it${
          count.undecided > 0
            ? ` (${count.undecided} more once the judge answers)`
            : count.judged
              ? " (judged now)"
              : ""
        }.`,
      );
    } catch (error) {
      lines.push(`Could not count: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return lines.join("\n");
}

async function writeSections(
  ctx: ToolContext,
  rules: SectionRuleSetting[],
  order: string[],
): Promise<void> {
  const validRules = validateSetting("sections.rules", rules);
  if (!validRules.ok) throw new Error(`sections.rules: ${validRules.error}`);
  const validOrder = validateSetting("sections.order", order);
  if (!validOrder.ok) throw new Error(`sections.order: ${validOrder.error}`);
  await ctx.host.writeSetting("sections.rules", validRules.value);
  await ctx.host.writeSetting("sections.order", validOrder.value);
}

const createSection: ToolDefinition<{
  name: string;
  sentence?: string | undefined;
  when?: WhenInput | undefined;
  judge?: string | undefined;
  placement?: "stream" | "nav" | "both" | undefined;
  position?: "top" | "bottom" | undefined;
}> = {
  name: "create_section",
  description:
    'Create a Section from what the user said: a name, the user\'s sentence, deterministic conditions over thread state and Group, an optional judge statement (a yes-or-no sentence the judge answers per thread, such as "the sender is asking the owner to pay an invoice"), and where it shows: as a heading in the stream (default), as an entry in the nav ("a folder"), or both. Shows what will exist and how many recent threads it would hold, then applies. Reversible: undo removes it. Threads are never deleted.',
  tier: "reversible",
  input: z.object({
    name: z.string().min(1).max(80),
    sentence: z.string().max(500).optional().describe("The user's own words"),
    when: whenInput.optional(),
    judge: z.string().max(1000).optional().describe("A yes-or-no statement about a thread"),
    placement: z.enum(["stream", "nav", "both"]).optional(),
    position: z
      .enum(["top", "bottom"])
      .optional()
      .describe("Where in the stream order; bottom by default"),
  }),
  summarize: (i) => `${i.name} (${i.placement ?? "stream"})`,
  async run(input, ctx): Promise<ToolPlan> {
    const { list: rules, pinned } = await readList<SectionRuleSetting>(ctx, "sections.rules");
    if (pinned) return { kind: "refused", text: PINNED("sections.rules") };
    const { list: order, pinned: orderPinned } = await readList<string>(ctx, "sections.order");
    if (orderPinned) return { kind: "refused", text: PINNED("sections.order") };
    if (rules.some((r) => sectionLabel(r).toLowerCase() === input.name.trim().toLowerCase())) {
      return {
        kind: "refused",
        text: `A section named "${input.name}" already exists; use update_section.`,
      };
    }
    const id = sectionIdFor(
      input.name,
      rules.map((r) => r.id),
    );
    const rule: SectionRuleSetting = {
      id,
      name: input.name.trim(),
      when: toWhen(input.when),
      ...(input.sentence ? { sentence: input.sentence.trim() } : {}),
      ...(input.judge?.trim() ? { judge: input.judge.trim() } : {}),
      placement: input.placement ?? "stream",
      createdBy: "agent",
    };
    const nextOrder = input.position === "top" ? [id, ...order] : [...order, id];
    const nextRules = input.position === "top" ? [rule, ...rules] : [...rules, rule];
    return {
      kind: "action",
      preview: text(await sectionLine(ctx, rule, "Create")),
      count: 1,
      apply: async () => {
        await writeSections(ctx, nextRules, nextOrder);
        return {
          text: `Section "${rule.name}" (${id}) exists ${placementWord(rule.placement)}.`,
          data: { section: rule },
          undo: {
            kind: "settings",
            entries: [
              { key: "sections.rules", previous: rules },
              { key: "sections.order", previous: order },
            ],
          },
        };
      },
    };
  },
};

const updateSection: ToolDefinition<{
  section: string;
  name?: string | undefined;
  sentence?: string | undefined;
  when?: WhenInput | undefined;
  judge?: string | null | undefined;
  placement?: "stream" | "nav" | "both" | undefined;
  hidden?: boolean | undefined;
  position?: "top" | "bottom" | undefined;
}> = {
  name: "update_section",
  description:
    "Change a Section by id or name: rename, reword the sentence, replace its conditions, set or clear (null) its judge statement, move it between the stream and the nav, hide or show it, or move it to the top or bottom of the stream. The shipped sections (needs-reply, waiting, fyi, newsletters) are rows like any other. Reversible.",
  tier: "reversible",
  input: z.object({
    section: z.string().min(1).describe("The Section id or name"),
    name: z.string().min(1).max(80).optional(),
    sentence: z.string().max(500).optional(),
    when: whenInput.optional().describe("Replaces every condition when given"),
    judge: z.string().max(1000).nullable().optional(),
    placement: z.enum(["stream", "nav", "both"]).optional(),
    hidden: z.boolean().optional(),
    position: z.enum(["top", "bottom"]).optional(),
  }),
  summarize: (i) => i.section,
  async run(input, ctx): Promise<ToolPlan> {
    const { list: rules, pinned } = await readList<SectionRuleSetting>(ctx, "sections.rules");
    if (pinned) return { kind: "refused", text: PINNED("sections.rules") };
    const { list: order, pinned: orderPinned } = await readList<string>(ctx, "sections.order");
    if (orderPinned) return { kind: "refused", text: PINNED("sections.order") };
    const current = findSection(rules, input.section);
    if (!current) return { kind: "refused", text: `No section "${input.section}".` };
    const next: SectionRuleSetting = {
      ...current,
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.sentence !== undefined ? { sentence: input.sentence.trim() } : {}),
      ...(input.when !== undefined ? { when: toWhen(input.when) } : {}),
      ...(input.placement !== undefined ? { placement: input.placement } : {}),
      ...(input.hidden !== undefined ? { hidden: input.hidden } : {}),
    };
    if (input.judge === null) delete next.judge;
    else if (input.judge?.trim()) next.judge = input.judge.trim();
    const nextRules = rules.map((r) => (r.id === current.id ? next : r));
    let nextOrder = order.includes(current.id) ? order : [...order, current.id];
    if (input.position) {
      const rest = nextOrder.filter((id) => id !== current.id);
      nextOrder = input.position === "top" ? [current.id, ...rest] : [...rest, current.id];
    }
    return {
      kind: "action",
      preview: text(await sectionLine(ctx, next, "Change")),
      count: 1,
      apply: async () => {
        await writeSections(ctx, nextRules, nextOrder);
        return {
          text: `Section "${sectionLabel(next)}" (${next.id}) changed: ${placementWord(next.placement)}${next.hidden ? ", hidden" : ""}.`,
          data: { section: next },
          undo: {
            kind: "settings",
            entries: [
              { key: "sections.rules", previous: rules },
              { key: "sections.order", previous: order },
            ],
          },
        };
      },
    };
  },
};

const deleteSection: ToolDefinition<{ section: string }> = {
  name: "delete_section",
  description:
    "Remove a Section by id or name. Its threads stay in the mailbox and fall into the next section that holds them. Reversible: undo puts the section back.",
  tier: "reversible",
  input: z.object({ section: z.string().min(1) }),
  summarize: (i) => i.section,
  async run(input, ctx): Promise<ToolPlan> {
    const { list: rules, pinned } = await readList<SectionRuleSetting>(ctx, "sections.rules");
    if (pinned) return { kind: "refused", text: PINNED("sections.rules") };
    const { list: order, pinned: orderPinned } = await readList<string>(ctx, "sections.order");
    if (orderPinned) return { kind: "refused", text: PINNED("sections.order") };
    const current = findSection(rules, input.section);
    if (!current) return { kind: "refused", text: `No section "${input.section}".` };
    return {
      kind: "action",
      preview: text(
        `Remove section "${sectionLabel(current)}" from ${placementWord(current.placement).replace("in ", "")}. Its threads stay and show under the next section that holds them.`,
      ),
      count: 1,
      apply: async () => {
        await writeSections(
          ctx,
          rules.filter((r) => r.id !== current.id),
          order.filter((id) => id !== current.id),
        );
        await seamOf(ctx)?.forget(ctx.host.workspaceId, current.id);
        return {
          text: `Section "${sectionLabel(current)}" removed; no thread was deleted.`,
          data: { section: current },
          undo: {
            kind: "settings",
            entries: [
              { key: "sections.rules", previous: rules },
              { key: "sections.order", previous: order },
            ],
          },
        };
      },
    };
  },
};

export function findSection(
  rules: readonly SectionRuleSetting[],
  ref: string,
): SectionRuleSetting | undefined {
  const want = ref.trim().toLowerCase();
  return (
    rules.find((r) => r.id.toLowerCase() === want) ??
    rules.find((r) => sectionLabel(r).toLowerCase() === want)
  );
}

/* ------------------------------ Custom actions ------------------------------ */

/** The tools a custom action may call: one Thread in, an ordinary tool call out. */
export const ACTION_TOOLS = [
  "forward_thread",
  "draft_message",
  "archive_threads",
  "snooze_threads",
  "tag_threads",
  "move_threads",
  "trash_threads",
] as const;

const onInput = z
  .object({
    group: z.string().min(1).optional().describe("A Group id or name"),
    section: z.string().min(1).optional().describe("A Section id"),
    judge: z.string().min(1).max(1000).optional().describe("A yes-or-no statement about a thread"),
  })
  .describe("Where the action shows; every condition set must hold");

function describeOn(on: CustomActionSetting["on"]): string {
  const parts: string[] = [];
  if (on.group) parts.push(`threads in ${on.group}`);
  if (on.section) parts.push(`threads under ${on.section}`);
  if (on.judge) parts.push(`threads for which the judge says yes to: "${on.judge}"`);
  return parts.length ? parts.join(" and ") : "every thread";
}

function tierWord(action: CustomActionSetting, ctx: ToolContext): string {
  const base = TOOL_TIERS[action.tool];
  const asks =
    action.tier === "always-ask" ||
    base === "leaves_mailbox" ||
    base === "destructive" ||
    ctx.settings.alwaysAsk.includes(action.tool);
  return asks ? "asks first" : base === "reversible" ? "runs with Undo" : "runs silently";
}

function actionLine(action: CustomActionSetting, ctx: ToolContext, verb: string): string {
  return [
    `${verb} button "${action.label}" on ${describeOn(action.on)}.`,
    `It calls ${action.tool} with ${JSON.stringify(action.args)} and ${tierWord(action, ctx)}.`,
  ].join("\n");
}

async function writeActions(ctx: ToolContext, actions: CustomActionSetting[]): Promise<void> {
  const valid = validateSetting("actions.custom", actions);
  if (!valid.ok) throw new Error(`actions.custom: ${valid.error}`);
  await ctx.host.writeSetting("actions.custom", valid.value);
}

function checkTool(tool: string): string | null {
  if (!(ACTION_TOOLS as readonly string[]).includes(tool)) {
    return `A custom action may call one of: ${ACTION_TOOLS.join(", ")}.`;
  }
  return null;
}

export function findAction(
  actions: readonly CustomActionSetting[],
  ref: string,
): CustomActionSetting | undefined {
  const want = ref.trim().toLowerCase();
  return (
    actions.find((a) => a.id.toLowerCase() === want) ??
    actions.find((a) => a.label.toLowerCase() === want)
  );
}

const createAction: ToolDefinition<{
  label: string;
  on?: z.output<typeof onInput> | undefined;
  tool: string;
  args?: Record<string, unknown> | undefined;
  always_ask?: boolean | undefined;
}> = {
  name: "create_action",
  description:
    "Create a custom action: a button on the threads of a Group or Section, or on threads a judge statement holds, that runs one tool with fixed arguments (the thread is added when it runs; strings may hold {{thread.subject}}, {{thread.from}}, {{thread.id}}). Tools: forward_thread (to, note), draft_message (kind, to, subject, body), archive_threads, snooze_threads (until), tag_threads (add, remove), move_threads (group), trash_threads. The tool's own Tier applies: a forward asks first, an archive or tag runs with Undo; always_ask promotes a reversible tool. Reversible: undo removes the button.",
  tier: "reversible",
  input: z.object({
    label: z.string().min(1).max(60),
    on: onInput.optional(),
    tool: z.string().min(1),
    args: z.record(z.string(), z.unknown()).optional(),
    always_ask: z.boolean().optional(),
  }),
  summarize: (i) => `${i.label}: ${i.tool}`,
  async run(input, ctx): Promise<ToolPlan> {
    const bad = checkTool(input.tool);
    if (bad) return { kind: "refused", text: bad };
    const { list: actions, pinned } = await readList<CustomActionSetting>(ctx, "actions.custom");
    if (pinned) return { kind: "refused", text: PINNED("actions.custom") };
    if (actions.some((a) => a.label.toLowerCase() === input.label.trim().toLowerCase())) {
      return {
        kind: "refused",
        text: `An action labelled "${input.label}" already exists; use update_action.`,
      };
    }
    const action: CustomActionSetting = {
      id: customActionIdFor(
        input.label,
        actions.map((a) => a.id),
      ),
      label: input.label.trim(),
      on: {
        ...(input.on?.group ? { group: input.on.group } : {}),
        ...(input.on?.section ? { section: input.on.section } : {}),
        ...(input.on?.judge?.trim() ? { judge: input.on.judge.trim() } : {}),
      },
      tool: input.tool,
      args: input.args ?? {},
      ...(input.always_ask ? { tier: "always-ask" as const } : {}),
      createdBy: "agent",
    };
    return {
      kind: "action",
      preview: text(actionLine(action, ctx, "Add")),
      count: 1,
      apply: async () => {
        await writeActions(ctx, [...actions, action]);
        return {
          text: `Button "${action.label}" (${action.id}) added on ${describeOn(action.on)}; it ${tierWord(action, ctx)}.`,
          data: { action },
          undo: { kind: "settings", entries: [{ key: "actions.custom", previous: actions }] },
        };
      },
    };
  },
};

const updateAction: ToolDefinition<{
  action: string;
  label?: string | undefined;
  on?: z.output<typeof onInput> | undefined;
  tool?: string | undefined;
  args?: Record<string, unknown> | undefined;
  always_ask?: boolean | undefined;
}> = {
  name: "update_action",
  description:
    "Change a custom action by id or label: its label, where it shows (replaces every condition when given), the tool, its arguments, or whether it always asks. Reversible.",
  tier: "reversible",
  input: z.object({
    action: z.string().min(1),
    label: z.string().min(1).max(60).optional(),
    on: onInput.optional(),
    tool: z.string().min(1).optional(),
    args: z.record(z.string(), z.unknown()).optional(),
    always_ask: z.boolean().optional(),
  }),
  summarize: (i) => i.action,
  async run(input, ctx): Promise<ToolPlan> {
    if (input.tool !== undefined) {
      const bad = checkTool(input.tool);
      if (bad) return { kind: "refused", text: bad };
    }
    const { list: actions, pinned } = await readList<CustomActionSetting>(ctx, "actions.custom");
    if (pinned) return { kind: "refused", text: PINNED("actions.custom") };
    const current = findAction(actions, input.action);
    if (!current) return { kind: "refused", text: `No custom action "${input.action}".` };
    const next: CustomActionSetting = {
      ...current,
      ...(input.label !== undefined ? { label: input.label.trim() } : {}),
      ...(input.on !== undefined
        ? {
            on: {
              ...(input.on.group ? { group: input.on.group } : {}),
              ...(input.on.section ? { section: input.on.section } : {}),
              ...(input.on.judge?.trim() ? { judge: input.on.judge.trim() } : {}),
            },
          }
        : {}),
      ...(input.tool !== undefined ? { tool: input.tool } : {}),
      ...(input.args !== undefined ? { args: input.args } : {}),
    };
    if (input.always_ask === true) next.tier = "always-ask";
    else if (input.always_ask === false) delete next.tier;
    return {
      kind: "action",
      preview: text(actionLine(next, ctx, "Change")),
      count: 1,
      apply: async () => {
        await writeActions(
          ctx,
          actions.map((a) => (a.id === current.id ? next : a)),
        );
        return {
          text: `Button "${next.label}" (${next.id}) changed: ${next.tool} on ${describeOn(next.on)}; it ${tierWord(next, ctx)}.`,
          data: { action: next },
          undo: { kind: "settings", entries: [{ key: "actions.custom", previous: actions }] },
        };
      },
    };
  },
};

const deleteAction: ToolDefinition<{ action: string }> = {
  name: "delete_action",
  description: "Remove a custom action by id or label. Reversible: undo puts the button back.",
  tier: "reversible",
  input: z.object({ action: z.string().min(1) }),
  summarize: (i) => i.action,
  async run(input, ctx): Promise<ToolPlan> {
    const { list: actions, pinned } = await readList<CustomActionSetting>(ctx, "actions.custom");
    if (pinned) return { kind: "refused", text: PINNED("actions.custom") };
    const current = findAction(actions, input.action);
    if (!current) return { kind: "refused", text: `No custom action "${input.action}".` };
    return {
      kind: "action",
      preview: text(`Remove button "${current.label}" from ${describeOn(current.on)}.`),
      count: 1,
      apply: async () => {
        await writeActions(
          ctx,
          actions.filter((a) => a.id !== current.id),
        );
        await seamOf(ctx)?.forget(ctx.host.workspaceId, current.id);
        return {
          text: `Button "${current.label}" removed.`,
          data: { action: current },
          undo: { kind: "settings", entries: [{ key: "actions.custom", previous: actions }] },
        };
      },
    };
  },
};

/* ------------------------------ Groups ------------------------------ */

const REFUSED = "Groups cannot be changed from this host.";

const groupInput = {
  sentence: z.string().max(500).optional().describe("The plain-language Routing rule"),
  senders: z.array(z.string().min(3)).max(50).optional().describe("Sender addresses"),
  domains: z.array(z.string().min(2)).max(50).optional().describe("Sender domains"),
  subject_patterns: z.array(z.string().min(1)).max(20).optional(),
  threshold: z.number().min(0).max(1).nullable().optional(),
};

type GroupFields = {
  sentence?: string | undefined;
  senders?: string[] | undefined;
  domains?: string[] | undefined;
  subject_patterns?: string[] | undefined;
  threshold?: number | null | undefined;
};

function groupPatch(i: GroupFields): Partial<GroupInput> {
  const predicate = {
    ...(i.senders !== undefined ? { senders: i.senders } : {}),
    ...(i.domains !== undefined ? { domains: i.domains } : {}),
    ...(i.subject_patterns !== undefined ? { subjectPatterns: i.subject_patterns } : {}),
  };
  return {
    ...(i.sentence !== undefined ? { sentence: i.sentence } : {}),
    ...(Object.keys(predicate).length ? { predicate } : {}),
    ...(i.threshold !== undefined ? { threshold: i.threshold } : {}),
  };
}

async function resolveGroup(
  seam: OrganizeSeam,
  workspaceId: string,
  ref: string,
): Promise<Awaited<ReturnType<OrganizeSeam["listGroups"]>>[number] | undefined> {
  const want = ref.trim().toLowerCase();
  const all = await seam.listGroups(workspaceId);
  return (
    all.find((g) => g.id.toLowerCase() === want) ?? all.find((g) => g.name.toLowerCase() === want)
  );
}

const createGroup: ToolDefinition<GroupFields & { name: string; parent?: string | undefined }> = {
  name: "create_group",
  description:
    "Create a Group, or a Sub-group under a parent Group (id or name), with its plain-language Routing rule and optional Predicate (senders, domains, subject patterns). A Group is a lens on the Inbox. Shows what will exist; nothing moves until organize_existing routes the mail already there. Reversible: undo deletes it.",
  tier: "reversible",
  input: z.object({
    name: z.string().min(1).max(60),
    parent: z.string().min(1).optional().describe("The parent Group, for a Sub-group"),
    ...groupInput,
  }),
  summarize: (i) => (i.parent ? `${i.parent} / ${i.name}` : i.name),
  async run(input, ctx): Promise<ToolPlan> {
    const seam = seamOf(ctx);
    if (!seam) return { kind: "refused", text: REFUSED };
    const workspaceId = ctx.host.workspaceId;
    const existing = await seam.listGroups(workspaceId);
    if (existing.some((g) => g.name.toLowerCase() === input.name.trim().toLowerCase())) {
      return { kind: "refused", text: `A Group named "${input.name}" already exists.` };
    }
    let parentId: string | null = null;
    if (input.parent) {
      const parent = await resolveGroup(seam, workspaceId, input.parent);
      if (!parent) return { kind: "refused", text: `No Group "${input.parent}" to nest under.` };
      if (parent.parentId) return { kind: "refused", text: "Nesting stops at one level." };
      parentId = parent.id;
    }
    const patch = groupPatch(input);
    const groupInputValue: GroupInput = { name: input.name.trim(), parentId, ...patch };
    return {
      kind: "action",
      preview: text(
        `Create ${parentId ? `sub-group "${input.parent} / ${input.name}"` : `group "${input.name}"`}${
          patch.sentence ? `: ${patch.sentence}` : ""
        }. Nothing moves yet; organize_existing routes the mail already there.`,
      ),
      count: 1,
      apply: async () => {
        const group = await seam.createGroup(workspaceId, groupInputValue);
        return {
          text: `Group "${group.name}" (${group.id}) exists${parentId ? ` under ${input.parent}` : ""}.`,
          data: { group: { id: group.id, name: group.name, parentId: group.parentId } },
          undo: { kind: "group", groupId: group.id, previous: null },
        };
      },
    };
  },
};

const updateGroup: ToolDefinition<
  GroupFields & { group: string; name?: string | undefined; parent?: string | null | undefined }
> = {
  name: "update_group",
  description:
    "Change a Group by id or name: rename, reword its rule sentence, replace Predicate lists, change its threshold, or nest it under a parent (null to un-nest). Reversible: undo restores the previous values.",
  tier: "reversible",
  input: z.object({
    group: z.string().min(1),
    name: z.string().min(1).max(60).optional(),
    parent: z.string().min(1).nullable().optional(),
    ...groupInput,
  }),
  summarize: (i) => i.group,
  async run(input, ctx): Promise<ToolPlan> {
    const seam = seamOf(ctx);
    if (!seam) return { kind: "refused", text: REFUSED };
    const workspaceId = ctx.host.workspaceId;
    const current = await resolveGroup(seam, workspaceId, input.group);
    if (!current) return { kind: "refused", text: `No Group "${input.group}".` };
    const patch: Partial<GroupInput> = {
      ...groupPatch(input),
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    };
    if (input.parent === null) patch.parentId = null;
    else if (input.parent !== undefined) {
      const parent = await resolveGroup(seam, workspaceId, input.parent);
      if (!parent) return { kind: "refused", text: `No Group "${input.parent}" to nest under.` };
      patch.parentId = parent.id;
    }
    if (Object.keys(patch).length === 0) return { kind: "refused", text: "Nothing to change." };
    const previous: GroupInput = {
      name: current.name,
      parentId: current.parentId,
      sentence: current.rule.sentence,
      predicate: current.rule.predicate,
      threshold: current.threshold,
      briefPolicy: current.briefPolicy,
    };
    return {
      kind: "action",
      preview: text(
        `Change group "${current.name}": ${Object.entries(patch)
          .map(([k, v]) => `${k} to ${JSON.stringify(v)}`)
          .join(", ")}.`,
      ),
      count: 1,
      apply: async () => {
        const group = await seam.updateGroup(current.id, patch);
        return {
          text: `Group "${group.name}" (${group.id}) changed.`,
          data: { group: { id: group.id, name: group.name, parentId: group.parentId } },
          undo: { kind: "group", groupId: group.id, previous },
        };
      },
    };
  },
};

/* ------------------------------ Existing mail ------------------------------ */

const organizeExisting: ToolDefinition<{
  group?: string | undefined;
  section?: string | undefined;
  recent?: number | undefined;
}> = {
  name: "organize_existing",
  description:
    "Route the mail already there into a Group (id or name): scores the newest threads with the Group's rule and moves the ones it claims, with a preview above the threshold; or judge the newest threads for a Section with a judge statement so it fills at once. Reversible: undo puts every moved thread back and forgets the judgments.",
  tier: "reversible",
  input: z.object({
    group: z.string().min(1).optional(),
    section: z.string().min(1).optional(),
    recent: z.int().min(1).max(5000).optional().describe("How many newest threads to consider"),
  }),
  summarize: (i) => i.group ?? i.section ?? "",
  async run(input, ctx): Promise<ToolPlan> {
    const seam = seamOf(ctx);
    if (!seam)
      return { kind: "refused", text: "Organizing existing mail is not available from this host." };
    const workspaceId = ctx.host.workspaceId;
    const settings = await seam.settings();
    const recent = input.recent ?? settings.recent;
    if (input.group) {
      const group = await resolveGroup(seam, workspaceId, input.group);
      if (!group) return { kind: "refused", text: `No Group "${input.group}".` };
      const preview = await seam.previewGroups(workspaceId, [], recent);
      const moves = preview.moves.filter(
        (m): m is ProposedMove & { proposed: { kind: "route" } } =>
          m.proposed.kind === "route" &&
          (m.proposed.groupId === group.id || m.proposed.subgroupId === group.id),
      );
      if (moves.length === 0) {
        return {
          kind: "result",
          text: `Nothing to move: no thread among the newest ${preview.considered} joins "${group.name}".`,
          data: { moved: 0, considered: preview.considered },
        };
      }
      const list = moves
        .slice(0, 25)
        .map((m) => `  ${m.subject || "(no subject)"} (${m.from?.name || m.from?.email || "?"})`)
        .join("\n");
      return {
        kind: "action",
        preview: text(
          `Move ${plural(moves.length, "thread")} of the newest ${preview.considered} into "${group.name}":\n${list}${moves.length > 25 ? `\n  and ${moves.length - 25} more` : ""}`,
        ),
        count: moves.length > settings.previewAbove ? ALWAYS_ASK : moves.length,
        apply: async () => {
          const applied = await seam.applyMoves(workspaceId, moves);
          const reverse: (IntentArgs & { threadId: string })[] = moves.map((m) => ({
            threadId: m.threadId,
            kind: "move",
            group: m.current.groupId,
            subgroup: m.current.subgroupId,
          }));
          return {
            text: `${plural(applied.moved, "thread")} moved into "${group.name}".`,
            data: { moved: applied.moved, threadIds: moves.map((m) => m.threadId) },
            undo: { kind: "organize", intents: reverse, sectionId: null },
          };
        },
      };
    }
    if (input.section) {
      const { rules } = await seam.sectionRules();
      const rule = findSection(rules, input.section);
      if (!rule) return { kind: "refused", text: `No section "${input.section}".` };
      if (!rule.judge) {
        return {
          kind: "result",
          text: `"${sectionLabel(rule)}" has no judge statement; its conditions already sort every thread at once.`,
          data: null,
        };
      }
      if (!(await seam.judgeAvailable())) {
        return {
          kind: "refused",
          text: "The judge is not available; add a TypeSafe key under Settings, AI.",
        };
      }
      return {
        kind: "action",
        preview: text(
          `Judge the newest ${recent} threads for "${sectionLabel(rule)}": "${rule.judge}". Threads the judge says yes to show under it at once; nothing moves or is deleted.`,
        ),
        count: 1,
        apply: async () => {
          const count = await seam.countSection(workspaceId, rule, recent);
          return {
            text: `${plural(count.holds, "thread")} of ${count.considered} are in "${sectionLabel(rule)}".`,
            data: { holds: count.holds, considered: count.considered },
            undo: { kind: "organize", intents: [], sectionId: rule.id },
          };
        },
      };
    }
    return { kind: "refused", text: "Name a group or a section." };
  },
};

export const ORGANIZE_TOOLS: readonly ToolDefinition<never>[] = [
  createSection,
  updateSection,
  deleteSection,
  createAction,
  updateAction,
  deleteAction,
  createGroup,
  updateGroup,
  organizeExisting,
] as unknown as readonly ToolDefinition<never>[];
