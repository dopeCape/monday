// The compose state one screen owns: the compose windows (the active one the
// screen renders, the ones kept open beside it, the minimized ones in the
// dock), the reply open inline, the send waiting in its undo window, a
// discarded Draft's Undo, and the notices to show (docs/spec/inbox.md,
// "Composing several messages at once"). Pure orchestration over the
// Composer; the surfaces render it, and the dock renders itself.
//
// Opening never waits: a new message is a window the moment it is asked for,
// and its Draft is created by the first autosave after a change. Only a saved
// Draft whose Cache copy is older than the Server's waits for its content.

import type { DraftContent, Message, Person, SendError, Settings, Thread } from "@monday/shared";
import { formatSize, formatWhen } from "@monday/ui";
import {
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { chordOf, type KeymapName, resolveKeymap } from "../../keyboard/keymaps.ts";
import { useIsActivePane } from "../../shell/active.ts";
import { composeBus } from "./bus.ts";
import type { Composer } from "./composer.ts";
import { type Discarded, Dock } from "./Dock.tsx";
import { useDockHost } from "./dock-host.ts";
import { type ComposeLink, type Surface, type SurfaceState, setLink } from "./link.ts";
import {
  initialContent,
  plainToHtml,
  replyRecipients,
  shouldReplyAll,
  signatureFor,
} from "./reply.ts";
import { type ComposeUiStrings, composeStrings } from "./strings.ts";
import {
  type ComposeWindow,
  cycleOrder,
  dock,
  findWindow,
  forget,
  hasContent,
  minimizeActive,
  NO_WINDOWS,
  nextInCycle,
  openWindow,
  sameContent,
  setDirty,
  type Windows,
  windowSettings,
} from "./windows.ts";

/** The window the screen renders: its Draft and what it opens with. */
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
  /** What a fresh reply opened with, for "has this any content"; null for a saved Draft. */
  pristine?: DraftContent | null | undefined;
  /** Opened by itself because the Thread has a saved reply Draft. */
  auto?: boolean | undefined;
}

export interface PendingSend {
  sendId: string;
  runAt: string;
  draftId: string;
  /** Picked from the Later menu: the bar shows the time, not a countdown. */
  later?: boolean | undefined;
}

