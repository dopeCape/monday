// The Filter menu under the list header's Filter button: the on/off filters
// (Unread, Starred, Has attachments, Needs a reply) and four panes, Year,
// Person, Domain and Date, whose choices come from the Cache with their
// counts (list-filter.ts). Arrows or J/K move, Enter or the right arrow
// picks, the left arrow or Escape goes back a pane, Escape on the first pane
// closes, a click outside closes. Typing in Person or Domain narrows the
// choices over the whole Cache. Handled keys stop here so the list keymap
// stays quiet. The chips a pick leaves are the list header's (FilterChips).

import type { Settings } from "@monday/shared";
import { Btn, Chip, cx, MONTH_SHORT } from "@monday/ui";
import { CaretLeftIcon, CaretRightIcon, CheckIcon, XIcon } from "@phosphor-icons/react";
import {
  type AnimationEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type Facet,
  type FacetKind,
  type FilterChip,
  type FlagKind,
  toggleFlag,
  withChip,
} from "./list-filter.ts";

type StringKey = Extract<keyof Settings, `strings.${string}`>;
export type FilterText = (key: StringKey) => string;

const fill = (template: string, vars: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));

const FLAG_LABEL: Record<FlagKind, StringKey> = {
  unread: "strings.inbox.filter.unread",
  starred: "strings.inbox.filter.starred",
  attachments: "strings.inbox.filter.attachments",
  needs_reply: "strings.inbox.filter.needs_reply",
};

/** "Sep 5", or "Sep 5, 2025" outside `now`'s year, for a picked day (YYYY-MM-DD). */
function dayLabel(ymd: string, now: Date): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  const year = Number(m[1]);
  const base = `${MONTH_SHORT[Number(m[2]) - 1] ?? ""} ${Number(m[3])}`;
  return year === now.getFullYear() ? base : `${base}, ${year}`;
}

/** What a chip says under the list header and on the Filter button. */
export function chipLabel(chip: FilterChip, t: FilterText, now: Date): string {
  switch (chip.kind) {
    case "unread":
    case "starred":
    case "attachments":
    case "needs_reply":
      return t(FLAG_LABEL[chip.kind]);
    case "year":
      return String(chip.year);
    case "person":
      return fill(t("strings.inbox.filter.chip.person"), { name: chip.name || chip.email });
    case "domain":
      return fill(t("strings.inbox.filter.chip.domain"), { domain: chip.domain });
    case "range":
      if (chip.range === "week") return t("strings.inbox.filter.week");
      if (chip.range === "month") return t("strings.inbox.filter.month");
      return fill(t("strings.inbox.filter.chip.dates"), {
        from: dayLabel(chip.from, now),
        to: dayLabel(chip.to, now),
      });
  }
}

/** The chips under the list header: each removes itself on click; Clear all when there are several. */
export function FilterChips({
  chips,
  t,
  now,
  onChange,
}: {
  chips: readonly FilterChip[];
  t: FilterText;
  now: Date;
  onChange: (chips: FilterChip[]) => void;
}) {
  if (chips.length === 0) return null;
  return (
    <div className="filter-chips">
      {chips.map((c) => {
        const label = chipLabel(c, t, now);
        const remove = fill(t("strings.inbox.filter.chip.remove"), { label });
        return (
          <Chip
            key={c.kind}
            on
            className="filter-chip"
            data-kind={c.kind}
            title={remove}
            aria-label={remove}
            onClick={() => onChange(chips.filter((x) => x !== c))}
          >
            <span>{label}</span>
            <XIcon className="filter-x" aria-hidden="true" />
          </Chip>
        );
      })}
      {chips.length > 1 ? (
        <button type="button" className="filter-chips-clear" onClick={() => onChange([])}>
          {t("strings.inbox.filter.clear_all")}
        </button>
      ) : null}
    </div>
  );
}

type Pane = "root" | FacetKind | "date";

interface MenuItem {
  key: string;
  label: string;
  detail?: string | undefined;
  title?: string | undefined;
  checked?: boolean;
  sub?: boolean;
  back?: boolean;
  run: () => void;
}

export interface FilterMenuProps {
  chips: readonly FilterChip[];
  t: FilterText;
  now: Date;
  /** Whether Needs a reply is offered (Sections on). */
  needsReply: boolean;
  /** A facet's choices over the list under the other filters, most Threads first. */
  facets: (kind: FacetKind, needle: string) => Promise<Facet[]>;
  onChange: (chips: FilterChip[]) => void;
  onClose: () => void;
  leaving?: boolean | undefined;
  onLeft?: (() => void) | undefined;
}

