// The command palette (⌘K): search, jump, or ask, over a scrim.
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import type { ChangeEvent, MouseEvent, ReactNode } from "react";
import { cx } from "../format.ts";
import { Icon, type IconComponent } from "./icon.tsx";
import { Kbd, Mark } from "./primitives.tsx";

export interface CommandItem {
  key: string;
  label: string;
  icon?: IconComponent | undefined;
  /** Sent to the Agent instead of run; shows the mark instead of an icon. */
  ai?: boolean | undefined;
  kbd?: string | undefined;
}

export interface CommandSection {
  label: string;
  items: readonly CommandItem[];
}

export interface ScrimProps {
  onClose?: (() => void) | undefined;
  children?: ReactNode | undefined;
  className?: string | undefined;
}

/** The dimmed backdrop under an overlay. Clicking it closes the overlay. */
export function Scrim({ onClose, children, className }: ScrimProps) {
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose?.();
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a click on the backdrop closes; Escape is the Shell's
    <div className={cx("scrim", className)} onClick={onClick} role="presentation">
      {children}
    </div>
  );
}

export interface CommandPaletteProps {
  sections: readonly CommandSection[];
  /** The highlighted item. Defaults to the first one. */
  activeKey?: string | undefined;
  query?: string | undefined;
  onQuery?: ((query: string) => void) | undefined;
  onSelect?: ((item: CommandItem) => void) | undefined;
  onClose?: (() => void) | undefined;
  className?: string | undefined;
}

export function CommandPalette({
  sections,
  activeKey,
  query,
  onQuery,
  onSelect,
  onClose,
  className,
}: CommandPaletteProps) {
  const first = sections[0]?.items[0]?.key;
  const active = activeKey ?? first;
  return (
    <Scrim onClose={onClose}>
      <div className={cx("cmdk", className)} role="dialog" aria-label="Command palette">
        <div className="cmdk-in">
          <Icon icon={MagnifyingGlassIcon} />
          <input
            // biome-ignore lint/a11y/noAutofocus: the palette opens to take typing
            autoFocus
            placeholder="Search, jump, or ask"
            aria-label="Search, jump, or ask"
            {...(onQuery
              ? {
                  value: query ?? "",
                  onChange: (e: ChangeEvent<HTMLInputElement>) => onQuery(e.target.value),
                }
              : { defaultValue: query })}
          />
          <Kbd>esc</Kbd>
        </div>
        {sections.map((s) => (
          <div key={s.label}>
            <div className="cmdk-sec">{s.label}</div>
            {s.items.map((it) => (
              <div
                key={it.key}
                className={cx("cmdk-item", it.key === active && "on")}
                role="option"
                aria-selected={it.key === active}
                tabIndex={-1}
                onClick={() => onSelect?.(it)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSelect?.(it);
                }}
              >
                {it.ai ? <Mark small /> : it.icon ? <Icon icon={it.icon} /> : null}
                <span>{it.label}</span>
                {it.kbd ? <Kbd>{it.kbd}</Kbd> : null}
              </div>
            ))}
          </div>
        ))}
        <div className="cmdk-foot">
          <span>
            <Kbd>↑↓</Kbd> move
          </span>
          <span>
            <Kbd>↵</Kbd> select
          </span>
          <span>
            <Kbd>tab</Kbd> ask instead
          </span>
        </div>
      </div>
    </Scrim>
  );
}
