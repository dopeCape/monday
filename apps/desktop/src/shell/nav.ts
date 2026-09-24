// What the navigation shows, built from the Workspace, the Cache and the
// Settings rather than from the design fixtures: the workspace button with the
// owner's address and its initials, the Mail folders with their labels from
// Settings, the unread counts per folder and per Group from the Inbox seam,
// the rail's items (Inbox, the Mail folders, then the top-level Groups) and
// its tail, the Drafts and Snoozed totals beside their folders, and every
// Section with its unread count (docs/spec/inbox.md: Sections live in the nav
// only, shipped and user-defined alike, whatever their placement; a hidden
// one is left out; a Section the Agent created a moment ago appears without a
// reload, because the model is recomputed from the Settings it came in with). Pure, so the App composes it
// in a memo and the tests read it without a DOM.

import type { Group, SectionRuleSetting, Settings, Thread } from "@monday/shared";
import { isSettingKey, orderedSectionRules, sectionLabel } from "@monday/shared";
import type { IconComponent, NavItem, NavLabels, NavWorkspace, RailItem } from "@monday/ui";
import {
  AirplaneIcon,
  ArchiveIcon,
  BellIcon,
  BookOpenIcon,
  BriefcaseIcon,
  CalendarBlankIcon,
  CalendarIcon,
  ChartLineIcon,
  ChatCircleIcon,
  CheckCircleIcon,
  ClockIcon,
  CodeIcon,
  CurrencyDollarIcon,
  FlowArrowIcon,
  FolderSimpleIcon,
  GearSixIcon,
  GitBranchIcon,
  GithubLogoIcon,
  GraduationCapIcon,
  HandshakeIcon,
  HeartIcon,
  HouseIcon,
  LifebuoyIcon,
  MegaphoneIcon,
  MicrophoneIcon,
  NewspaperIcon,
  NotePencilIcon,
  PaperPlaneTiltIcon,
  ReceiptIcon,
  RocketIcon,
  ScalesIcon,
  ShieldCheckIcon,
  ShoppingBagIcon,
  StackIcon,
  StarIcon,
  TagIcon,
  TrayIcon,
  TruckIcon,
  UserPlusIcon,
  UsersIcon,
  UsersThreeIcon,
  WarningIcon,
} from "@phosphor-icons/react";

export type NavStringKey = Extract<keyof Settings, `strings.nav.${string}`>;
/** The nav's own strings, plus the shipped Section names a placed Section may read. */
export type NavStrings = Pick<Settings, NavStringKey> &
  Partial<Pick<Settings, Extract<keyof Settings, `strings.section.${string}`>>>;

/** The icons a Group may carry, by the name the `routing.group_icons` Setting uses. */
export const GROUP_ICON_CATALOG: Readonly<Record<string, IconComponent>> = {
  "users-three": UsersThreeIcon,
  "user-plus": UserPlusIcon,
  receipt: ReceiptIcon,
  handshake: HandshakeIcon,
  "github-logo": GithubLogoIcon,
  microphone: MicrophoneIcon,
  calendar: CalendarIcon,
  archive: ArchiveIcon,
  "check-circle": CheckCircleIcon,
  airplane: AirplaneIcon,
  scales: ScalesIcon,
  lifebuoy: LifebuoyIcon,
  newspaper: NewspaperIcon,
  briefcase: BriefcaseIcon,
  house: HouseIcon,
  heart: HeartIcon,
  tag: TagIcon,
  folder: FolderSimpleIcon,
  "git-branch": GitBranchIcon,
  code: CodeIcon,
  bell: BellIcon,
  warning: WarningIcon,
  users: UsersIcon,
  "book-open": BookOpenIcon,
  "shopping-bag": ShoppingBagIcon,
  shield: ShieldCheckIcon,
  megaphone: MegaphoneIcon,
  "chat-circle": ChatCircleIcon,
  rocket: RocketIcon,
  "currency-dollar": CurrencyDollarIcon,
  "graduation-cap": GraduationCapIcon,
  "chart-line": ChartLineIcon,
  truck: TruckIcon,
};

/**
 * The icon for a Group from the Setting: the first entry whose word is the
 * Group's id or appears in its name, case-insensitively; undefined when none
 * matches or the icon name is not in the catalog.
 */
