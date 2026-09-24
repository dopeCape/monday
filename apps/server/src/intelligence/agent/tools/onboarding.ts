// The onboarding tools (docs/spec/onboarding.md, "What it seeds"): the
// context the conversation starts from, Group proposals with the count of
// existing Threads that would move (routing's preview over candidate Groups,
// nothing created until approved, one Undo), catalog Workflows matched to
// the tools chosen and shown with their Dry run (enabled only on approval),
// a Focus view, and the keymap. They reach routing and the Workflows module
// through the OnboardingSeam in ToolExtensions, so a host without it refuses.
// Every proposal is an `action` plan whose count sits above every preview
// threshold, so the card always asks (ADR 0002, ADR 0004).

import type {
  DryRunPreview,
  GroupInput,
  IntentArgs,
  ProposedMove,
  ToolPreview,
  ViewSetting,
} from "@monday/shared";
import { levelAtLeast, validateSetting } from "@monday/shared";
import { z } from "zod";
import type { OnboardingSeam } from "../../onboarding.ts";
import type { ToolContext, ToolDefinition, ToolPlan } from "./catalog.ts";

const text = (t: string): ToolPreview => ({ kind: "text", text: t });
const REFUSED = "Onboarding is not available from this host.";
/** Above every preview threshold: the card asks (docs/spec/onboarding.md: nothing applied until approved). */
const ALWAYS_ASK = Number.MAX_SAFE_INTEGER;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function seamOf(ctx: ToolContext): OnboardingSeam | null {
  return ctx.extensions?.onboarding ?? null;
}

/* ------------------------------ Context ------------------------------ */

const onboardingContext: ToolDefinition<{ senders?: number | undefined }> = {
  name: "onboarding_context",
  description:
    "What onboarding starts from: the AI level, the top senders already synced (headers only), the Thread count, the Groups and Workflows that already exist. Read-only; call it once at the start of the onboarding conversation.",
  tier: "read",
  input: z.object({ senders: z.int().min(1).max(20).optional() }),
  summarize: () => "",
  async run(input, ctx) {
    const seam = seamOf(ctx);
    if (!seam) return { kind: "refused", text: REFUSED };
    const workspaceId = ctx.host.workspaceId;
    const [level, senders, threadCount, groups, workflows, keymap] = await Promise.all([
      seam.level(),
      seam.topSenders(workspaceId, input.senders ?? 8),
      seam.threadCount(workspaceId),
      ctx.host.listGroups(),
      ctx.extensions?.workflows?.list(workspaceId) ?? Promise.resolve([]),
      ctx.host.readSetting("keyboard.keymap"),
    ]);
    const lines = [
      `AI level: ${level}.`,
      `Keymap in effect: ${String(keymap.value)}.`,
      `Threads synced: ${threadCount}.`,
      senders.length
        ? `Top senders: ${senders.map((s) => `${s.name || s.email} <${s.email}> (${plural(s.messages, "message")})`).join("; ")}.`
        : "Top senders: none synced yet.",
      groups.length
        ? `Existing Groups: ${groups.map((g) => g.name).join(", ")}.`
        : "No Groups yet.",
      workflows.length
        ? `Existing Workflows: ${workflows.map((w) => `${w.name} (${w.enabled ? "on" : "off"})`).join(", ")}.`
        : "No Workflows yet.",
    ];
    return {
      kind: "result",
      text: lines.join("\n"),
      data: {
        level,
        keymap: keymap.value,
        senders,
        threadCount,
        groups,
        workflows: workflows.map((w) => w.name),
      },
    };
  },
};

/* ------------------------------ Groups ------------------------------ */

const groupProposal = z.object({
  name: z.string().min(1).max(60),
  sentence: z.string().min(1).max(500).describe("The plain-language Routing rule"),
  senders: z.array(z.string().min(3)).max(50).optional().describe("Sender addresses"),
  domains: z.array(z.string().min(2)).max(50).optional().describe("Sender domains"),
  subject_patterns: z.array(z.string().min(1)).max(20).optional(),
});
type GroupProposal = z.output<typeof groupProposal>;

