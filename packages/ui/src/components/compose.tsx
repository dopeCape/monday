// The compose overlay: a Draft with To, Subject, body, an optional ghost
// completion, an optional note from the Agent, and the send bar. Rendered
// from the Draft alone it is the mock; the app fills the slots (recipients
// editor, rich text editor, toolbar, attachments, a Later menu) and keeps the
// same classes (ADR 0010).
import type { Draft } from "@monday/shared";
import { ClockIcon, PaperclipIcon, TextAaIcon, XIcon } from "@phosphor-icons/react";
import type { ChangeEvent, ReactNode } from "react";
import { cx, paragraphs } from "../format.ts";
import { Scrim } from "./command-palette.tsx";
import { Icon } from "./icon.tsx";
import { Btn, ColHead, Kbd, Mark } from "./primitives.tsx";

export interface ComposeNote {
  text: string;
  onYes?: (() => void) | undefined;
  onNo?: (() => void) | undefined;
}

export interface ComposeStrings {
  newMessage: string;
  reply: string;
  forward: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  send: string;
  later: string;
  attach: string;
  formatting: string;
  rewrite: string;
  close: string;
  yes: string;
  no: string;
}

const DEFAULT_STRINGS: ComposeStrings = {
  newMessage: "New message",
  reply: "Reply",
  forward: "Forward",
  to: "To",
  cc: "Cc",
  bcc: "Bcc",
  subject: "Subject",
  send: "Send",
  later: "Later",
  attach: "Attach",
  formatting: "Formatting",
  rewrite: "Rewrite",
  close: "Close",
  yes: "Yes",
  no: "No",
};

export interface ComposeProps {
  draft: Draft;
  /** A proposed continuation shown faint after the body; Tab accepts it. */
  ghost?: string | undefined;
  /** Something the Agent noticed about the Draft, with a yes or no. */
  note?: ComposeNote | undefined;
  onSubject?: ((subject: string) => void) | undefined;
  onSend?: (() => void) | undefined;
  onLater?: (() => void) | undefined;
  onAttach?: (() => void) | undefined;
  onFormat?: (() => void) | undefined;
  onRewrite?: (() => void) | undefined;
  onClose?: (() => void) | undefined;
  /** Replaces the To pills and input: the recipients editor. */
  recipients?: ReactNode | undefined;
  /** Extra address rows (Cc, Bcc) rendered after To. */
  extraFields?: ReactNode | undefined;
  /** Replaces the rendered paragraphs: the rich text editor. */
  editor?: ReactNode | undefined;
  /** Rendered above the footer: the formatting toolbar, attachments, the undo bar. */
  extra?: ReactNode | undefined;
  /** Rendered after the send button: the Later menu, the saved line. */
  status?: ReactNode | undefined;
  /** The Formatting button shows as pressed. */
  formatting?: boolean | undefined;
  /** Without a recipient the Send button is disabled. */
  canSend?: boolean | undefined;
  strings?: Partial<ComposeStrings> | undefined;
  className?: string | undefined;
  /** On its way out: the scrim runs its leave and reports the end. */
  leaving?: boolean | undefined;
  onLeft?: (() => void) | undefined;
}

export function Compose({
  draft,
  ghost,
  note,
  onSubject,
  onSend,
  onLater,
  onAttach,
  onFormat,
  onRewrite,
  onClose,
  recipients,
  extraFields,
  editor,
  extra,
  status,
  formatting,
  canSend = true,
  strings: stringOverrides,
  className,
  leaving,
  onLeft,
}: ComposeProps) {
  const strings = { ...DEFAULT_STRINGS, ...(stringOverrides ?? {}) };
  const title =
    draft.kind === "forward"
      ? strings.forward
      : draft.kind === "reply"
        ? strings.reply
        : strings.newMessage;
  const body = paragraphs(draft.bodyText);
  return (
    <Scrim onClose={onClose} leaving={leaving} onLeft={onLeft}>
      <div className={cx("compose", className)} role="dialog" aria-label={title}>
        <ColHead title={title}>
          <Btn icon title={strings.close} onClick={onClose}>
            <Icon icon={XIcon} />
          </Btn>
        </ColHead>
        <div className="c-field">
          <label htmlFor="compose-to">{strings.to}</label>
          {recipients ?? (
            <>
              {draft.to.map((p) => (
                <span key={p.email} className="pill" title={p.email}>
                  {p.name}
                </span>
              ))}
              <input id="compose-to" aria-label={strings.to} />
              <span className="cc">
                {draft.cc.length ? (
                  <span>
                    {strings.cc} {draft.cc.map((p) => p.name).join(", ")}
                  </span>
                ) : (
                  <span>{strings.cc}</span>
                )}
                <span>{strings.bcc}</span>
              </span>
            </>
          )}
        </div>
        {extraFields}
        <div className="c-field">
          <label htmlFor="compose-subject">{strings.subject}</label>
          <input
            id="compose-subject"
            {...(onSubject
              ? {
                  value: draft.subject,
                  onChange: (e: ChangeEvent<HTMLInputElement>) => onSubject(e.target.value),
                }
              : { defaultValue: draft.subject })}
          />
        </div>
        {editor ?? (
          <div className="c-body">
            {body.map((p) => (
              <p key={p}>{p}</p>
            ))}
            {ghost ? (
              <p>
                <span className="ghost">
                  {ghost} <Kbd>tab</Kbd>
                </span>
              </p>
            ) : null}
          </div>
        )}
        {note ? (
          <div className="c-ai">
            <Mark small />
            <div>
              {note.text}
              <Btn sm primary onClick={note.onYes}>
                {strings.yes}
              </Btn>
              <Btn sm onClick={note.onNo}>
                {strings.no}
              </Btn>
            </div>
          </div>
        ) : null}
        {extra}
        <div className="c-foot">
          <Btn primary onClick={onSend} disabled={!canSend}>
            {strings.send}
          </Btn>
          <Btn onClick={onLater}>
            <Icon icon={ClockIcon} /> {strings.later}
          </Btn>
          {status}
          <span className="sp" />
          <Btn icon title={strings.attach} onClick={onAttach}>
            <Icon icon={PaperclipIcon} />
          </Btn>
          <Btn icon title={strings.formatting} on={formatting} onClick={onFormat}>
            <Icon icon={TextAaIcon} />
          </Btn>
          <Btn onClick={onRewrite}>
            <Mark small /> {strings.rewrite}
          </Btn>
        </div>
      </div>
    </Scrim>
  );
}
