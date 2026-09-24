// A calendar draft on the Calendar: the bar under the header naming the
// draft, its counts and Apply, Discard and Review; the review list beside
// the views, one row per change with a box to leave it out ("apply some");
// and the detail of one change when its ghost is clicked. Drafts waiting
// that are not on screen get a quiet line with Open.

import type { CalendarDraft, CalendarDraftChange, Settings } from "@monday/shared";
import { Btn, cx, Icon, Mark } from "@monday/ui";
import { ListChecksIcon, XIcon } from "@phosphor-icons/react";
import { CHANGE_MARK, changeWhen, countsLine } from "../../calendar/DraftCard.tsx";
import type { DraftEntry } from "../../calendar/drafts.ts";

const fill = (t: string, vars: Record<string, string | number>) =>
  t.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));

export interface DraftBarProps {
  entry: DraftEntry;
  s: Settings;
  /** Changes left out of the next apply. */
  skipped: ReadonlySet<string>;
  reviewing: boolean;
  busy: boolean;
  onReview: () => void;
  onApply: () => void;
  onDiscard: () => void;
  onClose: () => void;
}

export function DraftBar({
  entry,
  s,
  skipped,
  reviewing,
  busy,
  onReview,
  onApply,
  onDiscard,
  onClose,
}: DraftBarProps) {
  const open = entry.draft.changes.filter((c) => !entry.applied.includes(c.id));
  const picked = open.filter((c) => !skipped.has(c.id)).length;
  const all = picked === open.length;
  return (
    <section className="cal-draft-bar" aria-label={s["strings.calendar.draft.bar"]}>
      <Mark small />
      <div className="cal-draft-bar-text">
        <b>{entry.draft.title}</b>
        <span>{countsLine(entry.draft, s)}</span>
      </div>
      <Btn sm on={reviewing} onClick={onReview}>
        <Icon icon={ListChecksIcon} />{" "}
        {reviewing ? s["strings.calendar.draft.hide_review"] : s["strings.calendar.draft.review"]}
      </Btn>
      <Btn sm onClick={onDiscard}>
        {s["strings.calendar.draft.discard"]}
      </Btn>
      <Btn sm primary disabled={busy || picked === 0} onClick={onApply}>
        {all
          ? entry.status === "partial"
            ? s["strings.calendar.draft.apply_rest"]
            : s["strings.calendar.draft.apply_all"]
          : fill(s["strings.calendar.draft.apply_some"], { n: picked })}
      </Btn>
      <Btn sm icon title={s["strings.calendar.close"]} onClick={onClose}>
        <Icon icon={XIcon} />
      </Btn>
    </section>
  );
}

export interface DraftReviewProps {
  draft: CalendarDraft;
  applied: readonly string[];
  skipped: ReadonlySet<string>;
  s: Settings;
  focus: string | null;
  onToggle: (changeId: string, include: boolean) => void;
  onPick: (change: CalendarDraftChange) => void;
}

/** The draft's changes as a list, each with a box to keep it in or leave it out. */
export function DraftReview({
  draft,
  applied,
  skipped,
  s,
  focus,
  onToggle,
  onPick,
}: DraftReviewProps) {
  return (
    <aside className="cal-side cal-draft-review" aria-label={s["strings.calendar.draft.review"]}>
      <h3>{draft.title}</h3>
      {draft.summary ? <p className="cal-draft-sum">{draft.summary}</p> : null}
      <ul>
        {draft.changes.map((c) => {
          const done = applied.includes(c.id);
          const f = c.after ?? c.before;
          return (
            <li
              key={c.id}
              className={cx(
                c.kind,
                done && "done",
                focus === c.id && "focus",
                skipped.has(c.id) && "skipped",
              )}
            >
              <input
                type="checkbox"
                aria-label={s["strings.calendar.draft.pick"]}
                checked={done || !skipped.has(c.id)}
                disabled={done}
                onChange={(e) => onToggle(c.id, e.currentTarget.checked)}
              />
              <button type="button" onClick={() => onPick(c)}>
                <span className="cal-draft-mark" aria-hidden="true">
                  {CHANGE_MARK[c.kind]}
                </span>
                <span className="cal-draft-body">
                  <b>{f?.title}</b>
                  <span>{changeWhen(c, s)}</span>
                  {c.reason ? <i>{c.reason}</i> : null}
                </span>
                <span className="cal-draft-kind">
                  {s[`strings.calendar.draft.kind.${c.kind}` as keyof Settings] as string}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

/** One change's detail, in the popover beside its ghost. */
export function DraftChangeDetail({
  change,
  s,
  skipped,
  onToggle,
  onClose,
}: {
  change: CalendarDraftChange;
  s: Settings;
  skipped: boolean;
  onToggle: (include: boolean) => void;
  onClose: () => void;
}) {
  const f = change.after ?? change.before;
  return (
    <div className={cx("cal-detail cal-draft-detail", change.kind)}>
      <div className="cal-detail-tools">
        <Btn icon sm title={s["strings.calendar.close"]} onClick={onClose}>
          <Icon icon={XIcon} />
        </Btn>
      </div>
      <div className="cal-detail-title">
        <span className="cal-draft-mark" aria-hidden="true">
          {CHANGE_MARK[change.kind]}
        </span>
        <h3>{f?.title}</h3>
      </div>
      <p className="cal-detail-when">
        {s[`strings.calendar.draft.kind.${change.kind}` as keyof Settings] as string} ·{" "}
        {changeWhen(change, s)}
      </p>
      {change.reason ? <p className="cal-draft-reason">{change.reason}</p> : null}
      {change.guests.length ? (
        <p className="cal-detail-line faint">
          {change.guests.map((g) => g.name || g.email).join(", ")}
        </p>
      ) : null}
      <div className="cal-rsvp">
        <span>{s["strings.calendar.draft.pick"]}</span>
        <Btn sm on={!skipped} aria-pressed={!skipped} onClick={() => onToggle(skipped)}>
          {skipped ? s["strings.calendar.draft.include"] : s["strings.calendar.draft.leave_out"]}
        </Btn>
      </div>
    </div>
  );
}

export function DraftsWaiting({ n, s, onOpen }: { n: number; s: Settings; onOpen: () => void }) {
  return (
    <div className="cal-draft-bar quiet" role="status">
      <Mark small />
      <span>{fill(s["strings.calendar.draft.waiting"], { n })}</span>
      <Btn sm onClick={onOpen}>
        {s["strings.calendar.draft.open"]}
      </Btn>
    </div>
  );
}
