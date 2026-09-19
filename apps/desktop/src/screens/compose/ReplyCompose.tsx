// The inline reply below a Thread, over a real Draft: the mock's reply box
// with the editor in place of the textarea, the recipients above it, the
// reply-all toggle (remembered per Thread), the forward attachments checkbox,
// autosave and Send (ADR 0010).

import type { DraftAttachment, DraftContent, Person } from "@monday/shared";
import { ReplyBox } from "@monday/ui";
import { type DragEvent, useCallback, useRef, useState } from "react";
import { Attachments } from "./Attachments.tsx";
import type { Composer } from "./composer.ts";
import { Editor } from "./Editor.tsx";
import { Recipients } from "./Recipients.tsx";
import type { ComposeUiStrings } from "./strings.ts";
import { useDraftEditor } from "./useDraftEditor.ts";

export interface ReplyComposeProps {
  composer: Composer;
  draftId: string;
  initial: DraftContent;
  /** The first name in the placeholder. */
  recipient: string;
  strings: ComposeUiStrings;
  idleMs: number;
  /** The undo window Send schedules with (send.delay_seconds); zero sends at once. */
  delaySeconds: number;
  replyAll: boolean;
  /** The toggle; the parent answers with the recipients for the new mode, or null to keep them. */
  onReplyAll: (replyAll: boolean) => { to: Person[]; cc: Person[] } | null;
  onForward: () => void;
  /** Forward: the original attachments, so the checkbox can drop or keep them. */
  originalAttachments: readonly DraftAttachment[];
  onDraft?: (() => void) | undefined;
  onSent: (sent: { sendId: string; runAt: string; draftId: string }) => void;
  onError: (message: string) => void;
}

export function ReplyCompose({
  composer,
  draftId,
  initial,
  recipient,
  strings,
  idleMs,
  delaySeconds,
  replyAll,
  onReplyAll,
  onForward,
  originalAttachments,
  onDraft,
  onSent,
  onError,
}: ReplyComposeProps) {
  const editor = useDraftEditor({ composer, draftId, initial, idleMs });
  const [formatting, setFormatting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const { content } = editor;
  const forward = content.kind === "forward";
  const includeOriginals =
    originalAttachments.length > 0 &&
    originalAttachments.every((a) => content.attachments.some((c) => c.blobId === a.blobId));

  const send = useCallback(async () => {
    try {
      const result = await editor.send({ delaySeconds });
      onSent({ ...result, draftId });
    } catch (error) {
      onError(
        error instanceof Error && error.message === "no_recipients"
          ? strings.noRecipients
          : String(error),
      );
    }
  }, [editor, onSent, onError, draftId, delaySeconds, strings.noRecipients]);

  const toggleOriginals = (on: boolean) => {
    const without = content.attachments.filter(
      (c) => !originalAttachments.some((a) => a.blobId === c.blobId),
    );
    editor.setAttachments(on ? [...without, ...originalAttachments] : without);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length) void editor.attach(files);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop target for files; the Attach button is the keyboard path
    <div
      className={dragging ? "drop-target" : undefined}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <ReplyBox
        recipient={recipient}
        replyAll={replyAll}
        strings={{
          placeholder: strings.replyTo,
          send: strings.overlay.send,
          draft: strings.draftReply,
          attach: strings.overlay.attach,
          replyAll: replyAll ? strings.replyOne : strings.replyAll,
          forward: strings.overlay.forward,
        }}
        onSend={() => void send()}
        onDraft={onDraft}
        onAttach={() => fileInput.current?.click()}
        onReplyAll={() => {
          const next = onReplyAll(!replyAll);
          if (next) {
            editor.setRecipients("to", next.to);
            editor.setRecipients("cc", next.cc);
          }
        }}
        onForward={onForward}
        status={
          <>
            <span className="c-status">{editor.saving ? strings.saving : strings.saved}</span>
            <button
              type="button"
              className={`btn sm${formatting ? " on" : ""}`}
              onClick={() => setFormatting((f) => !f)}
            >
              {strings.overlay.formatting}
            </button>
          </>
        }
        editor={
          <>
            <div className="reply-meta">
              <span>{strings.overlay.to}</span>
              <Recipients
                label={strings.overlay.to}
                value={content.to}
                onChange={(people: Person[]) => editor.setRecipients("to", people)}
                people={composer.participants()}
                onBlur={() => void editor.flush()}
              />
              {content.cc.length > 0 || replyAll ? (
                <>
                  <span>{strings.overlay.cc}</span>
                  <Recipients
                    label={strings.overlay.cc}
                    value={content.cc}
                    onChange={(people: Person[]) => editor.setRecipients("cc", people)}
                    people={composer.participants()}
                    onBlur={() => void editor.flush()}
                  />
                </>
              ) : null}
              {forward && originalAttachments.length > 0 ? (
                <label>
                  <input
                    type="checkbox"
                    checked={includeOriginals}
                    onChange={(e) => toggleOriginals(e.target.checked)}
                  />
                  {strings.forwardAttachments.replace("{n}", String(originalAttachments.length))}
                </label>
              ) : null}
            </div>
            <Editor
              initialHtml={content.bodyHtml}
              placeholder={strings.replyTo.replace(
                "{name}",
                recipient.split(/\s+/)[0] ?? recipient,
              )}
              onChange={editor.setBody}
              onBlur={() => void editor.flush()}
              autofocus
              strings={strings.editor}
              toolbar={formatting}
            />
          </>
        }
        extra={
          <Attachments
            attachments={content.attachments}
            uploads={editor.uploads}
            onRemove={editor.removeAttachment}
            onDismissUpload={editor.dismissUpload}
            strings={{ uploading: strings.uploading, remove: strings.removeAttachment }}
          />
        }
      />
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        aria-label={strings.overlay.attach}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) void editor.attach(files);
        }}
      />
    </div>
  );
}
