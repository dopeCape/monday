// The command palette container (ADR 0011): builds the catalogues from the
// keymap, the navigation and the recent Threads, runs the local search for
// what is typed, and renders the pure model through the CommandPalette
// component. Every keystroke is answered from memory and the Cache; nothing
// here waits on the network or a model.

import type { Settings, Thread } from "@monday/shared";
import {
  type CommandItem,
  CommandPalette,
  type CommandSection,
  type IconComponent,
} from "@monday/ui";
import { commands as fixtureCommands, folders, groups } from "@monday/ui/fixtures";
import {
  ArchiveIcon,
  ArrowBendUpLeftIcon,
  ArrowsOutLineVerticalIcon,
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
import { chordLabel, KEY_ACTIONS, type KeyAction, type Keymap } from "../keyboard/keymaps.ts";
import type { SearchHit, SearchModule } from "../search/index.ts";
import {
  type AgentAsk,
  agentHandoff,
  buildPalette,
  moveActive,
  type PaletteAction,
  type PaletteCommand,
  type PaletteNav,
  type PaletteStrings,
} from "../search/palette.ts";
import { useShell } from "../shell/Shell.tsx";

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

/** Canned lines for the Agent until the composer (slice 14) supplies real ones. */
const agentSuggestions = fixtureCommands
  .flatMap((sec) => sec.items)
  .filter((it) => it.ai)
  .map((it) => ({ key: it.key, label: it.label }));

const fill = (template: string, vars: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));

/** The action catalogue: every named action with its shortcut, plus the screen-level ones. */
export function paletteActions(keymap: Keymap, settings: Settings, mac: boolean): PaletteAction[] {
  const t = (k: string) => (k in settings ? String(settings[k as keyof Settings]) : k);
  const out: PaletteAction[] = [];
  for (const action of KEY_ACTIONS) {
    const view = /^view\.(\d)$/.exec(action);
    const label = view
      ? fill(t("strings.action.view"), { n: view[1] ?? "" })
      : t(`strings.action.${action}`);
    if (view && !settings["views.list"][Number(view[1]) - 1]) continue;
    out.push({
      action,
      label,
      kbd: chordLabel(keymap[action], mac),
      icon: view ? "view" : ACTION_ICON[action],
      featured: FEATURED_ACTIONS.includes(action),
    });
  }
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

/** Folders, Groups, saved Views and Settings pages. */
export function paletteNavigation(settings: Settings, mac: boolean): PaletteNav[] {
  const t = (k: string) => (k in settings ? String(settings[k as keyof Settings]) : k);
  const out: PaletteNav[] = [];
  for (const f of folders) {
    out.push({
      target: f.key === "inbox" ? "inbox" : `folder:${f.key}`,
      label: f.key === "inbox" ? t("strings.palette.nav.inbox") : f.label,
      icon: f.key === "inbox" ? "inbox" : f.key === "sent" ? "sent" : "move",
      featured: f.key === "inbox",
    });
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
  for (const section of [
    "accounts",
    "appearance",
    "routing",
    "ai",
    "workflows",
    "server",
    "shortcuts",
    "about",
  ]) {
    out.push({
      target: `settings:${section}`,
      label: fill(t("strings.palette.nav.settings_page"), {
        name: section.charAt(0).toUpperCase() + section.slice(1),
      }),
      icon: "settings",
    });
  }
  out.push({ target: "search", label: t("strings.palette.nav.search"), icon: "search" });
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
  onCommand: (command: PaletteCommand) => void;
  /** Tab: the `agent.ask` action with the parsed query attached. */
  onAsk: (ask: AgentAsk) => void;
  now?: Date | undefined;
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
  onCommand,
  onAsk,
  now,
}: PaletteProps) {
  const { settings } = useShell();
  const mac = isMac();
  const t = (k: keyof Settings) => String(settings[k]);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const seq = useRef(0);

  const actions = useMemo(() => paletteActions(keymap, settings, mac), [keymap, settings, mac]);
  const navigation = useMemo(() => paletteNavigation(settings, mac), [settings, mac]);
  const strings = useMemo<PaletteStrings>(
    () => ({
      ask: settings["strings.palette.ask"],
      actions: settings["strings.palette.actions"],
      go: settings["strings.palette.go"],
      threads: settings["strings.palette.threads"],
      results: settings["strings.palette.results"],
      askItem: settings["strings.palette.ask_item"],
      searchItem: settings["strings.palette.search_item"],
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

  const model = useMemo(
    () =>
      buildPalette({
        text: query,
        actions,
        navigation,
        threads: recentThreads,
        suggestions: agentSuggestions,
        hits,
        strings,
        ...(now ? { now } : {}),
      }),
    [query, actions, navigation, recentThreads, hits, strings, now],
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

  return (
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
      strings={{
        placeholder: t("strings.search.placeholder"),
        move: t("strings.palette.foot.move"),
        select: t("strings.palette.foot.select"),
        ask: t("strings.palette.foot.ask"),
        empty: model.mode === "search" ? t("strings.search.empty") : undefined,
      }}
    />
  );
}
