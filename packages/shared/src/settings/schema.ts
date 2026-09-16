// The settings schema: the single source for the Settings screens, the Agent's
// settings tool and the Config file validator (ADR 0001, ADR 0004).
//
// Every product behavior is a Setting with a default here, never a constant.
// Keys are dotted and snake_case so they map one to one onto monday.toml
// tables and keys ("appearance.font_size" is `font_size` under `[appearance]`).
//
// Runtime-neutral: zod only, no Bun, no DOM, no Node.

import { z } from "zod";
import type { Density, HostedProvider, Layout, Role, Task, ThemeMode } from "../domain.ts";

/* ------------------------------ Entry shape ------------------------------ */

/** Where a Setting is stored: shared across every Device, or per Device (ADR 0001). */
export type SettingScope = "global" | "device";

/** The eight sections of the Settings screen (docs/spec/settings.md). */
export type SettingSection =
  | "accounts"
  | "appearance"
  | "routing"
  | "ai"
  | "workflows"
  | "server"
  | "shortcuts"
  | "about";

export const SETTING_SECTIONS: readonly SettingSection[] = [
  "accounts",
  "appearance",
  "routing",
  "ai",
  "workflows",
  "server",
  "shortcuts",
  "about",
];

export interface SettingEntry<T extends z.ZodType = z.ZodType> {
  /** The value's shape, range and options. The screens render from this. */
  type: T;
  /** The shipped default. Onboarding may seed a different one per user. */
  default: z.output<T>;
  scope: SettingScope;
  section: SettingSection;
  /** Short control label. */
  label: string;
  /** One or two sentences shown under the control. */
  help: string;
}

function setting<T extends z.ZodType>(entry: SettingEntry<T>): SettingEntry<T> {
  return entry;
}

/* ------------------------------ Value types ------------------------------ */

const themeMode = z.enum(["system", "light", "dark"]) satisfies z.ZodType<ThemeMode>;
const density = z.enum(["compact", "comfortable", "spacious"]) satisfies z.ZodType<Density>;
const navKnob = z.enum(["full", "rail", "hidden"]);
const agentKnob = z.enum(["bottom", "left", "right"]);
const listKnob = z.enum(["stream", "split"]);
const layoutPreset = z.enum(["stream", "columns", "agent-left", "custom"]);
const layoutShape = z.object({
  nav: navKnob,
  agent: agentKnob,
  list: listKnob,
}) satisfies z.ZodType<Layout>;

export const viewShape = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  shortcut: z.string().nullable(),
  layout: layoutShape,
});
export type ViewSetting = z.output<typeof viewShape>;

const rowField = z.enum([
  "dot",
  "sender",
  "subject",
  "snippet",
  "snippet2",
  "group",
  "attachment",
  "time",
]);
const rowFields = z.object({ stream: z.array(rowField), split: z.array(rowField) });
const rowsByDensity = z.object({ compact: rowFields, comfortable: rowFields, spacious: rowFields });

const snoozePreset = z.enum(["later-today", "tomorrow-morning", "next-week", "pick-a-time"]);

const confidence = z.number().min(0).max(1);

const briefPolicyDefault =
  "Needs your reply and Waiting on you always; For your information only with two or more messages, an attachment, or more than 800 words; Newsletters and automated senders never. Anything else is computed on open.";

const runtimeMode = z.enum(["local", "hosted"]);
const localCli = z.enum(["claude-code", "codex", "opencode"]);
const hostedProvider = z.enum([
  "anthropic",
  "gemini",
  "openai",
  "kimi",
  "openrouter",
]) satisfies z.ZodType<HostedProvider>;
export const HOSTED_PROVIDERS = hostedProvider.options;

const role = z.enum(["main", "fast"]) satisfies z.ZodType<Role>;
const roles = z.object({ main: z.string().min(1), fast: z.string().min(1) });
const effort = z.enum(["low", "medium", "high"]);
export type Effort = z.output<typeof effort>;
/** A Task's model choice: a Role, an optional exact model that beats the Role, and effort. */
const taskModel = z.object({ role, model: z.string(), effort });
export type TaskModel = z.output<typeof taskModel>;

export const TASKS: readonly Task[] = [
  "composer",
  "agentic-step",
  "brief",
  "classify",
  "route",
  "section",
  "tag",
  "draft-in-voice",
  "summarize",
];

const reevaluatePolicy = z.enum(["manual", "on-rule-change", "on-correction", "always"]);
const placement = z.enum(["server", "local"]);
const keymap = z.enum(["vim", "gmail", "natural"]);
const direction = z.enum(["next", "previous"]);
const colorOverrides = z.record(z.string(), z.string());
const bindings = z.record(z.string(), z.string());
const sectionOrder = z.array(z.string().min(1));

function str(section: SettingSection, label: string, value: string) {
  return setting({
    type: z.string(),
    default: value,
    scope: "global",
    section,
    label,
    help: "A user-visible string. The Agent can change the wording on request.",
  });
}

