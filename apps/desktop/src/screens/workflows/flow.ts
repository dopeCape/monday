// A Workflow document worded as the cards of its flow (ADR 0003): the
// trigger in plain words with its conditions, each Step with its kind, a
// one-sentence summary, its fields with the template holes named ("name
// from Extract"), the approval it runs under (ADR 0002), the branches of a
// condition and the Steps it guards set in under it. The Workflows page and
// the composer's Workflow card both draw from here; an edit's diff marks
// new, changed and removed Steps, and one Run's Step results lay over the
// cards. Every word is a strings.workflows.flow.* Setting (ADR 0004).

import type {
  RunView,
  Settings,
  Step,
  Trigger,
  WorkflowDiff,
  WorkflowSketch,
} from "@monday/shared";
import { describeCron, stepTier, TOOL_TIERS } from "@monday/shared";
import type { FlowCardModel, FlowField, FlowRunStatus, FlowText, FlowTierKind } from "@monday/ui";
import { fill } from "../inbox/triage.ts";

type FlowKey = Extract<keyof Settings, `strings.workflows.flow.${string}`>;
export type FlowStrings = Pick<Settings, FlowKey>;

const FLOW_PREFIX = "strings.workflows.flow.";

/** The flow's words out of Settings. */
export function flowStrings(settings: Settings): FlowStrings {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    if (key.startsWith(FLOW_PREFIX)) out[key] = value;
  }
  return out as FlowStrings;
}

export interface FlowOptions {
  /** Group ids to names: "Hiring › Candidates". */
  groupName?: ((id: string) => string) | undefined;
  /** What an edit changes; the cards carry New and Changed, and removed Steps come back apart. */
  diff?: WorkflowDiff | null | undefined;
  /** One Run whose Step results lay over the cards. */
  run?: RunView | null | undefined;
}

export interface FlowModel {
  cards: FlowCardModel[];
  /** The Steps an edit takes out, as cards marked Removed. */
  removed: FlowCardModel[];
}

/* ------------------------------ Templates ------------------------------ */

const HOLE = /\{\{\s*([^}]+?)\s*\}\}/g;

/** A template as text and named holes. */
export function templateText(
  template: string,
  s: FlowStrings,
  stepName: (id: string) => string,
): FlowText {
  const out: Array<string | { hole: string }> = [];
  let at = 0;
  for (const m of template.matchAll(HOLE)) {
    const index = m.index ?? 0;
    if (index > at) out.push(template.slice(at, index));
    out.push({ hole: holeName(m[1] ?? "", s, stepName) });
    at = index + m[0].length;
  }
  if (at < template.length) out.push(template.slice(at));
  return out;
}

function holeName(path: string, s: FlowStrings, stepName: (id: string) => string): string {
  if (path === "thread.subject") return s["strings.workflows.flow.hole.subject"];
  if (path === "thread.from") return s["strings.workflows.flow.hole.from"];
  const step = /^steps\.([a-z0-9_]+)\.(.+)$/.exec(path);
  if (step) {
    return fill(s["strings.workflows.flow.hole.step"], {
      field: step[2] ?? "",
      step: stepName(step[1] ?? ""),
    });
  }
  return path;
}

/** A worded text as one plain line, holes in their names. */
export function plain(text: FlowText): string {
  return text.map((p) => (typeof p === "string" ? p : p.hole)).join("");
}

/* ------------------------------ The trigger ------------------------------ */

