// The compose state one screen owns: which Draft is open in the overlay,
// which reply is open inline, the send waiting in its undo window, and the
// notices to show. Pure orchestration over the Composer; the surfaces render it.

import type { DraftContent, Message, SendError, Settings, Thread } from "@monday/shared";
import { formatSize, formatWhen } from "@monday/ui";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Composer } from "./composer.ts";
import {
  initialContent,
  plainToHtml,
  replyRecipients,
  shouldReplyAll,
  signatureFor,
} from "./reply.ts";
import { type ComposeUiStrings, composeStrings } from "./strings.ts";

export interface OverlayState {
  draftId: string;
  initial: DraftContent;
}

export interface ReplyState {
  threadId: string;
  draftId: string;
  initial: DraftContent;
  kind: "reply" | "forward";
  replyAll: boolean;
  last: Message | null;
}

export interface PendingSend {
  sendId: string;
  runAt: string;
  draftId: string;
}

export interface ComposeController {
  strings: ComposeUiStrings;
  overlay: OverlayState | null;
  reply: ReplyState | null;
  pending: PendingSend | null;
  /** A one-line notice (an error, "send cancelled"); the screen shows it as a toast. */
  notice: { text: string; id: number } | null;
  clearNotice(): void;
  openNew(): void;
  /** Reopens a saved Draft: in the reply box when its Thread is open, else the overlay. */
  openDraft(draftId: string, openThreadId: string | null): Promise<void>;
  startReply(
    thread: Thread,
    messages: readonly Message[],
    kind: "reply" | "forward",
    forceReplyAll?: boolean,
  ): void;
  closeOverlay(): void;
  closeReply(): void;
  /** The reply-all toggle: recomputes To and Cc and remembers the choice for the Thread. */
  setReplyAll(replyAll: boolean): { to: DraftContent["to"]; cc: DraftContent["cc"] } | null;
  onSent(sent: PendingSend): void;
  /** Undo: cancels the send and reopens the Draft where it was. */
  undo(openThreadId: string | null): Promise<void>;
  elapsed(): void;
  onError(message: string): void;
  idleMs: number;
  delaySeconds: number;
  laterPresetsHours: readonly number[];
}

export interface UseComposeOptions {
  composer: Composer;
  settings: Settings;
  now: () => Date;
  /** Mints Draft ids; tests make them predictable. */
  id?: (() => string) | undefined;
}

/** The one-line wording for a failed send. */
export function sendErrorText(
  error: SendError | null,
  strings: ComposeUiStrings,
  account: string,
): string {
  if (!error) return strings.sendFailed.replace("{error}", "");
  if (error.code === "too_large") {
    return strings.tooLarge
      .replace("{size}", formatSize(error.size))
      .replace("{limit}", error.limit > 0 ? formatSize(error.limit) : "")
      .replace("{account}", account);
  }
  if (error.code === "no_recipients") return strings.noRecipients;
  return strings.sendFailed.replace("{error}", error.message);
}

