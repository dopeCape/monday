// What the navigation shows, built from the Workspace, the Cache and the
// Settings rather than from the design fixtures: the workspace button with the
// owner's address and its initials, the Mail folders with their labels from
// Settings, the unread counts per folder and per Group from the Inbox seam,
// the rail's items (Inbox, then the top-level Groups) and its tail. Pure, so
// the App composes it in a memo and the tests read it without a DOM.

import type { Group, Settings, Thread } from "@monday/shared";
import type { IconComponent, NavItem, NavLabels, NavWorkspace, RailItem } from "@monday/ui";
import {
  AirplaneIcon,
  ArchiveIcon,
  BriefcaseIcon,
  CalendarBlankIcon,
  CalendarIcon,
  CheckCircleIcon,
  ClockIcon,
  FlowArrowIcon,
  FolderSimpleIcon,
  GearSixIcon,
  GitBranchIcon,
  GithubLogoIcon,
  HandshakeIcon,
  HeartIcon,
  HouseIcon,
  LifebuoyIcon,
  MicrophoneIcon,
  NewspaperIcon,
  NotePencilIcon,
  PaperPlaneTiltIcon,
  ReceiptIcon,
  ScalesIcon,
  StarIcon,
  TagIcon,
  TrayIcon,
  UserPlusIcon,
  UsersThreeIcon,
} from "@phosphor-icons/react";

export type NavStringKey = Extract<keyof Settings, `strings.nav.${string}`>;
export type NavStrings = Pick<Settings, NavStringKey>;

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
};

/**
 * The icon for a Group from the Setting: the first entry whose word is the
 * Group's id or appears in its name, case-insensitively; undefined when none
 * matches or the icon name is not in the catalog.
 */
export function groupIconFor(
  icons: Readonly<Record<string, string>>,
): (group: Group) => IconComponent | undefined {
  const entries = Object.entries(icons).map(([word, icon]) => [word.toLowerCase(), icon] as const);
  return (group) => {
    const id = group.id.toLowerCase();
    const name = group.name.toLowerCase();
    const exact = entries.find(([word]) => word === id || word === name);
    const partial = exact ?? entries.find(([word]) => name.includes(word));
    return partial ? GROUP_ICON_CATALOG[partial[1]] : undefined;
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
  /** Sends still scheduled; a Scheduled folder appears while there are any. */
  scheduled?: { count: number; label: string } | undefined;
  strings: NavStrings;
}

export interface NavModel {
  workspace: NavWorkspace;
  labels: NavLabels;
  folders: NavItem[];
  calendar: NavItem;
  automation: NavItem[];
  /** Unread counts by folder key or Group id; absent keys show no count. */
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

/** Unread Threads per folder key and per Group id (a Sub-group's count rolls up into its parent). */
export function unreadCounts(
  threads: readonly Thread[],
  groups: readonly Group[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  const bump = (key: string) => {
    counts[key] = (counts[key] ?? 0) + 1;
  };
  const parentOf = new Map(groups.map((g) => [g.id, g.parentId]));
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
  }
  return counts;
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
  return {
    workspace: { name: input.address, initials: addressInitials(input.address), status },
    labels: {
      search: s["strings.nav.search"],
      compose: s["strings.nav.compose"],
      mail: s["strings.nav.mail"],
      groups: s["strings.nav.groups"],
      automation: s["strings.nav.automation"],
      settings: s["strings.nav.settings"],
    },
    folders,
    calendar: { key: "calendar", label: s["strings.nav.calendar"], icon: CalendarBlankIcon },
    automation: [
      { key: "workflows", label: s["strings.nav.workflows"], icon: FlowArrowIcon },
      { key: "routing", label: s["strings.nav.routing"], icon: GitBranchIcon },
    ],
    counts: unreadCounts(input.threads, input.groups),
    rail: [
      { key: "inbox", icon: TrayIcon, title: s["strings.nav.inbox"] },
      ...top.map((g) => ({ key: g.id, icon: groupIcon(g) ?? FolderSimpleIcon, title: g.name })),
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