function triggerCard(trigger: Trigger, s: FlowStrings, options: FlowOptions): FlowCardModel {
  const group = (id: string) => options.groupName?.(id) ?? id;
  const base = {
    key: "trigger",
    tone: "trig" as const,
    eyebrow: s["strings.workflows.flow.when"],
    depth: 0,
  };
  switch (trigger.kind) {
    case "arrival": {
      const p = trigger.predicate ?? {};
      const who = [...(p.senders ?? []), ...(p.domains ?? [])];
      const facts: string[] = [];
      // The sender goes in the title when no Group does; otherwise it is one more condition.
      const title = trigger.group
        ? fill(s["strings.workflows.flow.trigger.arrival_in"], { group: group(trigger.group) })
        : who.length
          ? fill(s["strings.workflows.flow.trigger.arrival_from"], { who: who.join(", ") })
          : s["strings.workflows.flow.trigger.arrival"];
      if (trigger.group && who.length)
        facts.push(`${s["strings.workflows.flow.fact.from"]} ${who.join(", ")}`);
      if (p.subjectPatterns?.length)
        facts.push(`${s["strings.workflows.flow.fact.subject"]} ${p.subjectPatterns.join(", ")}`);
      if (p.listIds?.length)
        facts.push(`${s["strings.workflows.flow.fact.list"]} ${p.listIds.join(", ")}`);
      for (const [name, value] of Object.entries(p.headers ?? {}))
        facts.push(`${s["strings.workflows.flow.fact.header"]} ${name}: ${value}`);
      if (p.hasAttachment) facts.push(s["strings.workflows.flow.fact.attachment"]);
      const judge = trigger.judge
        ? [
            fill(s["strings.workflows.flow.judge"], { statement: trigger.judge.statement }) +
              (trigger.judge.threshold === undefined
                ? ""
                : `, ${fill(s["strings.workflows.flow.threshold"], {
                    pct: Math.round(trigger.judge.threshold * 100),
                  })}`),
          ]
        : [];
      return { ...base, icon: "envelope", title, facts: [...facts, ...judge] };
    }
    case "schedule":
      return {
        ...base,
        icon: "calendar",
        title: fill(s["strings.workflows.flow.trigger.schedule"], {
          when: describeCron(trigger.cron),
        }),
        facts: [`${s["strings.workflows.flow.fact.cron"]} ${trigger.cron}`],
      };
    case "manual":
      return { ...base, icon: "hand", title: s["strings.workflows.flow.trigger.manual"] };
    case "silence":
      return {
        ...base,
        icon: "timer",
        title: trigger.group
          ? fill(s["strings.workflows.flow.trigger.silence_in"], {
              days: trigger.days,
              group: group(trigger.group),
            })
          : fill(s["strings.workflows.flow.trigger.silence"], { days: trigger.days }),
      };
    case "thread_event":
      return {
        ...base,
        icon: "tag",
        title: fill(s["strings.workflows.flow.trigger.event"], { event: trigger.event }),
        facts: trigger.value
          ? [
              `${s["strings.workflows.flow.fact.value"]} ${
                trigger.event === "moved" ? group(trigger.value) : trigger.value
              }`,
            ]
          : [],
      };
  }
}

/* ------------------------------ Steps ------------------------------ */

const STEP_ICON: Record<Step["kind"], string> = {
  tag: "tag",
  move: "folder",
  archive: "archive",
  snooze: "clock",
  draft_reply: "note",
  send: "send",
  notify: "bell",
  wait: "timer",
  condition: "branch",
  slack: "slack",
  notion: "notion",
  drive: "drive",
  discord: "discord",
  webhook: "webhook",
  mcp: "plug",
  agentic: "brain",
};

/** The approval a Step runs under: what leaves the mailbox asks, unless the user granted a Standing approval. */
function tierOfStep(step: Step, standing: readonly string[]): FlowTierKind | null {
  if (step.kind === "condition") return null;
  if (step.kind === "agentic") {
    // An agent Step asks exactly where its tools do; no allowlist means every tool.
    const tiers = step.tools.length
      ? step.tools.map((t) => TOOL_TIERS[t] ?? "leaves_mailbox")
      : ["leaves_mailbox"];
    const asks = tiers.some((t) => t === "leaves_mailbox" || t === "destructive");
    if (asks) return standing.includes(step.id) ? "standing" : "ask";
    return tiers.includes("reversible") ? "undo" : "read";
  }
  const tier = stepTier(step.kind);
  if (tier === "always-ask") return standing.includes(step.id) ? "standing" : "ask";
  return tier === "reversible" ? "undo" : "read";
}

