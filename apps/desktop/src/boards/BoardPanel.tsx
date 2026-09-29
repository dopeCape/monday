// The `board` Panel (docs/spec/boards.md, "Panels"): a Board's Lane counts
// placed in the Layout above the Inbox, beside the Today panel. A Board is
// the data; the Panel is one way to show it. The Setting boards.panel names
// the Board (the Agent places it with change_setting); each count opens the
// Board.

import { cx } from "@monday/ui";
import { useShell } from "../shell/Shell.tsx";
import { useBoards, useBoardView } from "./useBoards.ts";

export function BoardPanel({ now, onOpen }: { now: Date; onOpen(boardId: string): void }) {
  const shell = useShell();
  const id = shell.settings["boards.panel"];
  const boards = useBoards();
  const board = id ? (boards?.find((b) => b.id === id) ?? null) : null;
  const { view } = useBoardView(board, now);
  if (!board || !view) return null;
  return (
    <section className="board-panel" data-board={board.id} aria-label={board.doc.name}>
      <button type="button" className="board-panel-h" onClick={() => onOpen(board.id)}>
        {board.doc.name}
      </button>
      <div className="board-counts">
        {view.lanes.map((lane) => (
          <button
            key={lane.id}
            type="button"
            className={cx("board-count")}
            data-tone={lane.tone}
            data-lane={lane.id}
            onClick={() => onOpen(board.id)}
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