function aiRoles(provider: HostedProvider, main: string, fast: string) {
  return setting({
    type: roles,
    default: { main, fast },
    scope: "global",
    section: "ai",
    label: `${provider} Roles`,
    help: `The models the main and fast Roles resolve to on ${provider}. A Task may name an exact model instead.`,
  });
}

function aiTask(task: Task, r: Role, e: Effort) {
  return setting({
    type: taskModel,
    default: { role: r, model: "", effort: e },
    scope: "global",
    section: "ai",
    label: `${task} model`,
    help: `Which Role the ${task} Task uses, an optional exact model that overrides the Role, and the effort level. An empty model means use the Role.`,
  });
}

/* ------------------------------ The schema ------------------------------ */

export const settingsSchema = {
  /* Appearance */
  "appearance.mode": setting({
    type: themeMode,
    default: "system",
    scope: "global",
    section: "appearance",
    label: "Mode",
    help: "Light, dark, or follow the system.",
  }),
  "appearance.palette": setting({
    type: z.string().min(1),
    default: "graphite",
    scope: "global",
    section: "appearance",
    label: "Palette",
    help: "One of the shipped palettes, or a path to a palette file (token TOML or base16 YAML).",
  }),
  "appearance.overrides": setting({
    type: colorOverrides,
    default: {},
    scope: "global",
    section: "appearance",
    label: "Token overrides",
    help: "Color tokens that replace the palette's, by token name, for example accent or bg.",
  }),
  "appearance.font": setting({
    type: z.string().min(1),
    default: "Geist Variable",
    scope: "global",
    section: "appearance",
    label: "Font",
    help: "The interface font family.",
  }),
  "appearance.font_size": setting({
    type: z.int().min(10).max(24),
    default: 14,
    scope: "device",
    section: "appearance",
    label: "Font size",
    help: "Base text size in pixels. Per device.",
  }),
  "appearance.monospace": setting({
    type: z.string().min(1),
    default: "Geist Mono Variable",
    scope: "global",
    section: "appearance",
    label: "Monospace font",
    help: "The font for code, the Config file view and raw source.",
  }),
  "appearance.density": setting({
    type: density,
    default: "comfortable",
    scope: "device",
    section: "appearance",
    label: "Density",
    help: "The scale of text, icons and rows. Per device.",
  }),

  /* Layout */
  "layout.preset": setting({
    type: layoutPreset,
    default: "stream",
    scope: "global",
    section: "appearance",
    label: "Layout preset",
    help: "A built-in named Layout. Derived from the three knobs; custom when they match no preset.",
  }),
  "layout.nav": setting({
    type: navKnob,
    default: "full",
    scope: "global",
    section: "appearance",
    label: "Nav",
    help: "Full sidebar, a narrow rail, or hidden.",
  }),
  "layout.agent": setting({
    type: agentKnob,
    default: "bottom",
    scope: "global",
    section: "appearance",
    label: "Agent",
    help: "Where the Agent composer sits: a bottom bar, a left column or a right column.",
  }),
  "layout.list": setting({
    type: listKnob,
    default: "stream",
    scope: "global",
    section: "appearance",
    label: "List",
    help: "One stream with the reader as a sheet, or a split list and reader.",
  }),

  /* Views */
  "views.list": setting({
    type: z.array(viewShape),
    default: [],
    scope: "global",
    section: "appearance",
    label: "Views",
    help: "Saved Layouts with a shortcut, shared across Workspaces. In monday.toml a View is a [views.<name>] table of knobs.",
  }),

  /* Inbox rows and actions */
  "inbox.rows": setting({
    type: rowsByDensity,
    default: {
      compact: {
        stream: ["dot", "sender", "subject", "snippet", "group", "attachment", "time"],
        split: ["dot", "sender", "time", "subject"],
      },
      comfortable: {
        stream: ["dot", "sender", "subject", "snippet", "group", "attachment", "time"],
        split: ["dot", "sender", "time", "subject", "snippet"],
      },
      spacious: {
        stream: ["dot", "sender", "subject", "snippet", "snippet2", "group", "attachment", "time"],
        split: ["dot", "sender", "time", "subject", "snippet", "snippet2"],
      },
    },
    scope: "global",
    section: "appearance",
    label: "Row fields",
    help: "Which fields a Thread row shows, per density and per list knob.",
  }),
  "inbox.after_action.direction": setting({
    type: direction,
    default: "next",
    scope: "global",
    section: "shortcuts",
    label: "After archive, snooze or delete",
    help: "Which Thread the selection moves to after an action.",
  }),
  "inbox.after_action.open_next": setting({
    type: z.boolean(),
    default: true,
    scope: "global",
    section: "shortcuts",
    label: "Open the next Thread",
    help: "In the reader sheet, open the next Thread after an action instead of closing.",
  }),
  "inbox.snooze_presets": setting({
    type: z.array(snoozePreset),
    default: ["later-today", "tomorrow-morning", "next-week", "pick-a-time"],
    scope: "global",
    section: "appearance",
    label: "Snooze presets",
    help: "The choices the snooze picker offers, in order.",
  }),
  "inbox.batch_preview_above": setting({
    type: z.int().min(0),
    default: 10,
    scope: "global",
    section: "ai",
    label: "Preview batches above",
    help: "A batch action on more Threads than this shows the list first with one Apply (ADR 0002).",
  }),
  "inbox.snooze.later_today_hours": setting({
    type: z.int().min(1).max(12),
    default: 3,
    scope: "global",
    section: "appearance",
    label: "Later today",
    help: "How many hours from now the later today preset snoozes to, rounded up to the hour.",
  }),
  "inbox.snooze.morning_hour": setting({
    type: z.int().min(0).max(23),
    default: 8,
    scope: "global",
    section: "appearance",
    label: "Morning hour",
    help: "The hour tomorrow morning and next week wake a snoozed Thread.",
  }),
  "inbox.snooze.week_start": setting({
    type: z.int().min(0).max(6),
    default: 1,
    scope: "global",
    section: "appearance",
    label: "Week starts on",
    help: "The weekday the next week preset targets, 0 for Sunday through 6 for Saturday.",
  }),
  "inbox.row_collapse_ms": setting({
    type: z.int().min(0).max(1000),
    default: 180,
    scope: "device",
    section: "appearance",
    label: "Row collapse",
    help: "Milliseconds a row takes to collapse after archive, snooze or delete. Reduced motion skips it. Per device.",
  }),
  "inbox.undo_toast_ms": setting({
    type: z.int().min(1000),
    default: 8000,
    scope: "global",
    section: "appearance",
    label: "Undo toast",
    help: "Milliseconds an undo toast stays before it fades.",
  }),

  /* Sections */
  "sections.order": setting({
    type: sectionOrder,
    default: ["needs-reply", "waiting", "fyi", "newsletters"],
    scope: "global",
    section: "routing",
    label: "Section order",
    help: "Section ids in the order they appear in the stream. An empty Section is not rendered.",
  }),

  /* Routing */
  "routing.threshold.route": setting({
    type: confidence,
    default: 0.8,
    scope: "global",
    section: "routing",
    label: "Route threshold",
    help: "At or above this Confidence a Thread is placed in the Group. A Group may override it.",
  }),
  "routing.threshold.ask": setting({
    type: confidence,
    default: 0.5,
    scope: "global",
    section: "routing",
    label: "Ask band",
    help: "From this Confidence up to the route threshold a Thread goes to Needs a decision. Below, it is left alone.",
  }),
  "routing.threshold.tie_margin": setting({
    type: confidence,
    default: 0.1,
    scope: "global",
    section: "routing",
    label: "Tie margin",
    help: "Two rules within this Confidence of each other count as a tie and go to Needs a decision.",
  }),
  "routing.decisions.cap": setting({
    type: z.int().min(1),
    default: 20,
    scope: "global",
    section: "routing",
    label: "Needs a decision cap",
    help: "The most Threads held in Needs a decision at once. Older ones are left alone.",
  }),
  "routing.reevaluate": setting({
    type: reevaluatePolicy,
    default: "on-rule-change",
    scope: "global",
    section: "routing",
    label: "Re-evaluate",
    help: "When already-routed Threads are routed again: only by hand, when a rule changes, after each correction, or on every sync.",
  }),
  "routing.lookback_days": setting({
    type: z.int().min(0),
    default: 90,
    scope: "global",
    section: "routing",
    label: "Lookback",
    help: "How many days of existing mail a rule change or re-run considers.",
  }),
  "routing.learn_from_corrections": setting({
    type: z.boolean(),
    default: true,
    scope: "global",
    section: "routing",
    label: "Learn from corrections",
    help: "A correction becomes an Example for the rule and may extend its Predicate.",
  }),

  /* Briefs */
  "briefs.policy": setting({
    type: z.string().min(1),
    default: briefPolicyDefault,
    scope: "global",
    section: "routing",
    label: "Brief policy",
    help: "The rule sentence that decides which Threads get a Brief in the background. Same shape as a Section rule.",
  }),
  "briefs.prompt": setting({
    type: z.string(),
    default: "",
    scope: "global",
    section: "routing",
    label: "Custom Brief prompt",
    help: "Optional. Lets the model judge importance itself instead of the policy sentence. Empty means off.",
  }),
  "briefs.bullets_max": setting({
    type: z.int().min(1).max(5),
    default: 3,
    scope: "global",
    section: "routing",
    label: "Bullets",
    help: "The most bullets a Brief may have.",
  }),
  "briefs.actions_max": setting({
    type: z.int().min(0).max(5),
    default: 3,
    scope: "global",
    section: "routing",
    label: "Action chips",
    help: "The most action chips a Brief may show.",
  }),
  "briefs.background": setting({
    type: z.boolean(),
    default: true,
    scope: "global",
    section: "routing",
    label: "Compute in the background",
    help: "Compute Briefs under the policy before a Thread is opened. Needs a Hosted runtime; otherwise every Brief is computed on open.",
  }),
  "briefs.skip_under_words": setting({
    type: z.int().min(0),
    default: 120,
    scope: "global",
    section: "routing",
    label: "Skip short Threads",
    help: "A Thread with one Message under this many words gets no Brief.",
  }),

  /* Sync (docs/spec/slices.md, slice 5) */
  "sync.body_window_days": setting({
    type: z.int().min(0),
    default: 90,
    scope: "global",
    section: "accounts",
    label: "Body window",
    help: "Bodies and attachments are fetched for Messages newer than this many days during sync; older ones on open.",
  }),
  "sync.reconcile_minutes": setting({
    type: z.int().min(1),
    default: 5,
    scope: "global",
    section: "accounts",
    label: "Reconcile interval",
    help: "Minutes between full incremental passes over every folder. Push notifications are lossy; this catches what they miss.",
  }),
  "sync.hot_folders": setting({
    type: z.int().min(1).max(10),
    default: 3,
    scope: "global",
    section: "accounts",
    label: "Watched folders",
    help: "How many folders an IMAP Account keeps a live IDLE connection on, Inbox first. Each one costs a connection.",
  }),
  "sync.batch_size": setting({
    type: z.int().min(10).max(1000),
    default: 200,
    scope: "global",
    section: "accounts",
    label: "Sync batch",
    help: "Messages fetched per step during the first sync. Larger is faster; smaller shows progress sooner.",
  }),

  /* Send */
  "send.delay_seconds": setting({
    type: z.int().min(0).max(600),
    default: 30,
    scope: "global",
    section: "accounts",
    label: "Undo send window",
    help: "Seconds a send Job waits before it runs. Zero sends at once (ADR 0010).",
  }),
  "send.reply_all_default": setting({
    type: z.boolean(),
    default: false,
    scope: "global",
    section: "accounts",
    label: "Reply all by default",
    help: "Reply answers everyone on the Thread instead of the sender only.",
  }),

  /* Search and Cache */
  "search.cache_window_days": setting({
    type: z.int().min(1),
    default: 730,
    scope: "device",
    section: "server",
    label: "Pre-warm window",
    help: "How many days of bodies the Cache pre-warms, newest first, within the size cap (ADR 0011). Per device.",
  }),
  "search.cache_cap_gb": setting({
    type: z.number().min(0.1),
    default: 2,
    scope: "device",
    section: "server",
    label: "Cache size cap",
    help: "The most the Cache may hold, in gigabytes. Per device.",
  }),
  "search.prewarm_on_metered": setting({
    type: z.boolean(),
    default: false,
    scope: "device",
    section: "server",
    label: "Pre-warm on metered networks",
    help: "Fetch bodies for the Cache while on a metered connection. Per device.",
  }),
  "search.prewarm_on_battery": setting({
    type: z.boolean(),
    default: false,
    scope: "device",
    section: "server",
    label: "Pre-warm on battery",
    help: "Fetch bodies for the Cache while not on mains power. Per device.",
  }),
  "search.all_accounts": setting({
    type: z.boolean(),
    default: false,
    scope: "global",
    section: "appearance",
    label: "Search all accounts",
    help: "Search every Workspace instead of the current one. The only cross-Workspace read.",
  }),
  "search.results_limit": setting({
    type: z.int().min(1).max(500),
    default: 50,
    scope: "global",
    section: "appearance",
    label: "Results per search",
    help: "The most Threads one search shows. Results are ranked, so the best come first.",
  }),
  "search.recency_boost_days": setting({
    type: z.int().min(1),
    default: 30,
    scope: "global",
    section: "appearance",
    label: "Recency boost",
    help: "How many days of activity count as recent when ranking results. Newer Threads rank above older ones with the same match.",
  }),
  "search.recent_max": setting({
    type: z.int().min(0).max(50),
    default: 10,
    scope: "device",
    section: "appearance",
    label: "Recent searches",
    help: "How many recent searches the palette remembers. Per device.",
  }),
  "search.prewarm_batch": setting({
    type: z.int().min(1).max(1000),
    default: 200,
    scope: "device",
    section: "server",
    label: "Pre-warm batch",
    help: "Bodies fetched per request while the Cache pre-warms. Per device.",
  }),
  "search.older_batch": setting({
    type: z.int().min(1).max(1000),
    default: 200,
    scope: "device",
    section: "server",
    label: "Search older mail batch",
    help: "Bodies fetched per request when a search reaches past the Cache. Per device.",
  }),

  /* AI and agent */
  "ai.mode": setting({
    type: runtimeMode,
    default: "local",
    scope: "device",
    section: "ai",
    label: "Runtime",
    help: "Local CLI on this machine, or a Hosted provider by API key. Per device.",
  }),
  "ai.local.cli": setting({
    type: localCli,
    default: "claude-code",
    scope: "device",
    section: "ai",
    label: "Local CLI",
    help: "Which installed command-line agent drives the Local runtime. Per device.",
  }),
  "ai.hosted.provider": setting({
    type: hostedProvider,
    default: "anthropic",
    scope: "global",
    section: "ai",
    label: "Hosted provider",
    help: "The provider the Hosted runtime uses.",
  }),
  "ai.roles.anthropic": aiRoles("anthropic", "claude-sonnet-5", "claude-haiku-4-5"),
  "ai.roles.gemini": aiRoles("gemini", "gemini-2.5-pro", "gemini-2.5-flash"),
  "ai.roles.openai": aiRoles("openai", "gpt-5", "gpt-5-mini"),
  "ai.roles.kimi": aiRoles("kimi", "kimi-k2-thinking", "kimi-k2-turbo-preview"),
  "ai.roles.openrouter": aiRoles(
    "openrouter",
    "anthropic/claude-sonnet-5",
    "anthropic/claude-haiku-4.5",
  ),
  "ai.task.composer": aiTask("composer", "main", "high"),
  "ai.task.agentic-step": aiTask("agentic-step", "main", "medium"),
  "ai.task.brief": aiTask("brief", "fast", "low"),
  "ai.task.classify": aiTask("classify", "fast", "low"),
  "ai.task.route": aiTask("route", "fast", "low"),
  "ai.task.section": aiTask("section", "fast", "low"),
  "ai.task.tag": aiTask("tag", "fast", "low"),
  "ai.task.draft-in-voice": aiTask("draft-in-voice", "main", "medium"),
  "ai.task.summarize": aiTask("summarize", "fast", "low"),
  "ai.share_key_with_server": setting({
    type: z.boolean(),
    default: false,
    scope: "global",
    section: "ai",
    label: "Let the server use this key",
    help: "Store the Hosted key under the envelope on the Server so Briefs and Workflows run while every device is off. The Server host can then read it.",
  }),
  "ai.developer_mode_default": setting({
    type: z.boolean(),
    default: false,
    scope: "device",
    section: "ai",
    label: "Developer mode by default",
    help: "Start each Session with the Local runtime's own shell, file and web tools enabled. Mail content is untrusted; keep this off.",
  }),
  "ai.web_fetch": setting({
    type: z.boolean(),
    default: false,
    scope: "global",
    section: "ai",
    label: "Web fetch",
    help: "Let the Agent fetch web pages through a monday tool.",
  }),
  "ai.session.new_after_hours": setting({
    type: z.int().min(1),
    default: 24,
    scope: "global",
    section: "ai",
    label: "New Session after",
    help: "Hours of inactivity after which the composer starts a new Session.",
  }),
  "ai.session.retention_days": setting({
    type: z.int().min(1),
    default: 90,
    scope: "global",
    section: "ai",
    label: "Session retention",
    help: "Days a Session is kept on the Server before it is summarized to one Activity log line.",
  }),
  "ai.suggestions.max": setting({
    type: z.int().min(0).max(8),
    default: 4,
    scope: "global",
    section: "ai",
    label: "Suggestion chips",
    help: "The most suggestion chips shown when a Session is empty.",
  }),

  /* External MCP */
  "external.approval_timeout_minutes": setting({
    type: z.int().min(1),
    default: 5,
    scope: "global",
    section: "ai",
    label: "External approval timeout",
    help: "Minutes an external always-ask call waits for the owner before it returns pending.",
  }),
  "external.rate_per_minute": setting({
    type: z.int().min(1),
    default: 60,
    scope: "global",
    section: "ai",
    label: "External rate limit",
    help: "Calls per minute per external credential.",
  }),
  "external.key_expiry_days": setting({
    type: z.int().min(1),
    default: 90,
    scope: "global",
    section: "ai",
    label: "Key expiry",
    help: "Default lifetime of a new external key in days. Keys always expire.",
  }),
  "external.search_cap": setting({
    type: z.int().min(1),
    default: 50,
    scope: "global",
    section: "ai",
    label: "External search cap",
    help: "The most results one external search call returns.",
  }),

  /* Workflows */
  "workflows.placement": setting({
    type: placement,
    default: "server",
    scope: "global",
    section: "workflows",
    label: "Default Placement",
    help: "Where a new Workflow runs: on the Server with a Hosted runtime, or on a Local runtime while the client is open.",
  }),
  "workflows.ask_before_enable": setting({
    type: z.boolean(),
    default: true,
    scope: "global",
    section: "workflows",
    label: "Ask before enabling",
    help: "Show a Dry run and ask before a new Workflow is enabled.",
  }),
  "workflows.notify_on_failure": setting({
    type: z.boolean(),
    default: true,
    scope: "global",
    section: "workflows",
    label: "Notify on failure",
    help: "Send a desktop notification when a Run fails.",
  }),
  "workflows.run_retention_days": setting({
    type: z.int().min(1),
    default: 30,
    scope: "global",
    section: "workflows",
    label: "Run log retention",
    help: "Days a Run and its log are kept.",
  }),
  "workflows.budget.tool_calls": setting({
    type: z.int().min(1),
    default: 25,
    scope: "global",
    section: "workflows",
    label: "Budget: tool calls",
    help: "Default cap on Tool calls for one agentic Step. Exceeding it fails the Run.",
  }),
  "workflows.budget.minutes": setting({
    type: z.int().min(1),
    default: 10,
    scope: "global",
    section: "workflows",
    label: "Budget: wall time",
    help: "Default cap in minutes for one agentic Step.",
  }),
  "workflows.budget.tokens": setting({
    type: z.int().min(1000),
    default: 200000,
    scope: "global",
    section: "workflows",
    label: "Budget: tokens",
    help: "Default cap on model tokens for one agentic Step.",
  }),

  /* Keyboard */
  "keyboard.keymap": setting({
    type: keymap,
    default: "vim",
    scope: "global",
    section: "shortcuts",
    label: "Keymap",
    help: "The built-in binding set: Vim, Gmail or Natural.",
  }),
  "keyboard.bindings": setting({
    type: bindings,
    default: {},
    scope: "global",
    section: "shortcuts",
    label: "Bindings",
    help: "Per-action overrides of the keymap, action name to key chord.",
  }),

  /* Notifications and calendar */
  "notifications.enabled": setting({
    type: z.boolean(),
    default: true,
    scope: "device",
    section: "accounts",
    label: "Desktop notifications",
    help: "Show desktop notifications on this device.",
  }),
  "notifications.calendar_lead_minutes": setting({
    type: z.int().min(0),
    default: 10,
    scope: "global",
    section: "accounts",
    label: "Event reminder",
    help: "Minutes before an Event to notify.",
  }),
  "calendar.poll_minutes": setting({
    type: z.int().min(1),
    default: 5,
    scope: "global",
    section: "accounts",
    label: "Calendar polling",
    help: "Minutes between calendar polls where the Provider offers no push.",
  }),

  /* Server */
  "server.url": setting({
    type: z.string(),
    default: "",
    scope: "device",
    section: "server",
    label: "Cloud server URL",
    help: "The Cloud server this device pairs with. Empty means Sidecar only. Per device.",
  }),
  "server.insecure_allowed": setting({
    type: z.boolean(),
    default: false,
    scope: "device",
    section: "server",
    label: "Allow plain HTTP",
    help: "Permit an http:// server on a private network. Shows a persistent warning (ADR 0006). Per device.",
  }),
  "server.share_root_key": setting({
    type: z.boolean(),
    default: false,
    scope: "global",
    section: "server",
    label: "Share the root key with the Cloud",
    help: "Let the Cloud server decrypt mail for Briefs and Workflows while every device is off.",
  }),

  /* Strings */
  "strings.inbox.empty": str("routing", "Empty inbox line", "Nothing needs you"),
  "strings.inbox.syncing": str("routing", "Syncing line", "Syncing, {done} of {total}"),
  "strings.inbox.undo": str("routing", "Undo toast button", "Undo"),
  "strings.inbox.toast.archived": str("routing", "Toast: archived", "Archived"),
  "strings.inbox.toast.unarchived": str("routing", "Toast: back in Inbox", "Back in Inbox"),
  "strings.inbox.toast.snoozed": str("routing", "Toast: snoozed", "Snoozed until {when}"),
  "strings.inbox.toast.deleted": str("routing", "Toast: deleted", "Deleted"),
  "strings.inbox.toast.starred": str("routing", "Toast: starred", "Starred"),
  "strings.inbox.toast.unstarred": str("routing", "Toast: unstarred", "Unstarred"),
  "strings.inbox.toast.read": str("routing", "Toast: marked read", "Marked read"),
  "strings.inbox.toast.unread": str("routing", "Toast: marked unread", "Marked unread"),
  "strings.inbox.toast.moved": str("routing", "Toast: moved", "Moved to {group}"),
  "strings.inbox.toast.undone": str("routing", "Toast: undone", "Undone"),
  "strings.inbox.toast.batch": str("routing", "Toast: batch suffix", "{action}, {n} threads"),
  "strings.inbox.selected": str("routing", "Selection count", "{n} selected"),
  "strings.inbox.batch.title": str("routing", "Batch preview heading", "{action} {n} threads?"),
  "strings.inbox.batch.apply": str("routing", "Batch apply button", "Apply"),
  "strings.inbox.batch.cancel": str("routing", "Batch cancel button", "Cancel"),
  "strings.inbox.mark_all_read": str("routing", "Mark all read", "Mark all read"),
  "strings.inbox.more": str("routing", "More menu title", "More"),
  "strings.inbox.filter": str("routing", "Filter button", "Filter"),
  "strings.inbox.title": str("routing", "Inbox title", "Inbox"),
  "strings.inbox.offline": str("routing", "Offline dot title", "Offline"),
  "strings.inbox.snooze.title": str("routing", "Snooze picker heading", "Snooze until"),
  "strings.inbox.snooze.later_today": str("routing", "Snooze: later today", "Later today"),
  "strings.inbox.snooze.tomorrow_morning": str(
    "routing",
    "Snooze: tomorrow morning",
    "Tomorrow morning",
  ),
  "strings.inbox.snooze.next_week": str("routing", "Snooze: next week", "Next week"),
  "strings.inbox.snooze.pick_a_time": str("routing", "Snooze: pick a time", "Pick a time"),
  "strings.inbox.snooze.confirm": str("routing", "Snooze: confirm picked time", "Snooze"),
  "strings.inbox.action.archive": str("routing", "Action: archive", "Archive"),
  "strings.inbox.action.snooze": str("routing", "Action: snooze", "Snooze"),
  "strings.inbox.action.move": str("routing", "Action: move", "Move"),
  "strings.inbox.action.label": str("routing", "Action: label", "Label"),
  "strings.inbox.action.delete": str("routing", "Action: delete", "Delete"),
  "strings.inbox.action.star": str("routing", "Action: star", "Star"),
  "strings.inbox.action.unstar": str("routing", "Action: unstar", "Unstar"),
  "strings.inbox.action.read": str("routing", "Action: mark read", "Mark read"),
  "strings.inbox.action.unread": str("routing", "Action: mark unread", "Mark unread"),
  "strings.inbox.action.ask": str("routing", "Action: ask", "Ask"),
  "strings.inbox.action.close": str("routing", "Action: close", "Close"),
  "strings.inbox.action.compose": str("routing", "Action: new message", "New message"),
  "strings.inbox.move.title": str("routing", "Move picker heading", "Move to"),
  "strings.inbox.move.none": str("routing", "Move: no Group", "No group"),
  "strings.reader.messages": str("routing", "Reader message count", "{n} messages"),
  "strings.reader.message": str("routing", "Reader one message", "1 message"),
  "strings.reader.brief_source": str("routing", "Brief source line", "{runtime}, on this machine"),
  "strings.agent.placeholder": str("ai", "Agent bar placeholder", "Ask or tell monday"),
  "strings.agent.placeholder_open": str(
    "ai",
    "Agent bar placeholder when open",
    "Reply, or ask something else",
  ),
  "strings.section.needs-reply": str("routing", "Section: needs reply", "Needs your reply"),
  "strings.section.waiting": str("routing", "Section: waiting", "Waiting on you"),
  "strings.section.fyi": str("routing", "Section: for your information", "For your information"),
  "strings.section.newsletters": str("routing", "Section: newsletters", "Newsletters"),
  "strings.routing.decisions": str("routing", "Needs a decision heading", "Needs a decision"),
  "strings.agent.offline": str("ai", "Agent offline line", "Offline, hosted work paused"),
  "strings.agent.unavailable": str("ai", "Local runtime unavailable", "{runtime} not available"),
  "strings.agent.ask_about_thread": str("ai", "Ask about this Thread", "About this thread"),
  "strings.agent.developer_warning": str(
    "ai",
    "Developer mode warning",
    "Developer mode gives the runtime its own shell, file and web tools. Mail content is untrusted and could direct them.",
  ),
  "strings.settings.pinned": str("appearance", "Pinned control label", "set in monday.toml"),
  "strings.settings.fix": str("appearance", "Fix config button", "Fix with monday"),
  "strings.send.undo": str("accounts", "Undo send bar", "Sent. Undo?"),
  "strings.search.title": str("appearance", "Search results title", "Search"),
  "strings.search.placeholder": str("appearance", "Palette placeholder", "Search, jump, or ask"),
  "strings.search.empty": str("appearance", "No results line", "Nothing matches"),
  "strings.search.results": str("appearance", "Results count", "{n} results"),
  "strings.search.result": str("appearance", "One result", "1 result"),
  "strings.search.older": str("appearance", "Search older mail line", "Search older mail"),
  "strings.search.older_help": str(
    "appearance",
    "Search older mail help",
    "Older bodies are not in the Cache yet. Fetch them to search inside.",
  ),
  "strings.search.older_pulling": str(
    "appearance",
    "Search older mail progress",
    "Fetching older mail, {done} of {total}",
  ),
  "strings.search.older_locked": str(
    "appearance",
    "Search older mail when locked",
    "The Server is locked; unlock it to fetch older mail.",
  ),
  "strings.search.all_accounts": str("appearance", "All accounts toggle", "All accounts"),
  "strings.search.chip.unread": str("appearance", "Filter chip: unread", "Unread"),
  "strings.search.chip.attachments": str("appearance", "Filter chip: attachments", "Attachments"),
  "strings.search.chip.group": str("appearance", "Filter chip: group", "In a group"),
  "strings.search.recent": str("appearance", "Recent searches heading", "Recent searches"),
  "strings.palette.actions": str("appearance", "Palette section: actions", "Actions"),
  "strings.palette.go": str("appearance", "Palette section: go to", "Go to"),
  "strings.palette.threads": str("appearance", "Palette section: threads", "Recent threads"),
  "strings.palette.results": str("appearance", "Palette section: results", "Results"),
  "strings.palette.ask": str("appearance", "Palette section: ask", "Ask the agent"),
  "strings.palette.ask_item": str("appearance", "Palette ask item", "Ask monday: {text}"),
  "strings.palette.search_item": str("appearance", "Palette search item", "Search for {text}"),
  "strings.palette.workflow_from_thread": str(
    "appearance",
    "Palette: new workflow from this thread",
    "New workflow from this thread",
  ),
  "strings.palette.foot.move": str("appearance", "Palette footer: move", "move"),
  "strings.palette.foot.select": str("appearance", "Palette footer: select", "select"),
  "strings.palette.foot.ask": str("appearance", "Palette footer: ask", "ask instead"),
  "strings.palette.nav.inbox": str("appearance", "Palette: Inbox", "Inbox"),
  "strings.palette.nav.settings": str("appearance", "Palette: Settings", "Settings"),
  "strings.palette.nav.search": str("appearance", "Palette: Search", "Search"),
  "strings.palette.nav.view": str("appearance", "Palette: a saved View", "View: {name}"),
  "strings.palette.nav.settings_page": str("appearance", "Palette: a Settings page", "Settings: {name}"),
  "strings.action.move.down": str("shortcuts", "Action: move down", "Move down"),
  "strings.action.move.up": str("shortcuts", "Action: move up", "Move up"),
  "strings.action.thread.open": str("shortcuts", "Action: open", "Open thread"),
  "strings.action.sheet.close": str("shortcuts", "Action: close", "Close"),
  "strings.action.thread.archive": str("shortcuts", "Action: archive", "Archive"),
  "strings.action.thread.snooze": str("shortcuts", "Action: snooze", "Snooze"),
  "strings.action.thread.star": str("shortcuts", "Action: star", "Star"),
  "strings.action.thread.delete": str("shortcuts", "Action: delete", "Delete"),
  "strings.action.thread.label": str("shortcuts", "Action: label", "Label"),
  "strings.action.thread.move": str("shortcuts", "Action: move to group", "Move to group"),
  "strings.action.compose.reply": str("shortcuts", "Action: reply", "Reply"),
  "strings.action.compose.reply_all": str("shortcuts", "Action: reply all", "Reply all"),
  "strings.action.compose.forward": str("shortcuts", "Action: forward", "Forward"),
  "strings.action.select.toggle": str("shortcuts", "Action: select", "Select"),
  "strings.action.select.extend_down": str("shortcuts", "Action: extend selection down", "Extend selection down"),
  "strings.action.select.extend_up": str("shortcuts", "Action: extend selection up", "Extend selection up"),
  "strings.action.undo": str("shortcuts", "Action: undo", "Undo"),
  "strings.action.agent.focus": str("shortcuts", "Action: talk to the agent", "Ask monday"),
  "strings.action.palette.open": str("shortcuts", "Action: palette", "Command palette"),
  "strings.action.view": str("shortcuts", "Action: switch to a View", "Switch to view {n}"),
  "strings.about.telemetry": str("about", "Telemetry line", "monday sends no telemetry."),
} satisfies Record<string, SettingEntry>;

