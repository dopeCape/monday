// The icon rail: the "rail" nav knob. Workspace, search, compose, then the
// primary destinations, a spacer, and the secondary ones.
import { MagnifyingGlassIcon, PencilSimpleLineIcon } from "@phosphor-icons/react";
import { cx } from "../format.ts";
import { Icon, type IconComponent } from "./icon.tsx";
import { DEFAULT_NAV_LABELS, type NavLabels, type NavWorkspace } from "./nav-sidebar.tsx";
import { Avatar } from "./primitives.tsx";

export interface RailItem {
  key: string;
  icon: IconComponent;
  /** The tooltip; the rail shows no labels. */
  title: string;
}

export interface RailProps {
  workspace: NavWorkspace;
  /** The search and compose tooltips; the app reads them from Settings. */
  labels?: Pick<NavLabels, "search" | "compose"> | undefined;
  /** Inbox and the Groups, at the top. */
  items: readonly RailItem[];
  /** Calendar, Workflows, Routing, Settings, at the bottom. */
  tail: readonly RailItem[];
  active: string;
  onSelect?: ((key: string) => void) | undefined;
  onSearch?: (() => void) | undefined;
  onCompose?: (() => void) | undefined;
  className?: string | undefined;
}

function RailButton({
  item,
  on,
  onSelect,
}: {
  item: RailItem;
  on: boolean;
  onSelect: ((key: string) => void) | undefined;
}) {
  return (
    <button
      type="button"
      className={cx(on && "on")}
      title={item.title}
      aria-label={item.title}
      aria-current={on ? "page" : undefined}
      onClick={() => onSelect?.(item.key)}
    >
      <Icon icon={item.icon} />
    </button>
  );
}

export function Rail({
  workspace,
  labels = DEFAULT_NAV_LABELS,
  items,
  tail,
  active,
  onSelect,
  onSearch,
  onCompose,
  className,
}: RailProps) {
  return (
    <nav className={cx("rail", className)}>
      <Avatar name={workspace.name} initials={workspace.initials} color="var(--fg)" square />
      <button
        type="button"
        title={`${labels.search} ⌘K`}
        aria-label={labels.search}
        onClick={onSearch}
      >
        <Icon icon={MagnifyingGlassIcon} />
      </button>
      <button type="button" title={labels.compose} aria-label={labels.compose} onClick={onCompose}>
        <Icon icon={PencilSimpleLineIcon} />
      </button>
      <span className="gap" />
      {items.map((it) => (
        <RailButton key={it.key} item={it} on={active === it.key} onSelect={onSelect} />
      ))}
      <span className="sp" />
      {tail.map((it) => (
        <RailButton key={it.key} item={it} on={active === it.key} onSelect={onSelect} />
      ))}
    </nav>
  );
}
