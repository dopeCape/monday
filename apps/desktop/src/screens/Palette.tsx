// The command palette container (ADR 0011): builds the catalogues from the
// keymap, the navigation and the recent Threads, runs the local search for
// what is typed, and renders the pure model through the CommandPalette
// component. Every keystroke is answered from memory and the Cache; nothing
// here waits on the network or a model. A sentence that matches no entry is
// also sent, after a pause, to the judge (slice 27, ADR 0012): when its
// reading arrives it becomes the first row, and the list never waited for it.

import {
  type Group,
  gateIntent,
  type IntentGroupOption,
  type IntentSectionOption,
  type Person,
  resolveIntent,
  SETTING_SECTIONS,
  type Settings,
  type Thread,
  type TypedIntent,
} from "@monday/shared";
import {
  type CommandItem,
  CommandPalette,
  type CommandSection,
  type IconComponent,
  MONTH_SHORT,
  WEEKDAY_SHORT,
} from "@monday/ui";
import {
  ArchiveIcon,
  ArrowBendUpLeftIcon,
  ArrowsOutLineVerticalIcon,
  CalendarBlankIcon,
  CaretDownIcon,
  CaretUpIcon,
  CheckSquareIcon,
  ClockIcon,
  CommandIcon,
  EnvelopeOpenIcon,
  FlowArrowIcon,
  FolderIcon,
  GearIcon,
  KeyboardIcon,
  LayoutIcon,
  MagnifyingGlassIcon,
  NotePencilIcon,
  PaperPlaneTiltIcon,
  ShareFatIcon,
  StarIcon,
  TagIcon,
  TrashIcon,
  TrayIcon,
  UsersThreeIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  chordLabel,
  inScope,
  KEY_ACTIONS,
  type KeyAction,
  type Keymap,
  type KeyScope,
} from "../keyboard/keymaps.ts";
import type { SearchHit, SearchModule } from "../search/index.ts";
import {
  type AgentAsk,
  agentHandoff,
  buildPalette,
  isSentence,
  moveActive,
  type PaletteAction,
  type PaletteCommand,
  type PaletteIntent,
  type PaletteNav,
  type PaletteStrings,
  type PaletteSuggestion,
} from "../search/palette.ts";
import { useShell } from "../shell/Shell.tsx";
import { dayKey } from "./calendar/dates.ts";
import { parseJumpDate } from "./calendar/jump.ts";
import type { IntentJudge } from "./inbox/intents.ts";

export type { PaletteCommand } from "../search/palette.ts";

const ICONS: Record<string, IconComponent> = {
  archive: ArchiveIcon,
  snooze: ClockIcon,
  label: TagIcon,
  move: FolderIcon,
  star: StarIcon,
  delete: TrashIcon,
  reply: ArrowBendUpLeftIcon,
  forward: ShareFatIcon,
  compose: NotePencilIcon,
  select: CheckSquareIcon,
  down: CaretDownIcon,
  up: CaretUpIcon,
  open: EnvelopeOpenIcon,
  close: XIcon,
  undo: ArrowsOutLineVerticalIcon,
  ask: CommandIcon,
  palette: KeyboardIcon,
  view: LayoutIcon,
  inbox: TrayIcon,
  group: UsersThreeIcon,
  settings: GearIcon,
  search: MagnifyingGlassIcon,
  workflow: FlowArrowIcon,
  sent: PaperPlaneTiltIcon,
  calendar: CalendarBlankIcon,
};

const ACTION_ICON: Partial<Record<KeyAction, string>> = {
  "move.down": "down",
  "move.up": "up",
  "thread.open": "open",
  "sheet.close": "close",
  "thread.archive": "archive",
  "thread.snooze": "snooze",
  "thread.star": "star",
  "thread.delete": "delete",
  "thread.label": "label",
  "thread.move": "move",
  "compose.new": "compose",
  "compose.reply": "reply",
  "compose.reply_all": "reply",
  "compose.forward": "forward",
  "select.toggle": "select",
  "select.extend_down": "select",
  "select.extend_up": "select",
  undo: "undo",
  "agent.focus": "ask",
  "palette.open": "palette",
};

/** Actions shown before anything is typed, in the mock's order. */
const FEATURED_ACTIONS: readonly string[] = [
  "compose.new",
  "thread.archive",
  "thread.snooze",
  "thread.label",
  "workflow.from_thread",
];

const NO_SUGGESTIONS: readonly PaletteSuggestion[] = [];
const NO_GROUPS: readonly Group[] = [];

const fill = (template: string, vars: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));

/** A Date as an ISO string in the Device's own offset, so the Server reads the user's day. */
export function localIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
}

