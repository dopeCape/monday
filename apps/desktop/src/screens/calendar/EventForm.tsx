// Making and editing an Event: the quick create that opens on the slot a
// click or a drag picked (title, time, calendar, guests) and the full
// editor behind "More options" and Edit (notes, place, meeting link,
// repeat, reminders, time zone). Both edit one Draft; saving hands it back
// and the screen asks whatever it must first (which instances, whether to
// email the guests).

import type { Calendar, MeetingLinkKind, Person, Settings } from "@monday/shared";
import { Btn, Icon, Input, Switch, useEscape, useFocusTrap } from "@monday/ui";
import {
  ArrowsClockwiseIcon,
  BellIcon,
  GlobeIcon,
  MapPinIcon,
  TextAlignLeftIcon,
  UsersIcon,
  VideoCameraIcon,
  XIcon,
} from "@phosphor-icons/react";
import {
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { CalendarAccount } from "./calendar-data.ts";
import { knownZones } from "./dates.ts";
import { type Draft, draftProblem, withStart } from "./draft.ts";
import { reminderWords } from "./EventDetail.tsx";
import { parsePeople } from "./model.ts";
import { presetOf, REPEAT_PRESETS, type RepeatPreset, ruleFor } from "./repeat.ts";

const fill = (t: string, vars: Record<string, string | number>) =>
  t.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));

/* ------------------------------ Fields ------------------------------ */

export function PeopleField({
  people,
  onChange,
  placeholder,
  label,
  removeLabel,
}: {
  people: readonly Person[];
  onChange: (people: Person[]) => void;
  placeholder: string;
  label: string;
  removeLabel: string;
}) {
  const [text, setText] = useState("");
  const commit = () => {
    const found = parsePeople(text);
    if (found.length === 0) return false;
    const have = new Set(people.map((p) => p.email.toLowerCase()));
    onChange([...people, ...found.filter((p) => !have.has(p.email.toLowerCase()))]);
    setText("");
    return true;
  };
  return (
    <div className="cal-people">
      {people.map((p) => (
        <span key={p.email} className="cal-chip" title={p.email}>
          {p.name || p.email}
          <button
            type="button"
            aria-label={fill(removeLabel, { name: p.name || p.email })}
            onClick={() => onChange(people.filter((x) => x.email !== p.email))}
          >
            <Icon icon={XIcon} />
          </button>
        </span>
      ))}
      <input
        className="cal-people-input"
        aria-label={label}
        value={text}
        placeholder={people.length ? "" : placeholder}
        onChange={(e) => {
          const v = e.target.value;
          if (/[,;]\s*$/.test(v)) {
            setText(v.replace(/[,;]\s*$/, ""));
            const found = parsePeople(v);
            if (found.length) {
              const have = new Set(people.map((p) => p.email.toLowerCase()));
              onChange([...people, ...found.filter((p) => !have.has(p.email.toLowerCase()))]);
              setText("");
            }
            return;
          }
          setText(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && text.trim()) {
            if (commit()) e.preventDefault();
          } else if (e.key === "Backspace" && text === "" && people.length > 0) {
            onChange(people.slice(0, -1));
          }
        }}
        onBlur={() => void commit()}
      />
    </div>
  );
}

