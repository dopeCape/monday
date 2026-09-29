// The selection bar (docs/spec/inbox.md, Multi-select): while any Thread is
// selected it takes the list header's place. A checkbox selects every row
// shown (or none), a link past it selects the whole list over the Cache, the
// count says what is selected, and the actions apply to all of it through
// the screen's batch path. The screen words and wires every action; this
// only draws them.

import { Btn, ColHead, cx } from "@monday/ui";
import { CheckIcon, DotsThreeIcon, MinusIcon, XIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";

export interface SelectionAction {
  key: string;
  /** The action's name, for screen readers. */
  label: string;
  /** The tooltip: the name with its key. */
  title: string;
  icon: ReactNode;
  onClick: () => void;
}

export interface SelectionBarProps {
  /** "N selected", or "All N in Inbox selected". */
  title: string;
  /** How the rows shown stand: none, some or all of them selected. */
  shown: "none" | "some" | "all";
  /** The checkbox's name: select all, or select none once all are. */
  checkLabel: string;
  onCheck: () => void;
  /** "Select all N in Inbox", when the list holds more than the rows shown. */
  offer?: { label: string; onClick: () => void } | undefined;
  actions: readonly SelectionAction[];
  more?: { label: string; onClick: () => void } | undefined;
  clear: { label: string; title: string; onClick: () => void };
  /** The bar's name, for screen readers. */
  label: string;
}

export function SelectionBar({
  title,
  shown,
  checkLabel,
  onCheck,
  offer,
  actions,
  more,
  clear,
  label,
}: SelectionBarProps) {
  return (
    <ColHead
      className="sel-bar"
      leading={
        <button
          type="button"
          className={cx("check", shown === "all" && "on", shown === "some" && "some")}
          aria-pressed={shown === "all" ? true : shown === "some" ? "mixed" : false}
          aria-label={checkLabel}
          title={checkLabel}
          onClick={onCheck}
        >
          {shown === "all" ? (
            <CheckIcon weight="bold" />
          ) : shown === "some" ? (
            <MinusIcon weight="bold" />
          ) : null}
        </button>
      }
      title={title}
      count={
        offer ? (
          <Btn sm className="sel-all" onClick={offer.onClick}>
            {offer.label}
          </Btn>
        ) : undefined
      }
    >
      <div className="sel-actions" role="toolbar" aria-label={label}>
        {actions.map((a) => (
          <Btn
            key={a.key}
            icon
            title={a.title}
            aria-label={a.label}
            data-action={a.key}
            onClick={a.onClick}
          >
            {a.icon}
          </Btn>
        ))}
        {more ? (
          <Btn
            icon
            title={more.label}
            aria-label={more.label}
            aria-haspopup="menu"
            data-action="more"
            onClick={more.onClick}
          >
            <DotsThreeIcon />
          </Btn>
        ) : null}
      </div>
      <span className="vr" />
      <Btn
        icon
        title={clear.title}
        aria-label={clear.label}
        data-action="clear"
        onClick={clear.onClick}
      >
        <XIcon />
      </Btn>
    </ColHead>
  );
}
