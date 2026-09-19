// The state one compose surface owns while a Draft is open: its content,
// the autosave, uploads in flight, and Send. The overlay and the inline reply
// both use it, so they behave the same and differ only in chrome.

import type { DraftContent, Person } from "@monday/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Upload } from "./Attachments.tsx";
import { fileToUpload } from "./Attachments.tsx";
import { type Autosave, createAutosave } from "./autosave.ts";
import type { Composer, SendOptions } from "./composer.ts";
import type { EditorValue } from "./Editor.tsx";

export interface DraftEditorOptions {
  composer: Composer;
  draftId: string;
  initial: DraftContent;
  idleMs: number;
  /** The Draft was never saved: the first change creates it. */
  fresh?: boolean | undefined;
}

export interface DraftEditor {
  content: DraftContent;
  saving: boolean;
  uploads: readonly Upload[];
  setRecipients(field: "to" | "cc" | "bcc", people: Person[]): void;
  setSubject(subject: string): void;
  setBody(value: EditorValue): void;
  /** Blur: save now. */
  flush(): Promise<void>;
  attach(files: readonly File[]): Promise<void>;
  removeAttachment(blobId: string): void;
  /** Forgets an upload that failed. */
  dismissUpload(key: string): void;
  setAttachments(attachments: DraftContent["attachments"]): void;
  /** Saves, then schedules the send Job. Rejects with "no_recipients" when nobody is on it. */
  send(options?: SendOptions): Promise<{ sendId: string; runAt: string }>;
  discard(): Promise<void>;
  canSend: boolean;
}

export function useDraftEditor(o: DraftEditorOptions): DraftEditor {
  const { composer, draftId, idleMs } = o;
  const [content, setContent] = useState<DraftContent>(o.initial);
  const [saving, setSaving] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const contentRef = useRef(content);
  contentRef.current = content;
  const uploadSeq = useRef(0);

  const autosave: Autosave = useMemo(
    () =>
      createAutosave({
        idleMs,
        save: (c) => composer.save(draftId, c),
        onState: setSaving,
      }),
    [composer, draftId, idleMs],
  );
  // Closing the surface (Escape, the close button, a send elsewhere) saves
  // what is pending rather than dropping it: a Draft is never lost to a key.
  // After discard or send nothing is pending, so this is a no-op then.
  useEffect(() => () => void autosave.flush(), [autosave]);

  const update = useCallback(
    (patch: Partial<DraftContent>) => {
      const next = { ...contentRef.current, ...patch };
      contentRef.current = next;
      setContent(next);
      autosave.change(next);
    },
    [autosave],
  );

  const attach = useCallback(
    async (files: readonly File[]) => {
      await Promise.all(
        files.map(async (file) => {
          uploadSeq.current += 1;
          const key = `u${uploadSeq.current}`;
          const upload: Upload = {
            key,
            name: file.name,
            size: file.size,
            mediaType: file.type || "application/octet-stream",
            fraction: 0,
          };
          setUploads((u) => [...u, upload]);
          try {
            const bytes = await fileToUpload(file);
            const done = await composer.upload(bytes, (fraction) =>
              setUploads((u) => u.map((x) => (x.key === key ? { ...x, fraction } : x))),
            );
            setUploads((u) => u.filter((x) => x.key !== key));
            update({ attachments: [...contentRef.current.attachments, done] });
          } catch (error) {
            setUploads((u) =>
              u.map((x) =>
                x.key === key
                  ? { ...x, error: error instanceof Error ? error.message : String(error) }
                  : x,
              ),
            );
          }
        }),
      );
    },
    [composer, update],
  );

  // A failed upload is not on the Draft; it shows with its error and never blocks Send.
  const canSend =
    content.to.length + content.cc.length + content.bcc.length > 0 &&
    uploads.every((u) => u.error !== undefined);

  return {
    content,
    saving,
    uploads,
    setRecipients: (field, people) => update({ [field]: people }),
    setSubject: (subject) => update({ subject }),
    setBody: (value) => update({ bodyHtml: value.html, bodyText: value.text }),
    flush: () => autosave.flush(),
    attach,
    removeAttachment: (blobId) =>
      update({ attachments: contentRef.current.attachments.filter((a) => a.blobId !== blobId) }),
    dismissUpload: (key) => setUploads((u) => u.filter((x) => x.key !== key)),
    setAttachments: (attachments) => update({ attachments }),
    async send(options) {
      if (
        contentRef.current.to.length +
          contentRef.current.cc.length +
          contentRef.current.bcc.length ===
        0
      ) {
        throw new Error("no_recipients");
      }
      await autosave.flush();
      if (autosave.count === 0) await composer.save(draftId, contentRef.current);
      return composer.send(draftId, options);
    },
    async discard() {
      autosave.cancel();
      await composer.discard(draftId);
    },
    canSend,
  };
}
