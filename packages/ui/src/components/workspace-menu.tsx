// The workspace switcher (CONTEXT.md "Workspace": one Account is one
// Workspace, shown one at a time): a panel anchored to the workspace button
// listing every connected Account with its provider mark, address and sync
// state, the current one checked; then "Add an account" and "Settings".
// Arrows move, Enter picks, Escape or a click outside closes, and the focus
// goes back to the button that opened it.

import { CheckIcon, GearSixIcon, PlusIcon } from "@phosphor-icons/react";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import { cx } from "../format.ts";
import { Icon } from "./icon.tsx";

export interface WorkspaceMenuAccount {
  id: string;
  address: string;
  /** The provider's mark: a logo icon or two letters. */
  mark: ReactNode;
  /** The sync state in words: "Connected", "Synced 2 minutes ago", "Sync error". */
  state: string;
  /** How the state reads: fine, needs a look, or not connected. */
  tone?: "ok" | "warn" | "off" | undefined;
  current: boolean;
}

export interface WorkspaceMenuLabels {
  /** The panel's name for assistive tech, such as "Switch account". */
  label: string;
  /** The heading over the Accounts. */
  title: string;
  add: string;
  settings: string;
}

export interface WorkspaceMenuProps {
  accounts: readonly WorkspaceMenuAccount[];
  labels: WorkspaceMenuLabels;
  /** The button the panel hangs from: a click on it is not a click outside, and the focus returns to it. */
  anchor: RefObject<HTMLElement | null>;
  onPick: (accountId: string) => void;
  onAdd: () => void;
  onSettings: () => void;
  onClose: () => void;
  className?: string | undefined;
}

export function WorkspaceMenu({
  accounts,
  labels,
  anchor,
  onPick,
  onAdd,
  onSettings,
  onClose,
  className,
}: WorkspaceMenuProps) {
  const host = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  // Opens on the current Account; closing puts the focus back on the button
  // unless a click outside already moved it somewhere.
  useLayoutEffect(() => {
    const items = host.current?.querySelectorAll<HTMLElement>(".pop-item");
    const current = host.current?.querySelector<HTMLElement>(".pop-item[aria-checked='true']");
    (current ?? items?.[0])?.focus();
    const button = anchor.current;
    return () => {
      const at = document.activeElement;
      if (!at || at === document.body || host.current?.contains(at)) button?.focus();
    };
  }, [anchor]);

  useEffect(() => {
    const away = (e: MouseEvent) => {
      const target = e.target as Node;
      if (host.current?.contains(target) || anchor.current?.contains(target)) return;
      close.current();
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [anchor]);

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // Every key belongs to the panel while it is open: the list keymap stays quiet.
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      close.current();
      return;
    }
    const down = e.key === "ArrowDown" || e.key === "j";
    const up = e.key === "ArrowUp" || e.key === "k";
    if (!down && !up) return;
    e.preventDefault();
    const items = [...(host.current?.querySelectorAll<HTMLElement>(".pop-item") ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = Math.min(items.length - 1, Math.max(0, at + (down ? 1 : -1)));
    items[next]?.focus();
  };

  return (
    <div
      ref={host}
      className={cx("pop ws-menu", className)}
      role="menu"
      aria-label={labels.label}
      onKeyDown={onKey}
    >
      <div className="pop-h">{labels.title}</div>
      {accounts.map((a) => (
        <button
          key={a.id}
          type="button"
          role="menuitemradio"
          aria-checked={a.current}
          className={cx("pop-item ws-acct", a.current && "current")}
          data-account={a.id}
          onClick={() => onPick(a.id)}
        >
          <span className="lg">{a.mark}</span>
          <span className="ws-acct-text">
            <span className="addr">{a.address}</span>
            <span className={cx("st", a.tone && `st-${a.tone}`)}>{a.state}</span>
          </span>
          {a.current ? <Icon icon={CheckIcon} className="ws-check" /> : null}
        </button>
      ))}
      <hr className="pop-sep" />
      <button type="button" role="menuitem" className="pop-item" onClick={onAdd}>
        <Icon icon={PlusIcon} />
        <span>{labels.add}</span>
      </button>
      <button type="button" role="menuitem" className="pop-item" onClick={onSettings}>
        <Icon icon={GearSixIcon} />
        <span>{labels.settings}</span>
      </button>
    </div>
  );
}

/** What the nav and the rail take to host the switcher on their workspace button. */
export type WorkspaceSwitcher = Omit<WorkspaceMenuProps, "anchor" | "className"> & {
  open: boolean;
};
