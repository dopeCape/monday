// The inline reply below a Thread, over a real Draft: the mock's reply box
// with the editor in place of the textarea, the recipients above it, the
// reply-all toggle (remembered per Thread), the forward attachments checkbox,
// the writing toolbar and assist, autosave and Send (ADR 0010). A reply
// Draft saved earlier (by the user or the Agent) opens here pre-filled, with
// who wrote it; Minimize docks it with the other open messages.

import type { DraftAttachment, DraftContent, Person } from "@monday/shared";
import { Btn, Icon, ReplyBox } from "@monday/ui";
import { MinusIcon, NotePencilIcon, TrashIcon } from "@phosphor-icons/react";
import type { Editor as TiptapEditor } from "@tiptap/core";
import { type DragEvent, useCallback, useEffect, useRef, useState } from "react";
import { useTemplateCompose } from "../../templates/compose.tsx";
import { useTemplateLink } from "../../templates/link.ts";
import { UnfilledPlaceholderError } from "../../templates/placeholders.ts";
import { AssistMenu, SuggestionPanel, useAssist } from "./Assist.tsx";
import { Attachments } from "./Attachments.tsx";
import { useAgentEdits } from "./agent-edits.ts";
import type { Composer } from "./composer.ts";
import { Editor } from "./Editor.tsx";
import { linkOf } from "./link.ts";
import { Recipients } from "./Recipients.tsx";
import type { ComposeUiStrings } from "./strings.ts";
import { Toolbar } from "./Toolbar.tsx";
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
  /** Discard without a compose controller: the Draft is gone, the parent closes the reply. */
  onDiscarded?: (() => void) | undefined;
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
  onDiscarded,
}: ReplyComposeProps) {
  const link = linkOf(composer);
  const editor = useDraftEditor({ composer, draftId, initial, idleMs });
  const [dragging, setDragging] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [tiptap, setTiptap] = useState<TiptapEditor | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const { content } = editor;
  const [author] = useState(() => link?.authorOf(draftId) ?? null);

  // The controller reads the latest content when it docks or closes this reply.
  const state = useRef({ content, saving: editor.saving, stop: editor.stop });
  state.current = { content, saving: editor.saving, stop: editor.stop };
  useEffect(
    () =>
      link?.register(draftId, {
        read: () => ({ content: state.current.content, dirty: state.current.saving }),
        stop: () => state.current.stop(),
      }),
    [link, draftId],
  );

  // The Agent's update_draft on this Draft shows here at once.
  const tiptapRef = useRef<TiptapEditor | null>(null);
  tiptapRef.current = tiptap;
  useAgentEdits(composer, draftId, (next) => {
    editor.replace(next);
    tiptapRef.current?.commands.setContent(next.bodyHtml, { emitUpdate: false });
  });

  const assist = useAssist({
    composer,
    draftId,
    editor: tiptap,
    enabled: link?.assist ?? false,
    subject: content.subject,
    to: content.to.map((p) => p.email),
    strings: strings.assist,
  });
  const attach = (files: File[]) => {
    if (files.length) void editor.attach(files);
  };
  const forward = content.kind === "forward";
  const includeOriginals =
    originalAttachments.length > 0 &&
    originalAttachments.every((a) => content.attachments.some((c) => c.blobId === a.blobId));

  const templateLink = useTemplateLink(composer);
  const templates = useTemplateCompose({
    composer,
    link: templateLink,
    editor: tiptap,
    threadId: content.threadId,
    to: content.to,
    subject: content.subject,
    setSubject: editor.setSubject,
    bodyHtml: content.bodyHtml,
  });
  const blocked = templates.blocked;

  const send = useCallback(async () => {
    if (blocked) {
      onError(blocked);
      return;
    }
    try {
      const result = await editor.send({ delaySeconds });
      onSent({ ...result, draftId });
    } catch (error) {
      onError(
        error instanceof Error && error.message === "no_recipients"
          ? strings.noRecipients
          : error instanceof UnfilledPlaceholderError
            ? (blocked ?? error.message)
            : String(error),
      );
    }
  }, [editor, onSent, onError, draftId, delaySeconds, strings.noRecipients, blocked]);

  const toggleOriginals = (on: boolean) => {
    const without = content.attachments.filter(
      (c) => !originalAttachments.some((a) => a.blobId === c.blobId),
    );
    editor.setAttachments(on ? [...without, ...originalAttachments] : without);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    attach(Array.from(e.dataTransfer.files ?? []));
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
        sendBlocked={blocked}
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
            {templateLink?.enabled && content.bodyText.trim() ? (
              <Btn
                sm
                className="tpl-save-as"
                onClick={() =>
                  templateLink.draftFrom({
                    texts: [{ subject: content.subject, text: content.bodyText }],
                  })
                }
              >
                {templateLink.strings.saveAs}
              </Btn>
            ) : null}
            {link ? (
              <Btn
                icon
                sm
                title={strings.overlay.minimize}
                onClick={() =>
                  link.minimize(draftId, {
                    content: state.current.content,
                    dirty: editor.saving,
                  })
                }
              >
                <Icon icon={MinusIcon} />
              </Btn>
            ) : null}
            <Btn
              sm
              className="reply-discard"
              title={strings.overlay.discard}
              onClick={() => {
                editor.stop();
                // The controller offers Undo; a reply rendered on its own just throws the Draft away.
                if (link) link.discard(draftId, state.current.content);
                else void editor.discard().then(onDiscarded);
              }}
            >
              <Icon icon={TrashIcon} /> {strings.overlay.discard}
            </Btn>
          </>
        }
        editor={
          <>
            <div className="c-byline" data-author={author ?? "user"}>
              <span className="draft-badge">
                <Icon icon={NotePencilIcon} /> {strings.draftBadge}
              </span>
              <span>{author === "agent" ? strings.draftedByAgent : strings.draftedByYou}</span>
            </div>
            <div className="reply-meta">
              <span>{strings.overlay.to}</span>
              <Recipients
                label={strings.overlay.to}
                value={content.to}
                onChange={(people: Person[]) => editor.setRecipients("to", people)}
                source={composer.people}
                onBlur={() => void editor.flush()}
              />
              {content.cc.length > 0 || replyAll ? (
                <>
                  <span>{strings.overlay.cc}</span>
                  <Recipients
                    label={strings.overlay.cc}
                    value={content.cc}
                    onChange={(people: Person[]) => editor.setRecipients("cc", people)}
                    source={composer.people}
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
            {templates.suggestionLine}
            <Editor
              initialHtml={initial.bodyHtml}
              placeholder={strings.replyTo.replace(
                "{name}",
                recipient.split(/\s+/)[0] ?? recipient,
              )}
              onChange={editor.setBody}
              onBlur={() => void editor.flush()}
              autofocus
              strings={strings.editor}
              onReady={setTiptap}
              onLink={() => setLinkOpen(true)}
              onFiles={attach}
            />
            <Toolbar
              editor={tiptap}
              strings={{ ...strings.editor, formatting: strings.overlay.formatting }}
              hidden={link ? !link.toolbar : false}
              linkOpen={linkOpen}
              onLinkOpen={setLinkOpen}
              templates={templates.button}
              assist={
                <AssistMenu
                  assist={assist}
                  strings={strings.assist}
                  editor={tiptap}
                  translateTo={link?.translateTo ?? "English"}
                />
              }
            />
            <SuggestionPanel
              suggestion={assist.suggestion}
              strings={strings.assist}
              onAccept={assist.accept}
              onReject={assist.reject}
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
      {templates.overlay}
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        aria-label={strings.overlay.attach}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          attach(files);
        }}
      />
    </div>
  );
}
