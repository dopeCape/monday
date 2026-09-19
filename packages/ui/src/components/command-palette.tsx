// The command palette (⌘K): search, jump, or ask, over a scrim. One input;
// sections of items, each an action, a place to go, a Thread row or a line
// for the Agent. The keys are handled here on the input: arrows move, Enter
// selects, Tab hands the text to the Agent, Escape closes.
import type { Thread } from "@monday/shared";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import {
  type AnimationEvent,
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useRef,
} from "react";
import { cx } from "../format.ts";
import { Icon, type IconComponent } from "./icon.tsx";
import { MessageRow } from "./message-row.tsx";
import { Kbd, Mark } from "./primitives.tsx";

export interface CommandItem {
  key: string;
  label: string;
  icon?: IconComponent | undefined;
  /** Sent to the Agent instead of run; shows the mark instead of an icon. */
  ai?: boolean | undefined;
  kbd?: string | undefined;
  /** Rendered as a Thread row in the list's visual language. */
  thread?: Thread | undefined;
  /** The account label after the row, in the all-accounts view. */
  account?: string | undefined;
  /** A matched passage that replaces the Thread's own snippet in the row. */
  snippet?: string | undefined;
}

export interface CommandSection {
  label: string;
  items: readonly CommandItem[];
}

export interface ScrimProps {
  onClose?: (() => void) | undefined;
  children?: ReactNode | undefined;
  className?: string | undefined;
  /** On its way out: the leave animation runs and clicks no longer land. */
  leaving?: boolean | undefined;
  /** The leave animation ended (the scrim's own, not a child's). */
  onLeft?: (() => void) | undefined;
}

/** The dimmed backdrop under an overlay. Clicking it closes the overlay. */
export function Scrim({ onClose, children, className, leaving, onLeft }: ScrimProps) {
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if (leaving) return;
    if (e.target === e.currentTarget) onClose?.();
  };
  const onAnimationEnd = (e: AnimationEvent<HTMLDivElement>) => {
    if (leaving && e.target === e.currentTarget) onLeft?.();
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a click on the backdrop closes; Escape is the Shell's
    <div
      className={cx("scrim", leaving && "leaving", className)}
      onClick={onClick}
      onAnimationEnd={onAnimationEnd}
      role="presentation"
    >
      {children}
    </div>
  );
}

export interface CommandPaletteStrings {
  placeholder: string;
  move: string;
  select: string;
  ask: string;
  /** Shown under the input when a section has no items, such as a search with no hits. */
  empty?: string | undefined;
}

const DEFAULT_STRINGS: CommandPaletteStrings = {
  placeholder: "Search, jump, or ask",
  move: "move",
  select: "select",
  ask: "ask instead",
};

export interface CommandPaletteProps {
  sections: readonly CommandSection[];
  /** The highlighted item. Defaults to the first one. */
  activeKey?: string | undefined;
  query?: string | undefined;
  onQuery?: ((query: string) => void) | undefined;
  onSelect?: ((item: CommandItem) => void) | undefined;
  /** Arrow keys: -1 up, +1 down. Without it the arrows do nothing. */
  onMove?: ((delta: number) => void) | undefined;
  /** Tab: hand the text to the Agent. */
  onAsk?: ((query: string) => void) | undefined;
  /** Enter with the active item, or with nothing active. */
  onSubmit?: ((query: string) => void) | undefined;
  onClose?: (() => void) | undefined;
  onHover?: ((key: string) => void) | undefined;
  strings?: Partial<CommandPaletteStrings> | undefined;
  /** For Thread rows' relative times. */
  now?: Date | undefined;
  className?: string | undefined;
  /** On its way out: the input lets go of the focus and the scrim runs its leave. */
  leaving?: boolean | undefined;
  onLeft?: (() => void) | undefined;
}

export function CommandPalette({
  sections,
  activeKey,
  query,
  onQuery,
  onSelect,
  onMove,
  onAsk,
  onSubmit,
  onClose,
  onHover,
  strings: overrides,
  now,
  className,
  leaving,
  onLeft,
}: CommandPaletteProps) {
  const s = { ...DEFAULT_STRINGS, ...overrides };
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (leaving) input.current?.blur();
  }, [leaving]);
  const first = sections[0]?.items[0]?.key;
  const active = activeKey ?? first;
  const activeItem = sections.flatMap((sec) => sec.items).find((it) => it.key === active);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!onMove) return;
      e.preventDefault();
      onMove(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeItem) onSelect?.(activeItem);
      else onSubmit?.(query ?? "");
    } else if (e.key === "Tab" && onAsk) {
      e.preventDefault();
      onAsk(query ?? "");
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose?.();
    }
  };

  return (
    <Scrim onClose={onClose} leaving={leaving} onLeft={onLeft}>
      <div className={cx("cmdk", className)} role="dialog" aria-label={s.placeholder}>
        <div className="cmdk-in">
          <Icon icon={MagnifyingGlassIcon} />
          <input
            ref={input}
            // biome-ignore lint/a11y/noAutofocus: the palette opens to take typing
            autoFocus
            placeholder={s.placeholder}
            aria-label={s.placeholder}
            aria-activedescendant={active ? `cmdk-${active}` : undefined}
            onKeyDown={onKeyDown}
            {...(onQuery
              ? {
                  value: query ?? "",
                  onChange: (e: ChangeEvent<HTMLInputElement>) => onQuery(e.target.value),
                }
              : { defaultValue: query })}
          />
          <Kbd>esc</Kbd>
        </div>
        {sections.map((sec) => (
          <div key={sec.label}>
            <div className="cmdk-sec">{sec.label}</div>
            {sec.items.length === 0 && s.empty ? <div className="cmdk-empty">{s.empty}</div> : null}
            {sec.items.map((it) =>
              it.thread ? (
                <div
                  key={it.key}
                  id={`cmdk-${it.key}`}
                  className={cx("cmdk-thread", it.key === active && "on")}
                  onMouseEnter={() => onHover?.(it.key)}
                >
                  <MessageRow
                    thread={it.snippet ? { ...it.thread, snippet: it.snippet } : it.thread}
                    selected={it.key === active}
                    now={now}
                    account={it.account}
                    onOpen={() => onSelect?.(it)}
                  />
                </div>
              ) : (
                <div
                  key={it.key}
                  id={`cmdk-${it.key}`}
                  className={cx("cmdk-item", it.key === active && "on")}
                  role="option"
                  aria-selected={it.key === active}
                  tabIndex={-1}
                  onClick={() => onSelect?.(it)}
                  onMouseEnter={() => onHover?.(it.key)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onSelect?.(it);
                  }}
                >
                  {it.ai ? <Mark small /> : it.icon ? <Icon icon={it.icon} /> : null}
                  <span>{it.label}</span>
                  {it.kbd ? <Kbd>{it.kbd}</Kbd> : null}
                </div>
              ),
            )}
          </div>
        ))}
        <div className="cmdk-foot">
          <span>
            <Kbd>↑↓</Kbd> {s.move}
          </span>
          <span>
            <Kbd>↵</Kbd> {s.select}
          </span>
          <span>
            <Kbd>tab</Kbd> {s.ask}
          </span>
        </div>
      </div>
    </Scrim>
  );
}
