// Settings › Sorting › Views (docs/spec/views.md, "Changing and removing"):
// the Workspace's Views in nav order, each with its version, and Move up,
// Move down, Unpin (or Pin), Rename and Delete with Undo. The limits sit
// under it as ordinary Settings. Every word is a strings.views.* Setting.

import type { View } from "@monday/shared";
import { Btn } from "@monday/ui";
import { ArrowDownIcon, ArrowUpIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { useShell } from "../../shell/Shell.tsx";
import { Card, messageOf, type PanelProps, registerPanel, useSettingsScreen } from "./render.tsx";
import { fill } from "./wizard.ts";

export function ViewsPanel(_: PanelProps) {
  const shell = useShell();
  const screen = useSettingsScreen();
  const s = shell.settings;
  const api = shell.api.views;
  const [views, setViews] = useState<View[] | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [undo, setUndo] = useState<{ text: string; run: () => Promise<unknown> } | null>(null);

  const load = useCallback(async () => {
    try {
      setViews(await api.list(screen.workspaceId));
      setError(null);
    } catch (e) {
      setViews(null);
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
      title={s["strings.views.settings.title"]}
      hint={s["strings.views.settings.intro"]}
      block
      attrs={{ "data-panel": "views" }}
      foot={
        <>
          {undo ? (
            <>
              <span>{undo.text}</span>
              <span className="sp" />
              <Btn sm onClick={() => void act(undo.run)}>
                {s["strings.views.undo"]}
              </Btn>
            </>
          ) : null}
          {error ? <span className="err">{error}</span> : null}
        </>
      }
    >
      {!views || views.length === 0 ? (
        <div className="note">{views === undefined ? "" : s["strings.views.settings.empty"]}</div>
      ) : (
        <div className="matrix views-table">
          {views.map((b, i) => (
            <div className="mr" key={b.id} data-view={b.id}>
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
                      aria-label={s["strings.views.rename"]}
                      onChange={(e) => setRenaming({ id: b.id, name: e.target.value })}
                    />
                  </form>
                ) : (
                  b.doc.name
                )}
                <span className="who">
                  {fill(s["strings.views.settings.version"], { version: b.version })}
                  {b.pinned ? "" : `, ${s["strings.views.unpin"].toLowerCase()}`}
                </span>
              </div>
              <div className="views-actions">
                <Btn
                  sm
                  icon
                  disabled={i === 0}
                  title={s["strings.views.move_up"]}
                  aria-label={s["strings.views.move_up"]}
                  onClick={() => void act(() => api.move(b.id, -1))}
                >
                  <ArrowUpIcon />
                </Btn>
                <Btn
                  sm
                  icon
                  disabled={i === views.length - 1}
                  title={s["strings.views.move_down"]}
                  aria-label={s["strings.views.move_down"]}
                  onClick={() => void act(() => api.move(b.id, 1))}
                >
                  <ArrowDownIcon />
                </Btn>
                <Btn sm onClick={() => setRenaming({ id: b.id, name: b.doc.name })}>
                  {s["strings.views.rename"]}
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
                  {b.pinned ? s["strings.views.unpin"] : s["strings.views.pin_again"]}
                </Btn>
                <Btn
                  sm
                  onClick={() =>
                    void act(() => api.remove(b.id), {
                      text: fill(s["strings.views.deleted"], { view: b.doc.name }),
                      run: () => api.restore(b.id),
                    })
                  }
                >
                  {s["strings.views.delete"]}
                </Btn>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

registerPanel("routing", "Views", ViewsPanel, {
  title: "strings.views.settings.title",
  description: "strings.views.settings.intro",
  searchTerms: ["views", "lanes", "red yellow green", "pinned", "nav"],
});
