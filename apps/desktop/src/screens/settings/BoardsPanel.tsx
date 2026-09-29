// Settings › Sorting › Boards (docs/spec/boards.md, "Changing and removing"):
// the Workspace's Boards in nav order, each with its version, and Move up,
// Move down, Unpin (or Pin), Rename and Delete with Undo. The limits sit
// under it as ordinary Settings. Every word is a strings.boards.* Setting.

import type { Board } from "@monday/shared";
import { Btn } from "@monday/ui";
import { ArrowDownIcon, ArrowUpIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { useShell } from "../../shell/Shell.tsx";
import { Card, messageOf, type PanelProps, registerPanel, useSettingsScreen } from "./render.tsx";
import { fill } from "./wizard.ts";

export function BoardsPanel(_: PanelProps) {
  const shell = useShell();
  const screen = useSettingsScreen();
  const s = shell.settings;
  const api = shell.api.boards;
  const [boards, setBoards] = useState<Board[] | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [undo, setUndo] = useState<{ text: string; run: () => Promise<unknown> } | null>(null);

  const load = useCallback(async () => {
    try {
      setBoards(await api.list(screen.workspaceId));
      setError(null);
    } catch (e) {
      setBoards(null);
      setError(messageOf(e));
    }
  }, [api, screen.workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (
    run: () => Promise<unknown>,
    then?: { text: string; run: () => Promise<unknown> },
  ) => {
    try {
      await run();
      setUndo(then ?? null);
      await load();
    } catch (e) {
      setError(messageOf(e));
    }
  };

  return (
    <Card
      title={s["strings.boards.settings.title"]}
      hint={s["strings.boards.settings.intro"]}
      block
      attrs={{ "data-panel": "boards" }}
      foot={
        <>
          {undo ? (
            <>
              <span>{undo.text}</span>
              <span className="sp" />
              <Btn sm onClick={() => void act(undo.run)}>
                {s["strings.boards.undo"]}
              </Btn>
            </>
          ) : null}
          {error ? <span className="err">{error}</span> : null}
        </>
      }
    >
      {!boards || boards.length === 0 ? (
        <div className="note">{boards === undefined ? "" : s["strings.boards.settings.empty"]}</div>
      ) : (
        <div className="matrix boards-table">
          {boards.map((b, i) => (
            <div className="mr" key={b.id} data-board={b.id}>
              <div>
                {renaming?.id === b.id ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const name = renaming.name.trim();
                      setRenaming(null);
                      if (name && name !== b.doc.name) {
                        void act(() => api.update(b.id, { ...b.doc, name }), {
                          text: name,
                          run: () => api.revert(b.id, b.version),
                        });
                      }
                    }}
                  >
                    <input
                      className="input"
                      value={renaming.name}
                      aria-label={s["strings.boards.rename"]}
                      onChange={(e) => setRenaming({ id: b.id, name: e.target.value })}
                    />
                  </form>
                ) : (
                  b.doc.name
                )}
                <span className="who">
                  {fill(s["strings.boards.settings.version"], { version: b.version })}
                  {b.pinned ? "" : `, ${s["strings.boards.unpin"].toLowerCase()}`}
                </span>
              </div>
              <div className="boards-actions">
                <Btn
                  sm
                  icon
                  disabled={i === 0}
                  title={s["strings.boards.move_up"]}
                  aria-label={s["strings.boards.move_up"]}
                  onClick={() => void act(() => api.move(b.id, -1))}
                >
                  <ArrowUpIcon />
                </Btn>
                <Btn
                  sm
                  icon
                  disabled={i === boards.length - 1}
                  title={s["strings.boards.move_down"]}
                  aria-label={s["strings.boards.move_down"]}
                  onClick={() => void act(() => api.move(b.id, 1))}
                >
                  <ArrowDownIcon />
                </Btn>
                <Btn sm onClick={() => setRenaming({ id: b.id, name: b.doc.name })}>
                  {s["strings.boards.rename"]}
                </Btn>
                <Btn
                  sm
                  onClick={() =>
                    void act(() => api.pin(b.id, !b.pinned), {
                      text: b.doc.name,
                      run: () => api.pin(b.id, b.pinned),
                    })
                  }
                >
                  {b.pinned ? s["strings.boards.unpin"] : s["strings.boards.pin_again"]}
                </Btn>
                <Btn
                  sm
                  onClick={() =>
                    void act(() => api.remove(b.id), {
                      text: fill(s["strings.boards.deleted"], { board: b.doc.name }),
                      run: () => api.restore(b.id),
                    })
                  }
                >
                  {s["strings.boards.delete"]}
                </Btn>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

registerPanel("routing", "Boards", BoardsPanel, {
  title: "strings.boards.settings.title",
  description: "strings.boards.settings.intro",
  searchTerms: ["boards", "lanes", "red yellow green", "pinned", "nav"],
});
