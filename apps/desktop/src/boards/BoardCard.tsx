// The Board card in the Agent (docs/spec/boards.md, "Making a Board", steps
// 3 to 5): the draft already tried on the user's own mail. The tried
// Threads, each with its Lane and the answers behind it ("Red: support
// request 94%, blocked 2.1 of 2"), the counts over all of them, a line when
// a quiet scope looked at earlier days. Each row has Move to (another Lane or
// Unsure) and, per question of the Board's own, Wrong; corrections are kept
// as the draft's Examples, and "Revise with my corrections" asks the Agent to
// fold them in and try again ("Agrees with your corrections on 9 of 10").
// Pin board saves version 1 and pins it; it waits until the card shows the
// tried Threads. An edit shows which Threads would move and Apply, with
// Undo. Without a TypeSafe key a Board that reads mail offers to keep only
// its Fact Lanes. Every word is a strings.boards.* Setting.

import type { BoardDraft, BoardPreview, Settings } from "@monday/shared";
import { OTHERS_LANE, UNSURE_LANE } from "@monday/shared";
import { Btn, cx } from "@monday/ui";
import { useCallback, useContext, useEffect, useState } from "react";
import { ComposerEnvContext } from "../agent/aui/context.tsx";
import { Picker } from "../screens/inbox/Picker.tsx";
import { useShell } from "../shell/Shell.tsx";

const fill = (t: string, vars: Record<string, string | number>) =>
  t.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));

/** A Lane id in words: the Board's label, Unsure, or Everything else. */
export function laneLabel(draft: BoardDraft, lane: string, s: Settings): string {
  if (lane === UNSURE_LANE) return draft.doc.unsure.label || s["strings.boards.unsure"];
  if (lane === OTHERS_LANE) return s["strings.boards.everything_else"];
  return draft.doc.lanes.find((l) => l.id === lane)?.label ?? lane;
}

const toneOf = (draft: BoardDraft, lane: string) =>
  draft.doc.lanes.find((l) => l.id === lane)?.tone ?? "muted";

/** The corrections already made on a row: its Move to Lane, and the Nouls marked Wrong. */
function correctionsOf(draft: BoardDraft, threadId: string) {
  const lane = draft.doc.examples._lanes?.find((e) => e.threadId === threadId)?.lane;
  const wrong = Object.entries(draft.doc.examples)
    .filter(([k, list]) => k !== "_lanes" && list.some((e) => e.threadId === threadId))
    .map(([k]) => k);
  return { lane, wrong };
}

/** Whether Pin board may be clicked: the card showed the tried Threads, or there was nothing to try. */
export function canPin(draft: BoardDraft, shownSetting: number): boolean {
  const t = draft.test;
  if (!t || draft.status !== "open" || draft.boardId) return false;
  if (t.empty) return true;
  return t.shown.length >= Math.min(shownSetting, t.tried);
}

