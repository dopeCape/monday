// The Drafts folder: every open Draft the Store holds, newest first (ADR
// 0010). A row names its recipients or says there are none, its subject or
// says there is none, and when it was last saved; a click opens the composer
// on it, and the row's delete removes it with an undo toast that saves it
// back as it was. Scheduled Drafts live in Scheduled, not here.

import type { Draft, DraftContent } from "@monday/shared";
import { Btn, ColHead, formatListTime, Icon, Toast } from "@monday/ui";
import { TrashIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { chordLabel, chordOf } from "../keyboard/keymaps.ts";
import { useActiveKeymap } from "../keyboard/useKeymap.ts";
import { useShell } from "../shell/Shell.tsx";
import type { Composer } from "./compose/composer.ts";

export interface DraftsProps {
  composer: Composer;
  now: Date;
  /** Opens the composer on a Draft. */
  onOpen: (draftId: string) => void;
  /** For tests: the toast's lifetime in ms, over inbox.undo_toast_ms. */
  toastMs?: number | undefined;
}

/** The Drafts a user can still edit: not scheduled, not sent. */
export function openDrafts(drafts: readonly Draft[]): Draft[] {
  return drafts.filter((d) => d.status === "open");
}

/** What a Draft holds, without the Store's bookkeeping, so a delete can be saved back. */
function contentOf(draft: Draft): DraftContent {
  return {
    threadId: draft.threadId,
    kind: draft.kind,
    inReplyToMessageId: draft.inReplyToMessageId,
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    bodyHtml: draft.bodyHtml,
    bodyText: draft.bodyText,
    attachments: draft.attachments,
  };
}

function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

export function Drafts({ composer, now, onOpen, toastMs }: DraftsProps) {
  const { settings: s } = useShell();
  const keymap = useActiveKeymap();
  const all = useSyncExternalStore(composer.subscribe, composer.drafts, composer.drafts);
  const drafts = useMemo(() => openDrafts(all), [all]);
  const [toast, setToast] = useState<{ id: number; draft: Draft } | null>(null);
  const seq = useRef(0);

  const remove = useCallback(
    (draft: Draft) => {
      seq.current += 1;
      setToast({ id: seq.current, draft });
      void composer.discard(draft.id);
    },
    [composer],
  );
  const undo = useCallback(() => {
    if (!toast) return;
    setToast(null);
    void composer.save(toast.draft.id, contentOf(toast.draft));
  }, [composer, toast]);
  // The keymap's undo key works while the toast shows, as it does in the stream.
  useEffect(() => {
    if (!toast) return;
    const onKey = (e: KeyboardEvent) => {
      if (chordOf(e) !== keymap.undo) return;
      e.preventDefault();
      undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toast, keymap.undo, undo]);

  const title = s["strings.nav.drafts"];
  return (
    <div className="main inbox drafts">
      <section className="col list" aria-label={title}>
        <ColHead title={title} count={drafts.length || undefined} />
        <div className="col-body">
          {drafts.length === 0 ? (
            <div className="empty-line">{s["strings.folder.drafts.empty"]}</div>
          ) : (
            <ul className="drafts-list" aria-label={title}>
              {drafts.map((d) => {
                const to = [...d.to, ...d.cc].map((p) => p.name || p.email).join(", ");
                return (
                  <li key={d.id} className="draft-row" data-draft={d.id}>
                    <button type="button" className="draft-open" onClick={() => onOpen(d.id)}>
                      <span className={to ? "to" : "to none"}>
                        {to || s["strings.drafts.no_recipient"]}
                      </span>
                      <span className={d.subject.trim() ? "subj" : "subj none"}>
                        {d.subject.trim() || s["strings.drafts.no_subject"]}
                      </span>
                      <span className="when">{formatListTime(d.updatedAt, now)}</span>
                    </button>
                    <Btn
                      icon
                      title={s["strings.drafts.delete"]}
                      aria-label={s["strings.drafts.delete"]}
                      onClick={() => remove(d)}
                    >
                      <Icon icon={TrashIcon} />
                    </Btn>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
      {toast ? (
        <Toast
          key={toast.id}
          text={s["strings.drafts.deleted"]}
          undoLabel={s["strings.inbox.undo"]}
          undoKey={chordLabel(keymap.undo, isMac())}
          ms={toastMs ?? s["inbox.undo_toast_ms"]}
          onUndo={undo}
          onExpire={() => setToast(null)}
        />
      ) : null}
    </div>
  );
}
