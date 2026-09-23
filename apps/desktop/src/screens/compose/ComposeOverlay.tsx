// A compose window over a real Draft: recipients as pills with autocomplete
// and the Cc and Bcc toggles, the writing toolbar with its shortcuts and the
// assist menu, the rich text editor, attachments by picker, drop or paste,
// autosave, Send (a scheduled Job), Later (the same Job, later, from a menu
// anchored to its button), Minimize into the dock and Discard with Undo.
// The screen renders the active window through ComposeOverlay; the dock
// renders windows kept open beside it through ComposeWindow, bare.

import type { DraftContent, Person } from "@monday/shared";
import { Compose, formatWhen } from "@monday/ui";
import type { Editor as TiptapEditor } from "@tiptap/core";
import {
  type DragEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { AssistMenu, SuggestionPanel, useAssist } from "./Assist.tsx";
import { Attachments } from "./Attachments.tsx";
import type { Composer, SendOptions } from "./composer.ts";
import { Editor } from "./Editor.tsx";
import { linkOf } from "./link.ts";
import { AnchoredMenu } from "./Menu.tsx";
import { Recipients } from "./Recipients.tsx";
import type { ComposeUiStrings } from "./strings.ts";
import { Toolbar } from "./Toolbar.tsx";
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
  /** Esc, the close button, a click on the scrim: the controller minimizes or closes by Setting. */
  onClose: () => void;
  onSent: (sent: { sendId: string; runAt: string; draftId: string; later?: boolean }) => void;
  onError: (message: string) => void;
  /** On its way out (the screen's exit hook): the scrim runs its leave, then onLeft. */
  leaving?: boolean | undefined;
  onLeft?: (() => void) | undefined;
}

export interface ComposeWindowProps extends ComposeOverlayProps {
  /** Open beside the active window, in the dock: no scrim, no autofocus. */
  bare?: boolean | undefined;
}

export function ComposeWindow({
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
  bare,
}: ComposeWindowProps) {
  const link = linkOf(composer);
  const editor = useDraftEditor({ composer, draftId, initial, idleMs });
  const [showCc, setShowCc] = useState(initial.cc.length > 0);
  const [showBcc, setShowBcc] = useState(initial.bcc.length > 0);
  const [later, setLater] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [tiptap, setTiptap] = useState<TiptapEditor | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const laterButton = useRef<HTMLButtonElement>(null);
  const { content } = editor;
  const suggestion = composer.suggestion(draftId);
  const [author] = useState(() => link?.authorOf(draftId) ?? null);
  const [fromDock] = useState(() => link?.fromDock(draftId) ?? false);

  // The controller reads the latest content when it minimizes, stacks or closes this window.
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

  const assist = useAssist({
    composer,
    draftId,
    editor: tiptap,
    enabled: link?.assist ?? false,
    subject: content.subject,
    to: content.to.map((p) => p.email),
    strings: strings.assist,
  });

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

  const minimize = link
    ? () => link.minimize(draftId, { content: state.current.content, dirty: editor.saving })
    : undefined;
  const discard = link
    ? () => {
        editor.stop();
        link.discard(draftId, state.current.content);
      }
    : undefined;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Esc inside the window: the controller minimizes (with content) or closes,
    // whatever key the active keymap gives the sheet close.
    if (e.key === "Escape" && !e.defaultPrevented) {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  const attach = (files: File[]) => {
    if (files.length) void editor.attach(files);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    attach(Array.from(e.dataTransfer.files ?? []));
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
      <label htmlFor={`compose-${field}-${draftId}`}>{label}</label>
      <Recipients
        inputId={`compose-${field}-${draftId}`}
        label={label}
        value={content[field]}
        onChange={(people: Person[]) => editor.setRecipients(field, people)}
        people={composer.participants()}
        onBlur={() => void editor.flush()}
      />
    </div>
  );

  const windowStyle = bare ? "sheet" : (link?.settings.windowStyle ?? "sheet");
  const exit = leaving ? link?.exitOf(draftId) : null;
  const motion = exit === "minimize" ? "to-dock" : fromDock && !leaving ? "from-dock" : undefined;
  const dockSide = link ? `dock-${link.settings.dockPosition}` : undefined;
  const byline =
    author === "agent" ? <span className="c-status">{strings.draftedByAgent}</span> : null;

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
      <Compose
        draft={draft}
        strings={strings.overlay}
        note={suggestion?.note ? { text: suggestion.note } : undefined}
        canSend={editor.canSend}
        leaving={leaving}
        onLeft={onLeft}
        bare={bare}
        windowStyle={windowStyle}
        className={[motion, dockSide].filter(Boolean).join(" ") || undefined}
        onKeyDown={onKeyDown}
        onClose={onClose}
        onMinimize={minimize}
        onDiscard={discard}
        onSend={() => void send()}
        onLater={() => setLater((l) => !l)}
        laterRef={laterButton}
        laterOpen={later}
        onAttach={() => fileInput.current?.click()}
        onSubject={editor.setSubject}
        recipients={
          <Recipients
            inputId={bare ? `compose-to-${draftId}` : "compose-to"}
            label={strings.overlay.to}
            value={content.to}
            onChange={(people) => editor.setRecipients("to", people)}
            people={composer.participants()}
            autofocus={!bare && initial.to.length === 0}
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
        tools={
          <Toolbar
            editor={tiptap}
            strings={{ ...strings.editor, formatting: strings.overlay.formatting }}
            hidden={link ? !link.toolbar : false}
            linkOpen={linkOpen}
            onLinkOpen={setLinkOpen}
            assist={
              <AssistMenu
                assist={assist}
                strings={strings.assist}
                editor={tiptap}
                translateTo={link?.translateTo ?? "English"}
              />
            }
          />
        }
        editor={
          <Editor
            className="c-editor"
            initialHtml={initial.bodyHtml}
            onChange={editor.setBody}
            onBlur={() => void editor.flush()}
            autofocus={!bare && initial.to.length > 0}
            strings={strings.editor}
            onReady={setTiptap}
            onLink={() => setLinkOpen(true)}
            onFiles={attach}
            ghost={suggestion?.ghost}
          />
        }
        suggestion={
          <SuggestionPanel
            suggestion={assist.suggestion}
            strings={strings.assist}
            onAccept={assist.accept}
            onReject={assist.reject}
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
        status={
          <>
            <span className="c-status">{editor.saving ? strings.saving : strings.saved}</span>
            {byline}
          </>
        }
      />
      {later ? (
        <AnchoredMenu
          anchor={laterButton.current}
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
          attach(files);
        }}
      />
    </div>
  );
}

/** The active window, over the whole app window like the mock's scrim. */
export function ComposeOverlay(props: ComposeOverlayProps) {
  return createPortal(<ComposeWindow {...props} />, document.body);
}