function toInput(p: GroupProposal): GroupInput {
  return {
    name: p.name,
    sentence: p.sentence,
    predicate: {
      ...(p.senders?.length ? { senders: p.senders } : {}),
      ...(p.domains?.length ? { domains: p.domains } : {}),
      ...(p.subject_patterns?.length ? { subjectPatterns: p.subject_patterns } : {}),
    },
  };
}

/** The list the card shows: each Group's sentence and how many existing Threads would move. */
export function groupsPreviewText(
  proposals: readonly { name: string; sentence: string; moves: number }[],
  considered: number,
): string {
  const lines = proposals.map(
    (p) => `${p.name}: ${p.sentence} (${plural(p.moves, "thread")} would move)`,
  );
  return `${lines.join("\n")}\nOver the newest ${plural(considered, "thread")}. Nothing moves until you approve; one Undo puts it all back.`;
}

const proposeGroups: ToolDefinition<{ groups: GroupProposal[]; recent?: number | undefined }> = {
  name: "propose_groups",
  description:
    "Propose Groups with their Routing rules for onboarding. Shows the list with each sentence and the count of existing Threads that would move, and asks; on approval the Groups are created and the moves applied, all undone by one Undo. Nothing is created before approval. Only at AI level automate.",
  tier: "reversible",
  input: z.object({
    groups: z.array(groupProposal).min(1).max(8),
    recent: z.int().min(1).max(500).optional().describe("How many newest Threads to score"),
  }),
  summarize: (i) => i.groups.map((g) => g.name).join(", "),
  async run(input, ctx): Promise<ToolPlan> {
    const seam = seamOf(ctx);
    if (!seam) return { kind: "refused", text: REFUSED };
    if (!levelAtLeast(await seam.level(), "automate")) {
      return {
        kind: "refused",
        text: "Groups are proposed only at AI level automate (Mail that sorts and acts for me).",
      };
    }
    const workspaceId = ctx.host.workspaceId;
    const existing = new Set((await ctx.host.listGroups()).map((g) => g.name.toLowerCase()));
    const fresh = input.groups.filter((g) => !existing.has(g.name.toLowerCase()));
    if (fresh.length === 0) {
      return { kind: "refused", text: "Every proposed Group already exists; nothing to add." };
    }
    const candidates = fresh.map((g, i) => ({ id: `candidate-${i + 1}`, ...toInput(g) }));
    const recent = input.recent ?? Math.max(ctx.settings.searchLimit, 100);
    const preview = await seam.previewGroups(workspaceId, candidates, recent);
    const moves = preview.moves.filter(
      (m): m is ProposedMove & { proposed: { kind: "route" } } =>
        m.proposed.kind === "route" && m.proposed.groupId.startsWith("candidate-"),
    );
    const counts = candidates.map((c) => ({
      name: c.name,
      sentence: c.sentence ?? "",
      moves: moves.filter((m) => m.proposed.groupId === c.id).length,
    }));
    return {
      kind: "action",
      // The card shows each Group as its own row; groupsPreviewText is the same list in words.
      preview: { kind: "groups", groups: counts, considered: preview.considered },
      count: ALWAYS_ASK,
      apply: async () => {
        const ids = new Map<string, string>();
        const created: string[] = [];
        for (const c of candidates) {
          const { id, ...rest } = c;
          const group = await seam.createGroup(workspaceId, rest);
          ids.set(id, group.id);
          created.push(group.id);
        }
        const real = moves.flatMap((m) => {
          const groupId = ids.get(m.proposed.groupId);
          return groupId ? [{ ...m, proposed: { ...m.proposed, groupId, subgroupId: null } }] : [];
        });
        const applied = await seam.applyMoves(workspaceId, real);
        const reverse: (IntentArgs & { threadId: string })[] = real.map((m) => ({
          threadId: m.threadId,
          kind: "move",
          group: m.current.groupId,
          subgroup: m.current.subgroupId,
        }));
        return {
          text: `Created ${plural(created.length, "Group")} (${counts.map((c) => c.name).join(", ")}); ${plural(applied.moved, "thread")} moved.`,
          data: { groups: created, moved: applied.moved },
          undo: { kind: "groups", groupIds: created, intents: reverse },
        };
      },
    };
  },
};

