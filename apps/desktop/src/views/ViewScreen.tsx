// A View as its own screen (docs/spec/views.md, "What the user sees"):
// opening a pinned View shows it in the list area like a Section, the reader
// beside or over it by the list knob, with the Inbox's rows, keys, row
// actions and multi-select (the Inbox renders it through its View lens).
// The header menu: Rename, Change icon, Move up or down in the nav, Show as,
// Show the source, Ask monday to change this view, Unpin, Delete (with
// Undo). Above the rows: the "check its first placements" bar for a View
// pinned without a test, and the offer to tighten a question the user keeps
// correcting. Every word is a strings.views.* Setting.

import type { LaneComponent, View, ViewDoc } from "@monday/shared";
import { LANE_COMPONENTS, showAs, VIEW_ICONS } from "@monday/shared";
import { Btn, Toast } from "@monday/ui";
import { DotsThreeIcon, XIcon } from "@phosphor-icons/react";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import type { ViewLens } from "../screens/Inbox.tsx";
import { Picker } from "../screens/inbox/Picker.tsx";
import { useShell } from "../shell/Shell.tsx";
import { useLaneView, useViews } from "./useViews.ts";
import { layoutOf, orderedThreads, ViewBlocks } from "./ViewBlocks.tsx";

const fill = (t: string, vars: Record<string, string | number>) =>
  t.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));

/** How many Threads the user moved out of each Lane in the last week. */
export function movesOutOf(view: View, now: Date): Record<string, number> {
  const week = now.getTime() - 7 * 86_400_000;
  const out: Record<string, number> = {};
  for (const p of Object.values(view.placements)) {
    if (!p.from || p.from === p.lane || Date.parse(p.at) < week) continue;
    out[p.from] = (out[p.from] ?? 0) + 1;
  }
  return out;
}

type Menu = null | "main" | "icon" | "show_as";

export interface ViewScreenProps {
  viewId: string;
  now: Date;
  /** Opens the Agent with a sentence ready (Ask monday to change this view, Tighten it). */
  onAsk(text: string): void;
  /** Leaves the View (after a delete whose Undo lapsed). */
  onLeave(): void;
  /** Draws the Inbox with the View lens. */
  render(lens: ViewLens): ReactNode;
}

