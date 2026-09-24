// The Calendar's floating pieces: a popover placed beside what it belongs
// to (an Event, the slot a drag made) and kept inside the window, and the
// small dialogs a write may need first: which instances of a recurring
// Event it reaches, and whether to email the guests (ADR 0002: anything
// that leaves the mailbox asks first). Escape and a press outside close
// the popover; a dialog traps focus until answered.

import type { RecurrenceScope, Settings } from "@monday/shared";
import { Btn, useEscape, useFocusTrap } from "@monday/ui";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface AnchorRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function rectOf(el: Element | null | undefined): AnchorRect | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/** Where a box of a size sits beside an anchor: to its right if it fits, else its left, else over it. */
export function placeBeside(
  anchor: AnchorRect,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 8,
): { left: number; top: number } {
  const margin = 8;
  let left = anchor.left + anchor.width + gap;
  if (left + size.width > viewport.width - margin) left = anchor.left - gap - size.width;
  if (left < margin) {
    left = Math.min(
      Math.max(margin, anchor.left + anchor.width / 2 - size.width / 2),
      viewport.width - margin - size.width,
    );
  }
  let top = anchor.top;
  if (top + size.height > viewport.height - margin) top = viewport.height - margin - size.height;
  top = Math.max(margin, top);
  return { left: Math.max(margin, left), top };
}

export interface PopoverProps {
  anchor: AnchorRect;
  onClose: () => void;
  label: string;
  className?: string | undefined;
  children: ReactNode;
}

/** A popover beside its anchor, in a portal so no scroll container clips it. */
export function Popover({ anchor, onClose, label, className, children }: PopoverProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useEscape(onClose);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const place = () =>
      setPos(
        placeBeside(
          anchor,
          { width: el.offsetWidth, height: el.offsetHeight },
          { width: window.innerWidth, height: window.innerHeight },
        ),
      );
    place();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(place) : null;
    observer?.observe(el);
    return () => observer?.disconnect();
  }, [anchor]);
  useLayoutEffect(() => {
    const onDown = (e: PointerEvent) => {
      const el = ref.current;
      const target = e.target as Node | null;
      if (!el || !target || el.contains(target)) return;
      // A press inside another floating layer (a dialog it opened) is not outside.
      if ((target as Element).closest?.(".cal-dialog-scrim, .cal-editor-scrim, .cal-float")) return;
      onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [onClose]);
  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      className={`cal-pop${className ? ` ${className}` : ""}`}
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
    >
      {children}
    </div>,
    document.body,
  );
}

export interface ChoiceDialogProps<V extends string> {
  title: string;
  body?: string | undefined;
  choices?: ReadonlyArray<{ value: V; label: string }> | undefined;
  initial?: V | undefined;
  confirm: string;
  cancel: string;
  onAnswer: (value: V | null) => void;
}

/** A small modal: an optional set of choices and a confirm, answered once. */
export function ChoiceDialog<V extends string>({
  title,
  body,
  choices,
  initial,
  confirm,
  cancel,
  onAnswer,
}: ChoiceDialogProps<V>) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [value, setValue] = useState<V | undefined>(initial ?? choices?.[0]?.value);
  useFocusTrap(ref);
  useEscape(() => onAnswer(null));
  return createPortal(
    <div className="cal-dialog-scrim">
      <div ref={ref} className="cal-dialog" role="alertdialog" aria-modal="true" aria-label={title}>
        <h3>{title}</h3>
        {body ? <p>{body}</p> : null}
        {choices ? (
          <div className="cal-choices" role="radiogroup" aria-label={title}>
            {choices.map((c) => (
              <label key={c.value} className={value === c.value ? "on" : ""}>
                <input
                  type="radio"
                  name="cal-choice"
                  checked={value === c.value}
                  onChange={() => setValue(c.value)}
                />
                {c.label}
              </label>
            ))}
          </div>
        ) : null}
        <div className="cal-dialog-foot">
          <Btn onClick={() => onAnswer(null)}>{cancel}</Btn>
          <Btn primary onClick={() => onAnswer((value ?? "ok") as V)}>
            {confirm}
          </Btn>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The question a write asks before it runs, and how its answer comes back. */
export type Ask =
  | { kind: "scope"; action: "edit" | "delete"; resolve: (scope: RecurrenceScope | null) => void }
  | {
      kind: "send";
      action: "invite" | "update" | "cancel";
      guests: readonly string[];
      resolve: (ok: boolean) => void;
    };

/** Renders the pending question, if any, from the strings. */
export function AskDialog({
  ask,
  s,
  onDone,
}: {
  ask: Ask | null;
  s: Settings;
  onDone: () => void;
}) {
  if (!ask) return null;
  const fill = (t: string, vars: Record<string, string | number>) =>
    t.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? ""));
  if (ask.kind === "scope") {
    return (
      <ChoiceDialog<RecurrenceScope>
        title={
          ask.action === "edit"
            ? s["strings.calendar.scope.edit_title"]
            : s["strings.calendar.scope.delete_title"]
        }
        choices={[
          { value: "this", label: s["strings.calendar.scope.this"] },
          { value: "following", label: s["strings.calendar.scope.following"] },
          { value: "all", label: s["strings.calendar.scope.all"] },
        ]}
        confirm={s["strings.calendar.scope.ok"]}
        cancel={s["strings.calendar.form.cancel"]}
        onAnswer={(v) => {
          ask.resolve(v);
          onDone();
        }}
      />
    );
  }
  const names = ask.guests.slice(0, 3).join(", ");
  const more =
    ask.guests.length > 3
      ? fill(s["strings.calendar.send.more"], { n: ask.guests.length - 3 })
      : "";
  const title =
    ask.action === "invite"
      ? s["strings.calendar.send.invite_title"]
      : ask.action === "update"
        ? s["strings.calendar.send.update_title"]
        : s["strings.calendar.send.cancel_title"];
  return (
    <ChoiceDialog<"ok">
      title={title}
      body={fill(s["strings.calendar.send.body"], {
        guests: `${names}${more}`,
        n: ask.guests.length,
      })}
      confirm={s["strings.calendar.send.confirm"]}
      cancel={s["strings.calendar.form.cancel"]}
      onAnswer={(v) => {
        ask.resolve(v === "ok");
        onDone();
      }}
    />
  );
}
