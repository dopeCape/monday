// The `view` Panel (docs/spec/views.md, "Panels"): a View's Lane counts
// placed in the Layout above the Inbox, beside the Today panel. A View is
// the data; the Panel is one way to show it. The Setting views.panel names
// the View (the Agent places it with change_setting); each count opens the
// View.

import { cx } from "@monday/ui";
import { useShell } from "../shell/Shell.tsx";
import { useLaneView, useViews } from "./useViews.ts";

export function ViewPanel({ now, onOpen }: { now: Date; onOpen(viewId: string): void }) {
  const shell = useShell();
  const id = shell.settings["views.panel"];
  const views = useViews();
  const view = id ? (views?.find((b) => b.id === id) ?? null) : null;
  const { lanes } = useLaneView(view, now);
  if (!view || !lanes) return null;
  return (
    <section className="view-panel" data-view={view.id} aria-label={view.doc.name}>
      <button type="button" className="view-panel-h" onClick={() => onOpen(view.id)}>
        {view.doc.name}
      </button>
      <div className="view-counts">
        {lanes.lanes.map((lane) => (
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
    </section>
  );
}