const NO_CONTACTS: readonly Person[] = [];
const NO_SECTIONS: readonly IntentSectionOption[] = [];

/** The action catalogue: every named action live on the screen with its shortcut, plus the screen-level ones. */
export function paletteActions(
  keymap: Keymap,
  settings: Settings,
  mac: boolean,
  scope: Exclude<KeyScope, "global"> = "mail",
): PaletteAction[] {
  const t = (k: string) => (k in settings ? String(settings[k as keyof Settings]) : k);
  const out: PaletteAction[] = [];
  for (const action of KEY_ACTIONS) {
    if (!inScope(action, scope)) continue;
    const view = /^view\.(\d)$/.exec(action);
    const label = view
      ? fill(t("strings.action.view"), { n: view[1] ?? "" })
      : t(`strings.action.${action}`);
    if (view && !settings["views.list"][Number(view[1]) - 1]) continue;
    out.push({
      action,
      label,
      kbd: chordLabel(keymap[action], mac),
      icon: view
        ? "view"
        : (ACTION_ICON[action] ?? (action.startsWith("calendar.") ? "calendar" : undefined)),
      featured: FEATURED_ACTIONS.includes(action),
    });
  }
  if (scope === "mail")
    out.push({
      action: "workflow.from_thread",
      label: t("strings.palette.workflow_from_thread"),
      icon: "workflow",
      featured: true,
    });
  return out.sort(
    (a, b) =>
      (a.featured ? FEATURED_ACTIONS.indexOf(a.action) : 99) -
      (b.featured ? FEATURED_ACTIONS.indexOf(b.action) : 99),
  );
}

/** The Inbox, the Mail folders, the Groups, saved Views and Settings pages. */
export function paletteNavigation(
  settings: Settings,
  mac: boolean,
  groups: readonly Group[],
): PaletteNav[] {
  const t = (k: string) => (k in settings ? String(settings[k as keyof Settings]) : k);
  const out: PaletteNav[] = [];
  out.push({
    target: "inbox",
    label: t("strings.palette.nav.inbox"),
    icon: "inbox",
    featured: true,
  });
  // The Mail folders, by the names the nav gives them.
  for (const [key, icon] of [
    ["starred", "star"],
    ["snoozed", "snooze"],
    ["drafts", "compose"],
    ["sent", "sent"],
    ["archive", "archive"],
  ] as const) {
    out.push({ target: `folder:${key}`, label: t(`strings.nav.${key}`), icon });
  }
  const byId = new Map(groups.map((g) => [g.id, g]));
  let featuredGroup = false;
  for (const g of groups) {
    const parent = g.parentId ? byId.get(g.parentId) : null;
    const featured = !featuredGroup && parent !== null && parent !== undefined;
    if (featured) featuredGroup = true;
    out.push({
      target: `group:${g.id}`,
      label: parent ? `${parent.name} › ${g.name}` : g.name,
      icon: "group",
      featured,
    });
  }
  settings["views.list"].forEach((v, i) => {
    out.push({
      target: `view:${i + 1}`,
      label: fill(t("strings.palette.nav.view"), { name: v.name }),
      kbd: chordLabel(`mod+${i + 1}`, mac),
      icon: "view",
    });
  });
  out.push({
    target: "settings",
    label: t("strings.palette.nav.settings"),
    icon: "settings",
    featured: true,
  });
  out.push({
    target: "settings:search",
    label: t("strings.palette.nav.settings_search"),
    icon: "search",
  });
  for (const section of SETTING_SECTIONS) {
    out.push({
      target: `settings:${section}`,
      label: fill(t("strings.palette.nav.settings_page"), {
        name: t(`strings.settings.section.${section}`),
      }),
      icon: "settings",
    });
  }
  out.push({ target: "routing", label: t("strings.palette.nav.routing"), icon: "group" });
  out.push({ target: "workflows", label: t("strings.palette.nav.workflows"), icon: "workflow" });
  out.push({ target: "calendar", label: t("strings.palette.nav.calendar"), icon: "calendar" });
  out.push({ target: "search", label: t("strings.palette.nav.search"), icon: "search" });
  // Set me up: onboarding again, from the three choices (docs/spec/onboarding.md, "Later and again").
  out.push({ target: "onboarding", label: t("strings.palette.nav.onboarding"), icon: "settings" });
  return out;
}

