// The View card in the Agent (docs/spec/views.md, "Making a View", steps
// 3 to 5): the draft already tried on the user's own mail. The tried
// Threads, each with its Lane and the answers behind it ("Red: support
// request 94%, blocked 2.1 of 2"), the counts over all of them, a line when
// a quiet scope looked at earlier days. Each row has Move to (another Lane or
// Unsure) and, per question of the View's own, Wrong; corrections are kept
// as the draft's Examples, and "Revise with my corrections" asks the Agent to
// fold them in and try again ("Agrees with your corrections on 9 of 10").
// Pin view saves version 1 and pins it; it waits until the card shows the
// tried Threads. An edit shows which Threads would move and Apply, with
// Undo. Without a TypeSafe key a View that reads mail offers to keep only
// its Fact Lanes. Every word is a strings.views.* Setting.

import type {
  BlockPreview,
  CoverageReason,
  Settings,
  ViewCoverage,
  ViewDraft,
  ViewPreview,
  ViewTest,
  ViewTriedThread,
} from "@monday/shared";
import { COVERAGE_REASONS, fieldsShown, OTHERS_LANE, UNSURE_LANE } from "@monday/shared";
import { BarChart, Btn, cx } from "@monday/ui";
import { WarningIcon } from "@phosphor-icons/react";
import { useCallback, useContext, useEffect, useState } from "react";
import { ComposerEnvContext } from "../agent/aui/context.tsx";
import { Picker } from "../screens/inbox/Picker.tsx";
import { useShell } from "../shell/Shell.tsx";

const fill = (t: string, vars: Record<string, string | number>) =>
  t.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));

/** A Lane id in words: the View's label, Unsure, or Everything else. */
export function laneLabel(draft: ViewDraft, lane: string, s: Settings): string {
  if (lane === UNSURE_LANE) return draft.doc.unsure.label || s["strings.views.unsure"];
  if (lane === OTHERS_LANE) return s["strings.views.everything_else"];
  return draft.doc.lanes.find((l) => l.id === lane)?.label ?? lane;
}

const toneOf = (draft: ViewDraft, lane: string) =>
  draft.doc.lanes.find((l) => l.id === lane)?.tone ?? "muted";

/** The corrections already made on a row: its Move to Lane, and the Nouls marked Wrong. */
function correctionsOf(draft: ViewDraft, threadId: string) {
  const lane = draft.doc.examples._lanes?.find((e) => e.threadId === threadId)?.lane;
  const wrong = Object.entries(draft.doc.examples)
    .filter(
      ([k, list]) =>
        k !== "_lanes" && !k.startsWith("x:") && list.some((e) => e.threadId === threadId),
    )
    .map(([k]) => k);
  const values = Object.entries(draft.doc.examples)
    .filter(([k, list]) => k.startsWith("x:") && list.some((e) => e.threadId === threadId))
    .map(([k]) => k.slice(2));
  return { lane, wrong, values };
}

/** Whether Pin view may be clicked: the card showed the tried Threads, or there was nothing to try. */
export function canPin(draft: ViewDraft, shownSetting: number): boolean {
  const t = draft.test;
  if (!t || draft.status !== "open" || draft.viewId) return false;
  if (t.empty) return true;
  return t.shown.length >= Math.min(shownSetting, t.tried);
}

