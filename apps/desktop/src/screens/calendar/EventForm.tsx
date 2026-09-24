// Making and editing an Event: the quick create that opens on the slot a
// click or a drag picked (title, when, repeat, calendar, guests) and the
// full editor behind "More options" and Edit, laid out in two columns: when
// and who on the left with the notes, where, the calendar and reminders on
// the right. Every control is monday's own (controls.tsx), never the
// browser's. Guests are suggested from the people in the mail and on
// earlier Events as they are typed. Both edit one Draft; saving hands it
// back and the screen asks whatever it must first (which instances,
// whether to email the guests).

import type { Calendar, MeetingLinkKind, Person, Settings } from "@monday/shared";
import { Avatar, Btn, cx, Icon, Input, useEscape, useFocusTrap } from "@monday/ui";
import {
  ArrowsClockwiseIcon,
  BellIcon,
  CalendarBlankIcon,
  ClockIcon,
  GlobeIcon,
  MapPinIcon,
  PlusIcon,
  UsersIcon,
  VideoCameraIcon,
  XIcon,
} from "@phosphor-icons/react";
import {
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { suggest } from "../compose/Recipients.tsx";
import type { CalendarAccount } from "./calendar-data.ts";
import { DateField, Dropdown, type DropdownOption, TimeField, ZoneField } from "./controls.tsx";
import { knownZones, zoneLabel } from "./dates.ts";
import { type Draft, draftProblem, withStart } from "./draft.ts";
import { reminderWords } from "./EventDetail.tsx";
import { parsePeople } from "./model.ts";
import { presetOf, REPEAT_PRESETS, type RepeatPreset, ruleFor } from "./repeat.ts";

const fill = (t: string, vars: Record<string, string | number>) =>
  t.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));

/* ------------------------------ Guests ------------------------------ */

export interface PeopleFieldProps {
  people: readonly Person[];
  onChange: (people: Person[]) => void;
  /** Who to suggest, most recent first: the people in the mail and on earlier Events. */
  directory: readonly Person[];
  limit: number;
  placeholder: string;
  label: string;
  removeLabel: string;
  autoFocus?: boolean | undefined;
}

