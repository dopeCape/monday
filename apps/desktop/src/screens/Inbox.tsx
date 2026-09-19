// The inbox screen: the stream or split list, the reader, the agent dock, and
// every triage behavior from docs/spec/inbox.md that needs no Server. Reads
// Threads through InboxSource and acts through InboxActions (screens/inbox/
// actions.ts); the Store implements both. Compose (the overlay, the inline
// reply, the undo bar) runs through the Composer seam (screens/compose).

import type { BriefAction, ExternalPending, Settings, Tag, Thread } from "@monday/shared";
import { Btn, ColHead, Kbd, MessageRow, SectionLabel, type Suggestion } from "@monday/ui";
import { DotsThreeIcon, FunnelSimpleIcon } from "@phosphor-icons/react";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Composer as AgentComposer, composerStrings } from "../agent/Composer.tsx";
import { runtimeLine } from "../agent/runtimeLine.ts";
import { suggestionsFor } from "../agent/suggestions.ts";
import { type AgentSession, NULL_SESSION } from "../agent/useAgentSession.ts";
import { chordLabel, isKeyAction, type KeyAction } from "../keyboard/keymaps.ts";
import {
  type KeyContext,
  type KeyHandlers,
  type Pane,
  useActiveKeymap,
  useKeymap,
} from "../keyboard/useKeymap.ts";
import { openExternal, saveDownload } from "../platform/open.ts";
import type { SearchModule } from "../search/index.ts";
import type { AgentAsk } from "../search/palette.ts";
import { useShell } from "../shell/Shell.tsx";
import { useWorkspace } from "../workspace.tsx";
import type { CalendarSource } from "./calendar/calendar-data.ts";
import { ComposeOverlay } from "./compose/ComposeOverlay.tsx";
import { type Composer, fixtureComposer } from "./compose/composer.ts";
import { ReplyCompose } from "./compose/ReplyCompose.tsx";
import { UndoBar } from "./compose/UndoBar.tsx";
import { useCompose } from "./compose/useCompose.ts";
import { fixtureInbox, type Inbox as InboxData, type UndoToken } from "./inbox/actions.ts";
import { BatchPreview } from "./inbox/BatchPreview.tsx";
import { type ComposeSeed, createActionRunner } from "./inbox/brief-actions.ts";
import { StreamTodayPanel, ThreadInviteBar } from "./inbox/InviteBar.tsx";
import { Picker } from "./inbox/Picker.tsx";
import { Reader } from "./inbox/Reader.tsx";
import { SnoozePicker } from "./inbox/SnoozePicker.tsx";
import { formatWake } from "./inbox/snooze.ts";
import { Toast } from "./inbox/Toast.tsx";
import {
  extendSelection,
  fill,
  needsPreview,
  neighbor,
  nextFocus,
  targets,
  toggleSelected,
} from "./inbox/triage.ts";
import { useClock } from "./inbox/useClock.ts";
import { useExit, useExitValue } from "./inbox/useExit.ts";
import { reducedMotion, useLeavingRows } from "./inbox/useLeaving.ts";
import { Palette, type PaletteCommand } from "./Palette.tsx";

export interface SyncProgress {
  done: number;
  total: number;
}

export interface InboxProps {
  /** The data seam. Defaults to the in-memory fixtures. */
  inbox?: InboxData | undefined;
  /** The compose seam. Defaults to an in-memory one. */
  composer?: Composer | undefined;
  /** First-sync progress for the thin line at the top, or null when not syncing. */
  syncing?: SyncProgress | null | undefined;
  /** Offline flips the agent bar's placeholder; the workspace dot is the App's. */
  online?: boolean | undefined;
  /**
   * The wall clock for relative times, pinned by tests. Absent, the
   * Workspace's clock (the design fixture's fixed one on the dev server) or
   * the real one, refreshed every inbox.time_refresh_seconds.
   */
  now?: Date | undefined;
  /** Opens this Thread in the reader on mount. Defaults to `?sel=` in the URL. */
  initialOpen?: string | null | undefined;
  /** Rows in the multi-select on mount. Defaults to `?multi=a,b` in the URL. */
  initialSelection?: readonly string[] | undefined;
  /** For tests: the collapse and toast delays in ms override the Settings. */
  timing?: { collapse?: number; toast?: number } | undefined;
  /** Bumped by the nav's New message; each change opens a fresh compose. */
  composeRequest?: number | undefined;
  /** Opens compose on mount: "new", or a Draft id. Defaults to `?compose=` in the URL. */
  initialCompose?: string | null | undefined;
  /** The Cache search behind the palette; absent in fixture mode. */
  search?: SearchModule | null | undefined;
  workspaceId?: string | undefined;
  /** The palette's "Go to": a screen, folder, group, view or settings page. */
  onNavigate?: ((target: string) => void) | undefined;
  /** The palette's "Search for ...": opens the results screen. */
  onSearch?: ((query: string) => void) | undefined;
  /** Text the agent bar opens with, such as a palette handoff. */
  initialAgentText?: string | undefined;
  /** The composer's Session; inert without an Agent host. */
  agent?: AgentSession | undefined;
  /** External calls parked on an approval, for the chips. */
  externalPending?: readonly ExternalPending[] | undefined;
  /** The calendar seam: the reader's invite bar and its overlap line. Absent, no bar. */
  calendar?: CalendarSource | undefined;
  /**
   * A Group lens (CONTEXT.md "Group"): only the Threads in this Group or
   * Sub-group, under the Group's name. Absent, the whole Inbox.
   */
  group?: string | undefined;
}

