// A Board as its own screen (docs/spec/boards.md, "What the user sees"):
// opening a pinned Board shows it in the list area like a Section, the reader
// beside or over it by the list knob, with the Inbox's rows, keys, row
// actions and multi-select (the Inbox renders it through its Board lens).
// The header menu: Rename, Change icon, Move up or down in the nav, Show as,
// Show the source, Ask monday to change this board, Unpin, Delete (with
// Undo). Above the rows: the "check its first placements" bar for a Board
// pinned without a test, and the offer to tighten a question the user keeps
// correcting. Every word is a strings.boards.* Setting.

import type { Board, BoardComponent, BoardDoc } from "@monday/shared";
import { BOARD_COMPONENTS, BOARD_ICONS, layoutForComponent } from "@monday/shared";
import { Btn, Toast } from "@monday/ui";
import { DotsThreeIcon, XIcon } from "@phosphor-icons/react";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import type { BoardLens } from "../screens/Inbox.tsx";
import { Picker } from "../screens/inbox/Picker.tsx";
import { useShell } from "../shell/Shell.tsx";
import { BoardLayout, orderedThreads } from "./BoardLayout.tsx";
import { useBoards, useBoardView } from "./useBoards.ts";

const fill = (t: string, vars: Record<string, string | number>) =>
  t.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));

/** How many Threads the user moved out of each Lane in the last week. */
export function movesOutOf(board: Board, now: Date): Record<string, number> {
  const week = now.getTime() - 7 * 86_400_000;
  const out: Record<string, number> = {};
  for (const p of Object.values(board.placements)) {
    if (!p.from || p.from === p.lane || Date.parse(p.at) < week) continue;
    out[p.from] = (out[p.from] ?? 0) + 1;
  }
  return out;
}

type Menu = null | "main" | "icon" | "show_as";

export interface BoardScreenProps {
  boardId: string;
  now: Date;
  /** Opens the Agent with a sentence ready (Ask monday to change this board, Tighten it). */
  onAsk(text: string): void;
  /** Leaves the Board (after a delete whose Undo lapsed). */
  onLeave(): void;
  /** Draws the Inbox with the Board lens. */
  render(lens: BoardLens): ReactNode;
}