const TIER_KEY: Record<FlowTierKind, FlowKey> = {
  ask: "strings.workflows.flow.tier.ask",
  undo: "strings.workflows.flow.tier.undo",
  read: "strings.workflows.flow.tier.read",
  standing: "strings.workflows.flow.tier.standing",
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

interface StepWords {
  summary: string;
  fields: FlowField[];
}

function stepWords(
  step: Step,
  s: FlowStrings,
  stepName: (id: string) => string,
  groupName: (id: string) => string,
): StepWords {
  const t = (template: string) => templateText(template, s, stepName);
  const text = (label: FlowKey, template: string | undefined): FlowField[] =>
    template ? [{ label: s[label], text: t(template) }] : [];
  switch (step.kind) {
    case "tag": {
      const add = step.add.join(", ");
      const remove = step.remove.join(", ");
      const key: FlowKey =
        add && remove
          ? "strings.workflows.flow.summary.tag_both"
          : remove
            ? "strings.workflows.flow.summary.tag_remove"
            : "strings.workflows.flow.summary.tag_add";
      return { summary: fill(s[key], { add, remove }), fields: [] };
    }
    case "move":
      return {
        summary: step.group
          ? fill(s["strings.workflows.flow.summary.move"], { group: groupName(step.group) })
          : s["strings.workflows.flow.summary.move_out"],
        fields: [],
      };
    case "archive":
      return { summary: s["strings.workflows.flow.summary.archive"], fields: [] };
    case "snooze":
      return {
        summary: fill(s["strings.workflows.flow.summary.snooze"], { hours: step.hours }),
        fields: [],
      };
    case "draft_reply":
      return {
        summary: step.template
          ? s["strings.workflows.flow.summary.draft_template"]
          : s["strings.workflows.flow.summary.draft_voice"],
        fields: [
          ...text("strings.workflows.flow.arg.template", step.template),
          ...(step.instructions
            ? [
                {
                  label: s["strings.workflows.flow.arg.instructions"],
                  text: [step.instructions],
                  quote: true,
                },
              ]
            : []),
        ],
      };
    case "send":
      return {
        summary: fill(s["strings.workflows.flow.summary.send"], { step: stepName(step.draftFrom) }),
        fields: [],
      };
    case "notify":
      return {
        summary: s["strings.workflows.flow.summary.notify"],
        fields: text("strings.workflows.flow.arg.text", step.text),
      };
    case "wait":
      return {
        summary: fill(s["strings.workflows.flow.summary.wait"], { hours: step.hours }),
        fields: [],
      };
    case "condition":
      return {
        summary: fill(s["strings.workflows.flow.summary.condition"], {
          test: conditionTest(step, s, stepName),
        }),
        fields: [],
      };
    case "slack":
    case "discord":
      return {
        summary: fill(s[`strings.workflows.flow.summary.${step.kind}`], { channel: step.channel }),
        fields: text("strings.workflows.flow.arg.text", step.text),
      };
    case "notion":
      return {
        summary: fill(s["strings.workflows.flow.summary.notion"], { database: step.database }),
        fields: Object.entries(step.properties).map(([label, value]) => ({
          label,
          text: t(value),
        })),
      };
    case "drive":
      return {
        summary: fill(s["strings.workflows.flow.summary.drive"], { folder: step.folder }),
        fields: text("strings.workflows.flow.arg.file_name", step.fileName),
      };
    case "webhook":
      return {
        summary: fill(s["strings.workflows.flow.summary.webhook"], {
          method: step.method,
          host: hostOf(step.url),
        }),
        fields: Object.entries(step.body).map(([label, value]) => ({ label, text: t(value) })),
      };
    case "mcp":
      return {
        summary: fill(s["strings.workflows.flow.summary.mcp"], {
          tool: step.tool,
          server: step.server,
        }),
        fields: Object.entries(step.args).map(([label, value]) => ({
          label,
          text: [typeof value === "string" ? value : JSON.stringify(value)],
        })),
      };
    case "agentic": {
      const budget = [
        step.budget.calls
          ? fill(s["strings.workflows.flow.budget.calls"], { n: step.budget.calls })
          : null,
        step.budget.tokens
          ? fill(s["strings.workflows.flow.budget.tokens"], { n: step.budget.tokens })
          : null,
        step.budget.minutes
          ? fill(s["strings.workflows.flow.budget.minutes"], { n: step.budget.minutes })
          : null,
      ].filter((b): b is string => b !== null);
      return {
        summary: s["strings.workflows.flow.summary.agentic"],
        fields: [
          {
            label: s["strings.workflows.flow.arg.instructions"],
            text: t(step.prompt),
            quote: true,
          },
          {
            label: s["strings.workflows.flow.arg.tools"],
            chips: step.tools.length ? step.tools : [s["strings.workflows.flow.tools_all"]],
          },
          ...(step.outputs.length
            ? [{ label: s["strings.workflows.flow.arg.outputs"], chips: step.outputs }]
            : []),
          ...(budget.length
            ? [{ label: s["strings.workflows.flow.arg.budget"], text: [budget.join(", ")] }]
            : []),
        ],
      };
    }
  }
}

function conditionTest(
  step: Extract<Step, { kind: "condition" }>,
  s: FlowStrings,
  stepName: (id: string) => string,
): string {
  const w = step.when;
  if (w.op === "judged") {
    const base = fill(s["strings.workflows.flow.op.judged"], { statement: w.statement ?? "" });
    return w.threshold === undefined
      ? base
      : `${base}, ${fill(s["strings.workflows.flow.threshold"], { pct: Math.round(w.threshold * 100) })}`;
  }
  return fill(s[`strings.workflows.flow.op.${w.op}`], {
    left: plain(templateText(w.left, s, stepName)),
    value: w.value === undefined ? "" : `"${w.value}"`,
  });
}

const RUN_KEY: Record<FlowRunStatus, FlowKey> = {
  done: "strings.workflows.flow.run.done",
  failed: "strings.workflows.flow.run.failed",
  waiting: "strings.workflows.flow.run.waiting",
  skipped: "strings.workflows.flow.run.skipped",
  running: "strings.workflows.flow.run.running",
  not_reached: "strings.workflows.flow.run.not_reached",
};

/* ------------------------------ The flow ------------------------------ */

/** The document as the cards of its flow. */
export function flowModel(
  doc: WorkflowSketch,
  s: FlowStrings,
  options: FlowOptions = {},
): FlowModel {
  const names = new Map(doc.steps.map((st) => [st.id, st.name]));
  const previousNames = new Map((options.diff?.removed ?? []).map((st) => [st.id, st.name]));
  const stepName = (id: string) => names.get(id) ?? previousNames.get(id) ?? id;
  const groupName = (id: string) => options.groupName?.(id) ?? id;
  const changeOf = new Map((options.diff?.steps ?? []).map((c) => [c.id, c.change]));
  const run = options.run ?? null;
  const results = new Map((run?.steps ?? []).map((r) => [r.stepId, r]));
  // A Run's Step results are keyed by Step id; by position for a result whose id the document lacks.
  const byIndex = new Map((run?.steps ?? []).map((r) => [r.index, r]));
  const runFinished = run !== null && (run.status === "done" || run.status === "failed");

  const trigger = triggerCard(doc.trigger, s, options);
  if (options.diff?.trigger === "changed") {
    trigger.change = { kind: "changed", label: s["strings.workflows.flow.change.changed"] };
  }
  const cards: FlowCardModel[] = [trigger];

  let base = 0;
  let pending: number | null = null;
  doc.steps.forEach((step, index) => {
    const depth = pending ?? base;
    pending = null;
    const words = stepWords(step, s, stepName, groupName);
    const tier = tierOfStep(step, doc.standingApprovals);
    const card: FlowCardModel = {
      key: step.id,
      tone: step.kind === "condition" ? "cond" : "step",
      icon: STEP_ICON[step.kind],
      eyebrow: `${fill(s["strings.workflows.flow.step"], { n: index + 1 })} · ${
        s[`strings.workflows.flow.kind.${step.kind}`]
      }`,
      title: step.name,
      summary: words.summary,
      fields: words.fields,
      tier: tier ? { kind: tier, label: s[TIER_KEY[tier]] } : undefined,
      note: step.onFailure ? s[`strings.workflows.flow.on_failure.${step.onFailure}`] : undefined,
      depth,
    };
    if (step.kind === "condition") {
      const next = doc.steps[index + 1];
      const stop = step.otherwise === "stop";
      card.branches = {
        yes: s["strings.workflows.flow.branch.yes"],
        no: stop
          ? s["strings.workflows.flow.branch.no_stop"]
          : fill(s["strings.workflows.flow.branch.no_skip"], { step: next?.name ?? "" }),
        noKind: stop ? "stop" : "skip",
      };
      if (stop) base = depth + 1;
      else pending = depth + 1;
    }
    const change = changeOf.get(step.id);
    if (change === "added" || change === "changed") {
      card.change = { kind: change, label: s[`strings.workflows.flow.change.${change}`] };
    }
    if (run) {
      const at = byIndex.get(index);
      const result = results.get(step.id) ?? (at && !names.has(at.stepId) ? at : undefined);
      const status: FlowRunStatus | null = result
        ? result.status
        : runFinished || run.status === "paused"
          ? "not_reached"
          : null;
      if (status) {
        card.run = {
          status,
          label: s[RUN_KEY[status]],
          detail: result?.detail || undefined,
        };
      }
    }
    cards.push(card);
  });

  const removed: FlowCardModel[] = (options.diff?.removed ?? []).map((step) => {
    const words = stepWords(step, s, stepName, groupName);
    return {
      key: `removed:${step.id}`,
      tone: step.kind === "condition" ? "cond" : "step",
      icon: STEP_ICON[step.kind],
      eyebrow: s[`strings.workflows.flow.kind.${step.kind}`],
      title: step.name,
      summary: words.summary,
      depth: 0,
      change: { kind: "removed", label: s["strings.workflows.flow.change.removed"] },
    };
  });
  return { cards, removed };
}

/** "1 new, 2 changed, 0 removed", or that the Steps stay the same. */
export function diffLine(diff: WorkflowDiff, s: FlowStrings): string {
  const added = diff.steps.filter((c) => c.change === "added").length;
  const changed = diff.steps.filter((c) => c.change === "changed").length;
  const removed = diff.removed.length;
  if (added + changed + removed === 0) return s["strings.workflows.flow.diff_none"];
  return fill(s["strings.workflows.flow.diff"], { added, changed, removed });
}
