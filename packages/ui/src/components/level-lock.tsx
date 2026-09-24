// The locked state a page shows while the AI level keeps its feature paused
// (CONTEXT.md "AI level": lowering it disables, never deletes). It says what
// is paused and that nothing is lost, offers one action (raise the level,
// after a short confirm that says what starts), a way to the level cards in
// Settings, and a preview of what the feature brings. The page renders what
// it kept underneath, read-only and marked paused.

import { ArrowUpIcon, CheckIcon, LockSimpleIcon } from "@phosphor-icons/react";
import { type ReactNode, useState } from "react";
import { cx } from "../format.ts";
import { Icon } from "./icon.tsx";
import { Btn } from "./primitives.tsx";

export interface LockedPanelProps {
  title: string;
  /** The one line that says what to do: "Increase the AI level to unlock Workflows." */
  lede: string;
  /** What is paused and what is kept, already worded. */
  body: string;
  benefitsTitle: string;
  benefits: readonly string[];
  /** A faded picture of the feature: an example flow, a Group card. */
  illustration?: ReactNode | undefined;
  /** "Raise to Mail that sorts and acts for me". */
  raiseLabel: string;
  confirmLabel: string;
  /** What raising starts, shown with the confirm. */
  confirmNote: string;
  cancelLabel: string;
  settingsLabel: string;
  /** The level is set in the Config file: the page says so instead of offering to change it (ADR 0001). */
  pinnedNote?: string | undefined;
  /** Why raising did not take, in plain words. */
  error?: string | null | undefined;
  busy?: boolean | undefined;
  onRaise: () => void;
  onSettings?: (() => void) | undefined;
  className?: string | undefined;
}

export function LockedPanel({
  title,
  lede,
  body,
  benefitsTitle,
  benefits,
  illustration,
  raiseLabel,
  confirmLabel,
  confirmNote,
  cancelLabel,
  settingsLabel,
  pinnedNote,
  error,
  busy,
  onRaise,
  onSettings,
  className,
}: LockedPanelProps) {
  const [confirming, setConfirming] = useState(false);
  return (
    <section className={cx("locked", className)} data-locked="true" aria-label={title}>
      <div className="locked-main">
        <span className="locked-badge" aria-hidden="true">
          <Icon icon={LockSimpleIcon} />
        </span>
        <h2>{title}</h2>
        <p className="locked-lede">{lede}</p>
        <p className="locked-body">{body}</p>
        {pinnedNote ? (
          <>
            <p className="locked-pinned">{pinnedNote}</p>
            {onSettings ? (
              <div className="locked-acts">
                <Btn onClick={onSettings}>{settingsLabel}</Btn>
              </div>
            ) : null}
          </>
        ) : confirming ? (
          <div className="locked-confirm">
            <p>{confirmNote}</p>
            <div className="locked-acts">
              <Btn
                primary
                disabled={busy}
                onClick={() => {
                  onRaise();
                }}
              >
                <Icon icon={CheckIcon} /> {confirmLabel}
              </Btn>
              <Btn onClick={() => setConfirming(false)} disabled={busy}>
                {cancelLabel}
              </Btn>
            </div>
          </div>
        ) : (
          <div className="locked-acts">
            <Btn primary onClick={() => setConfirming(true)}>
              <Icon icon={ArrowUpIcon} /> {raiseLabel}
            </Btn>
            {onSettings ? <Btn onClick={onSettings}>{settingsLabel}</Btn> : null}
          </div>
        )}
        {error ? (
          <p className="locked-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <div className="locked-side">
        {illustration ? <div className="locked-art">{illustration}</div> : null}
        <h3>{benefitsTitle}</h3>
        <ul>
          {benefits.map((b) => (
            <li key={b}>
              <Icon icon={CheckIcon} />
              <span>{b}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
