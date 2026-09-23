// The inbox screen: the stream or split list, the reader, the agent dock, and
// every triage behavior from docs/spec/inbox.md that needs no Server. Reads
// Threads through InboxSource and acts through InboxActions (screens/inbox/
// actions.ts); the Store implements both. Compose (the overlay, the inline
// reply, the undo bar) runs through the Composer seam (screens/compose).

import type {
  BriefAction,
  CustomActionSetting,
  EventPreview,
  ExternalPending,
  Settings,
  Tag,
  Thread,
  TypedIntent,
} from "@monday/shared";
import { customActionsFor, isSettingKey, orderedSectionRules, sectionLabel } from "@monday/shared";
import {
  Btn,
  ColHead,
  Kbd,
  MessageRow,
  personName,
  type Suggestion,
  ToolCard,
  VirtualList,
} from "@monday/ui";
import { DotsThreeIcon, FunnelSimpleIcon, MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Composer as AgentComposer, composerStrings, PreviewView } from "../agent/Composer.tsx";
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
import type { OlderMail, PullProgress, SearchHit, SearchModule } from "../search/index.ts";
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
import { type ComposeSeed, createActionRunner, judgedChips } from "./inbox/brief-actions.ts";
import { createCustomActionRunner, customActionTier } from "./inbox/custom-actions.ts";
import type { FolderKey } from "./inbox/folders.ts";
import { useHeldSections } from "./inbox/held-sections.ts";
import { StreamTodayPanel, ThreadInviteBar } from "./inbox/InviteBar.tsx";
import {
  contactsOf,
  describeIntent,
  eventCall,
  eventPreviewOf,
  type IntentJudge,
  targetsOf,
} from "./inbox/intents.ts";
import { Picker } from "./inbox/Picker.tsx";
import { Reader, type ReaderAction } from "./inbox/Reader.tsx";
import { SnoozePicker } from "./inbox/SnoozePicker.tsx";
import { formatWake, snoozeKnobs, snoozeUntil } from "./inbox/snooze.ts";
import {
  filterKeeps,
  localSearch,
  STREAM_FILTERS,
  type StreamFilter,
  searchTerms,
} from "./inbox/stream-filter.ts";
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
import { type DisplayRow, reducedMotion, useLeavingRows } from "./inbox/useLeaving.ts";
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
  /**
   * The palette's "Search for ...". The search now runs inline in the list
   * header, so the Inbox no longer calls it.
   * @deprecated the inline search handles it; kept for callers that pass it.
   */
  onSearch?: ((query: string) => void) | undefined;
  /**
   * Opens the inline search: each change (a counter the nav's Search, the
   * palette or a shortcut bumps) focuses the list header's search field and
   * selects its text.
   */
  searchRequest?: number | undefined;
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
  /**
   * A Section lens (CONTEXT.md "Section rule", a Section placed in the nav):
   * only the Threads under this Section, under its name. Absent, the whole
   * Inbox, where a Section placed only in the nav shows no heading.
   */
  section?: string | undefined;
  /**
   * A Mail folder lens (Starred, Snoozed, Sent, Archive): the stream over
   * the folder's Threads instead of the Inbox's, one list with no Section
   * headings, under the folder's name with its own empty line; Snoozed rows
   * say when they wake. Absent, the Inbox.
   */
  folder?: FolderKey | undefined;
  /**
   * The judge behind the palette's typed sentences (slice 27, ADR 0012).
   * Absent, or answering null, the palette behaves as before.
   */
  judge?: IntentJudge | null | undefined;
}

type RemovingKind = "archive" | "snooze" | "delete";
/** One row of the virtual list. */
interface ListItem {
  key: string;
  row: DisplayRow;
}
/** The search's "search older mail" pull in flight. */
type Pull = { older: OlderMail; progress: PullProgress | null; error: string | null };

/**
 * The Filter menu's choice per View (the list's lens) of one mailbox, for
 * the session: not a Setting (docs/spec/inbox.md), and it outlives a
 * remount of the screen.
 */
const filtersByInbox = new WeakMap<object, Map<string, StreamFilter>>();
function filtersOf(inbox: object): Map<string, StreamFilter> {
  let m = filtersByInbox.get(inbox);
  if (!m) {
    m = new Map();
    filtersByInbox.set(inbox, m);
  }
  return m;
}
type ToastState = { text: string; token: UndoToken | null; id: number };
type Batch = { kind: RemovingKind | "read"; ids: string[]; until?: Date };
/** The scheduling card a typed sentence opened in the composer, without a Session (slice 27). */
type IntentCard = {
  id: string;
  intent: TypedIntent;
  preview: EventPreview;
  status: "waiting" | "running" | "done" | "failed";
  result?: string | undefined;
};