export function BoardScreen({ boardId, now, onAsk, onLeave, render }: BoardScreenProps) {
  const shell = useShell();
  const s = shell.settings;
  const api = shell.api.boards;
  const boards = useBoards();
  const live = boards?.find((b) => b.id === boardId) ?? null;
  const [deleted, setDeleted] = useState<Board | null>(null);
  const board = live ?? deleted;
  const { view } = useBoardView(board, now);
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

  /** A new version of the document; Undo points the Board back at the one it replaced. */
  const edit = useCallback(
    (change: (doc: BoardDoc) => BoardDoc, text: string) =>
      act(async () => {
        if (!board) return;
        const r = await api.update(board.id, change(board.doc));
        setToast({ text, undo: () => api.revert(board.id, r.previous) });
      }),
    [act, api, board],
  );

  const threads = useMemo(
    () => (board && view ? orderedThreads(board.doc, view, countsLane) : []),
    [board, view, countsLane],
  );

  if (!board) {
    return render({
      id: boardId,
      name: "",
      threads: [],
      header: null,
      render: () => <div className="empty-line">{s["strings.boards.empty"]}</div>,
    });
  }

  const pick = (key: string) => {
    setMenu(null);
    switch (key) {
      case "rename":
        setRenaming(board.doc.name);
        return;
      case "icon":
        setMenu("icon");
        return;
      case "show_as":
        setMenu("show_as");
        return;
      case "up":
      case "down":
        void act(() => api.move(board.id, key === "up" ? -1 : 1));
        return;
      case "source":
        setSource(true);
        return;
      case "ask":
        onAsk(fill(s["strings.boards.ask_change_prompt"], { board: board.doc.name }));
        return;
      case "unpin":
        void act(async () => {
          await api.pin(board.id, !board.pinned);
          setToast({ text: board.doc.name, undo: () => api.pin(board.id, board.pinned) });
        });
        return;
      case "delete":
        void act(async () => {
          await api.remove(board.id);
          setDeleted(board);
          setToast({
            text: fill(s["strings.boards.deleted"], { board: board.doc.name }),
            undo: async () => {
              await api.restore(board.id);
              setDeleted(null);
            },
          });
        });
        return;
    }
  };

  const menuItems = [
    { key: "rename", label: s["strings.boards.rename"] },
    { key: "icon", label: s["strings.boards.change_icon"] },
    { key: "up", label: s["strings.boards.move_up"] },
    { key: "down", label: s["strings.boards.move_down"] },
    { key: "show_as", label: s["strings.boards.show_as"] },
    { key: "source", label: s["strings.boards.show_source"] },
    { key: "ask", label: s["strings.boards.ask_change"] },
    {
      key: "unpin",
      label: board.pinned ? s["strings.boards.unpin"] : s["strings.boards.pin_again"],
    },
    { key: "delete", label: s["strings.boards.delete"] },
  ];

  const moved = movesOutOf(board, now);
  const tighten = Object.entries(moved).find(([, n]) => n >= s["boards.corrections.offer_after"]);
  const tightenLane = tighten ? board.doc.lanes.find((l) => l.id === tighten[0]) : undefined;

  const header = (
    <>
      <Btn
        sm
        icon
        className="board-menu-btn"
        aria-haspopup="menu"
        title={s["strings.boards.menu"]}
        aria-label={s["strings.boards.menu"]}
        onClick={() => setMenu((m) => (m ? null : "main"))}
      >
        <DotsThreeIcon />
      </Btn>
      {menu === "main" ? (
        <Picker
          label={s["strings.boards.menu"]}
          items={menuItems}
          onPick={pick}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {menu === "icon" ? (
        <Picker
          label={s["strings.boards.change_icon"]}
          title={s["strings.boards.change_icon"]}
          items={BOARD_ICONS.map((i) => ({ key: i, label: i.replaceAll("-", " ") }))}
          onPick={(icon) => {
            setMenu(null);
            void edit((d) => ({ ...d, nav: { ...d.nav, icon } }), s["strings.boards.change_icon"]);
          }}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {menu === "show_as" ? (
        <Picker
          label={s["strings.boards.show_as"]}
          title={s["strings.boards.show_as"]}
          items={BOARD_COMPONENTS.map((c) => ({
            key: c,
            label: s[`strings.boards.show_as.${c}`],
            ...(c === board.doc.layout.component ? { detail: "✓" } : {}),
          }))}
          onPick={(c) => {
            setMenu(null);
            void edit(
              (d) => ({ ...d, layout: layoutForComponent(c as BoardComponent, d.layout) }),
              s[`strings.boards.show_as.${c as BoardComponent}`],
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
          className="board-bar board-rename"
          onSubmit={(e) => {
            e.preventDefault();
            const name = renaming.trim();
            setRenaming(null);
            if (name && name !== board.doc.name) {
              void edit((d) => ({ ...d, name }), s["strings.boards.rename"]);
            }
          }}
        >
          <input
            // biome-ignore lint/a11y/noAutofocus: the field opens on Rename, where the user is about to type
            autoFocus
            value={renaming}
            aria-label={s["strings.boards.rename"]}
            onChange={(e) => setRenaming(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setRenaming(null);
              e.stopPropagation();
            }}
          />
          <Btn sm primary type="submit">
            {s["strings.boards.rename"]}
          </Btn>
        </form>
      ) : null}
      {board.checkBar ? (
        <div className="board-bar" role="status">
          <span>{s["strings.boards.check_bar"]}</span>
          <Btn sm onClick={() => void act(() => api.dismissCheck(board.id))}>
            {s["strings.boards.dismiss"]}
          </Btn>
        </div>
      ) : null}
      {tighten && tightenLane ? (
        <div className="board-bar" role="status">
          <span>
            {fill(s["strings.boards.tighten"], { count: tighten[1], lane: tightenLane.label })}
          </span>
          <Btn
            sm
            onClick={() =>
              onAsk(fill(s["strings.boards.tighten_prompt"], { board: board.doc.name }))
            }
          >
            {s["strings.boards.tighten_action"]}
          </Btn>
        </div>
      ) : null}
      {error ? (
        <div className="board-bar err" role="alert">
          {error}
        </div>
      ) : null}
      {source ? (
        <div className="board-source" role="dialog" aria-label={s["strings.boards.show_source"]}>
          <div className="board-source-h">
            <b>
              {fill(s["strings.boards.source_title"], {
                board: board.doc.name,
                version: board.version,
              })}
            </b>
            <Btn sm icon aria-label={s["strings.boards.dismiss"]} onClick={() => setSource(false)}>
              <XIcon />
            </Btn>
          </div>
          <pre>{JSON.stringify(board.doc, null, 2)}</pre>
        </div>
      ) : null}
      {toast ? (
        <Toast
          text={toast.text}
          undoLabel={s["strings.boards.undo"]}
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
    id: board.id,
    name: board.doc.name,
    threads,
    header,
    above,
    render: (ctx) =>
      view ? (
        view.total === 0 && board.doc.layout.component !== "lanes" ? (
          <div className="empty-line">{s["strings.boards.empty"]}</div>
        ) : (
          <BoardLayout
            doc={board.doc}
            view={view}
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
                : (threadId, lane) => void act(() => api.place(board.id, threadId, lane))
            }
          />
        )
      ) : null,
  });
}