export function FilterMenu({
  chips,
  t,
  now,
  needsReply,
  facets,
  onChange,
  onClose,
  leaving,
  onLeft,
}: FilterMenuProps) {
  const [pane, setPane] = useState<Pane>("root");
  const [active, setActive] = useState(0);
  const [needle, setNeedle] = useState("");
  const [found, setFound] = useState<{ pane: Pane; needle: string; list: Facet[] } | null>(null);
  const [picking, setPicking] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const host = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  const has = (kind: FilterChip["kind"]) => chips.some((c) => c.kind === kind);
  const chipOf = <K extends FilterChip["kind"]>(kind: K) =>
    chips.find((c) => c.kind === kind) as Extract<FilterChip, { kind: K }> | undefined;
  const pick = useCallback(
    (next: FilterChip[]) => {
      if (leaving) return;
      onChange(next);
      onClose();
    },
    [leaving, onChange, onClose],
  );
  const go = (next: Pane) => {
    setPane(next);
    setActive(next === "root" ? 0 : 1);
    setNeedle("");
    setPicking(false);
  };

  // A facet pane reads its choices as it opens and as the user types; the last ask wins.
  useEffect(() => {
    if (pane === "root" || pane === "date") return;
    const mine = ++seq.current;
    facets(pane, needle).then(
      (list) => {
        if (mine === seq.current) setFound({ pane, needle, list });
      },
      () => {
        if (mine === seq.current) setFound({ pane, needle, list: [] });
      },
    );
  }, [pane, needle, facets]);

  const back: MenuItem = {
    key: "back",
    label: t("strings.inbox.filter.back"),
    back: true,
    run: () => go("root"),
  };
  const facetList = found && found.pane === pane ? found.list : [];
  let items: MenuItem[];
  let heading: string;
  if (pane === "root") {
    heading = t("strings.inbox.filter.title");
    const flags: FlagKind[] = needsReply
      ? ["unread", "starred", "attachments", "needs_reply"]
      : ["unread", "starred", "attachments"];
    const person = chipOf("person");
    const domain = chipOf("domain");
    const year = chipOf("year");
    const range = chipOf("range");
    items = [
      ...flags.map((f) => ({
        key: f,
        label: t(FLAG_LABEL[f]),
        checked: has(f),
        run: () => pick(toggleFlag(chips, f)),
      })),
      {
        key: "year",
        label: t("strings.inbox.filter.year"),
        detail: year ? String(year.year) : undefined,
        sub: true,
        run: () => go("year"),
      },
      {
        key: "person",
        label: t("strings.inbox.filter.person"),
        detail: person ? person.name || person.email : undefined,
        sub: true,
        run: () => go("person"),
      },
      {
        key: "domain",
        label: t("strings.inbox.filter.domain"),
        detail: domain ? domain.domain : undefined,
        sub: true,
        run: () => go("domain"),
      },
      {
        key: "date",
        label: t("strings.inbox.filter.date"),
        detail: range ? chipLabel(range, t, now) : undefined,
        sub: true,
        run: () => go("date"),
      },
      ...(chips.length > 0
        ? [{ key: "clear", label: t("strings.inbox.filter.clear"), run: () => pick([]) }]
        : []),
    ];
  } else if (pane === "date") {
    heading = t("strings.inbox.filter.date");
    const range = chipOf("range");
    items = [
      back,
      {
        key: "week",
        label: t("strings.inbox.filter.week"),
        checked: range?.range === "week",
        run: () => pick(withChip(chips, { kind: "range", range: "week" })),
      },
      {
        key: "month",
        label: t("strings.inbox.filter.month"),
        checked: range?.range === "month",
        run: () => pick(withChip(chips, { kind: "range", range: "month" })),
      },
      {
        key: "dates",
        label: t("strings.inbox.filter.dates"),
        checked: range?.range === "dates",
        run: () => {
          setPicking(true);
          queueMicrotask(() =>
            host.current?.querySelector<HTMLInputElement>(".pop-dates input")?.focus(),
          );
        },
      },
    ];
  } else {
    heading = t(`strings.inbox.filter.${pane}`);
    const current =
      pane === "year"
        ? String(chipOf("year")?.year ?? "")
        : pane === "person"
          ? (chipOf("person")?.email ?? "")
          : (chipOf("domain")?.domain ?? "");
    items = [
      back,
      ...facetList.map((f) => ({
        key: `${pane}:${f.key}`,
        label: f.label,
        detail: f.count.toLocaleString(),
        title: pane === "person" ? f.key : undefined,
        checked: f.key === current,
        run: () =>
          pick(
            withChip(
              chips,
              pane === "year"
                ? { kind: "year", year: Number(f.key) }
                : pane === "person"
                  ? { kind: "person", email: f.key, name: f.label === f.key ? "" : f.label }
                  : { kind: "domain", domain: f.key },
            ),
          ),
      })),
    ];
  }
  const typeAhead = pane === "person" || pane === "domain";

  // The first choice (or the search field) takes the focus as each pane opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the pane changes
  useEffect(() => {
    if (leaving) return;
    if (typeAhead) search.current?.focus();
    else host.current?.querySelectorAll<HTMLElement>(".pop-item")[active]?.focus();
  }, [pane, leaving]);

  useEffect(() => {
    if (leaving) {
      (document.activeElement as HTMLElement | null)?.blur?.();
      return;
    }
    const away = (e: MouseEvent) => {
      if (host.current && !host.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [onClose, leaving]);

  const onAnimationEnd = (e: AnimationEvent<HTMLDivElement>) => {
    if (leaving && e.target === e.currentTarget) onLeft?.();
  };
  const moveTo = (n: number) => {
    const i = Math.min(items.length - 1, Math.max(0, n));
    setActive(i);
    host.current?.querySelectorAll<HTMLElement>(".pop-item")[i]?.focus();
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const typing = target.tagName === "INPUT";
    const inSearch = target === search.current;
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      if (pane === "root") onClose();
      else go("root");
      return;
    }
    if (typing && !inSearch) {
      if (e.key === "Enter") {
        e.preventDefault();
        applyDates();
      }
      return;
    }
    const down = e.key === "ArrowDown" || (!typing && e.key === "j");
    const up = e.key === "ArrowUp" || (!typing && e.key === "k");
    if (down || up) {
      e.preventDefault();
      if (inSearch && down) moveTo(Math.min(items.length - 1, 1));
      else if (!inSearch && up && typeAhead && active <= 1) {
        setActive(1);
        search.current?.focus();
      } else moveTo(active + (down ? 1 : -1));
      return;
    }
    if (e.key === "Enter" || (!typing && (e.key === "ArrowRight" || e.key === "l"))) {
      const item = inSearch ? items[1] : items[active];
      if (!item) return;
      if (e.key !== "Enter" && !item.sub) return;
      e.preventDefault();
      item.run();
      return;
    }
    if (
      !typing &&
      pane !== "root" &&
      (e.key === "ArrowLeft" || e.key === "h" || e.key === "Backspace")
    ) {
      e.preventDefault();
      go("root");
    }
  };

  const applyDates = () => {
    if (!from) return;
    pick(withChip(chips, { kind: "range", range: "dates", from, to: to || from }));
  };

  return (
    <div
      ref={host}
      className={cx("pop filter-pop", leaving && "leaving")}
      role="dialog"
      aria-label={t("strings.inbox.filter")}
      data-pane={pane}
      onKeyDown={onKey}
      onAnimationEnd={onAnimationEnd}
    >
      <div className="pop-h">{heading}</div>
      {typeAhead ? (
        <div className="pop-pick">
          <input
            ref={search}
            className="input"
            type="search"
            value={needle}
            spellCheck={false}
            placeholder={t(
              pane === "person"
                ? "strings.inbox.filter.person.search"
                : "strings.inbox.filter.domain.search",
            )}
            aria-label={t(
              pane === "person"
                ? "strings.inbox.filter.person.search"
                : "strings.inbox.filter.domain.search",
            )}
            onChange={(e) => {
              setNeedle(e.target.value);
              setActive(1);
            }}
          />
        </div>
      ) : null}
      <div className="pop-list">
        {items.map((it, i) => (
          <button
            key={it.key}
            type="button"
            className={cx("pop-item", i === active && "on", it.back && "back")}
            aria-pressed={it.checked === undefined ? undefined : it.checked}
            title={it.title}
            onMouseEnter={() => setActive(i)}
            onClick={() => it.run()}
          >
            {it.back ? <CaretLeftIcon className="pop-ic" aria-hidden="true" /> : null}
            <span>{it.label}</span>
            {it.back ? null : <span className="when">{it.detail ?? ""}</span>}
            {it.checked ? <CheckIcon className="pop-check" aria-hidden="true" /> : null}
            {it.sub ? <CaretRightIcon className="pop-ic" aria-hidden="true" /> : null}
          </button>
        ))}
        {typeAhead && found?.pane === pane && facetList.length === 0 ? (
          <div className="pop-empty">{t("strings.inbox.filter.none")}</div>
        ) : null}
      </div>
      {pane === "date" && picking ? (
        <div className="pop-pick pop-dates">
          <label>
            <span>{t("strings.inbox.filter.dates.from")}</span>
            <input
              className="input"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label>
            <span>{t("strings.inbox.filter.dates.to")}</span>
            <input
              className="input"
              type="date"
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          <Btn sm primary disabled={!from} onClick={applyDates}>
            {t("strings.inbox.filter.dates.apply")}
          </Btn>
        </div>
      ) : null}
    </div>
  );
}
