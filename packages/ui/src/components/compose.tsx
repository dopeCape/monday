// The compose overlay: a Draft with To, Subject, body, an optional ghost
// completion, an optional note from the Agent, and the send bar. The body is
// rendered, not edited; the editor is a later slice (ADR 0010).
import type { Draft } from "@monday/shared";
import { ClockIcon, PaperclipIcon, TextAaIcon, XIcon } from "@phosphor-icons/react";
import type { ChangeEvent } from "react";
import { cx, paragraphs } from "../format.ts";
import { Scrim } from "./command-palette.tsx";
import { Icon } from "./icon.tsx";
import { Btn, ColHead, Kbd, Mark } from "./primitives.tsx";

export interface ComposeNote {
  text: string;
  onYes?: (() => void) | undefined;
  onNo?: (() => void) | undefined;
}

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
  className?: string | undefined;
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
  className,
}: ComposeProps) {
  const title = draft.threadId ? "Reply" : "New message";
  const body = paragraphs(draft.bodyText);
  return (
    <Scrim onClose={onClose}>
      <div className={cx("compose", className)} role="dialog" aria-label={title}>
        <ColHead title={title}>
          <Btn icon title="Close" onClick={onClose}>
            <Icon icon={XIcon} />
          </Btn>
        </ColHead>
        <div className="c-field">
          <label htmlFor="compose-to">To</label>
          {draft.to.map((p) => (
            <span key={p.email} className="pill" title={p.email}>
              {p.name}
            </span>
          ))}
          <input id="compose-to" aria-label="To" />
          <span className="cc">
            {draft.cc.length ? (
              <span>Cc {draft.cc.map((p) => p.name).join(", ")}</span>
            ) : (
              <span>Cc</span>
            )}
            <span>Bcc</span>
          </span>
        </div>
        <div className="c-field">
          <label htmlFor="compose-subject">Subject</label>
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
        {note ? (
          <div className="c-ai">
            <Mark small />
            <div>
              {note.text}
              <Btn sm primary onClick={note.onYes}>
                Yes
              </Btn>
              <Btn sm onClick={note.onNo}>
                No
              </Btn>
            </div>
          </div>
        ) : null}
        <div className="c-foot">
          <Btn primary onClick={onSend}>
            Send
          </Btn>
          <Btn onClick={onLater}>
            <Icon icon={ClockIcon} /> Later
          </Btn>
          <span className="sp" />
          <Btn icon title="Attach" onClick={onAttach}>
            <Icon icon={PaperclipIcon} />
          </Btn>
          <Btn icon title="Formatting" onClick={onFormat}>
            <Icon icon={TextAaIcon} />
          </Btn>
          <Btn onClick={onRewrite}>
            <Mark small /> Rewrite
          </Btn>
        </div>
      </div>
    </Scrim>
  );
}