export interface PaletteProps {
  query: string;
  onQuery: (query: string) => void;
  onClose: () => void;
  /** The active keymap, for the shortcut shown next to every action. */
  keymap: Keymap;
  /** The Cache search; absent in fixture mode, where the palette still jumps and acts. */
  search?: SearchModule | null | undefined;
  workspaceId: string;
  recentThreads: readonly Thread[];
  /** The Workspace's Groups, for "Go to". */
  groups?: readonly Group[] | undefined;
  /** The Agent's suggestion chips (docs/spec/agent-composer.md), shown before anything is typed. */
  suggestions?: readonly PaletteSuggestion[] | undefined;
  onCommand: (command: PaletteCommand) => void;
  /** Tab: the `agent.ask` action with the parsed query attached. */
  onAsk: (ask: AgentAsk) => void;
  /**
   * The judge (slice 27): a sentence that matches no entry is sent here after
   * a pause and its reading becomes the first row. Absent, or answering null,
   * the palette behaves as before.
   */
  judge?: IntentJudge | null | undefined;
  /** Contacts by recency, the options for the person a sentence names. */
  contacts?: readonly Person[] | undefined;
  /** The Sections a sentence may name, as the stream shows them. */
  sections?: readonly IntentSectionOption[] | undefined;
  /** The intent in the user's words, with the count of Threads it names; the screen knows the list. */
  describeIntent?: ((intent: TypedIntent) => string) | undefined;
  now?: Date | undefined;
  /** On its way out (the screen's exit hook): the leave animation runs, then onLeft. */
  leaving?: boolean | undefined;
  onLeft?: (() => void) | undefined;
  /** Which screen's actions to list: the mail screens' (default) or the Calendar's. */
  scope?: Exclude<KeyScope, "global"> | undefined;
}