export function useCompose(o: UseComposeOptions): ComposeController {
  const { composer, settings, now } = o;
  const mint = o.id ?? (() => crypto.randomUUID());
  const strings = useMemo(() => composeStrings(settings), [settings]);
  const [overlay, setOverlay] = useState<OverlayState | null>(null);
  const [reply, setReply] = useState<ReplyState | null>(null);
  const [pending, setPending] = useState<PendingSend | null>(null);
  const [notice, setNotice] = useState<{ text: string; id: number } | null>(null);
  const noticeSeq = useRef(0);
  const replyRef = useRef(reply);
  replyRef.current = reply;

  const signature = useMemo(
    () => signatureFor(composer.address, settings["send.signatures"], settings["send.signature"]),
    [composer.address, settings],
  );
  const formatDate = useCallback((iso: string) => formatWhen(iso, now()), [now]);
  const notify = useCallback((text: string) => {
    noticeSeq.current += 1;
    setNotice({ text, id: noticeSeq.current });
  }, []);

  // A send the Server refused (too large, no route) surfaces once, worded from the Settings.
  const sends = useSyncExternalStore(composer.subscribe, composer.sends, composer.sends);
  const reported = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const send of sends) {
      if (send.status !== "failed" || reported.current.has(send.id)) continue;
      reported.current.add(send.id);
      notify(sendErrorText(send.error, strings, composer.address));
      setPending((p) => (p?.sendId === send.id ? null : p));
    }
  }, [sends, notify, strings, composer.address]);

  const openNew = useCallback(() => {
    setOverlay({
      draftId: mint(),
      initial: initialContent({
        threadId: null,
        kind: "new",
        last: null,
        subject: "",
        me: composer.address,
        replyAll: false,
        signature,
        strings: strings.reply,
        formatDate,
      }),
    });
  }, [mint, composer.address, signature, strings.reply, formatDate]);

  const startReply = useCallback(
    (thread: Thread, messages: readonly Message[], kind: "reply" | "forward", force?: boolean) => {
      const last = messages[messages.length - 1] ?? null;
      const replyAll =
        kind === "reply" && last
          ? (force ??
            shouldReplyAll(last, composer.address, {
              remembered: composer.replyAllFor(thread.id),
              settingDefault: settings["send.reply_all_default"],
            }))
          : false;
      const attachments =
        kind === "forward" && last && settings["send.forward_attachments"]
          ? last.attachments.map((a) => ({
              blobId: `att:${a.id}`,
              name: a.name,
              size: a.size,
              mediaType: a.mediaType,
            }))
          : [];
      setReply({
        threadId: thread.id,
        draftId: mint(),
        kind,
        replyAll,
        last,
        initial: initialContent({
          threadId: thread.id,
          kind,
          last,
          subject: thread.subject,
          me: composer.address,
          replyAll,
          signature,
          strings: strings.reply,
          formatDate,
          attachments,
        }),
      });
    },
    [composer, settings, mint, signature, strings.reply, formatDate],
  );

  const openDraft = useCallback(
    async (draftId: string, openThreadId: string | null) => {
      const draft = await composer.ensureContent(draftId);
      if (!draft) return;
      const {
        id: _i,
        workspaceId: _w,
        attachmentBlobIds: _b,
        status: _s,
        updatedAt: _u,
        updatedBy: _y,
        ...rest
      } = draft;
      const content: DraftContent = {
        ...rest,
        bodyHtml: rest.bodyHtml || plainToHtml(rest.bodyText),
      };
      if (draft.threadId && draft.threadId === openThreadId && draft.kind !== "new") {
        setReply({
          threadId: draft.threadId,
          draftId,
          kind: draft.kind,
          replyAll: draft.cc.length > 0,
          last: null,
          initial: content,
        });
      } else {
        setOverlay({ draftId, initial: content });
      }
    },
    [composer],
  );

  const setReplyAll = useCallback(
    (replyAll: boolean) => {
      const current = replyRef.current;
      if (!current) return null;
      setReply({ ...current, replyAll });
      void composer.setReplyAllFor(current.threadId, replyAll);
      if (!current.last) return null;
      return replyRecipients(current.last, composer.address, replyAll);
    },
    [composer],
  );

  const onSent = useCallback((sent: PendingSend) => {
    setPending(sent);
    setOverlay((o2) => (o2?.draftId === sent.draftId ? null : o2));
    setReply((r) => (r?.draftId === sent.draftId ? null : r));
  }, []);

  const undo = useCallback(
    async (openThreadId: string | null) => {
      const p = pending;
      if (!p) return;
      setPending(null);
      await composer.cancel(p.sendId);
      notify(strings.sendCancelled);
      await openDraft(p.draftId, openThreadId);
    },
    [pending, composer, notify, strings.sendCancelled, openDraft],
  );

  return {
    strings,
    overlay,
    reply,
    pending,
    notice,
    clearNotice: () => setNotice(null),
    openNew,
    openDraft,
    startReply,
    closeOverlay: () => setOverlay(null),
    closeReply: () => setReply(null),
    setReplyAll,
    onSent,
    undo,
    elapsed: () => setPending(null),
    onError: notify,
    idleMs: settings["send.draft_autosave_ms"],
    delaySeconds: settings["send.delay_seconds"],
    laterPresetsHours: settings["send.later_presets_hours"],
  };
}
