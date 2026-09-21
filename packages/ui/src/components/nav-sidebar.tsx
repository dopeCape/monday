// The full navigation sidebar: workspace, search and compose, Mail folders,
// the calendar, Groups with their Sub-groups, the Sections placed in the nav
// (CONTEXT.md "Section rule"), Automation, and Settings.
import type { Group } from "@monday/shared";
import {
  CaretUpDownIcon,
  GearSixIcon,
  MagnifyingGlassIcon,
  PencilSimpleLineIcon,
  StackIcon,
} from "@phosphor-icons/react";
import { Fragment } from "react";
import { cx } from "../format.ts";
import { Icon, type IconComponent } from "./icon.tsx";
import { Avatar, Kbd } from "./primitives.tsx";

export interface NavItem {
  key: string;
  label: string;
  icon?: IconComponent | undefined;
  count?: number | undefined;
}

export interface NavWorkspace {
  name: string;
  initials: string;
  /** Tooltip on the workspace button, such as "Synced 12 seconds ago". */
  status?: string | undefined;
}

/** The fixed words on the sidebar; the app reads them from Settings, the mock keeps these. */
export interface NavLabels {
  search: string;
  compose: string;
  mail: string;
  groups: string;
  /** The heading over the Sections placed in the nav; absent means "Sections". */
  sections?: string | undefined;
  automation: string;
  settings: string;
}

export const DEFAULT_NAV_LABELS: NavLabels = {
  search: "Search",
  compose: "New message",
  mail: "Mail",
  groups: "Groups",
  sections: "Sections",
  automation: "Automation",
  settings: "Settings",
};

export interface NavSidebarProps {
  workspace: NavWorkspace;
  labels?: NavLabels | undefined;
  /** The Mail section: Inbox, Starred, Snoozed, Drafts, Sent, Archive. */
  folders: readonly NavItem[];
  calendar?: NavItem | undefined;
  /** Groups and Sub-groups. Sub-groups nest by parentId. */
  groups: readonly Group[];
  /** Unread counts per folder key or Group id. */
  counts?: Readonly<Record<string, number>> | undefined;
  /** Icons for top-level Groups; Sub-groups never carry one. */
  groupIcon?: (group: Group) => IconComponent | undefined;
  /** The Sections placed in the nav, under Groups; none hides the block. */
  sections?: readonly NavItem[] | undefined;
  automation: readonly NavItem[];
  /** The active folder key, Group id, or "calendar", "settings". */
  active: string;
  onSelect?: ((key: string) => void) | undefined;
  onSearch?: (() => void) | undefined;
  onCompose?: (() => void) | undefined;
  onWorkspace?: (() => void) | undefined;
  className?: string | undefined;
}

interface ItemProps {
  item: NavItem;
  on: boolean;
  sub?: boolean | undefined;
  onSelect: ((key: string) => void) | undefined;
}

function Item({ item, on, sub, onSelect }: ItemProps) {
  return (
    <button
      type="button"
      className={cx("nav-item", on && "on", sub && "sub")}
      aria-current={on ? "page" : undefined}
      onClick={() => onSelect?.(item.key)}
    >
      {item.icon ? <Icon icon={item.icon} /> : null}
      <span>{item.label}</span>
      {item.count ? <span className="n">{item.count}</span> : null}
    </button>
  );
}

export function NavSidebar({
  workspace,
  labels = DEFAULT_NAV_LABELS,
  folders,
  calendar,
  groups,
  counts,
  groupIcon,
  sections,
  automation,
  active,
  onSelect,
  onSearch,
  onCompose,
  onWorkspace,
  className,
}: NavSidebarProps) {
  const top = groups.filter((g) => g.parentId === null);
  const childrenOf = (g: Group) => groups.filter((c) => c.parentId === g.id);
  const withCount = (item: NavItem): NavItem =>
    item.count === undefined && counts?.[item.key] !== undefined
      ? { ...item, count: counts[item.key] }
      : item;

  return (
    <aside className={cx("nav", className)}>
      <button type="button" className="ws" title={workspace.status} onClick={onWorkspace}>
        <Avatar name={workspace.name} initials={workspace.initials} color="var(--fg)" square live />
        <span className="ws-name">{workspace.name}</span>
        <Icon icon={CaretUpDownIcon} />
      </button>
      <button type="button" className="nav-item" onClick={onSearch}>
        <Icon icon={MagnifyingGlassIcon} />
        <span>{labels.search}</span>
        <Kbd>⌘K</Kbd>
      </button>
      <button type="button" className="nav-item" onClick={onCompose}>
        <Icon icon={PencilSimpleLineIcon} />
        <span>{labels.compose}</span>
        <Kbd>C</Kbd>
      </button>

      <div className="nav-sec">{labels.mail}</div>
      {folders.map((f) => (
        <Item key={f.key} item={withCount(f)} on={active === f.key} onSelect={onSelect} />
      ))}
      {calendar ? (
        <Item item={withCount(calendar)} on={active === calendar.key} onSelect={onSelect} />
      ) : null}

      {top.length ? <div className="nav-sec">{labels.groups}</div> : null}
      {top.map((g) => (
        <Fragment key={g.id}>
          <Item
            item={withCount({ key: g.id, label: g.name, icon: groupIcon?.(g) })}
            on={active === g.id}
            onSelect={onSelect}
          />
          {childrenOf(g).map((c) => (
            <Item
              key={c.id}
              item={withCount({ key: c.id, label: c.name })}
              on={active === c.id}
              sub
              onSelect={onSelect}
            />
          ))}
        </Fragment>
      ))}

      {sections?.length ? (
        <div className="nav-sec">{labels.sections ?? DEFAULT_NAV_LABELS.sections}</div>
      ) : null}
      {sections?.map((sec) => (
        <Item
          key={sec.key}
          item={withCount({ icon: StackIcon, ...sec })}
          on={active === sec.key}
          onSelect={onSelect}
        />
      ))}

      {automation.length ? <div className="nav-sec">{labels.automation}</div> : null}
      {automation.map((a) => (
        <Item key={a.key} item={a} on={active === a.key} onSelect={onSelect} />
      ))}

      <div className="nav-foot">
        <Item
          item={{ key: "settings", label: labels.settings, icon: GearSixIcon }}
          on={active === "settings"}
          onSelect={onSelect}
        />
      </div>
    </aside>
  );
}