/** "Fri 3 Oct 2026" for the palette's date row. */
function dayLabel(d: Date): string {
  return `${WEEKDAY_SHORT[d.getDay()]} ${d.getDate()} ${MONTH_SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

export function Palette({
  query,
  onQuery,
  onClose,
  keymap,
  search,
  workspaceId,
  recentThreads,
  groups = NO_GROUPS,
  suggestions = NO_SUGGESTIONS,
  onCommand,
  onAsk,
  judge,
  contacts = NO_CONTACTS,
  sections: sectionOptions = NO_SECTIONS,
  describeIntent,
  now,
  leaving,
  onLeft,
  scope = "mail",
}: PaletteProps) {
  const { settings } = useShell();
  const mac = isMac();
  const t = (k: keyof Settings) => String(settings[k]);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const seq = useRef(0);
  /** The judge's reading of one exact text; a newer text drops it. */
  const [reading, setReading] = useState<{ text: string; intent: TypedIntent } | null>(null);
  const judgeSeq = useRef(0);

  const agent = settings["ai.level"] !== "off";
  const actions = useMemo(
    () =>
      paletteActions(keymap, settings, mac, scope).filter(
        (a) => agent || a.action !== "agent.focus",
      ),
    [keymap, settings, mac, agent, scope],
  );
  // A typed date offers the Calendar on that day ("Jump to date").
  const pinned = useMemo(() => {
    const day = parseJumpDate(query, now ?? new Date(), settings["calendar.dates_month_first"]);
    if (!day) return [];
    return [
      {
        target: `calendar:${dayKey(day)}`,
        label: fill(settings["strings.palette.calendar_jump"], { date: dayLabel(day) }),
        icon: "calendar",
      },
    ];
  }, [query, now, settings]);
  const navigation = useMemo(
    () => paletteNavigation(settings, mac, groups),
    [settings, mac, groups],
  );
  const strings = useMemo<PaletteStrings>(
    () => ({
      ask: settings["strings.palette.ask"],
      actions: settings["strings.palette.actions"],
      go: settings["strings.palette.go"],
      threads: settings["strings.palette.threads"],
      results: settings["strings.palette.results"],
      askItem: settings["strings.palette.ask_item"],
      searchItem: settings["strings.palette.search_item"],
      do: settings["strings.palette.do"],
      didYouMean: settings["strings.palette.did_you_mean"],
      confirm: settings["strings.palette.intent.confirm"],
    }),
    [settings],
  );

  // The Cache search for what is typed; a stale answer never overwrites a newer one.
  useEffect(() => {
    const text = query.trim();
    if (!search || text === "") {
      setHits([]);
      return;
    }
    const mine = ++seq.current;
    const all = settings["search.all_accounts"];
    void search
      .search(text, {
        workspace: all ? "all" : workspaceId,
        limit: settings["search.results_limit"],
        ...(now ? { now } : {}),
      })
      .then((r) => {
        if (mine === seq.current) setHits(r.hits);
      })
      .catch(() => {
        if (mine === seq.current) setHits([]);
      });
  }, [query, search, workspaceId, settings, now]);

  const base = useMemo(
    () =>
      buildPalette({
        text: query,
        actions,
        navigation,
        threads: recentThreads,
        suggestions,
        hits,
        strings,
        agent,
        pinned,
        ...(now ? { now } : {}),
      }),
    [query, actions, navigation, recentThreads, suggestions, hits, strings, now, agent, pinned],
  );

  // A sentence that matches no entry goes to the judge after a pause (slice 27).
  // The reading is code's to assemble: names from the sets sent, dates from
  // the Device's clock, the gate from Settings. Nothing here waits for it.
  const groupOptions = useMemo<IntentGroupOption[]>(
    () => groups.map((g) => ({ id: g.id, name: g.name, sentence: g.rule.sentence })),
    [groups],
  );
  const text = query.trim();
  const sentence = agent && Boolean(judge) && isSentence(base, text, settings["intent.min_words"]);
  useEffect(() => {
    if (!judge || !sentence) return;
    if (reading?.text === text) return;
    const mine = ++judgeSeq.current;
    const at = now ?? new Date();
    const timer = setTimeout(() => {
      void judge
        .intent({
          workspace: workspaceId,
          text,
          now: localIso(at),
          contacts: contacts.slice(0, settings["intent.contacts_max"]),
          groups: groupOptions,
          sections: [...sectionOptions],
        })
        .then((r) => {
          if (mine !== judgeSeq.current || !r) return;
          setReading({
            text,
            intent: resolveIntent(r, {
              now: at,
              contacts,
              groups: groupOptions,
              sections: sectionOptions,
              hours: settings["intent.hours"],
            }),
          });
        })
        .catch(() => {});
    }, settings["intent.debounce_ms"]);
    return () => clearTimeout(timer);
  }, [
    judge,
    sentence,
    text,
    reading,
    now,
    workspaceId,
    contacts,
    groupOptions,
    sectionOptions,
    settings,
  ]);

  const intent = useMemo<PaletteIntent | undefined>(() => {
    if (!reading || reading.text !== text || !sentence) return undefined;
    const gate = gateIntent(reading.intent, {
      actAbove: settings["intent.act_above"],
      askBelow: settings["intent.ask_below"],
    });
    if (gate === "agent") return undefined;
    return {
      intent: reading.intent,
      label: describeIntent ? describeIntent(reading.intent) : reading.intent.text,
      gate,
    };
  }, [reading, text, sentence, settings, describeIntent]);

  const model = useMemo(
    () =>
      intent
        ? buildPalette({
            text: query,
            actions,
            navigation,
            threads: recentThreads,
            suggestions,
            hits,
            strings,
            agent,
            intent,
            pinned,
            ...(now ? { now } : {}),
          })
        : base,
    [
      base,
      intent,
      query,
      actions,
      navigation,
      recentThreads,
      suggestions,
      hits,
      strings,
      now,
      agent,
      pinned,
    ],
  );

  // The highlight follows the list: a key that left it lands on the first row.
  const activeKey =
    active !== null && model.flat.some((i) => i.key === active)
      ? active
      : (model.flat[0]?.key ?? null);
  const byKey = useMemo(() => new Map(model.flat.map((i) => [i.key, i])), [model]);

  const sections: CommandSection[] = model.sections.map((sec) => ({
    label: sec.label,
    items: sec.items.map<CommandItem>((it) => ({
      key: it.key,
      label: it.label,
      kbd: it.kbd,
      ai: it.ai,
      icon: it.icon ? ICONS[it.icon] : undefined,
      thread: it.thread,
      account: settings["search.all_accounts"] ? it.account : undefined,
      snippet: it.snippet,
    })),
  }));

  const select = (item: CommandItem) => {
    const found = byKey.get(item.key);
    if (found) onCommand(found.command);
  };

  // The scrim covers the whole window, as the mock's does, not just the screen column.
  return createPortal(
    <CommandPalette
      sections={sections}
      activeKey={activeKey ?? undefined}
      query={query}
      onQuery={(q) => {
        onQuery(q);
        setActive(null);
      }}
      onMove={(delta) => setActive(moveActive(model.flat, activeKey, delta))}
      onHover={setActive}
      onSelect={select}
      onSubmit={(text) => {
        if (text.trim() !== "") onCommand({ type: "search", text, query: model.query });
      }}
      onAsk={(text) => onAsk(agentHandoff(text, now))}
      onClose={onClose}
      now={now}
      leaving={leaving}
      onLeft={onLeft}
      strings={{
        placeholder: t("strings.search.placeholder"),
        move: t("strings.palette.foot.move"),
        select: t("strings.palette.foot.select"),
        ask: t("strings.palette.foot.ask"),
        empty: model.mode === "search" ? t("strings.search.empty") : undefined,
      }}
    />,
    document.body,
  );
}