/* ------------------------------ Derived types and helpers ------------------------------ */

export type SettingsSchema = typeof settingsSchema;
export type SettingKey = keyof SettingsSchema;
/** Every Setting's value type, inferred from the schema. */
export type Settings = { [K in SettingKey]: z.output<SettingsSchema[K]["type"]> };
export type PartialSettings = Partial<Settings>;

export const settingKeys = Object.keys(settingsSchema) as SettingKey[];

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(settingsSchema, key);
}

/** The shipped defaults as a full Settings object. A fresh copy each call. */
export function defaultSettings(): Settings {
  const out: Record<string, unknown> = {};
  for (const key of settingKeys) {
    out[key] = structuredClone(settingsSchema[key].default);
  }
  return out as Settings;
}

export type ValidationResult<K extends SettingKey = SettingKey> =
  | { ok: true; value: Settings[K] }
  | { ok: false; error: string };

/** Validate a candidate value for a key. Unknown keys fail with a message. */
export function validateSetting<K extends SettingKey>(key: K, value: unknown): ValidationResult<K>;
export function validateSetting(key: string, value: unknown): ValidationResult;
export function validateSetting(key: string, value: unknown): ValidationResult {
  if (!isSettingKey(key)) return { ok: false, error: `Unknown setting "${key}"` };
  const result = settingsSchema[key].type.safeParse(value);
  if (result.success) return { ok: true, value: result.data as Settings[SettingKey] };
  return { ok: false, error: describeIssues(result.error) };
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? `${issue.path.map(String).join(".")}: ` : "";
      return `${path}${issue.message}`;
    })
    .join("; ");
}

export function settingScope(key: SettingKey): SettingScope {
  return settingsSchema[key].scope;
}

export function settingSection(key: SettingKey): SettingSection {
  return settingsSchema[key].section;
}

/** Keys shown in one Settings section, in schema order. */
export function keysInSection(section: SettingSection): SettingKey[] {
  return settingKeys.filter((key) => settingsSchema[key].section === section);
}