export interface ComposeController {
  strings: ComposeUiStrings;
  /** The active window, or null. Stable while the same window stays active. */
  overlay: OverlayState | null;
  /** Every window: active, open beside it, minimized. */
  windows: Windows;
  reply: ReplyState | null;
  pending: PendingSend | null;
  /** A one-line notice (an error, "send cancelled"); the screen shows it as a toast. */
  notice: { text: string; id: number } | null;
  clearNotice(): void;
  /** A new message; the open one is minimized (or kept beside it) by Setting. */
  openNew(): void;
  /** Reopens a saved Draft: in the reply box when its Thread is open, else a window. */
  openDraft(draftId: string, openThreadId: string | null): Promise<void>;
  startReply(
    thread: Thread,
    messages: readonly Message[],
    kind: "reply" | "forward",
    forceReplyAll?: boolean,
    /** From a Brief chip: the proposed opening line, or the forward recipient. */
    seed?: { opening?: string | undefined; to?: Person[] | undefined },
  ): void;
  /** Esc, the close button, the scrim: minimizes a window with content, or closes it, by Setting. */
  closeOverlay(): void;
  /** Esc on the inline reply: docks it when it has changes, else closes it. */
  closeReply(): void;
  /** Collapses a window or the inline reply into the dock. */
  minimize(draftId: string): void;
  /** Brings a docked or stacked window back. */
  restore(draftId: string): void;
  /** The cycle shortcut: the next open or minimized Draft. */
  cycle(): void;
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
  /** Where the dock remembers its Drafts across a restart; tests pass their own. */
  storage?: Pick<Storage, "getItem" | "setItem"> | null | undefined;
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

function defaultStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

const dockKey = (workspaceId: string) => `monday.compose.dock.${workspaceId}`;

/** The Draft's content as a window opens it. */
function contentOf(draft: NonNullable<ReturnType<Composer["draft"]>>): DraftContent {
  const {
    id: _i,
    workspaceId: _w,
    attachmentBlobIds: _b,
    status: _s,
    updatedAt: _u,
    updatedBy: _y,
    ...rest
  } = draft;
  return { ...rest, bodyHtml: rest.bodyHtml || plainToHtml(rest.bodyText) };
}

/** The windows a restart brings back: the Drafts that were in the dock, still open. */
function restoredWindows(
  composer: Composer,
  storage: Pick<Storage, "getItem" | "setItem"> | null,
  restore: boolean,
): Windows {
  if (!restore || !storage) return NO_WINDOWS;
  let ids: unknown = [];
  try {
    ids = JSON.parse(storage.getItem(dockKey(composer.workspaceId)) ?? "[]");
  } catch {
    return NO_WINDOWS;
  }
  if (!Array.isArray(ids)) return NO_WINDOWS;
  const docked: ComposeWindow[] = [];
  for (const id of ids) {
    if (typeof id !== "string") continue;
    const draft = composer.draft(id);
    if (draft?.status !== "open") continue;
    docked.push({ draftId: id, initial: contentOf(draft), pristine: null, dirty: false });
  }
  return docked.length ? { active: null, stacked: [], docked } : NO_WINDOWS;
}

export function useCompose(o: UseComposeOptions): ComposeController {
  const { composer, settings, now } = o;
  const mint = o.id ?? (() => crypto.randomUUID());
  const storage = o.storage === undefined ? defaultStorage() : o.storage;
  const strings = useMemo(() => composeStrings(settings), [settings]);
  const active = useIsActivePane();
  const activeRef = useRef(active);
  activeRef.current = active;
  const ws = useMemo(() => windowSettings(settings), [settings]);
  const wsRef = useRef(ws);
  wsRef.current = ws;

  const [windows, setWindows] = useState<Windows>(() =>
    restoredWindows(composer, storage, ws.restoreDocked),
  );
  const windowsRef = useRef(windows);
  const [reply, setReplyState] = useState<ReplyState | null>(null);
  const replyRef = useRef(reply);
  const [pending, setPending] = useState<PendingSend | null>(null);
  const [notice, setNotice] = useState<{ text: string; id: number } | null>(null);
  const [discarded, setDiscarded] = useState<Discarded | null>(null);
  const noticeSeq = useRef(0);
  const discardSeq = useRef(0);

  // What the controller knows about each open surface, by Draft id.
  const surfaces = useRef(new Map<string, Surface>());
  const lastState = useRef(new Map<string, SurfaceState>());
  const exits = useRef(new Map<string, "minimize" | "close">());
  const authors = useRef(new Map<string, "agent" | "user">());
  const shownThread = useRef<string | null>(composeBus.shownThread());
  const dismissed = useRef<string | null>(null);

  const setW = useCallback((next: Windows | ((w: Windows) => Windows)) => {
    const value = typeof next === "function" ? next(windowsRef.current) : next;
    if (value === windowsRef.current) return;
    windowsRef.current = value;
    setWindows(value);
  }, []);
  const setReply = useCallback((next: ReplyState | null) => {
    replyRef.current = next;
    setReplyState(next);
  }, []);

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

  /** A window with the latest content its surface holds. */
  const latest = useCallback((win: ComposeWindow): ComposeWindow => {
    const s = surfaces.current.get(win.draftId)?.read() ?? lastState.current.get(win.draftId);
    return s ? { ...win, initial: s.content, dirty: s.dirty } : win;
  }, []);
  const pristineOf = useCallback(
    (draftId: string) => findWindow(windowsRef.current, draftId)?.pristine ?? null,
    [],
  );

  /** Saves a window's content so a minimized one is an ordinary Draft; the dot clears once saved. */
  const keep = useCallback(
    (win: ComposeWindow) => {
      void composer.save(win.draftId, win.initial).then(
        () => setW((w) => setDirty(w, win.draftId, false)),
        () => {},
      );
    },
    [composer, setW],
  );

  /** Opens a window; the open one goes aside by Setting, or is dropped when it holds nothing. */
  const show = useCallback(
    (win: ComposeWindow, asideTo: "front" | "back" = "front") => {
      const w = windowsRef.current;
      let base = w;
      let current: ComposeWindow | undefined;
      if (w.active && w.active.draftId !== win.draftId) {
        current = latest(w.active);
        if (!hasContent(current.initial, current.pristine)) {
          surfaces.current.get(current.draftId)?.stop();
          exits.current.set(current.draftId, "close");
          base = forget(w, current.draftId);
          current = undefined;
        } else {
          exits.current.set(
            current.draftId,
            wsRef.current.newWhileOpen === "stack" ? "close" : "minimize",
          );
          keep(current);
        }
      }
      exits.current.delete(win.draftId);
      setW(openWindow(base, win, wsRef.current, current, asideTo));
    },
    [latest, keep, setW],
  );

  /** Docks the inline reply, when it holds changes. */
  const dockReply = useCallback(
    (r: ReplyState, force = false) => {
      const s = surfaces.current.get(r.draftId)?.read() ??
        lastState.current.get(r.draftId) ?? { content: r.initial, dirty: false };
      const changed = !sameContent(s.content, r.initial) || !r.auto;
      if (!hasContent(s.content, r.pristine ?? null)) return false;
      if (!force && !changed) return false;
      const win: ComposeWindow = {
        draftId: r.draftId,
        initial: s.content,
        pristine: r.pristine ?? null,
        dirty: s.dirty,
      };
      exits.current.set(r.draftId, "minimize");
      setW((w) => dock(w, win));
      keep(win);
      return true;
    },
    [setW, keep],
  );

  const openNew = useCallback(() => {
    const initial = initialContent({
      threadId: null,
      kind: "new",
      last: null,
      subject: "",
      me: composer.address,
      replyAll: false,
      signature,
      strings: strings.reply,
      formatDate,
    });
    show({ draftId: mint(), initial, pristine: initial, dirty: false });
  }, [mint, composer.address, signature, strings.reply, formatDate, show]);

  /** Puts a Draft inline under its Thread, docking the reply that was there. */
  const inline = useCallback(
    (next: ReplyState) => {
      const current = replyRef.current;
      if (current && current.draftId !== next.draftId) dockReply(current);
      setW((w) => forget(w, next.draftId));
      setReply(next);
    },
    [dockReply, setW, setReply],
  );

  const startReply = useCallback(
    (
      thread: Thread,
      messages: readonly Message[],
      kind: "reply" | "forward",
      force?: boolean,
      seed?: { opening?: string | undefined; to?: Person[] | undefined },
    ) => {
      // A reply already started on this Thread (by the user or the Agent) is continued, not doubled.
      const saved = composer
        .drafts()
        .find((d) => d.threadId === thread.id && d.kind === kind && d.status === "open");
      if (saved && !seed) {
        const current = replyRef.current;
        if (current?.draftId === saved.id) return;
        const win = findWindow(windowsRef.current, saved.id);
        authors.current.set(saved.id, saved.updatedBy === "agent" ? "agent" : "user");
        inline({
          threadId: thread.id,
          draftId: saved.id,
          kind,
          replyAll: saved.cc.length > 0,
          last: messages[messages.length - 1] ?? null,
          initial: win ? latest(win).initial : contentOf(saved),
          pristine: null,
        });
        return;
      }
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
      const initial = initialContent({
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
        opening: seed?.opening,
        to: seed?.to,
      });
      inline({
        threadId: thread.id,
        draftId: mint(),
        kind,
        replyAll,
        last,
        initial,
        pristine: seed?.opening || seed?.to ? null : initial,
      });
    },
    [composer, settings, mint, signature, strings.reply, formatDate, inline, latest],
  );

  const openDraft = useCallback(
    async (draftId: string, openThreadId: string | null, auto = false) => {
      const w = windowsRef.current;
      const thread = openThreadId ?? shownThread.current;
      const open = findWindow(w, draftId);
      if (open) {
        const kind = open.initial.kind;
        if (kind !== "new" && open.initial.threadId && open.initial.threadId === thread) {
          inline({
            threadId: open.initial.threadId,
            draftId,
            kind,
            replyAll: open.initial.cc.length > 0,
            last: null,
            initial: latest(open).initial,
            pristine: open.pristine,
          });
        } else {
          show(open);
        }
        return;
      }
      if (replyRef.current?.draftId === draftId) return;
      const local = composer.draft(draftId);
      const draft = local ?? (await composer.ensureContent(draftId));
      const fresh = local ? await composer.ensureContent(draftId) : draft;
      const found = fresh ?? draft;
      if (found?.status !== "open") return;
      authors.current.set(draftId, found.updatedBy === "agent" ? "agent" : "user");
      const content = contentOf(found);
      if (found.threadId && found.threadId === thread && found.kind !== "new") {
        inline({
          threadId: found.threadId,
          draftId,
          kind: found.kind,
          replyAll: found.cc.length > 0,
          last: null,
          initial: content,
          pristine: null,
          auto,
        });
      } else {
        show({ draftId, initial: content, pristine: null, dirty: false });
      }
    },
    [composer, inline, latest, show],
  );

  const minimize = useCallback(
    (draftId: string, state?: SurfaceState) => {
      const s = state ?? surfaces.current.get(draftId)?.read();
      const w = windowsRef.current;
      const r = replyRef.current;
      if (r?.draftId === draftId) {
        const win: ComposeWindow = {
          draftId,
          initial: s?.content ?? r.initial,
          pristine: r.pristine ?? null,
          dirty: s?.dirty ?? false,
        };
        exits.current.set(draftId, "minimize");
        setW((x) => dock(x, win));
        setReply(null);
        keep(win);
        return;
      }
      const open = findWindow(w, draftId);
      if (!open) return;
      const win = s ? { ...open, initial: s.content, dirty: s.dirty } : latest(open);
      exits.current.set(draftId, "minimize");
      setW((x) => (x.active?.draftId === draftId ? minimizeActive(x, win) : dock(x, win)));
      keep(win);
    },
    [latest, setW, setReply, keep],
  );

  /** A window closes: minimized when it has content and the Setting says so, else closed. */
  const closeWindow = useCallback(
    (draftId: string) => {
      const open = findWindow(windowsRef.current, draftId);
      if (!open) return;
      const cur = latest(open);
      if (!hasContent(cur.initial, cur.pristine)) {
        surfaces.current.get(draftId)?.stop();
        exits.current.set(draftId, "close");
        setW((w) => forget(w, draftId));
        if (composer.draft(draftId)) void composer.discard(draftId);
        return;
      }
      if (wsRef.current.closeBehavior === "minimize") {
        minimize(draftId, { content: cur.initial, dirty: cur.dirty });
        return;
      }
      exits.current.set(draftId, "close");
      setW((w) => forget(w, draftId));
    },
    [latest, composer, minimize, setW],
  );

  const closeOverlay = useCallback(() => {
    const active = windowsRef.current.active;
    if (active) closeWindow(active.draftId);
  }, [closeWindow]);

  const closeReply = useCallback(() => {
    const r = replyRef.current;
    if (!r) return;
    const s = surfaces.current.get(r.draftId)?.read() ?? { content: r.initial, dirty: false };
    if (!hasContent(s.content, r.pristine ?? null)) {
      surfaces.current.get(r.draftId)?.stop();
      if (composer.draft(r.draftId)) void composer.discard(r.draftId);
      setReply(null);
      return;
    }
    if (r.auto && sameContent(s.content, r.initial)) {
      // A saved Draft the Thread showed by itself: Esc hides it until the Thread opens again.
      dismissed.current = r.threadId;
      setReply(null);
      return;
    }
    if (wsRef.current.closeBehavior === "minimize") dockReply(r, true);
    setReply(null);
  }, [composer, dockReply, setReply]);

  const restore = useCallback(
    (draftId: string) => {
      void openDraft(draftId, shownThread.current);
    },
    [openDraft],
  );

  const cycle = useCallback(() => {
    const w = windowsRef.current;
    const next = nextInCycle(w);
    if (!next) return;
    const win = findWindow(w, next);
    if (!win) return;
    if (w.active) show(win, "back");
    else restore(next);
  }, [show, restore]);

  const discard = useCallback(
    (draftId: string, content: DraftContent) => {
      surfaces.current.get(draftId)?.stop();
      exits.current.set(draftId, "close");
      setW((w) => forget(w, draftId));
      if (replyRef.current?.draftId === draftId) setReply(null);
      void composer.discard(draftId);
      discardSeq.current += 1;
      setDiscarded({ draftId, content, seq: discardSeq.current });
    },
    [composer, setW, setReply],
  );

  const undoDiscard = useCallback(async () => {
    const d = discarded;
    if (!d) return;
    setDiscarded(null);
    await composer.save(d.draftId, d.content);
    const c = d.content;
    if (c.kind !== "new" && c.threadId && c.threadId === shownThread.current) {
      inline({
        threadId: c.threadId,
        draftId: d.draftId,
        kind: c.kind,
        replyAll: c.cc.length > 0,
        last: null,
        initial: c,
        pristine: null,
      });
    } else {
      show({ draftId: d.draftId, initial: c, pristine: null, dirty: false });
    }
  }, [discarded, composer, inline, show]);

  const setReplyAll = useCallback(
    (replyAll: boolean) => {
      const current = replyRef.current;
      if (!current) return null;
      setReply({ ...current, replyAll });
      void composer.setReplyAllFor(current.threadId, replyAll);
      if (!current.last) return null;
      return replyRecipients(current.last, composer.address, replyAll);
    },
    [composer, setReply],
  );

  const onSent = useCallback(
    (sent: PendingSend) => {
      setPending(sent);
      exits.current.set(sent.draftId, "close");
      setW((w) => forget(w, sent.draftId));
      if (replyRef.current?.draftId === sent.draftId) setReply(null);
    },
    [setW, setReply],
  );

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

  /* ------------------------------ The link the surfaces use ------------------------------ */

  const link = useRef<ComposeLink | null>(null);
  const aiOn = settings["ai.level"] !== "off" && settings["compose.assist"];
  if (!link.current) {
    link.current = {
      settings: ws,
      toolbar: settings["compose.toolbar"],
      assist: aiOn,
      translateTo: settings["compose.translate_default"],
      minimize: (draftId, state) => minimizeRef.current(draftId, state),
      discard: (draftId, content) => discardRef.current(draftId, content),
      pristineOf: (draftId) => pristineOfRef.current(draftId),
      exitOf: (draftId) => exits.current.get(draftId) ?? null,
      fromDock: (draftId) =>
        windowsRef.current.active?.draftId === draftId && !!windowsRef.current.active.fromDock,
      authorOf: (draftId) => authors.current.get(draftId) ?? null,
      register(draftId, surface) {
        surfaces.current.set(draftId, surface);
        lastState.current.delete(draftId);
        return () => {
          if (surfaces.current.get(draftId) !== surface) return;
          lastState.current.set(draftId, surface.read());
          surfaces.current.delete(draftId);
        };
      },
    };
  }
  const pristineOfRef = useRef(pristineOf);
  pristineOfRef.current = pristineOf;
  const minimizeRef = useRef(minimize);
  minimizeRef.current = minimize;
  const discardRef = useRef(discard);
  discardRef.current = discard;
  link.current.settings = ws;
  link.current.toolbar = settings["compose.toolbar"];
  link.current.assist = aiOn;
  link.current.translateTo = settings["compose.translate_default"];
  // Set during render: the active window reads it on its first render.
  setLink(composer, link.current);
  useEffect(() => () => setLink(composer, null), [composer]);

  /* ------------------------------ The bus: the reader and the Agent ------------------------------ */

  const openDraftRef = useRef(openDraft);
  openDraftRef.current = openDraft;
  const dockReplyRef = useRef(dockReply);
  dockReplyRef.current = dockReply;
  useEffect(
    () =>
      composeBus.listen({
        showThread(threadId) {
          if (threadId === shownThread.current) return;
          shownThread.current = threadId;
          dismissed.current = null;
          const r = replyRef.current;
          if (r && r.threadId !== threadId) {
            // Leaving a Thread with a reply in progress puts the reply in the dock.
            dockReplyRef.current(r);
            setReply(null);
          }
          if (!threadId || (replyRef.current && replyRef.current.threadId === threadId)) return;
          const saved = composer
            .drafts()
            .find(
              (d) =>
                d.threadId === threadId &&
                d.kind !== "new" &&
                d.status === "open" &&
                !findWindow(windowsRef.current, d.id),
            );
          if (saved) void openDraftRef.current(saved.id, threadId, true);
        },
        openDraft(request) {
          void openDraftRef.current(request.draftId, request.threadId ?? shownThread.current);
        },
      }),
    [composer, setReply],
  );

  // The Agent's turn context names the Draft that is open (bus.ts).
  const openId = windows.active?.draftId ?? reply?.draftId ?? null;
  useEffect(() => {
    composeBus.setOpenDraft(openId);
  }, [openId]);
  useEffect(() => () => composeBus.setOpenDraft(null), []);

  /* ------------------------------ The cycle shortcut ------------------------------ */

  const keymapName = settings["keyboard.keymap"] as KeymapName;
  const bindings = settings["keyboard.bindings"];
  const cycleChord = useMemo(
    () => resolveKeymap(keymapName, bindings)["compose.cycle"],
    [keymapName, bindings],
  );
  const cycleRef = useRef(cycle);
  cycleRef.current = cycle;
  useEffect(() => {
    if (typeof window === "undefined") return;
    const on = (e: KeyboardEvent) => {
      if (!activeRef.current) return;
      if (e.defaultPrevented || e.isComposing) return;
      if (chordOf(e) !== cycleChord) return;
      if (cycleOrder(windowsRef.current).length === 0) return;
      e.preventDefault();
      cycleRef.current();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [cycleChord]);

  /* ------------------------------ The dock survives a restart ------------------------------ */

  useEffect(() => {
    if (!storage) return;
    try {
      storage.setItem(dockKey(composer.workspaceId), JSON.stringify(cycleOrder(windows)));
    } catch {
      // A full or blocked storage only costs the dock after a restart.
    }
  }, [windows, storage, composer.workspaceId]);

  /* ------------------------------ The dock renders itself ------------------------------ */

  const idleMs = settings["send.draft_autosave_ms"];
  const delaySeconds = settings["send.delay_seconds"];
  const laterPresetsHours = settings["send.later_presets_hours"];
  const dockShown = windows.docked.length > 0 || windows.stacked.length > 0 || discarded !== null;
  useDockHost(
    createElement(Dock, {
      composer,
      windows,
      settings: ws,
      strings,
      idleMs,
      delaySeconds,
      laterPresetsHours,
      now,
      onRestore: restore,
      onCloseWindow: (draftId: string) => {
        if (windowsRef.current.stacked.some((w) => w.draftId === draftId)) closeWindow(draftId);
        else setW((w) => forget(w, draftId));
      },
      onSent,
      onError: notify,
      discarded,
      onUndoDiscard: () => void undoDiscard(),
      onDiscardExpired: () => setDiscarded(null),
      toastMs: settings["inbox.undo_toast_ms"],
      undoLabel: settings["strings.inbox.undo"],
    }),
    // A Workspace behind the one on show keeps its windows but draws no dock.
    dockShown && active,
  );

  return {
    strings,
    overlay: windows.active,
    windows,
    reply,
    pending,
    notice,
    clearNotice: () => setNotice(null),
    openNew,
    openDraft: (draftId, openThreadId) => openDraft(draftId, openThreadId),
    startReply,
    closeOverlay,
    closeReply,
    minimize: (draftId) => minimize(draftId),
    restore,
    cycle,
    setReplyAll,
    onSent,
    undo,
    elapsed: () => setPending(null),
    onError: notify,
    idleMs,
    delaySeconds,
    laterPresetsHours,
  };
}
