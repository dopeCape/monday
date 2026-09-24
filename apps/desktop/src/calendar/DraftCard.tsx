// A calendar draft in the composer: the Agent's proposed changes as a card,
// the title and summary, the counts to add, change and remove, the first
// few changes as diff lines, and Show on the Calendar, Discard and Apply.
// Mounting it offers the draft to the store, which opens the Calendar on a
// draft seen for the first time when calendar.agent_draft_focus says so.

import type { CalendarDraft, CalendarDraftChange, Settings } from "@monday/shared";
import { Btn, cx, formatSpan } from "@monday/ui";
import { useEffect, useState } from "react";
import { useShell } from "../shell/Shell.tsx";
import { useCalendarDrafts, useDraftEntries } from "./DraftsContext.tsx";
import { draftCounts } from "./drafts.ts";

const fill = (t: string, vars: Record<string, string | number>) =>
  t.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));

/** "Tue 29 Sep, 10:00 to 11:00", or before and after for a change. */
export function changeWhen(c: CalendarDraftChange, s: Settings): string {
  const f = c.after ?? c.before;
  if (!f) return "";
  const when = formatSpan(f.start, f.end, f.allDay);
  if (
    c.kind === "update" &&
    c.before &&
    c.after &&
    (c.before.start !== c.after.start || c.before.end !== c.after.end)
  ) {
    return fill(s["strings.calendar.draft.moved"], {
      from: formatSpan(c.before.start, c.before.end, c.before.allDay),
      to: when,
    });
  }
  return when;
}

export function countsLine(draft: CalendarDraft, s: Settings): string {
  const n = draftCounts(draft);
  return [
    n.create ? fill(s["strings.calendar.draft.to_add"], { n: n.create }) : "",
    n.update ? fill(s["strings.calendar.draft.to_change"], { n: n.update }) : "",
    n.delete ? fill(s["strings.calendar.draft.to_remove"], { n: n.delete }) : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

export const CHANGE_MARK: Record<CalendarDraftChange["kind"], string> = {
  create: "+",
  update: "~",
  delete: "−",
};

export function CalendarDraftPreview({ draft }: { draft: CalendarDraft }) {
  const { settings: s } = useShell();
  const drafts = useCalendarDrafts();
  const { entries } = useDraftEntries();
  const entry = entries.find((e) => e.draft.id === draft.id);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    void drafts?.store.offer(draft);
  }, [drafts, draft]);
  const rows = s["calendar.draft_card_rows"];
  const status = entry?.status ?? "open";
  const apply = async () => {
    if (!drafts) return;
    setBusy(true);
    const r = await drafts.apply(draft.id).finally(() => setBusy(false));
    if (r.failed.length)
      setNote(
        fill(s["strings.calendar.draft.some_failed"], {
          n: r.failed.length,
          message: r.failed[0]?.message ?? "",
        }),
      );
  };
  return (
    <div className="agent-preview cal-draft-card">
      <div className="cal-draft-card-head">
        <b>{draft.title}</b>
        <span className="faint">{countsLine(draft, s)}</span>
      </div>
      {draft.summary ? <p className="cal-draft-card-sum">{draft.summary}</p> : null}
      <ul className="cal-draft-lines">
        {draft.changes.slice(0, rows).map((c) => (
          <li key={c.id} className={cx(c.kind, entry?.applied.includes(c.id) && "done")}>
            <span className="cal-draft-mark" aria-hidden="true">
              {CHANGE_MARK[c.kind]}
            </span>
            <span className="cal-draft-title">{(c.after ?? c.before)?.title}</span>
            <span className="faint">{changeWhen(c, s)}</span>
          </li>
        ))}
      </ul>
      {draft.changes.length > rows ? (
        <p className="faint cal-draft-more">
          {fill(s["strings.calendar.draft.more"], { n: draft.changes.length - rows })}
        </p>
      ) : null}
      {note ? <p className="cal-error">{note}</p> : null}
      {drafts ? (
        <div className="cal-draft-card-actions">
          {status === "applied" || status === "discarded" ? (
            <span className="faint">
              {status === "applied"
                ? s["strings.calendar.draft.applied"]
                : s["strings.calendar.draft.discarded"]}
            </span>
          ) : (
            <>
              <Btn sm onClick={() => drafts.show(draft)}>
                {s["strings.calendar.draft.show"]}
              </Btn>
              <span className="sp" />
              <Btn sm onClick={() => void drafts.store.discard(draft.id)}>
                {s["strings.calendar.draft.discard"]}
              </Btn>
              <Btn sm primary disabled={busy} onClick={() => void apply()}>
                {status === "partial"
                  ? s["strings.calendar.draft.apply_rest"]
                  : s["strings.calendar.draft.apply_all"]}
              </Btn>
            </>
          )}
          {status === "applied" ? (
            <Btn sm onClick={() => void drafts.store.undo(draft.id)}>
              {s["strings.calendar.draft.undo"]}
            </Btn>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