export function ViewScreen({ viewId, now, onAsk, onLeave, render }: ViewScreenProps) {
  const shell = useShell();
  const s = shell.settings;
  const api = shell.api.views;
  const views = useViews();
  const live = views?.find((b) => b.id === viewId) ?? null;
  const [deleted, setDeleted] = useState<View | null>(null);
  const view = live ?? deleted;
  const { lanes } = useLaneView(view, now);
  const [menu, setMenu] = useState<Menu>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [source, setSource] = useState(false);
  const [countsLane, setCountsLane] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; undo: () => Promise<unknown> } | null>(null);

  const act = useCallback(async (run: () => Promise<unknown>) => {
    try {
      setError(null);
      await run();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  /** A new version of the document; Undo points the View back at the one it replaced. */
  const edit = useCallback(
    (change: (doc: ViewDoc) => ViewDoc, text: string) =>
      act(async () => {
        if (!view) return;
        const r = await api.update(view.id, change(view.doc));
        setToast({ text, undo: () => api.revert(view.id, r.previous) });
      }),
    [act, api, view],
  );

  const threads = useMemo(
    () => (view && lanes ? orderedThreads(view.doc, lanes, countsLane) : []),
    [view, lanes, countsLane],
  );

  if (!view) {
    return render({
      id: viewId,
      name: "",
      threads: [],
      header: null,
      render: () => <div className="empty-line">{s["strings.views.empty"]}</div>,
    });
  }

  const pick = (key: string) => {
    setMenu(null);
    switch (key) {
      case "rename":
        setRenaming(view.doc.name);
        return;
      case "icon":
        setMenu("icon");
        return;
      case "show_as":
        setMenu("show_as");
        return;
      case "up":
      case "down":
        void act(() => api.move(view.id, key === "up" ? -1 : 1));
        return;
      case "source":
        setSource(true);
        return;
      case "ask":
        onAsk(fill(s["strings.views.ask_change_prompt"], { view: view.doc.name }));
        return;
      case "unpin":
        void act(async () => {
          await api.pin(view.id, !view.pinned);
          setToast({ text: view.doc.name, undo: () => api.pin(view.id, view.pinned) });
        });
        return;
      case "delete":
        void act(async () => {
          await api.remove(view.id);
          setDeleted(view);
          setToast({
            text: fill(s["strings.views.deleted"], { view: view.doc.name }),
            undo: async () => {
              await api.restore(view.id);
              setDeleted(null);
            },
          });
        });
        return;
    }
  };

  const menuItems = [
    { key: "rename", label: s["strings.views.rename"] },
    { key: "icon", label: s["strings.views.change_icon"] },
    { key: "up", label: s["strings.views.move_up"] },
    { key: "down", label: s["strings.views.move_down"] },
    { key: "show_as", label: s["strings.views.show_as"] },
    { key: "source", label: s["strings.views.show_source"] },
    { key: "ask", label: s["strings.views.ask_change"] },
    {
      key: "unpin",
      label: view.pinned ? s["strings.views.unpin"] : s["strings.views.pin_again"],
    },
    { key: "delete", label: s["strings.views.delete"] },
  ];

  const moved = movesOutOf(view, now);
  const tighten = Object.entries(moved).find(([, n]) => n >= s["views.corrections.offer_after"]);
  const tightenLane = tighten ? view.doc.lanes.find((l) => l.id === tighten[0]) : undefined;

  const header = (
    <>
      <Btn
        sm
        icon
        className="view-menu-btn"
        aria-haspopup="menu"
        title={s["strings.views.menu"]}
        aria-label={s["strings.views.menu"]}
        onClick={() => setMenu((m) => (m ? null : "main"))}
      >
        <DotsThreeIcon />
      </Btn>
      {menu === "main" ? (
        <Picker
          label={s["strings.views.menu"]}
          items={menuItems}
          onPick={pick}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {menu === "icon" ? (
        <Picker
          label={s["strings.views.change_icon"]}
          title={s["strings.views.change_icon"]}
          items={VIEW_ICONS.map((i) => ({ key: i, label: i.replaceAll("-", " ") }))}
          onPick={(icon) => {
            setMenu(null);
            void edit((d) => ({ ...d, nav: { ...d.nav, icon } }), s["strings.views.change_icon"]);
          }}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {menu === "show_as" ? (
        <Picker
          label={s["strings.views.show_as"]}
          title={s["strings.views.show_as"]}
          items={LANE_COMPONENTS.map((c) => ({
            key: c,
            label: s[`strings.views.show_as.${c}`],
            ...(c === layoutOf(view.doc).component ? { detail: "✓" } : {}),
          }))}
          onPick={(c) => {
            setMenu(null);
            void edit(
              (d) => showAs(d, c as LaneComponent),
              s[`strings.views.show_as.${c as LaneComponent}`],
            );
          }}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </>
  );

  const above = (
    <>
      {renaming !== null ? (
        <form
          className="view-bar view-rename"
          onSubmit={(e) => {
            e.preventDefault();
            const name = renaming.trim();
            setRenaming(null);
            if (name && name !== view.doc.name) {
              void edit((d) => ({ ...d, name }), s["strings.views.rename"]);
            }
          }}
        >
          <input
            // biome-ignore lint/a11y/noAutofocus: the field opens on Rename, where the user is about to type
            autoFocus
            value={renaming}
            aria-label={s["strings.views.rename"]}
            onChange={(e) => setRenaming(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setRenaming(null);
              e.stopPropagation();
            }}
          />
          <Btn sm primary type="submit">
            {s["strings.views.rename"]}
          </Btn>
        </form>
      ) : null}
      {view.checkBar ? (
        <div className="view-bar" role="status">
          <span>{s["strings.views.check_bar"]}</span>
          <Btn sm onClick={() => void act(() => api.dismissCheck(view.id))}>
            {s["strings.views.dismiss"]}
          </Btn>
        </div>
      ) : null}
      {tighten && tightenLane ? (
        <div className="view-bar" role="status">
          <span>
            {fill(s["strings.views.tighten"], { count: tighten[1], lane: tightenLane.label })}
          </span>
          <Btn
            sm
            onClick={() => onAsk(fill(s["strings.views.tighten_prompt"], { view: view.doc.name }))}
          >
            {s["strings.views.tighten_action"]}
          </Btn>
        </div>
      ) : null}
      {error ? (
        <div className="view-bar err" role="alert">
          {error}
        </div>
      ) : null}
      {source ? (
        <div className="view-source" role="dialog" aria-label={s["strings.views.show_source"]}>
          <div className="view-source-h">
            <b>
              {fill(s["strings.views.source_title"], {
                view: view.doc.name,
                version: view.version,
              })}
            </b>
            <Btn sm icon aria-label={s["strings.views.dismiss"]} onClick={() => setSource(false)}>
              <XIcon />
            </Btn>
          </div>
          <pre>{JSON.stringify(view.doc, null, 2)}</pre>
        </div>
      ) : null}
      {toast ? (
        <Toast
          text={toast.text}
          undoLabel={s["strings.views.undo"]}
          undoKey=""
          ms={s["inbox.undo_toast_ms"]}
          onUndo={() => {
            const undo = toast.undo;
            setToast(null);
            void act(undo);
          }}
          onExpire={() => {
            setToast(null);
            if (deleted) onLeave();
          }}
        />
      ) : null}
    </>
  );

  return render({
    id: view.id,
    name: view.doc.name,
    threads,
    header,
    above,
    render: (ctx) =>
      lanes ? (
        lanes.total === 0 && layoutOf(view.doc).component !== "lanes" ? (
          <div className="empty-line">{s["strings.views.empty"]}</div>
        ) : (
          <ViewBlocks
            doc={view.doc}
            result={lanes}
            settings={s}
            now={now}
            row={ctx.row}
            focus={ctx.focus}
            open={ctx.open}
            countsLane={countsLane}
            onCountsLane={setCountsLane}
            onMove={
              deleted
                ? undefined
                : (threadId, lane) => void act(() => api.place(view.id, threadId, lane))
            }
          />
        )
      ) : null,
  });
}