export function groupIconFor(
  icons: Readonly<Record<string, string>>,
  /** routing.group_icon_fallback: the icon for a Group no word matches. */
  fallbackIcon = "folder",
): (group: Group) => IconComponent | undefined {
  const entries = Object.entries(icons).map(([word, icon]) => [word.toLowerCase(), icon] as const);
  const fallback = GROUP_ICON_CATALOG[fallbackIcon] ?? FolderSimpleIcon;
  return (group) => {
    const id = group.id.toLowerCase();
    const name = group.name.toLowerCase();
    const exact = entries.find(([word]) => word === id || word === name);
    const partial = exact ?? entries.find(([word]) => name.includes(word));
    // Every Group carries an icon: a word match, else the fallback.
    return (partial ? GROUP_ICON_CATALOG[partial[1]] : undefined) ?? fallback;
  };
}

export interface NavInput {
  /** The owner's address on this Workspace's Account. */
  address: string;
  /** The Store's connection state, for the workspace button's tooltip and dot. */
  status: "online" | "syncing" | "offline";
  /** Threads in the Inbox (not archived, not snoozed, not deleted), for the counts. */
  threads: readonly Thread[];
  /** Groups and Sub-groups of the Workspace. */
  groups: readonly Group[];
  /** Icons for top-level Groups, when the caller has some; the rail falls back to a folder. */
  groupIcon?: ((group: Group) => IconComponent | undefined) | undefined;
  /**
   * How many Drafts are open and how many Threads are snoozed: the nav shows
   * them beside Drafts and Snoozed, and nothing when there are none.
   */
  folderCounts?: { drafts?: number | undefined; snoozed?: number | undefined } | undefined;
  /** Sends still scheduled; a Scheduled folder appears while there are any. */
  scheduled?: { count: number; label: string } | undefined;
  /** The Section rules (sections.rules); every one not hidden is listed under Groups. */
  sections?: readonly SectionRuleSetting[] | undefined;
  /** Their order (sections.order). */
  sectionOrder?: readonly string[] | undefined;
  strings: NavStrings;
}

export interface NavModel {
  workspace: NavWorkspace;
  labels: NavLabels;
  folders: NavItem[];
  calendar: NavItem;
  automation: NavItem[];
  /** Every Section not hidden, in Section order, keyed "section:<id>". */
  sections: NavItem[];
  /** Unread counts by folder key, Group id or "section:<id>"; absent keys show no count. */
  counts: Record<string, number>;
  rail: RailItem[];
  railTail: RailItem[];
  groupIcon: (group: Group) => IconComponent | undefined;
}

/**
 * Two letters for an address: the first of the local part and the first of
 * the domain ("tejas@genai-labs.io" is "TG"); a name falls back to its words.
 */
export function addressInitials(address: string): string {
  const at = address.indexOf("@");
  if (at > 0) {
    const local = address.slice(0, at).replace(/^[^a-z0-9]+/i, "");
    const domain = address.slice(at + 1).replace(/^[^a-z0-9]+/i, "");
    return `${local.charAt(0)}${domain.charAt(0)}`.toUpperCase() || "?";
  }
  const words = address.split(/[\s._-]+/).filter(Boolean);
  return (
    words
      .slice(0, 2)
      .map((w) => w.charAt(0))
      .join("")
      .toUpperCase() || "?"
  );
}

/**
 * Unread Threads per folder key, per Group id (a Sub-group's count rolls up
 * into its parent) and, for the Section ids in `sections`, per
 * "section:<id>", so a Section placed in the nav carries its count like a
 * folder.
 */
export function unreadCounts(
  threads: readonly Thread[],
  groups: readonly Group[],
  sections: readonly string[] = [],
): Record<string, number> {
  const counts: Record<string, number> = {};
  const bump = (key: string) => {
    counts[key] = (counts[key] ?? 0) + 1;
  };
  const parentOf = new Map(groups.map((g) => [g.id, g.parentId]));
  const counted = new Set(sections);
  for (const t of threads) {
    if (!t.unread) continue;
    bump("inbox");
    if (t.starred) bump("starred");
    if (t.group) {
      bump(t.group);
      const parent = parentOf.get(t.group);
      if (parent) bump(parent);
    }
    if (t.subgroup && t.subgroup !== t.group) bump(t.subgroup);
    if (t.section && counted.has(t.section)) bump(`section:${t.section}`);
  }
  return counts;
}