/* ------------------------------ Workflows ------------------------------ */

/** The Dry run as the card and the model read it. */
export function dryRunLine(dry: DryRunPreview): string {
  if (dry.threads.length === 0) return `Dry run: nothing matched over recent mail.`;
  const lines = dry.threads
    .slice(0, 5)
    .map(
      (t) =>
        `  ${t.subject} (${t.from}): ${t.steps.map((s) => `${s.name} ${s.status}`).join(", ")}`,
    );
  return `Dry run over ${plural(dry.considered, "matching thread")}:\n${lines.join("\n")}`;
}

const proposeWorkflows: ToolDefinition<{ tools: string[]; max?: number | undefined }> = {
  name: "propose_workflows",
  description:
    "The catalog Workflows that match the tools the user uses (slack, notion, drive, discord; none for built-in ones), at most `max`, each with its Dry run over recent mail. Read-only: nothing is created; adopt_workflow creates and enables one on approval.",
  tier: "read",
  input: z.object({ tools: z.array(z.string()).max(10), max: z.int().min(1).max(5).optional() }),
  summarize: (i) => i.tools.join(", ") || "built-in",
  async run(input, ctx) {
    const seam = seamOf(ctx);
    if (!seam) return { kind: "refused", text: REFUSED };
    if (!levelAtLeast(await seam.level(), "automate")) {
      return { kind: "refused", text: "Workflows are proposed only at AI level automate." };
    }
    const entries = seam.catalog(input.tools, input.max ?? 2);
    if (entries.length === 0)
      return { kind: "result", text: "No catalog Workflow fits.", data: [] };
    const out: Array<{ id: string; name: string; sentence: string; dryRun: DryRunPreview }> = [];
    for (const e of entries) {
      const dryRun = await seam.dryRunInput(ctx.host.workspaceId, e.document);
      out.push({ id: e.id, name: e.document.name, sentence: e.document.sentence, dryRun });
    }
    return {
      kind: "result",
      text: out
        .map((p) => `${p.id}: ${p.name}. ${p.sentence}\n${dryRunLine(p.dryRun)}`)
        .join("\n\n"),
      data: out,
    };
  },
};

const adoptWorkflow: ToolDefinition<{ catalog_id: string }> = {
  name: "adopt_workflow",
  description:
    "Create and enable one catalog Workflow by its id from propose_workflows. Shows its Dry run and asks first; undo deletes it.",
  tier: "reversible",
  input: z.object({ catalog_id: z.string().min(1) }),
  summarize: (i) => i.catalog_id,
  async run(input, ctx): Promise<ToolPlan> {
    const seam = seamOf(ctx);
    const workflows = ctx.extensions?.workflows;
    if (!seam || !workflows) return { kind: "refused", text: REFUSED };
    if (!levelAtLeast(await seam.level(), "automate")) {
      return { kind: "refused", text: "Workflows are enabled only at AI level automate." };
    }
    const entry = seam.catalogEntry(input.catalog_id);
    if (!entry) return { kind: "refused", text: `No catalog Workflow "${input.catalog_id}".` };
    const workspaceId = ctx.host.workspaceId;
    const dry = await seam.dryRunInput(workspaceId, entry.document);
    return {
      kind: "action",
      preview: text(
        `Enable "${entry.document.name}"? ${entry.document.sentence}\n${dryRunLine(dry)}`,
      ),
      count: ALWAYS_ASK,
      apply: async () => {
        const created = await workflows.create(workspaceId, entry.document);
        const enabled = await workflows.enable(created.id, true);
        return {
          text: `${enabled.name} is created and enabled (${enabled.id}).`,
          data: { workflow: enabled },
          undo: { kind: "workflow", workflowId: created.id, previous: null },
        };
      },
    };
  },
};