export function BoardCard({ preview }: { preview: BoardPreview }) {
  const shell = useShell();
  const env = useContext(ComposerEnvContext);
  const s = shell.settings;
  const api = shell.api.boards;
  const [draft, setDraft] = useState<BoardDraft | null>(preview.draft);
  const [moving, setMoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [applied, setApplied] = useState<{
    version: number;
    undo: (() => Promise<unknown>) | null;
  } | null>(null);

  const refresh = useCallback(async () => {
    if (!preview.draftId || !shell.server) return;
    try {
      setDraft(await api.draft(preview.draftId));
    } catch {}
  }, [api, preview.draftId, shell.server]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (act: () => Promise<unknown>) => {
    setBusy(true);
    try {
      setNote(null);
      await act();
      await refresh();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!draft) {
    // A name, layout or delete: applied with Undo on the card's own row.
    return (
      <div className="agent-preview board-card" data-action={preview.action}>
        <div className="bc-line">
          <b>{preview.name}</b>
        </div>
      </div>
    );
  }

  const t = draft.test;
  const lanes = [...draft.doc.lanes.map((l) => l.id), UNSURE_LANE];
  const moveItems = (current: string) =>
    lanes.filter((l) => l !== current).map((l) => ({ key: l, label: laneLabel(draft, l, s) }));
  const hasCorrections = Object.values(draft.doc.examples).some((list) => list.length > 0);
  const open = draft.status === "open";
  const pinReady = canPin(draft, s["boards.test.shown"]);
  const over = t && t.inScope > s["boards.scope.max_threads"];

  return (
    <div className="agent-preview board-card" data-draft={draft.id} data-status={draft.status}>
      <div className="bc-line">
        <b>{draft.doc.name}</b>
        {t && !t.empty ? ` · ${fill(s["strings.boards.tried"], { count: t.tried })}` : null}
      </div>
      {t?.widened ? (
        <div className="bc-line">
          {fill(s["strings.boards.widened"], {
            when: s[`strings.boards.when.${t.widened.when}`],
            count: t.widened.count,
          })}
        </div>
      ) : null}
      {t?.empty ? <div className="bc-line">{s["strings.boards.empty_scope"]}</div> : null}
      {t && !t.empty ? (
        <div className="bc-lanes">
          {lanes.map((l) => (
            <span key={l} className="bc-lane" data-tone={toneOf(draft, l)} data-lane={l}>
              <span className="dot" aria-hidden="true" />
              {laneLabel(draft, l, s)} <b>{t.counts[l] ?? 0}</b>
            </span>
          ))}
        </div>
      ) : null}
      {t?.shown.length ? (
        <div className="bc-rows">
          {t.shown.map((row) => {
            const fixed = correctionsOf(draft, row.threadId);
            const lane = fixed.lane ?? row.lane;
            return (
              <div
                key={row.threadId}
                className={cx(
                  "bc-row",
                  (Boolean(fixed.lane) || fixed.wrong.length > 0) && "corrected",
                )}
                data-thread={row.threadId}
                data-lane={row.lane}
                data-tone={toneOf(draft, lane)}
              >
                <span className="dot" aria-hidden="true" />
                <span>
                  <span className="subj">{row.subject}</span>
                  <span className="who">{row.from}</span>
                  <span className="why">
                    {fill(s["strings.boards.reasons"], {
                      lane: laneLabel(draft, row.lane, s),
                      reasons: row.notRead ? s["strings.boards.not_read"] : row.reasons.join(", "),
                    })}
                    {fixed.lane ? ` → ${laneLabel(draft, fixed.lane, s)}` : ""}
                  </span>
                </span>
                {open ? (
                  <span className="fix">
                    <Btn
                      sm
                      disabled={busy}
                      onClick={() => setMoving(moving === row.threadId ? null : row.threadId)}
                    >
                      {s["strings.boards.move_to"]}
                    </Btn>
                    {row.nouls.map((n) => {
                      const holds = (n.noul ?? 0) >= s["signals.unsure.noul_high"];
                      return (
                        <Btn
                          key={n.signal}
                          sm
                          on={fixed.wrong.includes(n.signal)}
                          disabled={busy}
                          title={fill(
                            s[holds ? "strings.boards.wrong_title" : "strings.boards.right_title"],
                            {
                              signal: n.label,
                            },
                          )}
                          onClick={() =>
                            void run(() =>
                              api.correct(draft.id, {
                                threadId: row.threadId,
                                signal: n.signal,
                                holds: !holds,
                              }),
                            )
                          }
                        >
                          {s["strings.boards.wrong"]}
                        </Btn>
                      );
                    })}
                  </span>
                ) : null}
                {moving === row.threadId ? (
                  <Picker
                    label={s["strings.boards.move_to"]}
                    title={s["strings.boards.move_to"]}
                    items={moveItems(lane)}
                    onPick={(to) => {
                      setMoving(null);
                      void run(() => api.correct(draft.id, { threadId: row.threadId, lane: to }));
                    }}
                    onClose={() => setMoving(null)}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
      {t?.agreement ? (
        <div className="bc-line">
          {fill(s["strings.boards.agrees"], { n: t.agreement.agree, m: t.agreement.total })}
        </div>
      ) : null}
      {t?.changes.length ? (
        <div className="bc-line">
          {fill(s["strings.boards.revised"], { changes: t.changes.join("; ") })}
        </div>
      ) : null}
      {t?.moves ? (
        <div className="bc-line">
          {t.moves.length === 0
            ? s["strings.boards.no_moves"]
            : fill(s["strings.boards.moves"], {
                count: t.moves.reduce((n, m) => n + m.threadIds.length, 0),
                moves: t.moves
                  .map((m) =>
                    fill(s["strings.boards.move_line"], {
                      count: m.threadIds.length,
                      from: laneLabel(draft, m.from, s),
                      to: laneLabel(draft, m.to, s),
                    }),
                  )
                  .join(", "),
              })}
        </div>
      ) : null}
      {over ? (
        <div className="bc-line warn">
          {fill(s["strings.boards.over_limit"], {
            count: t?.inScope ?? 0,
            max: s["boards.scope.max_threads"],
          })}
        </div>
      ) : null}
      {t?.needsJudge ? (
        <div className="bc-line warn">{s["strings.boards.needs_typesafe"]}</div>
      ) : null}
      {note ? <div className="bc-line warn">{note}</div> : null}
      <div className="bc-actions">
        {draft.status === "pinned" ? <span>{s["strings.boards.pinned"]}</span> : null}
        {draft.status === "discarded" ? <span>{s["strings.boards.discarded"]}</span> : null}
        {draft.status === "applied" ? (
          <>
            {applied ? (
              <span>{fill(s["strings.boards.applied"], { version: applied.version })}</span>
            ) : null}
            {applied?.undo ? (
              <Btn
                sm
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await applied.undo?.();
                    setApplied({ ...applied, undo: null });
                  })
                }
              >
                {s["strings.boards.undo"]}
              </Btn>
            ) : null}
          </>
        ) : null}
        {open && !draft.boardId ? (
          <>
            {t?.needsJudge ? (
              <Btn
                sm
                disabled={busy}
                onClick={() => void run(() => api.pinDraft(draft.id, { factsOnly: true }))}
              >
                {s["strings.boards.keep_facts"]}
              </Btn>
            ) : (
              <Btn
                sm
                primary
                disabled={busy || !pinReady}
                onClick={() => void run(() => api.pinDraft(draft.id))}
              >
                {s["strings.boards.pin"]}
              </Btn>
            )}
            {hasCorrections && env ? (
              <Btn
                sm
                disabled={busy}
                onClick={() =>
                  env.actions.send(fill(s["strings.boards.revise_prompt"], { draft: draft.id }))
                }
              >
                {s["strings.boards.revise"]}
              </Btn>
            ) : null}
            <span className="sp" />
            <Btn sm disabled={busy} onClick={() => void run(() => api.discardDraft(draft.id))}>
              {s["strings.boards.not_now"]}
            </Btn>
          </>
        ) : null}
        {open && draft.boardId ? (
          <>
            <Btn
              sm
              primary
              disabled={busy || t?.needsJudge}
              onClick={() =>
                void run(async () => {
                  const r = await api.applyDraft(draft.id);
                  const boardId = r.board.id;
                  setApplied({
                    version: r.board.version,
                    undo: () => api.revert(boardId, r.previous),
                  });
                })
              }
            >
              {s["strings.boards.apply"]}
            </Btn>
            <span className="sp" />
            <Btn sm disabled={busy} onClick={() => void run(() => api.discardDraft(draft.id))}>
              {s["strings.boards.not_now"]}
            </Btn>
          </>
        ) : null}
      </div>
    </div>
  );
}
