// The compose window: a Draft with To, Subject, the writing toolbar with the
// assist menu, the body, an optional ghost completion and note from the Agent,
// and the send bar (Send, Later, the saved line, Attach, Discard). Rendered
// from the Draft alone it is the mock; the app fills the slots (recipients
// editor, rich text editor, toolbar, attachments, the suggestion) and keeps
// the same classes (ADR 0010). A window floats as a sheet over a scrim, sits
// docked at the bottom edge, fills the screen, or renders bare when the dock
// shows it open beside another.
import type { Draft } from "@monday/shared";
import {
  CaretDownIcon,
  ClockIcon,
  LinkSimpleIcon,
  ListBulletsIcon,
  ListNumbersIcon,
  MinusIcon,
  PaperclipIcon,
  QuotesIcon,
  TextBIcon,
  TextItalicIcon,
  TextTSlashIcon,
  TrashIcon,
  XIcon,
} from "@phosphor-icons/react";
import type { ChangeEvent, KeyboardEvent, ReactNode, Ref } from "react";
import { cx, paragraphs, personName } from "../format.ts";
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
  minimize: string;
  discard: string;
  assist: string;
  bold: string;
  italic: string;
  link: string;
  bullets: string;
  numbered: string;
  quote: string;
  clearFormat: string;
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
  minimize: "Minimize",
  discard: "Discard",
  assist: "Assist",
  bold: "Bold",
  italic: "Italic",
  link: "Link",
  bullets: "Bullets",
  numbered: "Numbered",
  quote: "Quote",
  clearFormat: "Clear formatting",
  yes: "Yes",
  no: "No",
};

/** How a window sits on screen (the compose.window_style Setting), or bare inside the dock. */
export type ComposeWindowStyle = "sheet" | "docked" | "fullscreen";

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
  onClose?: (() => void) | undefined;
  /** Collapses the window into a chip in the dock. Absent hides the button. */
  onMinimize?: (() => void) | undefined;
  /** Throws the Draft away (with Undo). Absent hides the button. */
  onDiscard?: (() => void) | undefined;
  /** Replaces the To pills and input: the recipients editor. */
  recipients?: ReactNode | undefined;
  /** Extra address rows (Cc, Bcc) rendered after To. */
  extraFields?: ReactNode | undefined;
  /** Replaces the mock's toolbar row: the live formatting buttons and the assist menu. */
  tools?: ReactNode | undefined;
  /** Replaces the rendered paragraphs: the rich text editor. */
  editor?: ReactNode | undefined;
  /** An assist result waiting for Accept or Reject, above the note. */
  suggestion?: ReactNode | undefined;
  /** Rendered above the footer: attachments, uploads. */
  extra?: ReactNode | undefined;
  /** Rendered after Later: the saved line. */
  status?: ReactNode | undefined;
  /** The Later button, so its menu can anchor to it. */
  laterRef?: Ref<HTMLButtonElement> | undefined;
  /** The Later menu is open: the button shows pressed. */
  laterOpen?: boolean | undefined;
  /** Without a recipient the Send button is disabled. */
  canSend?: boolean | undefined;
  strings?: Partial<ComposeStrings> | undefined;
  className?: string | undefined;
  /** Sheet (default), docked or full screen. */
  windowStyle?: ComposeWindowStyle | undefined;
  /** No scrim: the window sits in the dock beside the active one. */
  bare?: boolean | undefined;
  /** Keys pressed anywhere in the window (Escape minimizes). */
  onKeyDown?: ((e: KeyboardEvent<HTMLDivElement>) => void) | undefined;
  /** On its way out: the scrim runs its leave and reports the end. */
  leaving?: boolean | undefined;
  onLeft?: (() => void) | undefined;
}

/** The toolbar the mock shows: formatting on the left, the assist menu on the right. */
function MockTools({ strings }: { strings: ComposeStrings }) {
  const tool = (title: string, icon: typeof TextBIcon) => (
    <Btn icon sm title={title}>
      <Icon icon={icon} />
    </Btn>
  );
  return (
    <div className="c-tools" role="toolbar" aria-label={strings.formatting}>
      {tool(strings.bold, TextBIcon)}
      {tool(strings.italic, TextItalicIcon)}
      {tool(strings.link, LinkSimpleIcon)}
      <span className="vr" />
      {tool(strings.bullets, ListBulletsIcon)}
      {tool(strings.numbered, ListNumbersIcon)}
      {tool(strings.quote, QuotesIcon)}
      <span className="vr" />
      {tool(strings.clearFormat, TextTSlashIcon)}
      <span className="sp" />
      <Btn sm className="c-assist">
        <Mark small /> {strings.assist} <Icon icon={CaretDownIcon} />
      </Btn>
    </div>
  );
}

export function Compose({
  draft,
  ghost,
  note,
  onSubject,
  onSend,
  onLater,
  onAttach,
  onClose,
  onMinimize,
  onDiscard,
  recipients,
  extraFields,
  tools,
  editor,
  suggestion,
  extra,
  status,
  laterRef,
  laterOpen,
  canSend = true,
  strings: stringOverrides,
  className,
  windowStyle = "sheet",
  bare,
  onKeyDown,
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
  // Docked and bare windows have no scrim: the window runs its own leave.
  const unframed = bare === true || windowStyle === "docked";
  const window = (
    <div
      className={cx(
        "compose",
        windowStyle !== "sheet" && `is-${windowStyle}`,
        bare && "is-bare",
        unframed && leaving && "leaving",
        className,
      )}
      role="dialog"
      aria-label={title}
      onKeyDown={onKeyDown}
      onAnimationEnd={(e) => {
        if (unframed && leaving && e.target === e.currentTarget) onLeft?.();
      }}
    >
      <ColHead title={title}>
        {onMinimize || !editor ? (
          <Btn icon title={strings.minimize} onClick={onMinimize}>
            <Icon icon={MinusIcon} />
          </Btn>
        ) : null}
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
                  {strings.cc} {draft.cc.map((p) => personName(p)).join(", ")}
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
      {tools === undefined ? <MockTools strings={strings} /> : tools}
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
      {suggestion}
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
        <Btn ref={laterRef} onClick={onLater} on={laterOpen} aria-haspopup="menu">
          <Icon icon={ClockIcon} /> {strings.later} <Icon icon={CaretDownIcon} />
        </Btn>
        {status ?? (editor ? null : <span className="c-status">Saved</span>)}
        <span className="sp" />
        <Btn icon title={strings.attach} onClick={onAttach}>
          <Icon icon={PaperclipIcon} />
        </Btn>
        {onDiscard || !editor ? (
          <Btn icon title={strings.discard} onClick={onDiscard}>
            <Icon icon={TrashIcon} />
          </Btn>
        ) : null}
      </div>
    </div>
  );
  if (unframed) return window;
  return (
    <Scrim
      onClose={onClose}
      leaving={leaving}
      onLeft={onLeft}
      className={windowStyle === "fullscreen" ? "is-fullscreen" : undefined}
    >
      {window}
    </Scrim>
  );
}
