// The pictures a View's Blocks draw (docs/spec/views.md, "The Block
// catalog"): bars, stacked bars, lines and areas, a donut, a heatmap, a
// month grid and a stat tile. Plain SVG and markup over monday's own colour
// tokens, no chart library. Purely presentational: numbers and labels in,
// a pick callback out; the words come from the caller.

import type { ReactNode } from "react";
import { cx } from "../format.ts";

/** The series colours, in order: the palette's accent, semantic and tag tokens. */
export const CHART_COLORS = [
  "var(--accent)",
  "var(--info)",
  "var(--success)",
  "var(--warning)",
  "var(--danger)",
  "var(--tag-1)",
  "var(--tag-2)",
  "var(--tag-3)",
  "var(--tag-4)",
  "var(--tag-5)",
];

export const chartColor = (i: number) => CHART_COLORS[i % CHART_COLORS.length] as string;

export interface ChartItem {
  key: string;
  label: string;
  value: number;
  /** The value in words ("$41.97"); the number when absent. */
  text?: string | undefined;
}

const W = 48;
const H = 120;
const LABEL = 18;

const shortLabel = (s: string, n = 8) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Vertical bars, one per item, the value on hover; a click picks the item. */
export function BarChart({
  items,
  label,
  picked,
  onPick,
  height = H,
}: {
  items: readonly ChartItem[];
  label: string;
  picked?: string | null | undefined;
  onPick?: ((key: string) => void) | undefined;
  height?: number | undefined;
}) {
  const max = Math.max(0, ...items.map((i) => i.value)) || 1;
  const width = Math.max(items.length, 1) * W;
  return (
    <svg
      className="view-chart bar"
      viewBox={`0 0 ${width} ${height + LABEL}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={label}
    >
      {items.map((it, i) => {
        const h = Math.max(it.value > 0 ? 2 : 0, (it.value / max) * (height - 14));
        const x = i * W + 8;
        return (
          // biome-ignore lint/a11y/useSemanticElements: an SVG bar is the picker, a button cannot sit in SVG
          <g
            key={it.key}
            className={cx("bar-g", picked === it.key && "on")}
            data-key={it.key}
            role="button"
            tabIndex={onPick ? 0 : -1}
            onClick={onPick ? () => onPick(it.key) : undefined}
            onKeyDown={
              onPick
                ? (e) => {
                    if (e.key === "Enter" || e.key === " ") onPick(it.key);
                  }
                : undefined
            }
          >
            <title>{`${it.label}: ${it.text ?? it.value}`}</title>
            <rect x={x} y={height - h} width={W - 16} height={h} rx={3} fill={chartColor(0)} />
            <text x={x + (W - 16) / 2} y={height - h - 4} className="v" textAnchor="middle">
              {shortLabel(it.text ?? String(it.value), 9)}
            </text>
            <text x={x + (W - 16) / 2} y={height + 13} className="l" textAnchor="middle">
              {shortLabel(it.label)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export interface StackedGroup {
  key: string;
  label: string;
  /** One value per series, in the series' order. */
  values: readonly number[];
}

/** Bars made of stacked series, one colour per series, with a legend. */
export function StackedBarChart({
  groups,
  series,
  label,
  onPick,
}: {
  groups: readonly StackedGroup[];
  series: readonly { key: string; label: string }[];
  label: string;
  onPick?: ((key: string) => void) | undefined;
}) {
  const totals = groups.map((g) => g.values.reduce((a, b) => a + b, 0));
  const max = Math.max(0, ...totals) || 1;
  const width = Math.max(groups.length, 1) * W;
  return (
    <div className="view-chart-wrap">
      <svg
        className="view-chart stacked"
        viewBox={`0 0 ${width} ${H + LABEL}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={label}
      >
        {groups.map((g, i) => {
          let y = H;
          const x = i * W + 8;
          return (
            // biome-ignore lint/a11y/useSemanticElements: an SVG bar is the picker
            <g
              key={g.key}
              data-key={g.key}
              role="button"
              tabIndex={onPick ? 0 : -1}
              onClick={onPick ? () => onPick(g.key) : undefined}
              onKeyDown={onPick ? (e) => e.key === "Enter" && onPick(g.key) : undefined}
            >
              <title>{`${g.label}: ${totals[i]}`}</title>
              {g.values.map((v, s) => {
                const h = (v / max) * (H - 14);
                y -= h;
                return (
                  <rect
                    key={series[s]?.key ?? s}
                    x={x}
                    y={y}
                    width={W - 16}
                    height={h}
                    fill={chartColor(s)}
                  />
                );
              })}
              <text x={x + (W - 16) / 2} y={H + 13} className="l" textAnchor="middle">
                {shortLabel(g.label)}
              </text>
            </g>
          );
        })}
      </svg>
      <Legend
        items={series.map((s, i) => ({ key: s.key, label: s.label, color: chartColor(i) }))}
      />
    </div>
  );
}

/** A line through the items, filled underneath when `area`. */
export function LineChart({
  items,
  label,
  area,
  onPick,
}: {
  items: readonly ChartItem[];
  label: string;
  area?: boolean | undefined;
  onPick?: ((key: string) => void) | undefined;
}) {
  const max = Math.max(0, ...items.map((i) => i.value)) || 1;
  const width = Math.max(items.length, 1) * W;
  const pts = items.map((it, i) => ({
    it,
    x: i * W + W / 2,
    y: H - 6 - (it.value / max) * (H - 20),
  }));
  const line = pts.map((p) => `${p.x},${p.y}`).join(" ");
  const first = pts[0];
  const last = pts[pts.length - 1];
  return (
    <svg
      className={cx("view-chart line", area && "area")}
      viewBox={`0 0 ${width} ${H + LABEL}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={label}
    >
      {area && first && last ? (
        <polygon
          points={`${first.x},${H} ${line} ${last.x},${H}`}
          fill={chartColor(0)}
          opacity={0.18}
        />
      ) : null}
      <polyline points={line} fill="none" stroke={chartColor(0)} strokeWidth={2} />
      {pts.map((p) => (
        // biome-ignore lint/a11y/useSemanticElements: an SVG point is the picker
        <g
          key={p.it.key}
          data-key={p.it.key}
          role="button"
          tabIndex={onPick ? 0 : -1}
          onClick={onPick ? () => onPick(p.it.key) : undefined}
          onKeyDown={onPick ? (e) => e.key === "Enter" && onPick(p.it.key) : undefined}
        >
          <title>{`${p.it.label}: ${p.it.text ?? p.it.value}`}</title>
          <circle cx={p.x} cy={p.y} r={3.5} fill={chartColor(0)} />
          <text x={p.x} y={H + 13} className="l" textAnchor="middle">
            {shortLabel(p.it.label)}
          </text>
        </g>
      ))}
    </svg>
  );
}

/** A ring of slices with a legend beside it. */
export function DonutChart({
  items,
  label,
  onPick,
}: {
  items: readonly ChartItem[];
  label: string;
  onPick?: ((key: string) => void) | undefined;
}) {
  const total = items.reduce((n, i) => n + Math.max(0, i.value), 0) || 1;
  const r = 40;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="view-chart-wrap donut">
      <svg className="view-chart donut" viewBox="0 0 120 120" role="img" aria-label={label}>
        <circle cx={60} cy={60} r={r} fill="none" stroke="var(--sunken)" strokeWidth={18} />
        {items.map((it, i) => {
          const part = (Math.max(0, it.value) / total) * c;
          const dash = `${part} ${c - part}`;
          const el = (
            // biome-ignore lint/a11y/useSemanticElements: an SVG slice is the picker
            <circle
              key={it.key}
              data-key={it.key}
              role="button"
              tabIndex={onPick ? 0 : -1}
              cx={60}
              cy={60}
              r={r}
              fill="none"
              stroke={chartColor(i)}
              strokeWidth={18}
              strokeDasharray={dash}
              strokeDashoffset={-offset}
              transform="rotate(-90 60 60)"
              onClick={onPick ? () => onPick(it.key) : undefined}
              onKeyDown={onPick ? (e) => e.key === "Enter" && onPick(it.key) : undefined}
            >
              <title>{`${it.label}: ${it.text ?? it.value}`}</title>
            </circle>
          );
          offset += part;
          return el;
        })}
      </svg>
      <Legend
        items={items.map((it, i) => ({
          key: it.key,
          label: `${it.label} ${it.text ?? it.value}`,
          color: chartColor(i),
        }))}
      />
    </div>
  );
}

function Legend({ items }: { items: readonly { key: string; label: string; color: string }[] }) {
  return (
    <ul className="view-legend">
      {items.map((i) => (
        <li key={i.key}>
          <span className="sw" style={{ background: i.color }} aria-hidden="true" />
          {i.label}
        </li>
      ))}
    </ul>
  );
}

/** Counts in a grid (weekday by hour), each cell's colour by how many. */
export function Heatmap({
  rows,
  cols,
  cells,
  max,
  label,
  cellTitle,
}: {
  rows: readonly string[];
  cols: readonly string[];
  cells: readonly (readonly number[])[];
  max: number;
  label: string;
  cellTitle?: ((row: number, col: number, n: number) => string) | undefined;
}) {
  const cw = 14;
  const lw = 30;
  return (
    <svg
      className="view-chart heat"
      viewBox={`0 0 ${lw + cols.length * cw} ${rows.length * cw + 14}`}
      preserveAspectRatio="xMinYMin meet"
      role="img"
      aria-label={label}
    >
      {rows.map((r, ri) => (
        <text key={r} x={0} y={ri * cw + 10} className="l">
          {r}
        </text>
      ))}
      {cells.map((row, ri) =>
        row.map((n, ci) => (
          <rect
            // biome-ignore lint/suspicious/noArrayIndexKey: a grid cell is its position
            key={`${ri}:${ci}`}
            x={lw + ci * cw}
            y={ri * cw}
            width={cw - 2}
            height={cw - 2}
            rx={2}
            fill={n > 0 ? chartColor(0) : "var(--sunken)"}
            opacity={n > 0 ? 0.25 + 0.75 * (n / (max || 1)) : 1}
            data-n={n}
          >
            <title>{cellTitle ? cellTitle(ri, ci, n) : String(n)}</title>
          </rect>
        )),
      )}
      {cols.map((c, ci) =>
        ci % 3 === 0 ? (
          <text key={c} x={lw + ci * cw} y={rows.length * cw + 11} className="l">
            {c}
          </text>
        ) : null,
      )}
    </svg>
  );
}

export interface MonthItem {
  key: string;
  /** YYYY-MM-DD */
  day: string;
  label: string;
  tone?: string | undefined;
}

/** A month as weeks of days (Monday first), each day with its items; buttons for the months around it. */
export function MonthGrid({
  year,
  month,
  items,
  title,
  weekdays,
  prevLabel,
  nextLabel,
  onPrev,
  onNext,
  onPick,
  today,
}: {
  year: number;
  /** 1 to 12 */
  month: number;
  items: readonly MonthItem[];
  title: string;
  weekdays: readonly string[];
  prevLabel: string;
  nextLabel: string;
  onPrev(): void;
  onNext(): void;
  onPick?: ((key: string) => void) | undefined;
  /** YYYY-MM-DD */
  today?: string | undefined;
}) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const lead = (first.getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells: Array<number | null> = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: days }, (_, i) => i + 1),
  ];
  while (cells.length % 7) cells.push(null);
  const pad = (n: number) => String(n).padStart(2, "0");
  const byDay = new Map<string, MonthItem[]>();
  for (const it of items) byDay.set(it.day, [...(byDay.get(it.day) ?? []), it]);
  return (
    <div className="view-month">
      <div className="view-month-h">
        <button type="button" className="btn sm icon" aria-label={prevLabel} onClick={onPrev}>
          ‹
        </button>
        <b>{title}</b>
        <button type="button" className="btn sm icon" aria-label={nextLabel} onClick={onNext}>
          ›
        </button>
      </div>
      <div className="view-month-grid">
        {weekdays.map((w) => (
          <span key={w} className="wd">
            {w}
          </span>
        ))}
        {cells.map((d, i) => {
          const key = d ? `${year}-${pad(month)}-${pad(d)}` : null;
          const list = key ? (byDay.get(key) ?? []) : [];
          return (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: a day cell is its position
              key={i}
              className={cx("day", !d && "blank", key === today && "today")}
              data-day={key ?? undefined}
            >
              {d ? <span className="n">{d}</span> : null}
              {list.map((it) => (
                <button
                  key={it.key}
                  type="button"
                  className="ev"
                  data-tone={it.tone}
                  title={it.label}
                  onClick={onPick ? () => onPick(it.key) : undefined}
                >
                  {it.label}
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** One big number with its label, the change from the previous period, and a note. */
export function StatTile({
  label,
  value,
  change,
  note,
}: {
  label: string;
  value: string;
  change?: { text: string; dir: "up" | "down" | "same" } | null | undefined;
  note?: ReactNode;
}) {
  return (
    <div className="view-stat">
      <span className="lab">{label}</span>
      <b className="num">{value}</b>
      {change ? (
        <span className="chg" data-dir={change.dir}>
          {change.text}
        </span>
      ) : null}
      {note ? <span className="note">{note}</span> : null}
    </div>
  );
}