/* ------------------------------ Views and keymap ------------------------------ */

const proposeViews: ToolDefinition<{ name?: string | undefined }> = {
  name: "propose_views",
  description:
    "Offer a Focus View (nav hidden, agent on the right, one stream) for someone who gets a lot of mail: shows it and asks; on approval it joins views.list with the next free shortcut. Reversible.",
  tier: "reversible",
  input: z.object({ name: z.string().min(1).max(40).optional() }),
  summarize: (i) => i.name ?? "Focus",
  async run(input, ctx): Promise<ToolPlan> {
    const name = input.name ?? "Focus";
    const current = await ctx.host.readSetting("views.list");
    if (ctx.pinned.has("views.list") || current.pinned) {
      return { kind: "refused", text: "views.list is set in monday.toml; the file wins." };
    }
    const list = Array.isArray(current.value) ? (current.value as ViewSetting[]) : [];
    if (list.some((v) => v.name.toLowerCase() === name.toLowerCase())) {
      return { kind: "result", text: `A ${name} view already exists.`, data: null };
    }
    const taken = new Set(list.map((v) => v.shortcut));
    const slot = [1, 2, 3, 4, 5, 6, 7, 8, 9].find((n) => !taken.has(`mod+${n}`));
    const view: ViewSetting = {
      id: `view-${name.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`,
      name,
      shortcut: slot ? `mod+${slot}` : null,
      layout: { nav: "hidden", agent: "right", list: "stream" },
    };
    const next = [...list, view];
    const valid = validateSetting("views.list", next);
    if (!valid.ok) return { kind: "refused", text: valid.error };
    return {
      kind: "action",
      preview: {
        kind: "setting",
        key: "views.list",
        from: list.map((v) => v.name),
        to: next.map((v) => v.name),
      },
      count: ALWAYS_ASK,
      apply: async () => {
        await ctx.host.writeSetting("views.list", valid.value);
        return {
          text: `${name} view added${view.shortcut ? ` on ${view.shortcut}` : ""}: nav hidden, agent right, stream.`,
          data: { view },
          undo: { kind: "settings", entries: [{ key: "views.list", previous: list }] },
        };
      },
    };
  },
};

const setKeymap: ToolDefinition<{ keymap: "vim" | "gmail" | "natural" }> = {
  name: "set_keymap",
  description:
    "Pick the keymap: vim, gmail or natural. Sugar over change_setting for keyboard.keymap. Reversible.",
  tier: "reversible",
  input: z.object({ keymap: z.enum(["vim", "gmail", "natural"]) }),
  summarize: (i) => i.keymap,
  async run(input, ctx): Promise<ToolPlan> {
    const current = await ctx.host.readSetting("keyboard.keymap");
    if (ctx.pinned.has("keyboard.keymap") || current.pinned) {
      return { kind: "refused", text: "keyboard.keymap is set in monday.toml; the file wins." };
    }
    if (current.value === input.keymap) {
      return { kind: "result", text: `The keymap is already ${input.keymap}.`, data: null };
    }
    return {
      kind: "action",
      preview: { kind: "setting", key: "keyboard.keymap", from: current.value, to: input.keymap },
      count: 1,
      apply: async () => {
        await ctx.host.writeSetting("keyboard.keymap", input.keymap);
        return {
          text: `Keymap: ${input.keymap}.`,
          data: { keymap: input.keymap },
          undo: {
            kind: "settings",
            entries: [{ key: "keyboard.keymap", previous: current.value }],
          },
        };
      },
    };
  },
};

export const ONBOARDING_TOOLS: readonly ToolDefinition<never>[] = [
  onboardingContext,
  proposeGroups,
  proposeWorkflows,
  adoptWorkflow,
  proposeViews,
  setKeymap,
] as unknown as readonly ToolDefinition<never>[];