const defaultInbox = fixtureInbox();
const NO_THREADS: readonly Thread[] = [];

/** A snoozed row says when it wakes, ahead of its snippet (strings.folder.snoozed.wakes). */
function wakeSnippet(thread: Thread, settings: Settings, now: Date): Thread {
  if (!thread.snoozedUntil) return thread;
  const when = formatWake(new Date(thread.snoozedUntil), now);
  const wakes = fill(String(settings["strings.folder.snoozed.wakes"]), { when });
  return { ...thread, snippet: thread.snippet ? `${wakes} · ${thread.snippet}` : wakes };
}
const defaultComposer = fixtureComposer();

/** A Section's heading: the rule's own name, the strings.section.<id> Setting, or the id in words. */
function sectionName(settings: Settings, rule: { id: string; name?: string | undefined }): string {
  const key = `strings.section.${rule.id}`;
  return sectionLabel(
    rule as Parameters<typeof sectionLabel>[0],
    isSettingKey(key) ? String(settings[key]) : undefined,
  );
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

/** The open Thread's Judgments from the Cache (slice 25); they change with the stream, not the reader. */
function useThreadJudgments(inbox: InboxData, threadId: string | null) {
  const get = useCallback(
    () => (threadId ? inbox.judgments?.(threadId) : undefined),
    [inbox, threadId],
  );
  return useSyncExternalStore(inbox.subscribe, get, get);
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

const activityOf = (t: Thread) => {
  const ms = Date.parse(t.lastActivity);
  return Number.isNaN(ms) ? 0 : ms;
};
/** Newest activity first, stable; the list itself when it already is. */
function newestFirst(list: readonly Thread[]): readonly Thread[] {
  for (let i = 1; i < list.length; i++) {
    if (activityOf(list[i] as Thread) > activityOf(list[i - 1] as Thread)) {
      return [...list].sort((a, b) => activityOf(b) - activityOf(a));
    }
  }
  return list;
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
  onSearch: _onSearch,
  searchRequest = 0,
  initialAgentText,
  agent = NULL_SESSION,
  externalPending,
  calendar,
  group,
  section,
  folder,
  judge,
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

  // A folder lens reads its own query (inbox/folders.ts); the Inbox reads every Thread.
  const streamOf = useCallback(
    () => (folder ? (inbox.folder?.(folder) ?? NO_THREADS) : inbox.threads()),
    [inbox, folder],
  );
  const liveThreads = useSyncExternalStore(inbox.subscribe, streamOf, streamOf);
  // A row stays in the Section it was rendered in until the stream is rebuilt
  // (inbox/held-sections.ts): opening a Thread reads it, and reading must not
  // move it under the cursor. The rows under the cursor survive even a rebuild.
  const cursor = useRef<{ focus: string | null; open: string | null; selection: string[] }>({
    focus: null,
    open: null,
    selection: [],
  });
  const allThreads = useHeldSections(
    liveThreads,
    [inbox, group, section, folder, settings["sections.rules"], settings["sections.order"]],
    () => {
      const c = cursor.current;
      return new Set([c.focus, c.open, ...c.selection].filter((id): id is string => id !== null));
    },
  );
  const groups = useSyncExternalStore(inbox.subscribe, inbox.groups, inbox.groups);
  const tags = useSyncExternalStore(inbox.subscribe, inbox.tags, inbox.tags);
  const lens = group ? groups.find((g) => g.id === group) : undefined;
  const sectionLens = useMemo(() => {
    if (!section) return undefined;
    const rule = settings["sections.rules"].find((r) => r.id === section);
    return rule
      ? { id: rule.id, name: sectionName(settings, rule) }
      : { id: section, name: section };
  }, [section, settings]);
  const threads = useMemo(() => {
    const list = lens
      ? allThreads.filter((t) => t.group === lens.id || t.subgroup === lens.id)
      : sectionLens
        ? allThreads.filter((t) => t.section === sectionLens.id)
        : allThreads;
    // A folder keeps its own order (Snoozed wakes soonest first) and shows the wake time.
    if (folder === "snoozed") return list.map((t) => wakeSnippet(t, settings, now));
    if (folder) return list;
    return newestFirst(list);
  }, [allThreads, lens, sectionLens, folder, settings, now]);
  const tagsOf = useCallback(
    (th: Thread): Tag[] => th.tags.flatMap((id) => tags.filter((t) => t.id === id)),
    [tags],
  );
  const collapseMs = timing?.collapse ?? (reducedMotion() ? 0 : settings["inbox.row_collapse_ms"]);
  const toastMs = timing?.toast ?? settings["inbox.undo_toast_ms"];
  const rows = useLeavingRows(threads, collapseMs);

  /* ------------------------------ Filter and search ------------------------------ */

  // The Filter menu narrows the visible Sections (or the search results) to
  // one kind of Thread; Esc or Clear lifts it. Per View, for the session.
  const viewKey = `${group ?? ""}|${section ?? ""}|${folder ?? ""}`;
  const [filterState, setFilterState] = useState<{ view: string; filter: StreamFilter | null }>(
    () => ({ view: viewKey, filter: filtersOf(inbox).get(viewKey) ?? null }),
  );
  const filter =
    filterState.view === viewKey ? filterState.filter : (filtersOf(inbox).get(viewKey) ?? null);
  const setFilter = useCallback(
    (next: StreamFilter | null) => {
      if (next) filtersOf(inbox).set(viewKey, next);
      else filtersOf(inbox).delete(viewKey);
      setFilterState({ view: viewKey, filter: next });
    },
    [viewKey, inbox],
  );
  // A Thread shown under the filter stays until the filter changes, so
  // reading it under "Unread" does not pull it from under the cursor.
  const filterShown = useRef<{ key: string; ids: Set<string> }>({ key: "", ids: new Set() });
  const filterKey = `${viewKey}|${filter ?? ""}`;
  if (filterShown.current.key !== filterKey)
    filterShown.current = { key: filterKey, ids: new Set() };
  const keeps = useCallback(
    (th: Thread) => {
      if (!filter) return true;
      const shown = filterShown.current.ids;
      if (shown.has(th.id)) return true;
      if (!filterKeeps(filter, th, inbox.judgments?.(th.id))) return false;
      shown.add(th.id);
      return true;
    },
    [filter, inbox],
  );

  // The inline search: the field in the list header runs the Cache search
  // (ADR 0011) as the user types, and the results replace the Sections with
  // one ranked list; clearing it puts the stream back where it was.
  const [searchText, setSearchText] = useState("");
  const searching = searchText.trim() !== "";
  const [hits, setHits] = useState<readonly SearchHit[] | null>(null);
  const [older, setOlder] = useState<readonly OlderMail[]>([]);
  const [pull, setPull] = useState<Pull | null>(null);
  const searchSeq = useRef(0);
  const searchLimit = settings["search.results_limit"];
  const runSearch = useCallback(async () => {
    const mine = ++searchSeq.current;
    if (!search || !searchText.trim()) return;
    try {
      const r = await search.search(searchText, {
        workspace: workspaceId,
        limit: searchLimit,
        ...(nowProp ? { now: nowProp } : {}),
      });
      if (mine !== searchSeq.current) return;
      setHits(r.hits);
      setOlder(r.older);
    } catch {
      if (mine === searchSeq.current) setHits([]);
    }
  }, [search, searchText, workspaceId, searchLimit, nowProp]);
  useEffect(() => {
    if (!searching) {
      searchSeq.current++;
      setHits(null);
      setOlder([]);
      setPull(null);
      return;
    }
    void runSearch();
  }, [searching, runSearch]);
  const pullOlder = useCallback(
    async (o: OlderMail) => {
      if (!search) return;
      setPull({ older: o, progress: { done: 0, total: o.missing }, error: null });
      try {
        await search.pullOlder(o, (p) => {
          setPull({ older: o, progress: p, error: null });
          void runSearch();
        });
        setPull(null);
        await runSearch();
      } catch (error) {
        const message =
          error instanceof Error && /423|locked/i.test(error.message)
            ? String(settings["strings.search.older_locked"])
            : error instanceof Error
              ? error.message
              : String(error);
        setPull({ older: o, progress: null, error: message });
      }
    },
    [search, runSearch, settings],
  );
  const highlight = useMemo(
    () => (searching ? searchTerms(searchText) : undefined),
    [searching, searchText],
  );
  const liveById = useMemo(() => new Map(allThreads.map((th) => [th.id, th])), [allThreads]);
  /** The results as rows: the live Thread where the list has it, the hit's passage as its snippet. */
  const searchRows = useMemo<DisplayRow[] | null>(() => {
    if (!searching) return null;
    const found: Thread[] = search
      ? (hits ?? []).map((h) => {
          const live = liveById.get(h.thread.id) ?? inbox.thread(h.thread.id) ?? h.thread;
          return h.snippet ? { ...live, snippet: h.snippet } : live;
        })
      : localSearch(allThreads, searchText);
    return found.filter(keeps).map((th) => ({ thread: th, leaving: false }));
  }, [searching, search, hits, liveById, inbox, allThreads, searchText, keeps]);

  // The Inbox is one plain list, newest activity first (docs/spec/inbox.md,
  // Stream): no Section headings, nothing reordered by Groups or Sections.
  // Sections are nav entries; a Section lens shows that Section's Threads as
  // their own list. The Filter menu and the search narrow whichever list is
  // shown; a search replaces it with the ranked results.
  const items = useMemo<ListItem[]>(() => {
    const shown = searchRows ?? rows.filter((r) => r.leaving || keeps(r.thread));
    return shown.map((row) => ({ key: row.thread.id, row }));
  }, [searchRows, rows, keeps]);

  /** The Sections the palette may name: every rule not hidden, in the user's order (they all live in the nav). */
  const sectionOptions = useMemo(
    () =>
      orderedSectionRules(settings["sections.rules"], settings["sections.order"])
        .filter((r) => !r.hidden)
        .map((r) => ({ id: r.id, name: sectionName(settings, r) })),
    [settings],
  );

  /** The list order the keyboard walks. Leaving rows are not in it. */
  const order = useMemo(
    () => items.flatMap((it) => (it.row.leaving ? [] : [it.row.thread.id])),
    [items],
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
  // `?overlay=filter` opens the Filter menu on mount, as the mock does, for the screenshot check.
  const [picker, setPicker] = useState<"snooze" | "move" | "more" | "filter" | null>(() =>
    typeof location !== "undefined" &&
    new URLSearchParams(location.search).get("overlay") === "filter"
      ? "filter"
      : null,
  );
  const [pickerIds, setPickerIds] = useState<string[]>([]);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [intentCard, setIntentCard] = useState<IntentCard | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const lastToken = useRef<UndoToken | null>(null);
  const toastSeq = useRef(0);

  // The focus follows the list: a focus that left it (without an action moving
  // it first) lands on the first row.
  useEffect(() => {
    if (focus !== null && !order.includes(focus) && !inbox.thread(focus))
      setFocus(order[0] ?? null);
  }, [order, focus, inbox]);

  // Search keeps the stream's place: the focus and the multi-select are put
  // aside when a query starts and come back when it clears (the list's own
  // scroll position comes back through the VirtualList's scrollKey). While
  // searching, the focus sits on the best result.
  const searchInput = useRef<HTMLInputElement>(null);
  const beforeSearch = useRef<{ focus: string | null; selection: string[] } | null>(null);
  const wasSearching = useRef(false);
  useEffect(() => {
    if (searching && !wasSearching.current) {
      beforeSearch.current = { focus, selection };
      setSelection([]);
    } else if (!searching && wasSearching.current && beforeSearch.current) {
      setFocus(beforeSearch.current.focus);
      setSelection(beforeSearch.current.selection);
      beforeSearch.current = null;
    }
    wasSearching.current = searching;
  }, [searching, focus, selection]);
  useEffect(() => {
    if (searching && order.length > 0 && (focus === null || !order.includes(focus))) {
      setFocus(order[0] ?? null);
    }
  }, [searching, order, focus]);
  const openSearch = useCallback((text?: string) => {
    if (text !== undefined) setSearchText(text);
    queueMicrotask(() => {
      searchInput.current?.focus();
      searchInput.current?.select();
    });
  }, []);
  const closeSearch = useCallback(() => {
    setSearchText("");
    searchInput.current?.blur();
  }, []);
  const lastSearchRequest = useRef(searchRequest);
  useEffect(() => {
    if (searchRequest === lastSearchRequest.current) return;
    lastSearchRequest.current = searchRequest;
    openSearch();
  }, [searchRequest, openSearch]);

  const thread = focus ? inbox.thread(focus) : undefined;
  const showReader = stream ? readerOpen && thread !== undefined : true;
  const openThreadId = showReader && thread ? thread.id : null;
  cursor.current = { focus, open: openThreadId, selection };
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

  const openPicker = useCallback(
    (which: "snooze" | "move" | "more" | "filter", ids: readonly string[]) => {
      if (which !== "more" && which !== "filter" && ids.length === 0) return;
      setPickerIds([...ids]);
      setPicker(which);
    },
    [],
  );
  const closePicker = useCallback(() => setPicker(null), []);

  const focusAgent = useCallback(() => {
    setAgentOpen(true);
    queueMicrotask(() => document.querySelector<HTMLTextAreaElement>(".agent-bar textarea")?.focus());
  }, []);

  const startReply = useCallback(
    (kind: "reply" | "forward", replyAll?: boolean, seed?: ComposeSeed) => {
      if (!thread) return;
      setReaderOpen(true);
      compose.startReply(thread, inbox.messages(thread.id), kind, replyAll, seed);
    },
    [thread, inbox, compose],
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
  // Action chips are tool calls (ADR 0002): reply and forward open compose and
  // never send, snooze and archive apply with Undo, a link opens outside; the
  // judged chips (slice 25) hand the agent bar a sentence or open an attachment.
  const defaultDuration = s["calendar.default_duration_minutes"];
  const callPrompt = t("strings.chips.call_prompt");
  const payOrFilePrompt = t("strings.chips.pay_or_file_prompt");
  const actionRunner = useMemo(
    () =>
      createActionRunner({
        inbox,
        compose: (kind, _threadId, seed) => startReply(kind, undefined, seed),
        openLink: (url) => openExternal(url),
        openAttachment: (attachmentId) => openAttachment(attachmentId),
        ask: (_threadId, intent) => askAgent(intent === "call" ? callPrompt : payOrFilePrompt),
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
    [
      inbox,
      startReply,
      calendar,
      defaultDuration,
      openAttachment,
      askAgent,
      callPrompt,
      payOrFilePrompt,
    ],
  );
  // The chips the Thread's Judgments earn before its Brief exists (slice 25):
  // above the threshold, likeliest first, capped like a Brief's own chips.
  const judgments = useThreadJudgments(inbox, shownThreadId);
  const chipLabels = useMemo(
    () => ({
      reply: t("strings.chips.reply"),
      call: t("strings.chips.call"),
      review_link: t("strings.chips.review_link"),
      open_attachment: t("strings.chips.open_attachment"),
      pay_or_file: t("strings.chips.pay_or_file"),
      snooze: t("strings.chips.snooze"),
    }),
    [t],
  );
  const chipThreshold = s["chips.threshold"];
  const chipsMax = s["briefs.actions_max"];
  const judgedChipList = useMemo(() => {
    if (!judgments) return [];
    const newest = messages[messages.length - 1];
    const link = newest?.bodyText?.match(/https?:\/\/[^\s<>"')\]]+/)?.[0] ?? null;
    const attachmentId = messages.flatMap((m) => m.attachments).find((a) => !a.inline)?.id ?? null;
    const snoozeAt = snoozeUntil("tomorrow-morning", now, snoozeKnobs(s));
    return judgedChips(judgments, {
      threshold: chipThreshold,
      max: chipsMax,
      labels: chipLabels,
      link,
      attachmentId,
      snoozeUntil: snoozeAt ? snoozeAt.toISOString() : null,
    });
  }, [judgments, messages, now, s, chipThreshold, chipsMax, chipLabels]);
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

  // Custom actions (CONTEXT.md "Custom action"): the buttons defined for this
  // Thread's Group or Section, or where a judge statement holds, each an
  // ordinary tool call with its Tier. A forward opens compose and never
  // sends; a reversible tool runs with Undo; one that asks confirms first.
  const customActions = s["actions.custom"];
  const alwaysAsk = s["agent.always_ask"];
  const judgeThreshold = s["sections.judge_threshold"];
  const groupNames = useMemo(() => Object.fromEntries(groups.map((g) => [g.id, g.name])), [groups]);
  const threadActions = useMemo<Array<{ action: CustomActionSetting; reader: ReaderAction }>>(
    () =>
      thread
        ? customActionsFor(customActions, thread, {
            groupNames,
            judged: inbox.judged?.(thread.id),
            judgeThreshold,
          }).map((action) => ({
            action,
            reader: {
              id: action.id,
              label: action.label,
              tier: customActionTier(action, alwaysAsk),
            },
          }))
        : [],
    [thread, customActions, groupNames, inbox, judgeThreshold, alwaysAsk],
  );
  const customRunner = useMemo(
    () =>
      createCustomActionRunner({
        inbox,
        compose: (kind, _threadId, seed) => startReply(kind, undefined, seed),
        groups: () => groups,
        tags: () => tags,
      }),
    [inbox, startReply, groups, tags],
  );
  const [confirming, setConfirming] = useState<{ id: string; threadId: string } | null>(null);
  const runCustomAction = useCallback(
    async (actionId: string) => {
      if (!thread) return;
      const entry = threadActions.find((a) => a.action.id === actionId);
      if (!entry) return;
      const { action, reader } = entry;
      const handsToCompose = action.tool === "forward_thread" || action.tool === "draft_message";
      // An always-ask action that does not go through compose confirms on a second click.
      if (reader.tier === "always-ask" && !handsToCompose) {
        if (!(confirming?.id === actionId && confirming.threadId === thread.id)) {
          setConfirming({ id: actionId, threadId: thread.id });
          showToast(fill(t("strings.actions.toast.confirm"), { label: action.label }), null);
          return;
        }
        setConfirming(null);
      }
      const outcome = await customRunner.run(action, thread);
      if (!outcome.ok) {
        showToast(fill(t("strings.actions.toast.unavailable"), { label: action.label }), null);
        return;
      }
      if (outcome.handed === "compose") return;
      if (
        action.tool === "archive_threads" ||
        action.tool === "snooze_threads" ||
        action.tool === "trash_threads"
      ) {
        advanceAfter([thread.id]);
      }
      showToast(fill(t("strings.actions.toast.done"), { label: action.label }), outcome.undo);
    },
    [thread, threadActions, confirming, customRunner, advanceAfter, showToast, t],
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
      else if (document.activeElement === searchInput.current && searchInput.current) closeSearch();
      else if (compose.reply) compose.closeReply();
      else if (agentOpen) {
        setAgentOpen(false);
        (document.activeElement as HTMLElement | null)?.blur?.();
      } else if (stream && readerOpen) setReaderOpen(false);
      else if (searching) closeSearch();
      else if (selection.length) setSelection([]);
      else if (filter) setFilter(null);
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
        openSearch(command.text);
        break;
      case "ask":
      case "suggest":
        askAgent(command.text);
        break;
      case "intent":
        runIntent(command.intent);
        break;
    }
  };

  const handoff = (ask: AgentAsk) => {
    setPaletteOpen(false);
    askAgent(ask.text);
  };

  /* ------------------------------ Typed sentences (slice 27) ------------------------------ */

  /** The contacts a sentence may name: the composer's, else the list's participants, by recency. */
  const contacts = useMemo(
    () => contactsOf(composer.participants(), allThreads, s["intent.contacts_max"]),
    [composer, allThreads, s],
  );
  /** The intent in the user's words, with how many Threads it names in this list. */
  const describe = useCallback(
    (intent: TypedIntent) =>
      describeIntent(intent, targetsOf(intent, threads, focus).length, s, now),
    [threads, focus, s, now],
  );

  /** The scheduling card: the composer's own card with the arguments filled, no Session behind it. */
  const openIntentCard = useCallback(
    (intent: TypedIntent) => {
      // The card lives in the bottom composer this screen owns; in a column
      // Layout the Agent's own scheduling tool shows the same card, with a Session.
      if (shell.layout.agent !== "bottom") {
        askAgent(intent.text);
        return;
      }
      setIntentCard({
        id: `intent-${Date.now()}`,
        intent,
        preview: eventPreviewOf(intent, s, now),
        status: "waiting",
      });
      setAgentOpen(true);
    },
    [s, now, shell.layout.agent, askAgent],
  );

  const approveIntentCard = useCallback(async () => {
    const card = intentCard;
    if (card?.status !== "waiting") return;
    if (!calendar) {
      // No calendar seam on this Device: the Agent has the tool and asks the same way.
      setIntentCard(null);
      askAgent(card.intent.text);
      return;
    }
    setIntentCard({ ...card, status: "running" });
    try {
      const link = s["calendar.meeting_link"];
      await calendar.create({
        title: card.preview.title,
        start: card.preview.start,
        end: card.preview.end,
        timeZone: card.preview.timeZone,
        attendees: card.preview.attendees,
        ...(link === "provider" ? {} : { meetingLink: link }),
      });
      setIntentCard({ ...card, status: "done", result: t("strings.agent.applied") });
      showToast(
        fill(t("strings.reader.brief_action.calendar_added"), { title: card.preview.title }),
        null,
      );
    } catch (error) {
      setIntentCard({
        ...card,
        status: "failed",
        result: error instanceof Error ? error.message : String(error),
      });
    }
  }, [intentCard, calendar, askAgent, s, t, showToast]);

  /** What a typed sentence does once its row is picked: by Tier (ADR 0002), through the same actions as a key. */
  const runIntent = useCallback(
    (intent: TypedIntent) => {
      const ids = targetsOf(intent, threads, focus);
      switch (intent.kind) {
        case "archive":
          request("archive", ids);
          return;
        case "snooze":
          if (intent.when) request("snooze", ids, intent.when);
          else openPicker("snooze", ids);
          return;
        case "star":
          if (ids.length === 0) return;
          void inbox.star(ids).then((token) => {
            showToast(countText(t("strings.inbox.toast.starred"), ids.length), token);
          });
          return;
        case "mark_read": {
          const unread = ids.filter((id) => inbox.thread(id)?.unread);
          if (unread.length === 0) return;
          if (needsPreview(unread.length, s["inbox.batch_preview_above"])) {
            setBatch({ kind: "read", ids: unread });
            return;
          }
          void inbox.markRead(unread).then((token) => {
            showToast(countText(t("strings.inbox.toast.read"), unread.length), token);
          });
          return;
        }
        case "move":
          if (intent.group) void moveTo(ids, intent.group.id);
          else openPicker("move", ids);
          return;
        case "schedule_event":
          openIntentCard(intent);
          return;
        case "search":
          openSearch(intent.text);
          return;
        case "compose":
          compose.openNew();
          return;
        case "open_group":
          if (intent.group) onNavigate?.(`group:${intent.group.id}`);
          return;
        case "open_section":
          if (intent.section) onNavigate?.(`section:${intent.section.id}`);
          return;
        default:
          // Tags and anything else need a conversation: the Agent, as today.
          askAgent(intent.text);
      }
    },
    [
      threads,
      focus,
      request,
      openPicker,
      inbox,
      showToast,
      countText,
      t,
      s,
      moveTo,
      openIntentCard,
      openSearch,
      compose,
      onNavigate,
      askAgent,
    ],
  );

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
  const listTitle =
    lens?.name ??
    sectionLens?.name ??
    (folder ? t(`strings.nav.${folder}`) : t("strings.inbox.title"));
  /** The scheduling card a sentence opened: the composer's card, approve creates the Event, decline drops it. */
  const intentCardNode = intentCard ? (
    <ToolCard
      className="intent-card"
      call={{
        ...eventCall(intentCard.preview, intentCard.id),
        status: intentCard.status,
        ...(intentCard.result ? { result: intentCard.result } : {}),
      }}
      statusLabel={
        intentCard.status === "waiting"
          ? agentStrings["strings.agent.waiting"]
          : intentCard.status === "running"
            ? agentStrings["strings.agent.running"]
            : intentCard.status === "failed"
              ? agentStrings["strings.agent.failed"]
              : agentStrings["strings.agent.applied"]
      }
      preview={
        <PreviewView
          preview={{ kind: "event", event: intentCard.preview }}
          strings={agentStrings}
          now={now}
        />
      }
      actions={
        intentCard.status === "waiting"
          ? [agentStrings["strings.agent.approve"], agentStrings["strings.agent.decline"]]
          : undefined
      }
      onAction={(action) => {
        if (action === agentStrings["strings.agent.approve"]) void approveIntentCard();
        else setIntentCard(null);
      }}
    />
  ) : undefined;
  /** The row's hover actions, worded from Settings with the keymap's keys. */
  const rowTitles = {
    archive: `${t("strings.inbox.action.archive")} (${key("thread.archive")})`,
    snooze: `${t("strings.inbox.action.snooze")} (${key("thread.snooze")})`,
    ask: t("strings.inbox.action.ask"),
  };
  const headCount = selection.length
    ? fill(t("strings.inbox.selected"), { n: selection.length })
    : searching || filter
      ? order.length
      : threads.length;
  const filterLabel = (f: StreamFilter) =>
    t(
      f === "unread"
        ? "strings.inbox.filter.unread"
        : f === "starred"
          ? "strings.inbox.filter.starred"
          : f === "attachments"
            ? "strings.inbox.filter.attachments"
            : "strings.inbox.filter.needs_reply",
    );
  const olderMissing = older.reduce((n, o) => n + o.missing, 0);
  const renderItem = (item: ListItem) => {
    const { thread: th, leaving } = item.row;
    return (
      <MessageRow
        key={th.id}
        thread={th}
        tags={tagsOf(th)}
        selected={th.id === focus}
        className={
          [selection.includes(th.id) && "picked", leaving && "leaving"].filter(Boolean).join(" ") ||
          undefined
        }
        now={now}
        titles={rowTitles}
        highlight={highlight}
        onOpen={(id) => {
          if (searching && search) void search.remember(searchText);
          open(id);
        }}
        onArchive={(id) => request("archive", [id])}
        onSnooze={(id) => openPicker("snooze", [id])}
        onAsk={() => {
          setFocus(th.id);
          focusAgent();
        }}
      />
    );
  };

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
          <label className={`list-search${searching ? " on" : ""}`}>
            <MagnifyingGlassIcon className="search-ic" aria-hidden="true" />
            <input
              ref={searchInput}
              type="search"
              value={searchText}
              placeholder={t("strings.inbox.search.placeholder")}
              aria-label={t("strings.inbox.search.placeholder")}
              spellCheck={false}
              onChange={(e) => setSearchText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === "ArrowDown") {
                  e.preventDefault();
                  searchInput.current?.blur();
                  if (e.key === "Enter" && order[0]) {
                    if (search && searching) void search.remember(searchText);
                    open(focus && order.includes(focus) ? focus : order[0]);
                  }
                }
              }}
            />
            {searching ? (
              <button
                type="button"
                className="search-clear"
                title={t("strings.inbox.search.clear")}
                aria-label={t("strings.inbox.search.clear")}
                onClick={closeSearch}
              >
                <XIcon />
              </button>
            ) : null}
          </label>
          {stream ? (
            <Btn
              on={filter !== null}
              className="filter-btn"
              aria-haspopup="menu"
              onClick={() => openPicker("filter", [])}
            >
              <FunnelSimpleIcon /> {filter ? filterLabel(filter) : t("strings.inbox.filter")}
            </Btn>
          ) : null}
          <Btn icon title={t("strings.inbox.more")} onClick={() => openPicker("more", [])}>
            <DotsThreeIcon />
          </Btn>
        </ColHead>
        {pickerExit.value === "filter" ? (
          <Picker
            className="filter-pop"
            label={t("strings.inbox.filter")}
            title={t("strings.inbox.filter.title")}
            items={[
              ...STREAM_FILTERS.map((f) => ({
                key: f,
                label: filterLabel(f),
              })),
              ...(filter ? [{ key: "", label: t("strings.inbox.filter.clear") }] : []),
            ]}
            onPick={(k) => {
              closePicker();
              setFilter(k === "" ? null : (k as StreamFilter));
            }}
            onClose={closePicker}
            leaving={pickerExit.leaving}
            onLeft={pickerExit.onEnd}
          />
        ) : null}
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
        <VirtualList
          role="listbox"
          aria-label={listTitle}
          items={items}
          render={renderItem}
          overscan={s["inbox.overscan_rows"]}
          focusKey={focus}
          scrollKey={searching ? "search" : `stream:${filter ?? ""}`}
          layoutKey={`${shell.density}|${stream ? "stream" : "split"}|${fields}`}
          before={
            <>
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
              {searching && pull ? (
                <div className="search-older" role="status">
                  <span>
                    {pull.error ??
                      fill(t("strings.search.older_pulling"), {
                        done: pull.progress?.done ?? 0,
                        total: pull.progress?.total ?? pull.older.missing,
                      })}
                  </span>
                </div>
              ) : searching && olderMissing > 0 ? (
                <div className="search-older">
                  <span>{t("strings.search.older_help")}</span>
                  <Btn
                    sm
                    outline
                    onClick={() => {
                      const first = older[0];
                      if (first) void pullOlder(first);
                    }}
                  >
                    {t("strings.search.older")}
                  </Btn>
                </div>
              ) : null}
              {calendar && s["calendar.today_panel"] && !searching ? (
                <StreamTodayPanel calendar={calendar} now={now} settings={settings} />
              ) : null}
              {items.length === 0 && !syncing ? (
                <div className="empty-line">
                  {searching
                    ? t("strings.search.empty")
                    : filter && rows.length > 0
                      ? t("strings.inbox.filter.empty")
                      : t(folder ? `strings.folder.${folder}.empty` : "strings.inbox.empty")}
                </div>
              ) : null}
            </>
          }
        />
      </section>

      {shownThread ? (
        <Reader
          loadRemoteImages={settings["reader.load_remote_images"]}
          banner={
            calendar ? (
              <ThreadInviteBar calendar={calendar} threadId={shownThread.id} settings={settings} />
            ) : null
          }
          thread={shownThread}
          messages={messages}
          brief={brief}
          chips={judgedChipList}
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
          actions={threadActions.map((a) => a.reader)}
          onAction={(id) => void runCustomAction(id)}
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
                recipient={personName(
                  messages[messages.length - 1]?.from ?? shownThread.participants[0],
                )}
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
            asksFirst: t("strings.actions.tier.always_ask"),
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
                    // biome-ignore lint/suspicious/noArrayIndexKey: a split of one static string; the position is the identity
                    <Kbd key={`${part}-${i}`}>
                      {key(part === "{down}" ? "move.down" : "move.up")}
                    </Kbd>
                  ) : (
                    // biome-ignore lint/suspicious/noArrayIndexKey: same split; text parts can repeat
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
          onOpenRuntime={() => onNavigate?.("settings:ai")}
          card={intentCardNode}
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
          judge={judge}
          contacts={contacts}
          sections={sectionOptions}
          describeIntent={describe}
        />
      ) : null}
    </div>
  );
}
