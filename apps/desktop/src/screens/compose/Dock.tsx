// The dock along the bottom edge: minimized messages as chips (the subject or
// "New message", the first recipient, a dot while a change is unsaved, and a
// close that keeps the Draft), the ones past compose.dock_max_visible folded
// into "+N", the windows kept open beside the active one, and the Undo for a
// discarded Draft. Clicking a chip restores it; the others stay docked.

import type { DraftContent } from "@monday/shared";
import { Btn, Icon } from "@monday/ui";
import { XIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { ComposeWindow } from "./ComposeOverlay.tsx";
import type { Composer } from "./composer.ts";
import { AnchoredMenu } from "./Menu.tsx";
import type { ComposeUiStrings } from "./strings.ts";
import {
  dockView,
  type ComposeWindow as Win,
  type WindowSettings,
  type Windows,
} from "./windows.ts";

export interface Discarded {
  draftId: string;
  content: DraftContent;
  /** Bumped per discard, so a second one restarts the timer. */
  seq: number;
}

export interface DockProps {
  composer: Composer;
  windows: Windows;
  settings: WindowSettings;
  strings: ComposeUiStrings;
  idleMs: number;
  delaySeconds: number;
  laterPresetsHours: readonly number[];
  now: () => Date;
  onRestore: (draftId: string) => void;
  /** Closes a chip or a window beside the active one; the Draft stays in Drafts. */
  onCloseWindow: (draftId: string) => void;
  onSent: (sent: { sendId: string; runAt: string; draftId: string; later?: boolean }) => void;
  onError: (message: string) => void;
  discarded: Discarded | null;
  onUndoDiscard: () => void;
  onDiscardExpired: () => void;
  /** How long the Undo stays (the undo toast Setting). */
  toastMs: number;
  undoLabel: string;
}

/** The chip's two lines: what the message is, and who it goes to. */
export function chipText(
  w: Win,
  strings: ComposeUiStrings,
): { subject: string; to: string; label: string } {
  const c = w.initial;
  const subject =
    c.subject.trim() ||
    (c.kind === "new"
      ? strings.overlay.newMessage
      : c.kind === "forward"
        ? strings.overlay.forward
        : strings.overlay.reply);
  const people = [...c.to, ...c.cc];
  const first = people[0];
  const to = first
    ? `${first.name || first.email}${people.length > 1 ? ` +${people.length - 1}` : ""}`
    : strings.dock.noRecipient;
  return { subject, to, label: strings.dock.restore.replace("{subject}", subject) };
}

export function Dock({
  composer,
  windows,
  settings,
  strings,
  idleMs,
  delaySeconds,
  laterPresetsHours,
  now,
  onRestore,
  onCloseWindow,
  onSent,
  onError,
  discarded,
  onUndoDiscard,
  onDiscardExpired,
  toastMs,
  undoLabel,
}: DockProps) {
  const { visible, folded } = dockView(windows.docked, settings.dockMaxVisible);
  const [moreOpen, setMoreOpen] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const expire = useRef(onDiscardExpired);
  expire.current = onDiscardExpired;

  useEffect(() => {
    if (!discarded) return;
    const timer = setTimeout(() => expire.current(), toastMs);
    return () => clearTimeout(timer);
  }, [discarded, toastMs]);

  useEffect(() => {
    if (folded.length === 0) setMoreOpen(false);
  }, [folded.length]);

  const nothing = windows.docked.length === 0 && windows.stacked.length === 0;
  return (
    <>
      {nothing ? null : (
        <section className={`dock ${settings.dockPosition}`} aria-label={strings.dock.label}>
          {windows.stacked.length > 0 ? (
            <div className="stacked">
              {windows.stacked.map((w) => (
                <ComposeWindow
                  key={w.draftId}
                  bare
                  composer={composer}
                  draftId={w.draftId}
                  initial={w.initial}
                  strings={strings}
                  idleMs={idleMs}
                  delaySeconds={delaySeconds}
                  laterPresetsHours={laterPresetsHours}
                  now={now}
                  onClose={() => onCloseWindow(w.draftId)}
                  onSent={onSent}
                  onError={onError}
                />
              ))}
            </div>
          ) : null}
          {visible.map((w) => {
            const text = chipText(w, strings);
            return (
              <div key={w.draftId} className="dock-chip" data-draft={w.draftId}>
                <button
                  type="button"
                  className="dock-open"
                  title={text.label}
                  aria-label={text.label}
                  onClick={() => onRestore(w.draftId)}
                >
                  <span className="s">{text.subject}</span>
                  <span className="to">{text.to}</span>
                </button>
                {w.dirty ? (
                  <span className="dot" role="img" aria-label={strings.dock.unsaved} />
                ) : null}
                <Btn
                  icon
                  sm
                  title={strings.dock.close}
                  aria-label={strings.dock.close}
                  onClick={() => onCloseWindow(w.draftId)}
                >
                  <Icon icon={XIcon} />
                </Btn>
              </div>
            );
          })}
          {folded.length > 0 ? (
            <button
              ref={more}
              type="button"
              className="dock-chip more"
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((v) => !v)}
            >
              {strings.dock.more.replace("{n}", String(folded.length))}
            </button>
          ) : null}
          {moreOpen && folded.length > 0 ? (
            <AnchoredMenu
              anchor={more.current}
              label={strings.dock.label}
              items={folded.map((w) => {
                const text = chipText(w, strings);
                return { key: w.draftId, label: text.subject, detail: text.to };
              })}
              align="end"
              onPick={(draftId) => {
                setMoreOpen(false);
                onRestore(draftId);
              }}
              onClose={() => setMoreOpen(false)}
            />
          ) : null}
        </section>
      )}
      {discarded ? (
        <div key={discarded.seq} className="toast dock-undo" role="status" data-discard-undo>
          <span className="count">{strings.discarded}</span>
          <Btn sm onClick={onUndoDiscard}>
            {undoLabel}
          </Btn>
        </div>
      ) : null}
    </>
  );
}