type RemovingKind = "archive" | "snooze" | "delete";
type ToastState = { text: string; token: UndoToken | null; id: number };
type Batch = { kind: RemovingKind | "read"; ids: string[]; until?: Date };

const defaultInbox = fixtureInbox();
const defaultComposer = fixtureComposer();

/** "needs-reply" as a heading when no strings.section.* Setting names it. */
function sectionFallbackName(id: string): string {
  const words = id.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The Messages of the open Thread, from the reader seam, fetched on open. */
function useThreadMessages(inbox: InboxData, threadId: string | null) {
  const subscribe = useCallback(
    (listener: () => void) => (threadId ? inbox.watchMessages(threadId, listener) : () => {}),
    [inbox, threadId],
  );
  const get = useCallback(
    () => (threadId ? inbox.messages(threadId) : NO_MESSAGES),
    [inbox, threadId],
  );
  const messages = useSyncExternalStore(subscribe, get, get);
  useEffect(() => {
    if (threadId) void inbox.openThread(threadId);
  }, [inbox, threadId]);
  return messages;
}
const NO_MESSAGES: readonly never[] = [];

/** The open Thread's Brief from the reader seam: the Cache's, before or after open. */
function useThreadBrief(inbox: InboxData, threadId: string | null) {
  const subscribe = useCallback(
    (listener: () => void) => (threadId ? inbox.watchMessages(threadId, listener) : () => {}),
    [inbox, threadId],
  );
  const get = useCallback(() => (threadId ? inbox.brief(threadId) : undefined), [inbox, threadId]);
  return useSyncExternalStore(subscribe, get, get);
}

/** Why the open Thread's bodies are missing, from the reader seam; null when they are not. */
function useThreadUnavailable(inbox: InboxData, threadId: string | null) {
  const subscribe = useCallback(
    (listener: () => void) => (threadId ? inbox.watchMessages(threadId, listener) : () => {}),
    [inbox, threadId],
  );
  const get = useCallback(() => (threadId ? inbox.unavailable(threadId) : null), [inbox, threadId]);
  return useSyncExternalStore(subscribe, get, get);
}

function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

export function Inbox({
  inbox = defaultInbox,
  composer = defaultComposer,
  syncing = null,
  online = true,
  now: nowProp,
  initialOpen,
  initialSelection,
  timing,
  composeRequest = 0,
  initialCompose,
  search = null,
  workspaceId: workspaceIdProp,
  onNavigate,
  onSearch,
  initialAgentText,
  agent = NULL_SESSION,
  externalPending,
  calendar,
  group,
}: InboxProps) {
  const shell = useShell();
  const ws = useWorkspace();
  const workspaceId = workspaceIdProp ?? ws.id;
  const { settings } = shell;
  const clock = useClock(settings["inbox.time_refresh_seconds"], nowProp ?? ws.now);
  const now = nowProp ?? ws.now ?? clock;
  const stream = shell.layout.list === "stream";
  // Just mail (CONTEXT.md "AI level"): no agent bar, and `/` does nothing.
  const aiOff = settings["ai.level"] === "off";
  const mac = isMac();
  const keymap = useActiveKeymap();
  const key = (action: KeyAction) => chordLabel(keymap[action], mac);

  /* ------------------------------ Data ------------------------------ */

  const allThreads = useSyncExternalStore(inbox.subscribe, inbox.threads, inbox.threads);
  const groups = useSyncExternalStore(inbox.subscribe, inbox.groups, inbox.groups);
  const tags = useSyncExternalStore(inbox.subscribe, inbox.tags, inbox.tags);
  const lens = group ? groups.find((g) => g.id === group) : undefined;
  const threads = useMemo(
    () =>
      lens ? allThreads.filter((t) => t.group === lens.id || t.subgroup === lens.id) : allThreads,
    [allThreads, lens],
  );
  const tagsOf = useCallback(
    (th: Thread): Tag[] => th.tags.flatMap((id) => tags.filter((t) => t.id === id)),
    [tags],
  );
  const collapseMs = timing?.collapse ?? (reducedMotion() ? 0 : settings["inbox.row_collapse_ms"]);
  const toastMs = timing?.toast ?? settings["inbox.undo_toast_ms"];
  const rows = useLeavingRows(threads, collapseMs);

  // The Sections are the rules in Settings (ADR 0004): the order Setting says
  // which show and in what order, a rule may hide its Section, and the heading
  // is the strings.section.<id> Setting where one exists.
  const orderedSections = useMemo(() => {
    const rules = new Map(settings["sections.rules"].map((r) => [r.id, r]));
    return settings["sections.order"].flatMap((id) => {
      if (rules.get(id)?.hidden) return [];
      const nameKey = `strings.section.${id}`;
      const name =
        nameKey in settings ? String(settings[nameKey as keyof Settings]) : sectionFallbackName(id);
      return [{ id, name, rows: rows.filter((r) => r.thread.section === id) }];
    });
  }, [rows, settings]);

  /** The list order the keyboard walks. Leaving rows are not in it. */
  const order = useMemo(
    () => orderedSections.flatMap((s) => s.rows.filter((r) => !r.leaving).map((r) => r.thread.id)),
    [orderedSections],
  );

  const fields = settings["inbox.rows"][shell.density][stream ? "stream" : "split"].join(" ");

  /* ------------------------------ UI state ------------------------------ */

  const urlSel = useMemo(
    () =>
      initialOpen !== undefined
        ? initialOpen
        : typeof location === "undefined"
          ? null
          : new URLSearchParams(location.search).get("sel"),
    [initialOpen],
  );
  const [focus, setFocus] = useState<string | null>(() => urlSel ?? order[0] ?? null);
  const [selection, setSelection] = useState<string[]>(() => {
    if (initialSelection) return [...initialSelection];
    if (typeof location === "undefined") return [];
    const multi = new URLSearchParams(location.search).get("multi");
    return multi ? multi.split(",").filter(Boolean) : [];
  });
  const [readerOpen, setReaderOpen] = useState(!stream || urlSel !== null);
  const [agentOpen, setAgentOpen] = useState(initialAgentText !== undefined);
  const [agentText, setAgentText] = useState(initialAgentText ?? "");
  // `?overlay=cmdk` opens the palette on mount, as the mock does, for the screenshot check.
  const [paletteOpen, setPaletteOpen] = useState(
    () =>
      typeof location !== "undefined" &&
      new URLSearchParams(location.search).get("overlay") === "cmdk",
  );
  const [paletteQuery, setPaletteQuery] = useState("");
  /** A palette action runs once the overlay has closed, so the key handlers see the list. */
  const pendingAction = useRef<KeyAction | null>(null);
  const [picker, setPicker] = useState<"snooze" | "move" | "more" | null>(null);
  const [pickerIds, setPickerIds] = useState<string[]>([]);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const lastToken = useRef<UndoToken | null>(null);
  const toastSeq = useRef(0);

  // The focus follows the list: a focus that left it (without an action moving
  // it first) lands on the first row.
  useEffect(() => {
    if (focus !== null && !order.includes(focus) && !inbox.thread(focus))
      setFocus(order[0] ?? null);
  }, [order, focus, inbox]);

  const thread = focus ? inbox.thread(focus) : undefined;
  const showReader = stream ? readerOpen && thread !== undefined : true;
  const openThreadId = showReader && thread ? thread.id : null;
  // The sheet slides out over the Thread it showed, so that Thread's rows are
  // held until the leave ends; the split reader never leaves.
  const readerExit = useExitValue(showReader && thread ? thread : null);
  const shownThread = readerExit.value;
  const shownThreadId = shownThread?.id ?? null;
  const messages = useThreadMessages(inbox, shownThreadId);
  const brief = useThreadBrief(inbox, shownThreadId);
  const unavailable = useThreadUnavailable(inbox, shownThreadId);
  // Back online with a Thread open: read again what the Cache still lacks.
  useEffect(() => {
    if (online && shownThreadId && unavailable === "offline") void inbox.openThread(shownThreadId);
  }, [online, shownThreadId, unavailable, inbox]);
  const batchExit = useExitValue(batch);
  const pickerExit = useExitValue(picker, "--t-fast");
  const paletteExit = useExit(paletteOpen);

  // Opening a Thread reads it (a Setting): once per open, so "mark unread"
  // from the reader's menu holds until the next Thread opens. No toast and no
  // undo token: reading is not an action to take back.
  const markReadOnOpen = settings["reader.mark_read_on_open"];
  useEffect(() => {
    if (!markReadOnOpen || openThreadId === null) return;
    if (inbox.thread(openThreadId)?.unread) void inbox.markRead([openThreadId]);
  }, [markReadOnOpen, openThreadId, inbox]);

  /* ------------------------------ Compose ------------------------------ */

  // Compose runs on the real clock unless a test pins one: a send counts down
  // from the Server's run time, never from the fixtures' day.
  const nowFn = useCallback(() => nowProp ?? new Date(), [nowProp]);
  const compose = useCompose({ composer, settings, now: nowFn });
  const cs = compose.strings;
  const overlayExit = useExitValue(compose.overlay);
  const openNew = compose.openNew;
  const openDraft = compose.openDraft;
  const lastRequest = useRef(composeRequest);
  useEffect(() => {
    if (composeRequest !== lastRequest.current) {
      lastRequest.current = composeRequest;
      openNew();
    }
  }, [composeRequest, openNew]);
  const urlCompose = useMemo(
    () =>
      initialCompose !== undefined
        ? initialCompose
        : typeof location === "undefined"
          ? null
          : new URLSearchParams(location.search).get("compose"),
    [initialCompose],
  );
  const openedFromUrl = useRef(false);
  useEffect(() => {
    if (!urlCompose || openedFromUrl.current) return;
    if (urlCompose === "reply" || urlCompose === "forward") {
      // The inline reply needs the open Thread's Messages first.
      if (!thread || messages.length === 0) return;
      openedFromUrl.current = true;
      compose.startReply(thread, messages, urlCompose);
      return;
    }
    openedFromUrl.current = true;
    if (urlCompose === "new") openNew();
    else void openDraft(urlCompose, null);
  }, [urlCompose, openNew, openDraft, thread, messages, compose]);

  /* ------------------------------ Strings ------------------------------ */

  const s = settings;
  const t = useCallback(<K extends keyof Settings>(k: K) => String(settings[k]), [settings]);

  /* ------------------------------ Actions ------------------------------ */

  const showToast = useCallback((text: string, token: UndoToken | null) => {
    lastToken.current = token;
    setToast({ text, token, id: ++toastSeq.current });
  }, []);

  const countText = useCallback(
    (text: string, n: number) =>
      n > 1 ? fill(t("strings.inbox.toast.batch"), { action: text, n }) : text,
    [t],
  );

  /**
   * After Threads leave the list: the selection advances in the Setting's
   * direction and, in the sheet, the next Thread opens or the sheet closes
   * (docs/spec/inbox.md, "After archive, snooze or delete").
   */
  const advanceAfter = useCallback(
    (ids: readonly string[]) => {
      const next = nextFocus(order, focus, ids, s["inbox.after_action.direction"]);
      setSelection([]);
      setFocus(next);
      if (stream && readerOpen && focus !== null && ids.includes(focus)) {
        if (!s["inbox.after_action.open_next"] || next === null) setReaderOpen(false);
      }
    },
    [order, focus, s, stream, readerOpen],
  );

  /** Runs one removing action on ids, advances the focus and shows the toast. */
  const remove = useCallback(
    async (kind: RemovingKind, ids: readonly string[], until?: Date) => {
      if (ids.length === 0) return;
      let token: UndoToken;
      let text: string;
      if (kind === "archive") {
        token = await inbox.archive(ids);
        text = t("strings.inbox.toast.archived");
      } else if (kind === "delete") {
        token = await inbox.delete(ids);
        text = t("strings.inbox.toast.deleted");
      } else {
        const when = until ?? now;
        token = await inbox.snooze(ids, when);
        text = fill(t("strings.inbox.toast.snoozed"), { when: formatWake(when, now) });
      }
      advanceAfter(ids);
      showToast(countText(text, ids.length), token);
    },
    [t, inbox, now, advanceAfter, showToast, countText],
  );

  /** Previews a batch above the Setting, else runs it. */
  const request = useCallback(
    (kind: RemovingKind, ids: readonly string[], until?: Date) => {
      if (ids.length === 0) return;
      if (needsPreview(ids.length, s["inbox.batch_preview_above"])) {
        setBatch(until ? { kind, ids: [...ids], until } : { kind, ids: [...ids] });
        return;
      }
      void remove(kind, ids, until);
    },
    [s, remove],
  );

  const toggleStar = useCallback(
    async (ids: readonly string[]) => {
      if (ids.length === 0) return;
      const all = ids.every((id) => inbox.thread(id)?.starred);
      const token = all ? await inbox.unstar(ids) : await inbox.star(ids);
      showToast(
        countText(
          t(all ? "strings.inbox.toast.unstarred" : "strings.inbox.toast.starred"),
          ids.length,
        ),
        token,
      );
    },
    [inbox, showToast, countText, t],
  );

  const toggleRead = useCallback(
    async (ids: readonly string[]) => {
      if (ids.length === 0) return;
      const anyUnread = ids.some((id) => inbox.thread(id)?.unread);
      const token = anyUnread ? await inbox.markRead(ids) : await inbox.markUnread(ids);
      showToast(
        countText(
          t(anyUnread ? "strings.inbox.toast.read" : "strings.inbox.toast.unread"),
          ids.length,
        ),
        token,
      );
    },
    [inbox, showToast, countText, t],
  );

  const markAllRead = useCallback(async () => {
    const ids = order.filter((id) => inbox.thread(id)?.unread);
    if (ids.length === 0) return;
    if (needsPreview(ids.length, s["inbox.batch_preview_above"])) {
      setBatch({ kind: "read", ids });
      return;
    }
    const token = await inbox.markRead(ids);
    showToast(countText(t("strings.inbox.toast.read"), ids.length), token);
  }, [order, inbox, s, t, showToast, countText]);

  const moveTo = useCallback(
    async (ids: readonly string[], groupId: string | null) => {
      if (ids.length === 0) return;
      const token = await inbox.moveToGroup(ids, groupId);
      const name = groups.find((g) => g.id === groupId)?.name ?? t("strings.inbox.move.none");
      showToast(
        countText(fill(t("strings.inbox.toast.moved"), { group: name }), ids.length),
        token,
      );
    },
    [inbox, groups, showToast, countText, t],
  );

  const undo = useCallback(async () => {
    const token = lastToken.current;
    if (!token) return;
    lastToken.current = null;
    await inbox.undo(token);
    setToast({ text: t("strings.inbox.toast.undone"), token: null, id: ++toastSeq.current });
  }, [inbox, t]);

  const applyBatch = useCallback(async () => {
    const b = batch;
    setBatch(null);
    if (!b) return;
    if (b.kind === "read") {
      const token = await inbox.markRead(b.ids);
      showToast(countText(t("strings.inbox.toast.read"), b.ids.length), token);
      return;
    }
    await remove(b.kind, b.ids, b.until);
  }, [batch, inbox, remove, showToast, countText, t]);

  const openPicker = useCallback((which: "snooze" | "move" | "more", ids: readonly string[]) => {
    if (which !== "more" && ids.length === 0) return;
    setPickerIds([...ids]);
    setPicker(which);
  }, []);
  const closePicker = useCallback(() => setPicker(null), []);

  const focusAgent = useCallback(() => {
    setAgentOpen(true);
    queueMicrotask(() => document.querySelector<HTMLInputElement>(".agent-bar input")?.focus());
  }, []);

  const startReply = useCallback(
    (kind: "reply" | "forward", replyAll?: boolean, seed?: ComposeSeed) => {
      if (!thread) return;
      setReaderOpen(true);
      compose.startReply(thread, inbox.messages(thread.id), kind, replyAll, seed);
    },
    [thread, inbox, compose],
  );

  // Action chips are tool calls (ADR 0002): reply and forward open compose and
  // never send, snooze and archive apply with Undo, a link opens outside.
  const defaultDuration = s["calendar.default_duration_minutes"];
  const actionRunner = useMemo(
    () =>
      createActionRunner({
        inbox,
        compose: (kind, _threadId, seed) => startReply(kind, undefined, seed),
        openLink: (url) => openExternal(url),
        // The chip is the user's own click, so the Event goes straight on the calendar.
        ...(calendar
          ? {
              calendar: async ({ title, start }) => {
                const startAt = new Date(start);
                await calendar.create({
                  title,
                  start: startAt.toISOString(),
                  end: new Date(startAt.getTime() + defaultDuration * 60_000).toISOString(),
                  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                });
              },
            }
          : {}),
      }),
    [inbox, startReply, calendar, defaultDuration],
  );
  const runBriefAction = useCallback(
    async (action: BriefAction) => {
      if (!thread) return;
      const outcome = await actionRunner.run(action, thread.id);
      if (!outcome.ok) {
        showToast(
          t(
            outcome.reason === "calendar_unavailable"
              ? "strings.reader.brief_action.calendar_unavailable"
              : "strings.reader.brief_action.unavailable",
          ),
          null,
        );
        return;
      }
      if (outcome.call.tool === "calendar.create_event") {
        showToast(
          fill(t("strings.reader.brief_action.calendar_added"), { title: outcome.call.args.title }),
          null,
        );
      } else if (outcome.call.tool === "thread.archive") {
        advanceAfter([thread.id]);
        showToast(t("strings.inbox.toast.archived"), outcome.undo);
      } else if (outcome.call.tool === "thread.snooze") {
        advanceAfter([thread.id]);
        showToast(
          fill(t("strings.inbox.toast.snoozed"), {
            when: formatWake(new Date(outcome.call.args.until), now),
          }),
          outcome.undo,
        );
      }
    },
    [thread, actionRunner, advanceAfter, showToast, t, now],
  );

  const openAttachment = useCallback(
    async (attachmentId: string) => {
      const all = messages.flatMap((m) => m.attachments);
      const meta = all.find((a) => a.id === attachmentId);
      try {
        const { bytes, mediaType } = await inbox.attachmentBytes(attachmentId);
        await saveDownload(meta?.name ?? attachmentId, bytes, mediaType);
      } catch {
        // Plain words, not the transport's: the toast names the file.
        compose.onError(
          fill(t("strings.reader.download_failed"), { name: meta?.name ?? attachmentId }),
        );
      }
    },
    [messages, inbox, compose, t],
  );

  const attachmentSrc = useCallback(
    async (attachmentId: string) => {
      const { bytes, mediaType } = await inbox.attachmentBytes(attachmentId);
      return URL.createObjectURL(new Blob([bytes as BlobPart], { type: mediaType }));
    },
    [inbox],
  );

  /** The `agent.ask` action: the bar opens prefilled; Enter sends it as the turn. */
  const askAgent = useCallback(
    (text: string) => {
      setAgentText(text);
      focusAgent();
    },
    [focusAgent],
  );

  const applyView = useCallback(
    (n: number) => {
      const view = s["views.list"][n - 1];
      if (!view) return;
      void shell.set("layout.nav", view.layout.nav);
      void shell.set("layout.agent", view.layout.agent);
      void shell.set("layout.list", view.layout.list);
    },
    [s, shell],
  );

  /* ------------------------------ Keys ------------------------------ */

  const pane: Pane =
    batch || picker || paletteOpen || compose.overlay
      ? "overlay"
      : agentOpen
        ? "agent"
        : showReader
          ? "reader"
          : "list";
  const ctx: KeyContext = { pane, focus, selection };
  const overlay = pane === "overlay";
  const acting = () => targets(focus, selection);

  const handlers: KeyHandlers = {
    "move.down": () => !overlay && setFocus(neighbor(order, focus, 1)),
    "move.up": () => !overlay && setFocus(neighbor(order, focus, -1)),
    "thread.open": () => !overlay && focus && setReaderOpen(true),
    "sheet.close": () => {
      if (batch) setBatch(null);
      else if (picker) setPicker(null);
      else if (paletteOpen) setPaletteOpen(false);
      else if (compose.overlay) compose.closeOverlay();
      else if (compose.reply) compose.closeReply();
      else if (agentOpen) {
        setAgentOpen(false);
        (document.activeElement as HTMLElement | null)?.blur?.();
      } else if (stream && readerOpen) setReaderOpen(false);
      else if (selection.length) setSelection([]);
    },
    "thread.archive": () => !overlay && request("archive", acting()),
    "thread.snooze": () => !overlay && openPicker("snooze", acting()),
    "thread.delete": () => !overlay && request("delete", acting()),
    "thread.star": () => !overlay && void toggleStar(acting()),
    "thread.label": () => {
      if (overlay) return false;
      setPaletteQuery(t("strings.inbox.action.label"));
      setPaletteOpen(true);
    },
    "thread.move": () => !overlay && openPicker("move", acting()),
    "compose.new": () => !overlay && compose.openNew(),
    "compose.reply": () => !overlay && focus && startReply("reply"),
    "compose.reply_all": () => !overlay && focus && startReply("reply", true),
    "compose.forward": () => !overlay && focus && startReply("forward"),
    "select.toggle": () => !overlay && focus && setSelection(toggleSelected(selection, focus)),
    "select.extend_down": () => {
      if (overlay) return false;
      const r = extendSelection(order, selection, focus, 1);
      setSelection(r.selection);
      setFocus(r.focus);
    },
    "select.extend_up": () => {
      if (overlay) return false;
      const r = extendSelection(order, selection, focus, -1);
      setSelection(r.selection);
      setFocus(r.focus);
    },
    undo: ({ typing }) => {
      // In a field the field's own undo wins (the Natural keymap binds mod+z).
      if (overlay || typing) return false;
      if (compose.pending) void compose.undo(openThreadId);
      else void undo();
    },
    "agent.focus": () => !overlay && !aiOff && focusAgent(),
    "palette.open": () => {
      setPaletteQuery("");
      setPaletteOpen((o) => !o);
    },
  };
  for (let n = 1; n <= 9; n++) handlers[`view.${n}` as KeyAction] = () => applyView(n);

  useKeymap(handlers, ctx);

  useEffect(() => {
    if (paletteOpen || pendingAction.current === null) return;
    const action = pendingAction.current;
    pendingAction.current = null;
    handlers[action]?.(ctx);
  });

  /** What a palette row does once picked. */
  const runCommand = (command: PaletteCommand) => {
    setPaletteOpen(false);
    switch (command.type) {
      case "action":
        if (isKeyAction(command.action)) pendingAction.current = command.action;
        else if (command.action === "workflow.from_thread") {
          askAgent(t("strings.palette.workflow_from_thread"));
        }
        break;
      case "navigate":
        onNavigate?.(command.target);
        break;
      case "open":
        if (inbox.thread(command.threadId)) open(command.threadId);
        else onNavigate?.(`thread:${command.threadId}`);
        break;
      case "search":
        onSearch?.(command.text);
        break;
      case "ask":
      case "suggest":
        askAgent(command.text);
        break;
    }
  };

  const handoff = (ask: AgentAsk) => {
    setPaletteOpen(false);
    askAgent(ask.text);
  };

  /* ------------------------------ Render ------------------------------ */

  function open(id: string) {
    setFocus(id);
    setReaderOpen(true);
  }
  const runtime = runtimeLine(agent.runtimeInfo, s, ws.address);
  const agentStrings = useMemo(() => composerStrings(s), [s]);
  const chips = useMemo(
    () =>
      suggestionsFor({
        settings: s,
        waiting: agent.waiting,
        external: externalPending,
        needsReply: threads.filter((th) => th.section === "needs-reply"),
      }),
    [s, agent.waiting, externalPending, threads],
  );
  /** The same chips as lines in the palette's "Ask the agent" section. */
  const paletteSuggestions = useMemo(
    () => chips.map((c, i) => ({ key: `chip-${i}`, label: c.label })),
    [chips],
  );
  /** A chip that names Layout knobs applies them here; the sentence still goes to the Agent. */
  const applySuggestionLayout = (sg: Suggestion) => {
    if (!sg.layout) return;
    if (sg.layout.nav) void shell.set("layout.nav", sg.layout.nav);
    if (sg.layout.agent) void shell.set("layout.agent", sg.layout.agent);
    if (sg.layout.list) void shell.set("layout.list", sg.layout.list);
  };
  const listTitle = lens?.name ?? t("strings.inbox.title");
  /** The row's hover actions, worded from Settings with the keymap's keys. */
  const rowTitles = {
    archive: `${t("strings.inbox.action.archive")} (${key("thread.archive")})`,
    snooze: `${t("strings.inbox.action.snooze")} (${key("thread.snooze")})`,
    ask: t("strings.inbox.action.ask"),
  };
  const headCount = selection.length
    ? fill(t("strings.inbox.selected"), { n: selection.length })
    : threads.length;

  const shownBatch = batchExit.value;
  const batchThreads = shownBatch
    ? shownBatch.ids.flatMap((id) => {
        const th = inbox.thread(id);
        return th ? [th] : [];
      })
    : [];
  const batchAction = shownBatch
    ? t(
        shownBatch.kind === "archive"
          ? "strings.inbox.action.archive"
          : shownBatch.kind === "delete"
            ? "strings.inbox.action.delete"
            : shownBatch.kind === "snooze"
              ? "strings.inbox.action.snooze"
              : "strings.inbox.action.read",
      )
    : "";

  return (
    <div
      className={`main inbox ${stream && readerExit.mounted ? "has-sheet" : ""}`}
      data-pane={pane}
    >
      <section className="col list" data-fields={fields} aria-label={listTitle}>
        <ColHead title={listTitle} count={headCount}>
          {stream ? (
            <Btn>
              <FunnelSimpleIcon /> {t("strings.inbox.filter")}
            </Btn>
          ) : null}
          <Btn icon title={t("strings.inbox.more")} onClick={() => openPicker("more", [])}>
            <DotsThreeIcon />
          </Btn>
        </ColHead>
        {pickerExit.value === "more" ? (
          <Picker
            label={t("strings.inbox.more")}
            items={[{ key: "read-all", label: t("strings.inbox.mark_all_read") }]}
            onPick={() => {
              closePicker();
              void markAllRead();
            }}
            onClose={closePicker}
            leaving={pickerExit.leaving}
            onLeft={pickerExit.onEnd}
          />
        ) : null}
        {pickerExit.value === "snooze" ? (
          <SnoozePicker
            settings={s}
            now={now}
            onSnooze={(until) => {
              closePicker();
              request("snooze", pickerIds, until);
            }}
            onClose={closePicker}
            leaving={pickerExit.leaving}
            onLeft={pickerExit.onEnd}
          />
        ) : null}
        {pickerExit.value === "move" ? (
          <Picker
            label={t("strings.inbox.move.title")}
            title={t("strings.inbox.move.title")}
            items={[
              ...groups
                .filter((g) => g.parentId === null)
                .map((g) => ({ key: g.id, label: g.name })),
              { key: "", label: t("strings.inbox.move.none") },
            ]}
            onPick={(k) => {
              closePicker();
              void moveTo(pickerIds, k === "" ? null : k);
            }}
            onClose={closePicker}
            leaving={pickerExit.leaving}
            onLeft={pickerExit.onEnd}
          />
        ) : null}
        <div className="col-body" role="listbox" aria-label={listTitle}>
          {syncing ? (
            <div
              className="sync"
              role="progressbar"
              aria-valuenow={syncing.done}
              aria-valuemax={syncing.total}
            >
              <span
                className="bar"
                style={{
                  width: `${syncing.total ? Math.min(100, (100 * syncing.done) / syncing.total).toFixed(2) : 0}%`,
                }}
              />
              {fill(t("strings.inbox.syncing"), {
                done: syncing.done.toLocaleString("en-US"),
                total: syncing.total.toLocaleString("en-US"),
              })}
            </div>
          ) : null}
          {calendar && s["calendar.today_panel"] ? (
            <StreamTodayPanel calendar={calendar} now={now} settings={settings} />
          ) : null}
          {rows.length === 0 && !syncing ? (
            <div className="empty-line">{t("strings.inbox.empty")}</div>
          ) : null}
          {orderedSections.map((sec) =>
            sec.rows.length === 0 ? null : (
              <Fragment key={sec.id}>
                <SectionLabel className={sec.rows.every((r) => r.leaving) ? "leaving" : undefined}>
                  {sec.name}
                </SectionLabel>
                {sec.rows.map(({ thread: th, leaving }) => (
                  <MessageRow
                    key={th.id}
                    thread={th}
                    tags={tagsOf(th)}
                    selected={th.id === focus}
                    className={
                      [selection.includes(th.id) && "picked", leaving && "leaving"]
                        .filter(Boolean)
                        .join(" ") || undefined
                    }
                    now={now}
                    titles={rowTitles}
                    onOpen={open}
                    onArchive={(id) => request("archive", [id])}
                    onSnooze={(id) => openPicker("snooze", [id])}
                    onAsk={() => {
                      setFocus(th.id);
                      focusAgent();
                    }}
                  />
                ))}
              </Fragment>
            ),
          )}
        </div>
      </section>

      {shownThread ? (
        <Reader
          banner={
            calendar ? (
              <ThreadInviteBar calendar={calendar} threadId={shownThread.id} settings={settings} />
            ) : null
          }
          thread={shownThread}
          messages={messages}
          brief={brief}
          tags={tagsOf(shownThread)}
          sheet={stream}
          leaving={readerExit.leaving}
          onLeft={readerExit.onEnd}
          now={now}
          collapseQuoted={s["reader.collapse_quoted"]}
          messageStrings={{
            showQuoted: t("strings.reader.show_quoted"),
            hideQuoted: t("strings.reader.hide_quoted"),
            showImages: t("strings.reader.show_images"),
            loading:
              unavailable === "offline"
                ? t("strings.reader.offline_body")
                : unavailable === "locked"
                  ? t("strings.reader.locked")
                  : unavailable === "failed"
                    ? t("strings.reader.body_failed")
                    : t("strings.reader.loading"),
          }}
          onReply={startReply}
          onBriefAction={(action) => void runBriefAction(action)}
          onOpenAttachment={(id) => void openAttachment(id)}
          onOpenLink={(href) => void openExternal(href)}
          attachmentSrc={attachmentSrc}
          reply={
            compose.reply && compose.reply.threadId === shownThread.id ? (
              <ReplyCompose
                key={compose.reply.draftId}
                composer={composer}
                draftId={compose.reply.draftId}
                initial={compose.reply.initial}
                recipient={
                  messages[messages.length - 1]?.from.name ??
                  shownThread.participants[0]?.name ??
                  ""
                }
                strings={cs}
                idleMs={compose.idleMs}
                delaySeconds={compose.delaySeconds}
                replyAll={compose.reply.replyAll}
                onReplyAll={compose.setReplyAll}
                onForward={() => startReply("forward")}
                originalAttachments={
                  compose.reply.kind === "forward"
                    ? (compose.reply.last?.attachments ?? []).map((a) => ({
                        blobId: `att:${a.id}`,
                        name: a.name,
                        size: a.size,
                        mediaType: a.mediaType,
                      }))
                    : []
                }
                onDraft={focusAgent}
                onSent={compose.onSent}
                onError={compose.onError}
              />
            ) : undefined
          }
          strings={{
            replyTo: t("strings.compose.reply_to"),
            send: t("strings.compose.send"),
            draftReply: t("strings.compose.draft_reply"),
            attach: t("strings.compose.attach"),
            replyAll: t("strings.compose.reply_all"),
            forward: t("strings.compose.forward"),
            close: t("strings.inbox.action.close"),
            archive: t("strings.inbox.action.archive"),
            snooze: t("strings.inbox.action.snooze"),
            move: t("strings.inbox.action.move"),
            delete: t("strings.inbox.action.delete"),
            ask: t("strings.inbox.action.ask"),
            more: t("strings.inbox.more"),
            star: t("strings.inbox.action.star"),
            unstar: t("strings.inbox.action.unstar"),
            read: t("strings.inbox.action.read"),
            unread: t("strings.inbox.action.unread"),
            message: t("strings.reader.message"),
            messages: t("strings.reader.messages"),
            briefSource: fill(t("strings.reader.brief_source"), { runtime }),
            briefUpdating: t("strings.reader.brief_updating"),
          }}
          keys={{
            archive: key("thread.archive"),
            snooze: key("thread.snooze"),
            delete: key("thread.delete"),
            close: key("sheet.close"),
          }}
          onClose={() => setReaderOpen(false)}
          onAsk={focusAgent}
          onArchive={() => request("archive", [shownThread.id])}
          onSnooze={() => openPicker("snooze", [shownThread.id])}
          onMove={() => openPicker("move", [shownThread.id])}
          onDelete={() => request("delete", [shownThread.id])}
          onStar={() => void toggleStar([shownThread.id])}
          onToggleRead={() => void toggleRead([shownThread.id])}
        />
      ) : !stream ? (
        // The split list with nothing to open (an empty Inbox): the mock's empty reader.
        <section className="col reader" aria-label={t("strings.reader.empty_title")}>
          <div className="empty">
            <h3>{t("strings.reader.empty_title")}</h3>
            <p>
              {t("strings.reader.empty_help")
                .split(/(\{down\}|\{up\})/)
                .map((part, i) =>
                  part === "{down}" || part === "{up}" ? (
                    <Kbd key={`${part}-${i}`}>
                      {key(part === "{down}" ? "move.down" : "move.up")}
                    </Kbd>
                  ) : (
                    <Fragment key={`${part}-${i}`}>{part}</Fragment>
                  ),
                )}
            </p>
          </div>
        </section>
      ) : null}

      {shell.layout.agent === "bottom" && !aiOff ? (
        <AgentComposer
          agent={agent}
          mode="bottom"
          runtime={runtime}
          strings={agentStrings}
          suggestions={chips}
          now={now}
          open={agentOpen}
          onOpenChange={setAgentOpen}
          placeholder={
            !online
              ? t("strings.agent.offline")
              : agentOpen
                ? t("strings.agent.placeholder_open")
                : t("strings.agent.placeholder")
          }
          text={agentText}
          onTextChange={setAgentText}
          onOpenThread={(id) => {
            if (inbox.thread(id)) open(id);
            else onNavigate?.(`thread:${id}`);
          }}
          onSuggest={applySuggestionLayout}
        />
      ) : null}

      {compose.pending ? (
        <UndoBar
          key={compose.pending.sendId}
          runAt={compose.pending.runAt}
          later={compose.pending.later}
          stayMs={toastMs}
          now={nowFn}
          strings={cs.undo}
          undoKey={key("undo")}
          onUndo={() => void compose.undo(openThreadId)}
          onElapsed={compose.elapsed}
        />
      ) : compose.notice ? (
        <Toast
          key={`n${compose.notice.id}`}
          text={compose.notice.text}
          undoLabel={t("strings.inbox.undo")}
          undoKey={key("undo")}
          ms={toastMs}
          onExpire={compose.clearNotice}
        />
      ) : toast ? (
        <Toast
          key={toast.id}
          text={toast.text}
          undoLabel={t("strings.inbox.undo")}
          undoKey={key("undo")}
          ms={toastMs}
          onUndo={toast.token ? () => void undo() : undefined}
          onExpire={() => setToast((cur) => (cur?.id === toast.id ? null : cur))}
        />
      ) : null}

      {overlayExit.value ? (
        <ComposeOverlay
          key={overlayExit.value.draftId}
          composer={composer}
          draftId={overlayExit.value.draftId}
          initial={overlayExit.value.initial}
          strings={cs}
          idleMs={compose.idleMs}
          delaySeconds={compose.delaySeconds}
          laterPresetsHours={compose.laterPresetsHours}
          now={nowFn}
          onClose={compose.closeOverlay}
          onSent={compose.onSent}
          onError={compose.onError}
          leaving={overlayExit.leaving}
          onLeft={overlayExit.onEnd}
        />
      ) : null}

      {batchExit.value ? (
        <BatchPreview
          title={fill(t("strings.inbox.batch.title"), {
            action: batchAction,
            n: batchExit.value.ids.length,
          })}
          threads={batchThreads}
          applyLabel={t("strings.inbox.batch.apply")}
          cancelLabel={t("strings.inbox.batch.cancel")}
          onApply={() => void applyBatch()}
          onCancel={() => setBatch(null)}
          leaving={batchExit.leaving}
          onLeft={batchExit.onEnd}
        />
      ) : null}

      {paletteExit.mounted ? (
        <Palette
          query={paletteQuery}
          onQuery={setPaletteQuery}
          onClose={() => setPaletteOpen(false)}
          leaving={paletteExit.leaving}
          onLeft={paletteExit.onEnd}
          keymap={keymap}
          search={search}
          workspaceId={workspaceId}
          recentThreads={allThreads.slice(0, 20)}
          groups={groups}
          suggestions={paletteSuggestions}
          now={now}
          onCommand={runCommand}
          onAsk={handoff}
        />
      ) : null}
    </div>
  );
}
