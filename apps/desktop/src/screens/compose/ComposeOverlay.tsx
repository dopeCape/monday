// The compose overlay from the mock, over a real Draft: recipients as pills
// with autocomplete, the rich text editor, attachments by button or drop,
// autosave, Send (a scheduled Job) and Later (the same Job, later).

import type { DraftContent, Person } from "@monday/shared";
import { Compose, formatWhen } from "@monday/ui";
import { type DragEvent, useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Picker } from "../inbox/Picker.tsx";
import { Attachments } from "./Attachments.tsx";
import type { Composer, SendOptions } from "./composer.ts";
import { Editor } from "./Editor.tsx";
import { Recipients } from "./Recipients.tsx";
import type { ComposeUiStrings } from "./strings.ts";
import { useDraftEditor } from "./useDraftEditor.ts";

export interface ComposeOverlayProps {
  composer: Composer;
  draftId: string;
  initial: DraftContent;
  strings: ComposeUiStrings;
  idleMs: number;
  /** The undo window Send schedules with (send.delay_seconds); zero sends at once. */
  delaySeconds: number;
  /** Hours from now the Later menu offers. */
  laterPresetsHours: readonly number[];
  now: () => Date;
  onClose: () => void;
  onSent: (sent: { sendId: string; runAt: string; draftId: string; later?: boolean }) => void;
  onError: (message: string) => void;
  /** On its way out (the screen's exit hook): the scrim runs its leave, then onLeft. */
  leaving?: boolean | undefined;
  onLeft?: (() => void) | undefined;
}

export function ComposeOverlay({
  composer,
  draftId,
  initial,
  strings,
  idleMs,
  delaySeconds,
  laterPresetsHours,
  now,
  onClose,
  onSent,
  onError,
  leaving,
  onLeft,
}: ComposeOverlayProps) {
  const editor = useDraftEditor({ composer, draftId, initial, idleMs });
  const [showCc, setShowCc] = useState(initial.cc.length > 0);
  const [showBcc, setShowBcc] = useState(initial.bcc.length > 0);
  const [formatting, setFormatting] = useState(false);
  const [later, setLater] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const { content } = editor;
  const suggestion = composer.suggestion(draftId);

  const send = useCallback(
    async (options?: SendOptions) => {
      try {
        const result = await editor.send(options ?? { delaySeconds });
        onSent({ ...result, draftId, later: options?.runAt !== undefined });
      } catch (error) {
        onError(
          error instanceof Error && error.message === "no_recipients"
            ? strings.noRecipients
            : String(error),
        );
      }
    },
    [editor, onSent, onError, draftId, delaySeconds, strings.noRecipients],
  );

  const close = useCallback(async () => {
    await editor.flush();
    onClose();
  }, [editor, onClose]);

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    if (files.length) void editor.attach(files);
  };

  const draft = {
    id: draftId,
    workspaceId: composer.workspaceId,
    ...content,
    attachmentBlobIds: content.attachments.map((a) => a.blobId),
    status: "open" as const,
    updatedAt: "",
    updatedBy: "",
  };

  const recipientRow = (field: "cc" | "bcc", label: string) => (
    <div className="c-field" key={field}>
      <label htmlFor={`compose-${field}`}>{label}</label>
      <Recipients
        inputId={`compose-${field}`}
        label={label}
        value={content[field]}
        onChange={(people: Person[]) => editor.setRecipients(field, people)}
        people={composer.participants()}
        onBlur={() => void editor.flush()}
      />
    </div>
  );

  // The scrim covers the whole window, like the mock's, not just the screen column.
  return createPortal(
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
      <Compose
        draft={draft}
        strings={strings.overlay}
        note={suggestion?.note ? { text: suggestion.note } : undefined}
        formatting={formatting}
        canSend={editor.canSend}
        leaving={leaving}
        onLeft={onLeft}
        onClose={() => void close()}
        onSend={() => void send()}
        onLater={() => setLater((l) => !l)}
        onAttach={() => fileInput.current?.click()}
        onFormat={() => setFormatting((f) => !f)}
        onSubject={editor.setSubject}
        recipients={
          <Recipients
            inputId="compose-to"
            label={strings.overlay.to}
            value={content.to}
            onChange={(people) => editor.setRecipients("to", people)}
            people={composer.participants()}
            autofocus={initial.to.length === 0}
            onBlur={() => void editor.flush()}
            trailing={
              <span className="cc">
                {!showCc ? (
                  <button type="button" onClick={() => setShowCc(true)}>
                    {strings.overlay.cc}
                  </button>
                ) : null}
                {!showBcc ? (
                  <button type="button" onClick={() => setShowBcc(true)}>
                    {strings.overlay.bcc}
                  </button>
                ) : null}
              </span>
            }
          />
        }
        extraFields={
          <>
            {showCc ? recipientRow("cc", strings.overlay.cc) : null}
            {showBcc ? recipientRow("bcc", strings.overlay.bcc) : null}
          </>
        }
        editor={
          <Editor
            className="c-editor"
            initialHtml={content.bodyHtml}
            onChange={editor.setBody}
            onBlur={() => void editor.flush()}
            autofocus={initial.to.length > 0}
            strings={strings.editor}
            toolbar={formatting}
            ghost={suggestion?.ghost}
          />
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
        status={<span className="c-status">{editor.saving ? strings.saving : strings.saved}</span>}
      />
      {later ? (
        <Picker
          label={strings.overlay.later}
          title={strings.overlay.later}
          className="later"
          items={laterPresetsHours.map((h) => ({
            key: String(h),
            label: h === 1 ? strings.laterOne : strings.laterIn.replace("{n}", String(h)),
            detail: formatWhen(new Date(now().getTime() + h * 3_600_000).toISOString(), now()),
          }))}
          onPick={(key) => {
            setLater(false);
            const runAt = new Date(now().getTime() + Number(key) * 3_600_000).toISOString();
            void send({ runAt });
          }}
          onClose={() => setLater(false)}
        />
      ) : null}
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
    </div>,
    document.body,
  );
}
