/// <reference types="bun-types" />
// The View Blocks' pictures (docs/spec/views.md, "The Block catalog"): each
// draws from numbers and labels in plain SVG with the palette's tokens, and
// no user-facing word carries an em-dash.
import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import {
  BarChart,
  DonutChart,
  Heatmap,
  LineChart,
  MonthGrid,
  StackedBarChart,
  StatTile,
} from "./index.ts";

const items = [
  { key: "2026-09", label: "Sep", value: 41.97, text: "$41.97" },
  { key: "2026-10", label: "Oct", value: 120, text: "$120.00" },
];

describe("View charts", () => {
  test("bars: one per item, the tallest the largest, the value in words, tokens only", () => {
    const html = renderToString(<BarChart items={items} label="Spend per month" />);
    expect(html).toContain('aria-label="Spend per month"');
    expect((html.match(/<rect/g) ?? []).length).toBe(2);
    expect(html).toContain("$120.00");
    expect(html).toContain("var(--accent)");
    expect(html).not.toMatch(/#[0-9a-f]{6}/i);
  });

  test("stacked bars, a line with its area, and a donut with its legend", () => {
    const stacked = renderToString(
      <StackedBarChart
        label="By status"
        groups={[{ key: "a", label: "Sep", values: [1, 2] }]}
        series={[
          { key: "x", label: "Shipped" },
          { key: "y", label: "Delivered" },
        ]}
      />,
    );
    expect(stacked).toContain("Delivered");
    expect((stacked.match(/<rect/g) ?? []).length).toBe(2);
    const line = renderToString(<LineChart items={items} label="Trend" area />);
    expect(line).toContain("<polyline");
    expect(line).toContain("<polygon");
    const donut = renderToString(<DonutChart items={items} label="Share" />);
    expect(donut).toContain("Oct $120.00");
  });

  test("a heatmap cell per slot, a month grid with its items, a stat with its change", () => {
    const heat = renderToString(
      <Heatmap
        rows={["Mon", "Tue"]}
        cols={["00", "01", "02"]}
        cells={[
          [0, 1, 2],
          [3, 0, 0],
        ]}
        max={3}
        label="When"
      />,
    );
    expect((heat.match(/<rect/g) ?? []).length).toBe(6);
    const month = renderToString(
      <MonthGrid
        year={2026}
        month={11}
        title="November 2026"
        weekdays={["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]}
        items={[{ key: "flight", day: "2026-11-04", label: "Flight to Lisbon" }]}
        prevLabel="Previous month"
        nextLabel="Next month"
        onPrev={() => {}}
        onNext={() => {}}
      />,
    );
    expect(month).toContain('data-day="2026-11-04"');
    expect(month).toContain("Flight to Lisbon");
    const stat = renderToString(
      <StatTile label="Spent this month" value="$120.00" change={{ text: "up 186%", dir: "up" }} />,
    );
    expect(stat).toContain('data-dir="up"');
    for (const html of [heat, month, stat]) expect(html).not.toContain(String.fromCharCode(0x2014));
  });
});