function CalendarSelect({
  calendars,
  accounts,
  value,
  onChange,
  label,
}: {
  calendars: readonly Calendar[];
  accounts: readonly CalendarAccount[];
  value: string | null;
  onChange: (id: string) => void;
  label: string;
}) {
  const writable = calendars.filter((c) => c.writable);
  const groups = new Map<string, Calendar[]>();
  for (const c of writable) groups.set(c.workspaceId, [...(groups.get(c.workspaceId) ?? []), c]);
  const name = (ws: string) => accounts.find((a) => a.workspaceId === ws)?.address ?? ws;
  return (
    <select
      className="input cal-select"
      aria-label={label}
      value={value ?? writable[0]?.id ?? ""}
      onChange={(e) => onChange(e.target.value)}
    >
      {groups.size > 1
        ? [...groups.entries()].map(([ws, list]) => (
            <optgroup key={ws} label={name(ws)}>
              {list.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </optgroup>
          ))
        : writable.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
    </select>
  );
}

function TimeFields({
  draft,
  onChange,
  s,
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
  s: Settings;
}) {
  const step = s["calendar.snap_minutes"] * 60;
  return (
    <div className="cal-times">
      <Input
        type="date"
        aria-label={s["strings.calendar.form.start_date"]}
        value={draft.startDate}
        onChange={(e) => onChange(withStart(draft, e.target.value, draft.startTime))}
      />
      {draft.allDay ? null : (
        <Input
          type="time"
          step={step}
          aria-label={s["strings.calendar.form.start"]}
          value={draft.startTime}
          onChange={(e) => onChange(withStart(draft, draft.startDate, e.target.value))}
        />
      )}
      <span className="faint">{s["strings.calendar.to"]}</span>
      {draft.allDay ? null : (
        <Input
          type="time"
          step={step}
          aria-label={s["strings.calendar.form.end"]}
          value={draft.endTime}
          onChange={(e) => onChange({ ...draft, endTime: e.target.value })}
        />
      )}
      <Input
        type="date"
        aria-label={s["strings.calendar.form.end_date"]}
        value={draft.endDate}
        onChange={(e) => onChange({ ...draft, endDate: e.target.value })}
      />
    </div>
  );
}

function problemText(d: Draft, s: Settings): string | null {
  const p = draftProblem(d);
  if (p === "end_before_start") return s["strings.calendar.form.end_before_start"];
  if (p === "bad_time") return s["strings.calendar.form.bad_time"];
  return null;
}

/* ------------------------------ Quick create ------------------------------ */

export interface QuickCreateProps {
  draft: Draft;
  onChange: (d: Draft) => void;
  calendars: readonly Calendar[];
  accounts: readonly CalendarAccount[];
  colors: ReadonlyMap<string, string>;
  s: Settings;
  busy: boolean;
  error: string | null;
  onSave: () => void;
  onMore: () => void;
  onCancel: () => void;
}

export function QuickCreate({
  draft,
  onChange,
  calendars,
  accounts,
  colors,
  s,
  busy,
  error,
  onSave,
  onMore,
  onCancel,
}: QuickCreateProps) {
  const problem = problemText(draft, s);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!problem && !busy) onSave();
  };
  return (
    <form
      className="cal-quick"
      onSubmit={submit}
      aria-label={s["strings.calendar.new_event"]}
      style={
        {
          "--ev": (draft.calendarId && colors.get(draft.calendarId)) || "var(--fg-muted)",
        } as CSSProperties
      }
    >
      <input
        className="cal-quick-title"
        // biome-ignore lint/a11y/noAutofocus: the quick create opens to be typed into
        autoFocus
        value={draft.title}
        placeholder={s["strings.calendar.form.title_placeholder"]}
        aria-label={s["strings.calendar.form.title"]}
        onChange={(e) => onChange({ ...draft, title: e.target.value })}
      />
      <TimeFields draft={draft} onChange={onChange} s={s} />
      <div className="cal-quick-row">
        <Switch
          on={draft.allDay}
          label={s["strings.calendar.all_day"]}
          onChange={(v) => onChange({ ...draft, allDay: v })}
        />
        <span className="cal-dot" aria-hidden="true" />
        <CalendarSelect
          calendars={calendars}
          accounts={accounts}
          value={draft.calendarId}
          onChange={(id) => onChange({ ...draft, calendarId: id })}
          label={s["strings.calendar.form.calendar"]}
        />
      </div>
      <div className="cal-quick-row">
        <Icon icon={UsersIcon} />
        <PeopleField
          people={draft.attendees}
          onChange={(attendees) => onChange({ ...draft, attendees })}
          placeholder={s["strings.calendar.form.guests_placeholder"]}
          label={s["strings.calendar.form.attendees"]}
          removeLabel={s["strings.calendar.form.remove_guest"]}
        />
      </div>
      {problem || error ? (
        <p className="cal-error" role="alert">
          {problem ?? error}
        </p>
      ) : null}
      <div className="cal-quick-foot">
        <Btn type="button" onClick={onMore}>
          {s["strings.calendar.form.more"]}
        </Btn>
        <span className="sp" />
        <Btn type="button" onClick={onCancel}>
          {s["strings.calendar.form.cancel"]}
        </Btn>
        <Btn primary type="submit" disabled={busy || problem !== null}>
          {s["strings.calendar.form.save"]}
        </Btn>
      </div>
    </form>
  );
}

/* ------------------------------ The editor ------------------------------ */

export interface EventEditorProps {
  draft: Draft;
  onChange: (d: Draft) => void;
  /** Editing an Event rather than making one. */
  editing: boolean;
  /** An instance the Provider expanded: its series' rule is not in hand, so Repeat is read-only. */
  instance: boolean;
  calendars: readonly Calendar[];
  accounts: readonly CalendarAccount[];
  colors: ReadonlyMap<string, string>;
  s: Settings;
  busy: boolean;
  error: string | null;
  onSave: () => void;
  onDelete?: (() => void) | undefined;
  onCancel: () => void;
}

const LINK_KINDS: ReadonlyArray<MeetingLinkKind | "default"> = [
  "default",
  "none",
  "google-meet",
  "teams",
  "jitsi",
  "custom",
];