export function ViewCard({ preview }: { preview: ViewPreview }) {
  const shell = useShell();
  const env = useContext(ComposerEnvContext);
  const s = shell.settings;
  const api = shell.api.views;
  const [draft, setDraft] = useState<ViewDraft | null>(preview.draft);
  const [moving, setMoving] = useState<string | null>(null);
  /** The value whose "Wrong value" picker is open: its Thread and Extraction. */
  const [valuing, setValuing] = useState<{ threadId: string; extraction: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  /** A coverage reason the user clicked: the rows shown are the tried Threads it names. */
  const [filter, setFilter] = useState<CoverageFilter | null>(null);
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
      <div className="agent-preview view-card" data-action={preview.action}>
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
  const pinReady = canPin(draft, s["views.test.shown"]);
  const over = t && t.inScope > s["views.scope.max_threads"];
  const rows = t ? rowsFor(t, filter) : [];

  return (
    <div className="agent-preview view-card" data-draft={draft.id} data-status={draft.status}>
      <div className="bc-line">
        <b>{draft.doc.name}</b>
        {t && !t.empty ? ` · ${fill(s["strings.views.tried"], { count: t.tried })}` : null}
      </div>
      {t?.widened ? (
        <div className="bc-line">
          {fill(s["strings.views.widened"], {
            when: s[`strings.views.when.${t.widened.when}`],
            count: t.widened.count,
          })}
        </div>
      ) : null}
      {t?.empty ? <div className="bc-line">{s["strings.views.empty_scope"]}</div> : null}
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
      {filter ? (
        <div className="bc-line bc-filter">
          {fill(s["strings.views.card.filtered"], {
            count: rows.length,
            label: filter.label,
            reason: filter.text,
          })}
          <Btn sm onClick={() => setFilter(null)}>
            {s["strings.views.card.filter_clear"]}
          </Btn>
        </div>
      ) : null}
      {rows.length ? (
        <div className="bc-rows">
          {rows.map((row) => {
            const fixed = correctionsOf(draft, row.threadId);
            const lane = fixed.lane ?? row.lane;
            return (
              <div
                key={row.threadId}
                className={cx(
                  "bc-row",
                  (Boolean(fixed.lane) || fixed.wrong.length > 0 || fixed.values.length > 0) &&
                    "corrected",
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
                    {fill(s["strings.views.reasons"], {
                      lane: laneLabel(draft, row.lane, s),
                      reasons: row.notRead ? s["strings.views.not_read"] : row.reasons.join(", "),
                    })}
                    {fixed.lane ? ` → ${laneLabel(draft, fixed.lane, s)}` : ""}
                  </span>
                  {row.values?.length ? (
                    <span className="vals">
                      {row.values.map((v) => (
                        <span key={v.extraction} className="val" data-state={v.state}>
                          {fill(s["strings.views.value_title"], {
                            label: v.label,
                            value: valueText(v, s),
                          })}
                        </span>
                      ))}
                    </span>
                  ) : null}
                  {row.actions?.length ? (
                    <span className="acts">
                      <span className="lab">
                        {fill(s["strings.views.card.actions"], { actions: "" }).trim()}
                      </span>
                      {row.actions.map((a) => (
                        <Btn key={a} sm disabled>
                          {a}
                        </Btn>
                      ))}
                    </span>
                  ) : null}
                </span>
                {open ? (
                  <span className="fix">
                    <Btn
                      sm
                      disabled={busy}
                      onClick={() => setMoving(moving === row.threadId ? null : row.threadId)}
                    >
                      {s["strings.views.move_to"]}
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
                            s[holds ? "strings.views.wrong_title" : "strings.views.right_title"],
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
                          {s["strings.views.wrong"]}
                        </Btn>
                      );
                    })}
                    {(row.values ?? []).map((v) => (
                      <Btn
                        key={v.extraction}
                        sm
                        on={fixed.values.includes(v.extraction)}
                        disabled={busy}
                        data-extraction={v.extraction}
                        title={v.label}
                        onClick={() =>
                          setValuing(
                            valuing?.threadId === row.threadId &&
                              valuing.extraction === v.extraction
                              ? null
                              : { threadId: row.threadId, extraction: v.extraction },
                          )
                        }
                      >
                        {s["strings.views.wrong_value"]}
                      </Btn>
                    ))}
                  </span>
                ) : null}
                {valuing?.threadId === row.threadId ? (
                  <Picker
                    label={s["strings.views.wrong_value"]}
                    title={row.values.find((v) => v.extraction === valuing.extraction)?.label ?? ""}
                    items={[
                      ...(
                        row.values.find((v) => v.extraction === valuing.extraction)?.candidates ??
                        []
                      ).map((c) => ({ key: `c:${c}`, label: c })),
                      { key: "none", label: s["strings.views.not_stated"] },
                    ]}
                    onPick={(key) => {
                      const extraction = valuing.extraction;
                      setValuing(null);
                      void run(() =>
                        api.correct(draft.id, {
                          threadId: row.threadId,
                          extraction,
                          value: key === "none" ? null : key.slice(2),
                        }),
                      );
                    }}
                    onClose={() => setValuing(null)}
                  />
                ) : null}
                {moving === row.threadId ? (
                  <Picker
                    label={s["strings.views.move_to"]}
                    title={s["strings.views.move_to"]}
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
      {t?.blocks?.length ? (
        <div className="bc-blocks">
          <div className="bc-line">
            <b>{s["strings.views.card.blocks"]}</b>
          </div>
          {t.blocks.map((b) => (
            <BlockMini key={b.id} b={b} s={s} />
          ))}
        </div>
      ) : null}
      {t && !t.empty ? (
        <CoverageRows draft={draft} t={t} s={s} filter={filter} onFilter={setFilter} />
      ) : null}
      {t?.agreement ? (
        <div className="bc-line">
          {fill(s["strings.views.agrees"], { n: t.agreement.agree, m: t.agreement.total })}
        </div>
      ) : null}
      {t?.changes.length ? (
        <div className="bc-line">
          {fill(s["strings.views.revised"], { changes: t.changes.join("; ") })}
        </div>
      ) : null}
      {t?.moves ? (
        <div className="bc-line">
          {t.moves.length === 0
            ? s["strings.views.no_moves"]
            : fill(s["strings.views.moves"], {
                count: t.moves.reduce((n, m) => n + m.threadIds.length, 0),
                moves: t.moves
                  .map((m) =>
                    fill(s["strings.views.move_line"], {
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
          {fill(s["strings.views.over_limit"], {
            count: t?.inScope ?? 0,
            max: s["views.scope.max_threads"],
          })}
        </div>
      ) : null}
      {t?.needsJudge ? (
        <div className="bc-line warn">{s["strings.views.needs_typesafe"]}</div>
      ) : null}
      {note ? <div className="bc-line warn">{note}</div> : null}
      <div className="bc-actions">
        {draft.status === "pinned" ? <span>{s["strings.views.pinned"]}</span> : null}
        {draft.status === "discarded" ? <span>{s["strings.views.discarded"]}</span> : null}
        {draft.status === "applied" ? (
          <>
            {applied ? (
              <span>{fill(s["strings.views.applied"], { version: applied.version })}</span>
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
                {s["strings.views.undo"]}
              </Btn>
            ) : null}
          </>
        ) : null}
        {open && !draft.viewId ? (
          <>
            {t?.needsJudge ? (
              <Btn
                sm
                disabled={busy}
                onClick={() => void run(() => api.pinDraft(draft.id, { factsOnly: true }))}
              >
                {s["strings.views.keep_facts"]}
              </Btn>
            ) : (
              <Btn
                sm
                primary
                disabled={busy || !pinReady}
                onClick={() => void run(() => api.pinDraft(draft.id))}
              >
                {s["strings.views.pin"]}
              </Btn>
            )}
            {hasCorrections && env ? (
              <Btn
                sm
                disabled={busy}
                onClick={() =>
                  env.actions.send(fill(s["strings.views.revise_prompt"], { draft: draft.id }))
                }
              >
                {s["strings.views.revise"]}
              </Btn>
            ) : null}
            <span className="sp" />
            <Btn sm disabled={busy} onClick={() => void run(() => api.discardDraft(draft.id))}>
              {s["strings.views.not_now"]}
            </Btn>
          </>
        ) : null}
        {open && draft.viewId ? (
          <>
            <Btn
              sm
              primary
              disabled={busy || t?.needsJudge}
              onClick={() =>
                void run(async () => {
                  const r = await api.applyDraft(draft.id);
                  const viewId = r.view.id;
                  setApplied({
                    version: r.view.version,
                    undo: () => api.revert(viewId, r.previous),
                  });
                })
              }
            >
              {s["strings.views.apply"]}
            </Btn>
            <span className="sp" />
            <Btn sm disabled={busy} onClick={() => void run(() => api.discardDraft(draft.id))}>
              {s["strings.views.not_now"]}
            </Btn>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** A coverage reason the user clicked: its Field, its words and the tried Threads it names. */
export interface CoverageFilter {
  field: string;
  reason: CoverageReason;
  label: string;
  text: string;
  threadIds: readonly string[];
}

/** The rows the card lists: the shown ones, or every tried Thread a clicked reason names. */
export function rowsFor(t: ViewTest, filter: CoverageFilter | null): ViewTriedThread[] {
  if (!filter) return t.shown;
  const ids = new Set(filter.threadIds);
  const seen = new Set<string>();
  return [...t.shown, ...(t.rest ?? [])].filter((r) => {
    if (!ids.has(r.threadId) || seen.has(r.threadId)) return false;
    seen.add(r.threadId);
    return true;
  });
}

type CoverageField = ViewCoverage["fields"][number];

/** Why a Field did not read, in words, each reason with its count. */
function reasonsOf(
  draft: ViewDraft,
  f: CoverageField,
  s: Settings,
): Array<{ reason: CoverageReason; count: number; text: string }> {
  const x = f.field.startsWith("x:")
    ? draft.doc.extractions.find((e) => e.id === f.field.slice(2))
    : undefined;
  const out: Array<{ reason: CoverageReason; count: number; text: string }> = [];
  for (const reason of COVERAGE_REASONS) {
    if (reason === "resolved") continue;
    const count = f[reason];
    if (!count) continue;
    const text =
      reason === "noCandidates"
        ? fill(s["strings.views.card.reason.no_candidates"], {
            count,
            kind: x ? s[`strings.views.card.kind.${x.find}`] : "",
          })
        : reason === "notRead"
          ? fill(s["strings.views.card.reason.not_read"], { count })
          : fill(s[`strings.views.card.reason.${reason}`], { count });
    out.push({ reason, count, text });
  }
  return out;
}

/** How the tried Threads were chosen, in one line: how many of how many, newest first, and why. */
export function poolLine(t: ViewTest, s: Settings): string {
  const p = t.pool;
  const key = p?.query
    ? t.inScopeAtLeast
      ? "strings.views.card.pool_query_at_least"
      : "strings.views.card.pool_query"
    : t.inScopeAtLeast
      ? "strings.views.card.pool_at_least"
      : "strings.views.card.pool";
  const parts = [fill(s[key], { tried: t.tried, count: t.inScope })];
  if (p?.prefer?.length)
    parts.push(
      fill(s["strings.views.card.pool_prefer"], {
        kinds: p.prefer.map((k) => s[`strings.views.card.kind.${k}`]).join(", "),
      }),
    );
  if (p?.kept) parts.push(fill(s["strings.views.card.pool_kept"], { count: p.kept }));
  if (p?.skipped) parts.push(fill(s["strings.views.card.pool_skipped"], { count: p.skipped }));
  return parts.join(", ");
}

/**
 * Under the Block previews: how the tried Threads were chosen, who sent them,
 * and how each value and question read over all of them ("Total: 8 of 10
 * read, 2 had no amounts"). A Field a Block shows that read on less than
 * views.card.warn_below of them is marked; clicking a reason lists the tried
 * Threads it names. A draft tried before coverage was kept shows none of it.
 */
function CoverageRows({
  draft,
  t,
  s,
  filter,
  onFilter,
}: {
  draft: ViewDraft;
  t: ViewTest;
  s: Settings;
  filter: CoverageFilter | null;
  onFilter: (f: CoverageFilter | null) => void;
}) {
  const c = t.coverage;
  if (!c) return null;
  const shown = fieldsShown(draft.doc);
  const warnBelow = s["views.card.warn_below"];
  return (
    <div className="bc-coverage">
      <div className="bc-line">
        <b>{s["strings.views.card.coverage"]}</b>
      </div>
      <div className="bc-line bc-pool">{poolLine(t, s)}</div>
      {c.senders.length ? (
        <div className="bc-line bc-senders">
          {fill(s["strings.views.card.senders"], {
            senders: c.senders
              .map((x) => fill(s["strings.views.card.sender"], { from: x.from, count: x.count }))
              .join(", "),
          })}
        </div>
      ) : null}
      {c.fields.map((f) => {
        const out = f.per === "row" ? f.resolved + f.unsure + f.none : t.tried;
        const warn = out > 0 && shown.has(f.field) && f.resolved / out < warnBelow;
        const warnText = fill(s["strings.views.card.warn"], {
          label: f.label,
          pct: `${Math.round(warnBelow * 100)}%`,
        });
        const words = { label: f.label, resolved: f.resolved, tried: t.tried };
        const main =
          f.per === "row"
            ? fill(s["strings.views.card.read_rows"], words)
            : !f.field.startsWith("x:")
              ? fill(s["strings.views.card.read_signal"], words)
              : f.values !== undefined
                ? fill(s["strings.views.card.read_values"], { ...words, values: f.values })
                : fill(s["strings.views.card.read"], words);
        return (
          <div
            key={f.field}
            className={cx("bc-cov", warn && "warn")}
            data-field={f.field}
            data-warn={warn ? "true" : undefined}
          >
            {warn ? (
              <span className="ic" role="img" aria-label={warnText} title={warnText}>
                <WarningIcon />
              </span>
            ) : null}
            <span className="lab">{main}</span>
            {reasonsOf(draft, f, s).map((r) => {
              const ids = f.threads?.[r.reason];
              const on = filter?.field === f.field && filter.reason === r.reason;
              return ids?.length ? (
                <button
                  key={r.reason}
                  type="button"
                  className={cx("bc-reason", on && "on")}
                  data-reason={r.reason}
                  aria-pressed={on}
                  title={s["strings.views.card.filter_title"]}
                  onClick={() =>
                    onFilter(
                      on
                        ? null
                        : {
                            field: f.field,
                            reason: r.reason,
                            label: f.label,
                            text: r.text,
                            threadIds: ids,
                          },
                    )
                  }
                >
                  {r.text}
                </button>
              ) : (
                <span key={r.reason} className="bc-reason" data-reason={r.reason}>
                  {r.text}
                </span>
              );
            })}
            {f.examples.length ? (
              <span className="ex">
                {fill(s["strings.views.card.examples"], { examples: f.examples.join(", ") })}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** An Extraction's value on a tried row in words: the span, Unsure, Not stated or Not read yet. */
function valueText(v: ViewTriedThread["values"][number], s: Settings): string {
  if (v.state === "value") return v.text ?? "";
  if (v.state === "unsure") return s["strings.views.unsure"];
  if (v.state === "empty") return s["strings.views.not_stated"];
  return s["strings.views.not_read"];
}

/** One Block drawn small on the card: a stat's number, a chart's bars, Lane counts, first rows in words. */
function BlockMini({ b, s }: { b: BlockPreview; s: Settings }) {
  const title = b.title || s[`strings.views.show_as.${b.type as "lanes"}`] || b.type;
  return (
    <div className="bc-block" data-type={b.type} data-block={b.id}>
      {b.type !== "text" ? <span className="bt">{title}</span> : null}
      {b.type === "stat" ? (
        <span className="bstat">
          <b>{b.value}</b>
          {b.change ? <span className="chg">{b.change}</span> : null}
        </span>
      ) : b.type === "chart" ? (
        <BarChart
          label={title}
          height={60}
          items={b.items.map((i, n) => ({
            key: `${n}`,
            label: i.label,
            value: i.count ?? 0,
            text: i.value,
          }))}
        />
      ) : b.type === "text" ? (
        <span className="btext">{b.value}</span>
      ) : b.type === "lanes" || b.type === "list" || b.type === "counts" ? (
        <span className="blanes">
          {b.items.map((i) => (
            <span key={i.label} className="bc-lane" data-tone={i.tone}>
              <span className="dot" aria-hidden="true" />
              {i.label} <b>{i.count ?? 0}</b>
            </span>
          ))}
        </span>
      ) : (
        <span className="brows">
          {b.items.map((i, n) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a preview row is its position
            <span key={n} className="brow">
              {i.label}
              {i.value ? <span className="v"> · {i.value}</span> : null}
              {i.count !== undefined ? <b> {i.count}</b> : null}
            </span>
          ))}
        </span>
      )}
      {b.unsure > 0 ? (
        <span className="bunsure">
          {fill(s["strings.views.unsure_count"], { count: b.unsure })}
        </span>
      ) : null}
    </div>
  );
}
