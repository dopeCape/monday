// The `view` Panel (docs/spec/views.md, "The Block catalog", Panels): a
// View's first counts or stat Block placed in the Layout above the Inbox,
// beside the Today panel; a View with neither shows its Lane counts. A
// View is the data; the Panel is one way to show it. The Setting
// views.panel names the View (the Agent places it with change_setting);
// each count opens the View.

import type { BlockData } from "@monday/shared";
import { formatAggregate, formatChange } from "@monday/shared";
import { cx, StatTile } from "@monday/ui";
import { useMemo } from "react";
import { useShell } from "../shell/Shell.tsx";
import type { CachedViewThread } from "../store/views.ts";
import { useViewBase, useViews } from "./useViews.ts";
import { viewBlockData } from "./ViewBlocks.tsx";

export function ViewPanel({ now, onOpen }: { now: Date; onOpen(viewId: string): void }) {
  const shell = useShell();
  const s = shell.settings;
  const id = s["views.panel"];
  const views = useViews();
  const view = id ? (views?.find((b) => b.id === id) ?? null) : null;
  const { base } = useViewBase(view, now);
  const data = useMemo(() => (view && base ? viewBlockData(view, base, s) : []), [view, base, s]);
  if (!view || !base) return null;
  const shown = data.find(
    (
      d,
    ): d is Extract<BlockData<CachedViewThread>, { type: "stat" | "lanes" | "list" | "counts" }> =>
      d.type === "counts" || d.type === "stat",
  );
  const groups =
    shown?.type === "counts"
      ? shown.groups
      : base.lanes.lanes.map((l) => ({ id: l.id, label: l.label, tone: l.tone, rows: l.rows }));
  return (
    <section className="view-panel" data-view={view.id} aria-label={view.doc.name}>
      <button type="button" className="view-panel-h" onClick={() => onOpen(view.id)}>
        {view.doc.name}
      </button>
      {shown?.type === "stat" ? (
        <button type="button" className="view-panel-stat" onClick={() => onOpen(view.id)}>
          <StatTile
            label={shown.block.title ?? ""}
            value={formatAggregate(shown.value, shown.block.format) || "0"}
            change={(() => {
              const text = formatChange(shown.change, {
                up: s["strings.views.change.up"],
                down: s["strings.views.change.down"],
                same: s["strings.views.change.same"],
              });
              if (!text || shown.change === null) return null;
              return { text, dir: shown.change > 0 ? "up" : shown.change < 0 ? "down" : "same" };
            })()}
          />
        </button>
      ) : (
        <div className="view-counts">
          {groups.map((lane) => (
            <button
              key={lane.id}
              type="button"
              className={cx("view-count")}
              data-tone={lane.tone}
              data-lane={lane.id}
              onClick={() => onOpen(view.id)}
            >
              <span className="dot" aria-hidden="true" />
              {lane.label}
              <b>{lane.rows.length}</b>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