/** Guests as chips with an input that suggests people as they are typed; arrows walk, Enter or Tab picks. */
export function PeopleField({
  people,
  onChange,
  directory,
  limit,
  placeholder,
  label,
  removeLabel,
  autoFocus,
}: PeopleFieldProps) {
  const [text, setText] = useState("");
  const [cursor, setCursor] = useState(0);
  const [focused, setFocused] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  const suggestions = useMemo(
    () => suggest(directory, text, people, limit),
    [directory, text, people, limit],
  );
  const add = (found: readonly Person[]) => {
    const have = new Set(people.map((p) => p.email.toLowerCase()));
    const fresh = found.filter((p) => !have.has(p.email.toLowerCase()));
    if (fresh.length) onChange([...people, ...fresh]);
    setText("");
    setCursor(0);
  };
  const commit = (): boolean => {
    const picked = suggestions[cursor];
    if (picked && text.trim()) {
      add([picked]);
      return true;
    }
    const typed = parsePeople(text).map(
      (p) => directory.find((d) => d.email.toLowerCase() === p.email.toLowerCase()) ?? p,
    );
    if (typed.length === 0) return false;
    add(typed);
    return true;
  };
  const open = focused && suggestions.length > 0 && text.trim() !== "";
  return (
    <div className="cal-people-wrap" ref={box}>
      <div className={cx("cal-people", focused && "focused")}>
        {people.map((p) => (
          <span key={p.email} className="cal-chip" title={p.email}>
            <Avatar name={p.name || p.email} className="cal-chip-av" />
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
          role="combobox"
          aria-controls={listId}
          aria-label={label}
          aria-autocomplete="list"
          aria-expanded={open}
          // biome-ignore lint/a11y/noAutofocus: opened from "Add guests", it takes typing at once
          autoFocus={autoFocus}
          value={text}
          placeholder={people.length ? "" : placeholder}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            // A typed address becomes a guest on leaving the field; a half-typed name does not.
            if (parsePeople(text).length) add(parsePeople(text));
          }}
          onChange={(e) => {
            const v = e.target.value;
            if (/[,;]\s*$/.test(v)) {
              const found = parsePeople(v);
              if (found.length) {
                add(found);
                return;
              }
            }
            setText(v);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" && open) {
              e.preventDefault();
              setCursor((c) => Math.min(suggestions.length - 1, c + 1));
            } else if (e.key === "ArrowUp" && open) {
              e.preventDefault();
              setCursor((c) => Math.max(0, c - 1));
            } else if ((e.key === "Enter" || (e.key === "Tab" && open)) && text.trim()) {
              if (commit()) {
                e.preventDefault();
                e.stopPropagation();
              }
            } else if (e.key === "Escape" && open) {
              e.preventDefault();
              e.stopPropagation();
              setText("");
            } else if (e.key === "Backspace" && text === "" && people.length > 0) {
              onChange(people.slice(0, -1));
            }
          }}
        />
      </div>
      {open ? (
        <div className="cal-suggest" id={listId} role="listbox" aria-label={label}>
          {suggestions.map((p, i) => (
            <button
              type="button"
              role="option"
              key={p.email}
              aria-selected={i === cursor}
              className={cx("pop-item", i === cursor && "on")}
              onMouseEnter={() => setCursor(i)}
              // Before the input's blur.
              onPointerDown={(e) => {
                e.preventDefault();
                add([p]);
              }}
            >
              <Avatar name={p.name || p.email} className="cal-chip-av" />
              <span className="cal-suggest-name">{p.name || p.email}</span>
              {p.name ? <span className="when">{p.email}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------ Shared pieces ------------------------------ */

function calendarOptions(
  calendars: readonly Calendar[],
  accounts: readonly CalendarAccount[],
  colors: ReadonlyMap<string, string>,
): DropdownOption<string>[] {
  const writable = calendars.filter((c) => c.writable && c.access !== "free-busy");
  const many = new Set(writable.map((c) => c.workspaceId)).size > 1;
  const name = (ws: string) => accounts.find((a) => a.workspaceId === ws)?.address ?? ws;
  return writable.map((c) => ({
    value: c.id,
    label: c.name,
    color: colors.get(c.id),
    ...(many ? { group: name(c.workspaceId) } : {}),
  }));
}

/** The when row: the start day and time, the end time (and day when it differs), the length. */
function WhenFields({
  draft,
  onChange,
  s,
  now,
  compact = false,
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
  s: Settings;
  now: Date;
  /** The quick create: the end day only when the Event runs past its first day. */
  compact?: boolean;
}) {
  const step = s["calendar.snap_minutes"];
  const endDay = !compact || draft.allDay || draft.endDate !== draft.startDate;
  const mondayFirst = s["calendar.week_starts_monday"];
  const words = {
    minutes: s["strings.calendar.form.length_minutes"],
    hours: s["strings.calendar.form.length_hours"],
  };
  const dateProps = {
    mondayFirst,
    now,
    previousLabel: s["strings.calendar.previous_month"],
    nextLabel: s["strings.calendar.next_month"],
  };
  return (
    <div className="cal-times">
      <DateField
        {...dateProps}
        value={draft.startDate}
        label={s["strings.calendar.form.start_date"]}
        onChange={(v) => onChange(withStart(draft, v, draft.startTime))}
      />
      {draft.allDay ? null : (
        <TimeField
          value={draft.startTime}
          step={step}
          label={s["strings.calendar.form.start"]}
          onChange={(v) => onChange(withStart(draft, draft.startDate, v))}
        />
      )}
      <span className="cal-times-to">{s["strings.calendar.to"]}</span>
      {draft.allDay ? null : (
        <TimeField
          value={draft.endTime}
          step={step}
          label={s["strings.calendar.form.end"]}
          from={draft.endDate === draft.startDate ? draft.startTime : undefined}
          lengthWords={words}
          onChange={(v) => onChange({ ...draft, endTime: v })}
        />
      )}
      {endDay ? (
        <DateField
          {...dateProps}
          value={draft.endDate}
          label={s["strings.calendar.form.end_date"]}
          onChange={(v) => onChange({ ...draft, endDate: v })}
        />
      ) : null}
    </div>
  );
}

/** A switch-like chip: All day. */
function ToggleChip({
  on,
  label,
  onChange,
}: {
  on: boolean;
  label: string;
  onChange: (on: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={cx("cal-toggle", on && "on")}
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
    >
      <span className="cal-toggle-knob" aria-hidden="true" />
      {label}
    </button>
  );
}

function RepeatField({
  draft,
  onChange,
  s,
  instance,
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
  s: Settings;
  instance: boolean;
}) {
  const startDay = new Date(`${draft.startDate}T12:00:00`);
  const day = Number.isNaN(startDay.getTime()) ? new Date() : startDay;
  const preset: RepeatPreset = presetOf(draft.recurrence, day);
  const [customRule, setCustomRule] = useState(preset === "custom" ? (draft.recurrence ?? "") : "");
  if (instance) return <span className="cal-quiet">{s["strings.calendar.detail.repeats"]}</span>;
  return (
    <>
      <Dropdown<RepeatPreset>
        value={preset}
        label={s["strings.calendar.form.repeat"]}
        leading={<Icon icon={ArrowsClockwiseIcon} />}
        options={REPEAT_PRESETS.map((p) => ({
          value: p,
          label: s[`strings.calendar.repeat.preset.${p}` as keyof Settings] as string,
        }))}
        onChange={(p) =>
          onChange({ ...draft, recurrence: ruleFor(p, day, customRule || "FREQ=WEEKLY") })
        }
      />
      {preset === "custom" ? (
        <Input
          className="mono cal-rule"
          aria-label={s["strings.calendar.form.rule"]}
          value={customRule || (draft.recurrence ?? "")}
          placeholder="FREQ=WEEKLY;BYDAY=MO,WE"
          onChange={(e) => {
            setCustomRule(e.target.value);
            onChange({ ...draft, recurrence: ruleFor("custom", day, e.target.value) });
          }}
        />
      ) : null}
    </>
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
  directory: readonly Person[];
  s: Settings;
  now: Date;
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
  directory,
  s,
  now,
  busy,
  error,
  onSave,
  onMore,
  onCancel,
}: QuickCreateProps) {
  const problem = problemText(draft, s);
  const [guests, setGuests] = useState(draft.attendees.length > 0);
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
      <div className="cal-quick-row">
        <Icon icon={ClockIcon} className="cal-row-icon" />
        <WhenFields draft={draft} onChange={onChange} s={s} now={now} compact />
      </div>
      <div className="cal-quick-row cal-quick-chips">
        <span className="cal-row-icon" />
        <ToggleChip
          on={draft.allDay}
          label={s["strings.calendar.all_day"]}
          onChange={(v) => onChange({ ...draft, allDay: v })}
        />
        <RepeatField draft={draft} onChange={onChange} s={s} instance={false} />
      </div>
      <div className="cal-quick-row">
        <Icon icon={CalendarBlankIcon} className="cal-row-icon" />
        <Dropdown
          value={draft.calendarId ?? ""}
          label={s["strings.calendar.form.calendar"]}
          options={calendarOptions(calendars, accounts, colors)}
          onChange={(id) => onChange({ ...draft, calendarId: id })}
        />
      </div>
      <div className="cal-quick-row top">
        <Icon icon={UsersIcon} className="cal-row-icon" />
        {guests ? (
          <PeopleField
            people={draft.attendees}
            onChange={(attendees) => onChange({ ...draft, attendees })}
            directory={directory}
            limit={s["calendar.guest_suggestions_max"]}
            placeholder={s["strings.calendar.form.guests_placeholder"]}
            label={s["strings.calendar.form.attendees"]}
            removeLabel={s["strings.calendar.form.remove_guest"]}
            autoFocus
          />
        ) : (
          <button type="button" className="cal-add-line" onClick={() => setGuests(true)}>
            {s["strings.calendar.form.add_guests"]}
          </button>
        )}
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
  directory: readonly Person[];
  s: Settings;
  now: Date;
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

function Section({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cx("cal-ed-sec", className)}>
      <h4>{title}</h4>
      {children}
    </section>
  );
}

export function EventEditor({
  draft,
  onChange,
  editing,
  instance,
  calendars,
  accounts,
  colors,
  directory,
  s,
  now,
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
    if (e.key === "Enter") submit(e);
  };
  const reminderAdd: DropdownOption<string>[] = [
    ...choices
      .filter((m) => !reminders?.includes(m))
      .map((m) => ({ value: String(m), label: reminderWords(m, s) })),
    { value: "default", label: s["strings.calendar.reminder.use_default"] },
    { value: "none", label: s["strings.calendar.reminder.none"] },
  ];
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
            <span className="cal-editor-kicker">
              {editing ? s["strings.calendar.edit_event"] : s["strings.calendar.new_event_long"]}
            </span>
            <Btn icon type="button" title={s["strings.calendar.close"]} onClick={onCancel}>
              <Icon icon={XIcon} />
            </Btn>
          </div>
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
          <div className="cal-editor-body">
            <div className="cal-ed-main">
              <Section title={s["strings.calendar.editor.when"]}>
                <WhenFields draft={draft} onChange={onChange} s={s} now={now} />
                <div className="cal-ed-row">
                  <ToggleChip
                    on={draft.allDay}
                    label={s["strings.calendar.all_day"]}
                    onChange={(v) => onChange({ ...draft, allDay: v })}
                  />
                  <RepeatField draft={draft} onChange={onChange} s={s} instance={instance} />
                </div>
                {draft.allDay ? null : (
                  <div className="cal-ed-row">
                    <Icon icon={GlobeIcon} className="cal-row-icon" />
                    <ZoneField
                      value={draft.timeZone}
                      zones={zones}
                      limit={s["calendar.zone_suggestions_max"]}
                      label={s["strings.calendar.form.time_zone"]}
                      describe={(z) => zoneLabel(z, now)}
                      onChange={(z) => onChange({ ...draft, timeZone: z })}
                    />
                  </div>
                )}
              </Section>
              <Section title={s["strings.calendar.editor.guests"]}>
                <PeopleField
                  people={draft.attendees}
                  onChange={(attendees) => onChange({ ...draft, attendees })}
                  directory={directory}
                  limit={s["calendar.guest_suggestions_max"]}
                  placeholder={s["strings.calendar.form.guests_placeholder"]}
                  label={s["strings.calendar.form.attendees"]}
                  removeLabel={s["strings.calendar.form.remove_guest"]}
                />
                <p className="cal-ed-note">
                  {draft.attendees.length
                    ? s["strings.calendar.editor.guests_note"]
                    : s["strings.calendar.editor.no_guests"]}
                </p>
              </Section>
              <Section title={s["strings.calendar.editor.notes"]} className="grow">
                <textarea
                  className="input cal-notes"
                  aria-label={s["strings.calendar.form.description"]}
                  placeholder={s["strings.calendar.form.description_placeholder"]}
                  value={draft.description}
                  rows={5}
                  onChange={(e) => onChange({ ...draft, description: e.target.value })}
                />
              </Section>
            </div>
            <aside className="cal-ed-side">
              <Section title={s["strings.calendar.form.calendar"]}>
                <Dropdown
                  value={draft.calendarId ?? ""}
                  label={s["strings.calendar.form.calendar"]}
                  options={calendarOptions(calendars, accounts, colors)}
                  onChange={(id) => onChange({ ...draft, calendarId: id })}
                />
              </Section>
              <Section title={s["strings.calendar.editor.where"]}>
                <Dropdown<MeetingLinkKind | "default">
                  value={draft.meetingLink}
                  label={s["strings.calendar.form.meeting_link"]}
                  leading={<Icon icon={VideoCameraIcon} />}
                  options={kinds.map((k) => ({ value: k, label: linkLabel(k) }))}
                  onChange={(k) => onChange({ ...draft, meetingLink: k })}
                />
                {draft.meetingLink === "custom" ? (
                  <Input
                    type="url"
                    aria-label={s["strings.calendar.form.custom_link"]}
                    placeholder="https://"
                    value={draft.customLink}
                    onChange={(e) => onChange({ ...draft, customLink: e.target.value })}
                  />
                ) : null}
                <div className="cal-with-icon">
                  <Icon icon={MapPinIcon} />
                  <Input
                    aria-label={s["strings.calendar.form.location"]}
                    placeholder={s["strings.calendar.form.location"]}
                    value={draft.location}
                    onChange={(e) => onChange({ ...draft, location: e.target.value })}
                  />
                </div>
              </Section>
              <Section title={s["strings.calendar.editor.reminders"]}>
                <div className="cal-reminders">
                  {reminders === null ? (
                    <span className="cal-chip quiet">
                      <Icon icon={BellIcon} />
                      {fill(s["strings.calendar.reminder.default"], {
                        when: reminderWords(s["notifications.calendar_lead_minutes"], s),
                      })}
                    </span>
                  ) : reminders.length === 0 ? (
                    <span className="cal-chip quiet">{s["strings.calendar.reminder.none"]}</span>
                  ) : (
                    reminders.map((m) => (
                      <span key={m} className="cal-chip">
                        <Icon icon={BellIcon} />
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
                </div>
                <Dropdown
                  value=""
                  className="cal-dd-add"
                  label={s["strings.calendar.reminder.add"]}
                  leading={<Icon icon={PlusIcon} />}
                  options={[
                    { value: "", label: s["strings.calendar.reminder.add"] },
                    ...reminderAdd,
                  ]}
                  onChange={(v) => {
                    if (v === "") return;
                    if (v === "default") onChange({ ...draft, reminders: null });
                    else if (v === "none") onChange({ ...draft, reminders: [] });
                    else {
                      const next = [...new Set([...(reminders ?? []), Number(v)])].sort(
                        (a, b) => a - b,
                      );
                      onChange({ ...draft, reminders: next });
                    }
                  }}
                />
              </Section>
            </aside>
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
              {editing ? s["strings.calendar.form.save_changes"] : s["strings.calendar.form.save"]}
            </Btn>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