export function EventEditor({
  draft,
  onChange,
  editing,
  instance,
  calendars,
  accounts,
  colors,
  s,
  busy,
  error,
  onSave,
  onDelete,
  onCancel,
}: EventEditorProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  useFocusTrap(ref);
  useEscape(onCancel);
  const zones = useMemo(() => knownZones(), []);
  const problem = problemText(draft, s);
  const startDay = new Date(`${draft.startDate}T12:00:00`);
  const preset: RepeatPreset = presetOf(
    draft.recurrence,
    Number.isNaN(startDay.getTime()) ? new Date() : startDay,
  );
  const [customRule, setCustomRule] = useState(preset === "custom" ? (draft.recurrence ?? "") : "");
  const source = calendars.find((c) => c.id === draft.calendarId)?.source;
  const kinds = LINK_KINDS.filter(
    (k) => (k !== "google-meet" || source === "google") && (k !== "teams" || source === "graph"),
  );
  const linkLabel = (k: MeetingLinkKind | "default") =>
    s[`strings.calendar.link.${k === "google-meet" ? "meet" : k}` as keyof Settings] as string;
  const choices = s["calendar.reminder_choices"];
  const reminders = draft.reminders;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!problem && !busy) onSave();
  };
  const titleKeys = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(e);
  };
  return createPortal(
    <div className="cal-editor-scrim">
      <div
        ref={ref}
        className="cal-editor"
        role="dialog"
        aria-modal="true"
        aria-label={editing ? s["strings.calendar.edit_event"] : s["strings.calendar.new_event"]}
        style={
          {
            "--ev": (draft.calendarId && colors.get(draft.calendarId)) || "var(--fg-muted)",
          } as CSSProperties
        }
      >
        <form onSubmit={submit}>
          <div className="cal-editor-head">
            <span className="cal-dot" aria-hidden="true" />
            <input
              className="cal-editor-title"
              // biome-ignore lint/a11y/noAutofocus: the editor opens on the title
              autoFocus
              value={draft.title}
              placeholder={s["strings.calendar.form.title_placeholder"]}
              aria-label={s["strings.calendar.form.title"]}
              onChange={(e) => onChange({ ...draft, title: e.target.value })}
              onKeyDown={titleKeys}
            />
            <Btn icon type="button" title={s["strings.calendar.close"]} onClick={onCancel}>
              <Icon icon={XIcon} />
            </Btn>
          </div>
          <div className="cal-editor-body">
            <div className="cal-field">
              <TimeFields draft={draft} onChange={onChange} s={s} />
              <div className="cal-field-row">
                <Switch
                  on={draft.allDay}
                  label={s["strings.calendar.all_day"]}
                  onChange={(v) => onChange({ ...draft, allDay: v })}
                />
                {draft.allDay ? null : (
                  <label className="cal-inline">
                    <Icon icon={GlobeIcon} />
                    <input
                      className="input"
                      list="cal-zones"
                      aria-label={s["strings.calendar.form.time_zone"]}
                      value={draft.timeZone}
                      onChange={(e) => onChange({ ...draft, timeZone: e.target.value })}
                    />
                    <datalist id="cal-zones">
                      {zones.map((z) => (
                        <option key={z} value={z} />
                      ))}
                    </datalist>
                  </label>
                )}
              </div>
            </div>
            <div className="cal-field">
              <Icon icon={ArrowsClockwiseIcon} />
              {instance ? (
                <span className="faint">{s["strings.calendar.detail.repeats"]}</span>
              ) : (
                <>
                  <select
                    className="input cal-select"
                    aria-label={s["strings.calendar.form.repeat"]}
                    value={preset}
                    onChange={(e) => {
                      const p = e.target.value as RepeatPreset;
                      onChange({
                        ...draft,
                        recurrence: ruleFor(p, startDay, customRule || "FREQ=WEEKLY"),
                      });
                    }}
                  >
                    {REPEAT_PRESETS.map((p) => (
                      <option key={p} value={p}>
                        {s[`strings.calendar.repeat.preset.${p}` as keyof Settings] as string}
                      </option>
                    ))}
                  </select>
                  {preset === "custom" ? (
                    <Input
                      className="mono"
                      aria-label={s["strings.calendar.form.rule"]}
                      value={customRule || (draft.recurrence ?? "")}
                      placeholder="FREQ=WEEKLY;BYDAY=MO,WE"
                      onChange={(e) => {
                        setCustomRule(e.target.value);
                        onChange({
                          ...draft,
                          recurrence: ruleFor("custom", startDay, e.target.value),
                        });
                      }}
                    />
                  ) : null}
                </>
              )}
            </div>
            <div className="cal-field">
              <span className="cal-dot" aria-hidden="true" />
              <CalendarSelect
                calendars={calendars}
                accounts={accounts}
                value={draft.calendarId}
                onChange={(id) => onChange({ ...draft, calendarId: id })}
                label={s["strings.calendar.form.calendar"]}
              />
            </div>
            <div className="cal-field">
              <Icon icon={UsersIcon} />
              <PeopleField
                people={draft.attendees}
                onChange={(attendees) => onChange({ ...draft, attendees })}
                placeholder={s["strings.calendar.form.guests_placeholder"]}
                label={s["strings.calendar.form.attendees"]}
                removeLabel={s["strings.calendar.form.remove_guest"]}
              />
            </div>
            <div className="cal-field">
              <Icon icon={VideoCameraIcon} />
              <select
                className="input cal-select"
                aria-label={s["strings.calendar.form.meeting_link"]}
                value={draft.meetingLink}
                onChange={(e) =>
                  onChange({ ...draft, meetingLink: e.target.value as Draft["meetingLink"] })
                }
              >
                {kinds.map((k) => (
                  <option key={k} value={k}>
                    {linkLabel(k)}
                  </option>
                ))}
              </select>
              {draft.meetingLink === "custom" ? (
                <Input
                  type="url"
                  aria-label={s["strings.calendar.form.custom_link"]}
                  placeholder="https://"
                  value={draft.customLink}
                  onChange={(e) => onChange({ ...draft, customLink: e.target.value })}
                />
              ) : null}
            </div>
            <div className="cal-field">
              <Icon icon={MapPinIcon} />
              <Input
                aria-label={s["strings.calendar.form.location"]}
                placeholder={s["strings.calendar.form.location"]}
                value={draft.location}
                onChange={(e) => onChange({ ...draft, location: e.target.value })}
              />
            </div>
            <div className="cal-field">
              <Icon icon={BellIcon} />
              <div className="cal-reminders">
                {reminders === null ? (
                  <span className="cal-chip quiet">
                    {fill(s["strings.calendar.reminder.default"], {
                      when: reminderWords(s["notifications.calendar_lead_minutes"], s),
                    })}
                  </span>
                ) : reminders.length === 0 ? (
                  <span className="cal-chip quiet">{s["strings.calendar.reminder.none"]}</span>
                ) : (
                  reminders.map((m) => (
                    <span key={m} className="cal-chip">
                      {reminderWords(m, s)}
                      <button
                        type="button"
                        aria-label={fill(s["strings.calendar.reminder.remove"], {
                          when: reminderWords(m, s),
                        })}
                        onClick={() =>
                          onChange({ ...draft, reminders: reminders.filter((x) => x !== m) })
                        }
                      >
                        <Icon icon={XIcon} />
                      </button>
                    </span>
                  ))
                )}
                <select
                  className="input cal-select"
                  aria-label={s["strings.calendar.reminder.add"]}
                  value=""
                  onChange={(e) => {
                    const v = e.target.value;
                    if (v === "default") onChange({ ...draft, reminders: null });
                    else if (v === "none") onChange({ ...draft, reminders: [] });
                    else {
                      const m = Number(v);
                      const next = [...new Set([...(reminders ?? []), m])].sort((a, b) => a - b);
                      onChange({ ...draft, reminders: next });
                    }
                  }}
                >
                  <option value="">{s["strings.calendar.reminder.add"]}</option>
                  {choices
                    .filter((m) => !reminders?.includes(m))
                    .map((m) => (
                      <option key={m} value={m}>
                        {reminderWords(m, s)}
                      </option>
                    ))}
                  <option value="default">{s["strings.calendar.reminder.use_default"]}</option>
                  <option value="none">{s["strings.calendar.reminder.none"]}</option>
                </select>
              </div>
            </div>
            <div className="cal-field top">
              <Icon icon={TextAlignLeftIcon} />
              <textarea
                className="input cal-notes"
                aria-label={s["strings.calendar.form.description"]}
                placeholder={s["strings.calendar.form.description"]}
                value={draft.description}
                rows={4}
                onChange={(e) => onChange({ ...draft, description: e.target.value })}
              />
            </div>
          </div>
          {problem || error ? (
            <p className="cal-error cal-editor-error" role="alert">
              {problem ?? error}
            </p>
          ) : null}
          <div className="cal-editor-foot">
            {onDelete ? (
              <Btn type="button" onClick={onDelete}>
                {s["strings.calendar.delete"]}
              </Btn>
            ) : null}
            <span className="sp" />
            <Btn type="button" onClick={onCancel}>
              {s["strings.calendar.form.cancel"]}
            </Btn>
            <Btn primary type="submit" disabled={busy || problem !== null}>
              {s["strings.calendar.form.save"]}
            </Btn>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