/**
 * Every Section as a nav item, in Section order, labelled from the rule or
 * the strings: the nav is where Sections live, so placement no longer
 * decides; a hidden Section is left out.
 */
export function navSections(
  rules: readonly SectionRuleSetting[],
  order: readonly string[],
  strings: NavStrings,
): NavItem[] {
  return orderedSectionRules(rules, order)
    .filter((r) => !r.hidden)
    .map((r) => {
      const key = `strings.section.${r.id}`;
      const fromStrings = isSettingKey(key)
        ? String((strings as Record<string, unknown>)[key] ?? "")
        : "";
      return { key: `section:${r.id}`, label: sectionLabel(r, fromStrings || undefined) };
    });
}

/** The Drafts and Snoozed totals as nav counts; an empty folder shows no count, not zero. */
function totals(folderCounts: NavInput["folderCounts"]): Record<string, number> {
  const out: Record<string, number> = {};
  if (folderCounts?.drafts) out.drafts = folderCounts.drafts;
  if (folderCounts?.snoozed) out.snoozed = folderCounts.snoozed;
  return out;
}

export function navModel(input: NavInput): NavModel {
  const s = input.strings;
  const status =
    input.status === "online"
      ? s["strings.nav.status.online"]
      : input.status === "syncing"
        ? s["strings.nav.status.syncing"]
        : s["strings.nav.status.offline"];
  const folders: NavItem[] = [
    { key: "inbox", label: s["strings.nav.inbox"], icon: TrayIcon },
    { key: "starred", label: s["strings.nav.starred"], icon: StarIcon },
    { key: "snoozed", label: s["strings.nav.snoozed"], icon: ClockIcon },
    { key: "drafts", label: s["strings.nav.drafts"], icon: NotePencilIcon },
    { key: "sent", label: s["strings.nav.sent"], icon: PaperPlaneTiltIcon },
    { key: "archive", label: s["strings.nav.archive"], icon: ArchiveIcon },
  ];
  // The rail carries the same folders, as icons, after the Inbox.
  const railFolders: RailItem[] = folders.map((f) => ({
    key: f.key,
    icon: f.icon ?? TrayIcon,
    title: f.label,
  }));
  if (input.scheduled && input.scheduled.count > 0) {
    folders.push({
      key: "scheduled",
      label: input.scheduled.label,
      icon: ClockIcon,
      count: input.scheduled.count,
    });
  }
  const groupIcon = (g: Group) => input.groupIcon?.(g);
  const top = input.groups.filter((g) => g.parentId === null);
  const sections = navSections(input.sections ?? [], input.sectionOrder ?? [], s);
  return {
    workspace: { name: input.address, initials: addressInitials(input.address), status },
    labels: {
      search: s["strings.nav.search"],
      compose: s["strings.nav.compose"],
      mail: s["strings.nav.mail"],
      groups: s["strings.nav.groups"],
      sections: s["strings.nav.sections"],
      automation: s["strings.nav.automation"],
      settings: s["strings.nav.settings"],
    },
    folders,
    calendar: { key: "calendar", label: s["strings.nav.calendar"], icon: CalendarBlankIcon },
    automation: [
      { key: "workflows", label: s["strings.nav.workflows"], icon: FlowArrowIcon },
      { key: "routing", label: s["strings.nav.routing"], icon: GitBranchIcon },
    ],
    sections,
    counts: {
      ...unreadCounts(
        input.threads,
        input.groups,
        sections.map((item) => item.key.slice("section:".length)),
      ),
      ...totals(input.folderCounts),
    },
    rail: [
      ...railFolders,
      ...top.map((g) => ({ key: g.id, icon: groupIcon(g) ?? FolderSimpleIcon, title: g.name })),
      ...sections.map((item) => ({ key: item.key, icon: StackIcon, title: item.label })),
    ],
    railTail: [
      { key: "calendar", icon: CalendarBlankIcon, title: s["strings.nav.calendar"] },
      { key: "workflows", icon: FlowArrowIcon, title: s["strings.nav.workflows"] },
      { key: "routing", icon: GitBranchIcon, title: s["strings.nav.routing"] },
      { key: "settings", icon: GearSixIcon, title: s["strings.nav.settings"] },
    ],
    groupIcon,
  };
}
