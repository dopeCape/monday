// The inbox screen: the stream or split list, the reader, the agent dock, and
// every triage behavior from docs/spec/inbox.md that needs no Server. Reads
// Threads through InboxSource and acts through InboxActions (screens/inbox/
// actions.ts); the Store implements both. Compose (the overlay, the inline
// reply, the undo bar) runs through the Composer seam (screens/compose).

import type {
  CustomActionSetting,
  EventPreview,
  ExternalPending,
  MeetingChip,
  MeetingOptions,
  Person,
  Recommendation,
  RecommendationArgs,
  Settings,
  Tag,
  Thread,
  TypedIntent,
} from "@monday/shared";
import {
  customActionsFor,
  handOverNote,
  isSettingKey,
  orderedSectionRules,
  outcomeArgs,
  outcomeOf,
  sectionLabel,
} from "@monday/shared";
import {
  Btn,
  ColHead,
  DraftCard,
  Kbd,
  MessageRow,
  personName,
  type Suggestion,
  ToolCard,
  VirtualList,
} from "@monday/ui";
import {
  ArchiveIcon,
  ClockIcon,
  EnvelopeSimpleIcon,
  EnvelopeSimpleOpenIcon,
  FolderSimpleIcon,
  FunnelSimpleIcon,
  MagnifyingGlassIcon,
  PencilSimpleLineIcon,
  StarIcon,
  TrashIcon,
  TrayArrowUpIcon,
  XIcon,
} from "@phosphor-icons/react";
import {
  Fragment,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { cleanLabel, composerAttach, writeThreadDrag } from "../agent/aui/mentions.tsx";
import { Composer as AgentComposer, composerStrings, PreviewView } from "../agent/Composer.tsx";
import { runtimeLine } from "../agent/runtimeLine.ts";
import { suggestionsFor } from "../agent/suggestions.ts";
import { type AgentSession, NULL_SESSION } from "../agent/useAgentSession.ts";
import { chordLabel, isKeyAction, type KeyAction, normalizeChord } from "../keyboard/keymaps.ts";
import {
  isTypingTarget,
  type KeyContext,
  type KeyHandlers,
  type Pane,
  useActiveKeymap,
  useKeymap,
} from "../keyboard/useKeymap.ts";
import type { ListExit } from "../platform/api.ts";
import { openExternal, saveDownload } from "../platform/open.ts";
import {
  FullSearchError,
  mergeHits,
  type OlderMail,
  type SearchHit,
  type SearchModule,
} from "../search/index.ts";
import type { AgentAsk } from "../search/palette.ts";
import { useIsActivePane } from "../shell/active.ts";
import { useBack } from "../shell/back.ts";
import { DrawerButton } from "../shell/phone.tsx";
import { useShell } from "../shell/Shell.tsx";
import { type SwipeDirection, useListGestures } from "../shell/touch.ts";
import { queueTemplate, useTemplateLink } from "../templates/link.ts";
import { useReplyTemplate } from "../templates/reply.ts";
import type { InboxViewHost } from "../views/actions.ts";
import { useWorkspace } from "../workspace.tsx";
import type { CalendarSource } from "./calendar/calendar-data.ts";
import { ComposeOverlay } from "./compose/ComposeOverlay.tsx";
import { type Composer, fixtureComposer } from "./compose/composer.ts";
import { ReplyCompose } from "./compose/ReplyCompose.tsx";
import { UndoBar } from "./compose/UndoBar.tsx";
import { type ComposeController, useCompose } from "./compose/useCompose.ts";
import { fixtureInbox, type Inbox as InboxData, type UndoToken } from "./inbox/actions.ts";
import { BatchPreview } from "./inbox/BatchPreview.tsx";
import { createCustomActionRunner, customActionTier } from "./inbox/custom-actions.ts";
import { chipLabel, FilterChips, FilterMenu } from "./inbox/FilterMenu.tsx";
import type { FolderKey, ThreadListKey } from "./inbox/folders.ts";
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
import {
  type BaseListKey,
  type FacetKind,
  type FilterChip,
  facetsOf,
  filterKeepsThread,
  filterListKey,
  filterSearchText,
  isFilterEmpty,
  needsReply,
  resolveFilter,
  withoutFacet,
} from "./inbox/list-filter.ts";
import {
  calendarNewTarget,
  listMeetingChip,
  type MeetingsSeam,
  meetingsOn,
  readerMeetingChips,
  runMeetingChip,
} from "./inbox/meetings.ts";
import { Picker } from "./inbox/Picker.tsx";
import { Reader, type ReaderAction } from "./inbox/Reader.tsx";
import {
  readerChips as buildReaderChips,
  type ComposeSeed,
  chipMenu,
  createRecommendationRunner,
  followUpUntil,
  listMode,
  type ReaderChip,
  recommendedChipLabel,
  recommendedKeyIndex,
  shownRecommendations,
  wordsOf,
} from "./inbox/recommended.ts";
import { SelectionBar } from "./inbox/SelectionBar.tsx";
import { SnoozePicker } from "./inbox/SnoozePicker.tsx";
import { formatWake } from "./inbox/snooze.ts";
import { localSearch, searchTerms } from "./inbox/stream-filter.ts";
import { Toast } from "./inbox/Toast.tsx";
import {
  extendSelection,
  fill,
  needsPreview,
  neighbor,
  nextFocus,
  rangeSelect,
  targets,
  toggleSelected,
} from "./inbox/triage.ts";
import { UnsubscribeCard } from "./inbox/UnsubscribeCard.tsx";
import { useClock } from "./inbox/useClock.ts";
import { useExit, useExitValue } from "./inbox/useExit.ts";
import { type DisplayRow, reducedMotion, useLeavingRows } from "./inbox/useLeaving.ts";
import {
  AttachmentViewer,
  type ViewerFile,
  type ViewerStrings,
} from "./inbox/viewer/AttachmentViewer.tsx";
import { Palette, type PaletteCommand } from "./Palette.tsx";

export interface SyncProgress {
  done: number;
  total: number;
}

export interface InboxProps {
  /**
   * Compose, owned by the App so its windows open over any screen. Absent (a
   * test, the dev server) the Inbox keeps its own and renders its windows.
   */
  compose?: ComposeController | undefined;
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
   * Whether Sections are on (sections.require_ai and an AI that can sort).
   * Off, the palette names no Section and no chip counts Needs your reply.
   * Default on.
   */
  sectionsOn?: boolean | undefined;
  /**
   * A Mail folder lens (Starred, Snoozed, Sent, Archive): the stream over
   * the folder's Threads instead of the Inbox's, one list with no Section
   * headings, under the folder's name with its own empty line; Snoozed rows
   * say when they wake. Absent, the Inbox.
   */
  folder?: FolderKey | undefined;
  /**
   * A View lens (docs/spec/views.md): the View's Threads in Lane order in
   * the list area, rendered by the View's component, with the Inbox's rows,
   * keys, reader, row actions and multi-select.
   */
  view?: ViewLens | undefined;
  /** Panels above the stream beside the Today panel: the `view` Panel (views.panel). */
  panels?: ReactNode | undefined;
  /**
   * The judge behind the palette's typed sentences (slice 27, ADR 0012).
   * Absent, or answering null, the palette behaves as before.
   */
  judge?: IntentJudge | null | undefined;
  /**
   * Meetings from mail (docs/spec/meetings.md): the options on open and the
   * reply text for a chip. Absent, no meeting chips.
   */
  meetings?: MeetingsSeam | null | undefined;
  /** Syncs now: the phone list's pull to refresh. Absent, the list does not pull. */
  onRefresh?: (() => Promise<unknown>) | undefined;
}

/** What the View screen hands the Inbox: its Threads in Lane order, and how to draw them. */
export interface ViewLens {
  id: string;
  name: string;
  /** Every Thread the View shows, in the order its component shows them (Lane by Lane). */
  threads: readonly Thread[];
  /** The header's own controls: the menu, the count line. */
  header: ReactNode;
  /** Above the rows: the check bar, the tighten offer. */
  above?: ReactNode;
  /** Draws the component, with the Inbox's own row for a Thread. */
  render(ctx: {
    row(thread: Thread): ReactNode;
    focus: string | null;
    /** Opens a Thread, on one of its Messages when a View row is that Message. */
    open(threadId: string, messageId?: string | null): void;
    /** What the View's action buttons act through. */
    host: InboxViewHost;
  }): ReactNode;
}

/** An action that takes Threads out of the list shown ("unarchive" out of Archive). */
type RemovingKind = "archive" | "snooze" | "delete" | "unarchive";
type FlagKind = "star" | "unstar" | "read" | "unread";
/** What a batch does: a removing action, a flag, a move to a Group, or a custom action. */
type BatchKind = RemovingKind | FlagKind | "move" | "custom";
const FLAG_TOAST = {
  star: "strings.inbox.toast.starred",
  unstar: "strings.inbox.toast.unstarred",
  read: "strings.inbox.toast.read",
  unread: "strings.inbox.toast.unread",
} as const;
const BATCH_WORD = {
  archive: "strings.inbox.action.archive",
  unarchive: "strings.inbox.select.unarchive",
  delete: "strings.inbox.action.delete",
  snooze: "strings.inbox.action.snooze",
  star: "strings.inbox.action.star",
  unstar: "strings.inbox.action.unstar",
  read: "strings.inbox.action.read",
  unread: "strings.inbox.action.unread",
  move: "strings.inbox.action.move",
} as const;
/** One row of the virtual list. */
interface ListItem {
  key: string;
  row: DisplayRow;
}
/**
 * "Search older mail": the full search on the Server (ADR 0015) for the
 * query as typed. Its hits are merged into the local ones; nothing lands in
 * the Cache. `cursor` resumes below where it stopped ("Search further").
 */
type OlderRun = {
  status: "running" | "paused" | "done" | "error";
  hits: readonly SearchHit[];
  scanned: number;
  total: number;
  cursor: string | null;
  error: string | null;
};

/**
 * The Filter menu's chips per Workspace (one mailbox seam each), for the
 * session: not a Setting (docs/spec/inbox.md), kept across the lenses and
 * across a remount of the screen, gone when the app restarts.
 */
const chipsByInbox = new WeakMap<object, readonly FilterChip[]>();
const NO_CHIPS: readonly FilterChip[] = [];
type ToastState = { text: string; token: UndoToken | null; id: number };
/**
 * A batch waiting on its preview. `byQuery` marks one over the whole list
 * ("Select all N"), whose Threads the seam may not hold: the preview lists
 * only the ones it does.
 */
type Batch = {
  kind: BatchKind;
  ids: string[];
  until?: Date;
  group?: string | null;
  action?: string;
  byQuery?: boolean;
};
/** The scheduling card a typed sentence opened in the composer, without a Session (slice 27). */
type IntentCard = {
  id: string;
  /** What the Agent is asked instead when this Device has no calendar seam. */
  fallback: string;
  /** Set when a meeting's Schedule chip opened the card (docs/spec/meetings.md). */
  meeting?: { threadId: string } | undefined;
  preview: EventPreview;
  status: "waiting" | "running" | "done" | "failed";
  result?: string | undefined;
};

const defaultInbox = fixtureInbox();
/** Where a custom action picked from the selection bar waits on its confirming second pick. */
const SELECTION = "selection";
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

/** The Thread the neighbours are counted from: the open one, else the focused row. */
function openThreadIdForPrefetch(
  readerOpen: boolean,
  openId: string | null,
  focus: string | null,
): string | null {
  return readerOpen && openId ? openId : focus;
}

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

/** A Thread's Recommended actions from the Cache (docs/spec/actions.md); they change with the stream. */
function useThreadRecommendations(inbox: InboxData, threadId: string | null) {
  const get = useCallback(
    () => (threadId ? inbox.recommendations?.(threadId) : undefined),
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

export function Inbox(props: InboxProps) {
  return props.compose ? (
    <InboxBody {...props} compose={props.compose} ownsCompose={false} />
  ) : (
    <InboxOwnCompose {...props} />
  );
}

/** An Inbox without the App's compose: it keeps its own and draws its windows. */
function InboxOwnCompose(props: InboxProps) {
  const { settings } = useShell();
  const nowProp = props.now;
  const nowFn = useCallback(() => nowProp ?? new Date(), [nowProp]);
  const compose = useCompose({
    composer: props.composer ?? defaultComposer,
    settings,
    now: nowFn,
  });
  return <InboxBody {...props} compose={compose} ownsCompose />;
}

function InboxBody({
  compose,
  ownsCompose,
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
  sectionsOn = true,
  folder,
  judge,
  meetings,
  view,
  panels,
  onRefresh,
}: InboxProps & { compose: ComposeController; ownsCompose: boolean }) {
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

  // A folder lens and a Group lens read their own bounded query
  // (inbox/folders.ts); the Inbox and a Section lens read the Inbox's. A seam
  // over a large Cache holds the newest part of each list and reads more as
  // the list nears its end (listKey names which).
  const groupList = group !== undefined && inbox.group !== undefined;
  const baseKey: BaseListKey = folder ? folder : groupList ? `group:${group}` : "inbox";

  // The Filter menu's chips, per Workspace for the session. A seam over the
  // Cache reads the filtered list from SQL over every Thread (list-filter.ts),
  // paged like the Inbox; a seam without one (the fixtures) is filtered here.
  const [chipState, setChipState] = useState(() => ({
    inbox: inbox as object,
    chips: chipsByInbox.get(inbox) ?? NO_CHIPS,
  }));
  const filterChips =
    chipState.inbox === inbox ? chipState.chips : (chipsByInbox.get(inbox) ?? NO_CHIPS);
  const setFilterChips = useCallback(
    (next: readonly FilterChip[]) => {
      chipsByInbox.set(inbox, next);
      setChipState({ inbox, chips: next });
    },
    [inbox],
  );
  const weekStartsMonday = settings["calendar.week_starts_monday"];
  const today = now.toDateString();
  // biome-ignore lint/correctness/useExhaustiveDependencies: the dates resolve per day, not per clock tick
  const resolved = useMemo(
    () => resolveFilter(filterChips, now, weekStartsMonday),
    [filterChips, today, weekStartsMonday],
  );
  const cacheFilter = inbox.list !== undefined && !isFilterEmpty(resolved);
  const listKey: ThreadListKey = cacheFilter ? filterListKey(baseKey, resolved) : baseKey;
  // A list whose first page is not read yet is loading, not empty (Sent, Archive, a Group).
  const listLoading = inbox.listLoaded ? !inbox.listLoaded(listKey) : false;
  const streamOf = useCallback(
    () =>
      cacheFilter
        ? (inbox.list?.(listKey) ?? NO_THREADS)
        : folder
          ? (inbox.folder?.(folder) ?? NO_THREADS)
          : group !== undefined && inbox.group
            ? inbox.group(group)
            : inbox.threads(),
    [inbox, folder, group, cacheFilter, listKey],
  );
  const subscribeList = useCallback(
    (listener: () => void) =>
      inbox.watchList ? inbox.watchList(listKey, listener) : inbox.subscribe(listener),
    [inbox, listKey],
  );
  const liveThreads = useSyncExternalStore(subscribeList, streamOf, streamOf);
  const totalOf = useCallback(
    () => (cacheFilter ? (inbox.listTotal?.(listKey) ?? null) : null),
    [inbox, cacheFilter, listKey],
  );
  const filteredTotal = useSyncExternalStore(subscribeList, totalOf, totalOf);
  const growAt = settings["inbox.memory_grow_rows"];
  const readMore = useCallback(() => inbox.more?.(listKey), [inbox, listKey]);
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
    [
      inbox,
      group,
      section,
      folder,
      listKey,
      settings["sections.rules"],
      settings["sections.order"],
    ],
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
    // A View orders its own Threads, Lane by Lane.
    if (view) return view.threads;
    const list = lens
      ? allThreads.filter((t) => t.group === lens.id || t.subgroup === lens.id)
      : sectionLens
        ? allThreads.filter((t) => t.section === sectionLens.id)
        : allThreads;
    // A folder keeps its own order (Snoozed wakes soonest first) and shows the wake time.
    if (folder === "snoozed") return list.map((t) => wakeSnippet(t, settings, now));
    if (folder) return list;
    return newestFirst(list);
  }, [allThreads, lens, sectionLens, folder, settings, now, view]);
  const viewThreads = useMemo(
    () => (view ? new Map(view.threads.map((th) => [th.id, th])) : null),
    [view],
  );
  const tagsOf = useCallback(
    (th: Thread): Tag[] => th.tags.flatMap((id) => tags.filter((t) => t.id === id)),
    [tags],
  );
  const collapseMs = timing?.collapse ?? (reducedMotion() ? 0 : settings["inbox.row_collapse_ms"]);
  const toastMs = timing?.toast ?? settings["inbox.undo_toast_ms"];
  const rows = useLeavingRows(threads, collapseMs);

  /* ------------------------------ Filter and search ------------------------------ */

  // The chips narrow whichever list is shown (or the search results); they
  // combine with AND, Escape takes the last one back, Clear all lifts them.
  // Needs a reply reads the Section and the Judgments of the Threads held,
  // so it filters here; the rest came from the Cache already, unless the seam
  // has none. A Thread shown under a filter stays until the filter changes,
  // so reading it under "Unread" does not pull it from under the cursor.
  const filtering = filterChips.length > 0;
  const needsReplyOn = filterChips.some((c) => c.kind === "needs_reply");
  const filterHere = !cacheFilter && !isFilterEmpty(resolved);
  const viewKey = `${group ?? ""}|${section ?? ""}|${folder ?? ""}`;
  const filterShown = useRef<{ key: string; ids: Set<string> }>({ key: "", ids: new Set() });
  const filterKey = `${viewKey}|${listKey}|${needsReplyOn}|${JSON.stringify(resolved)}`;
  if (filterShown.current.key !== filterKey)
    filterShown.current = { key: filterKey, ids: new Set() };
  const keeps = useCallback(
    (th: Thread) => {
      if (!needsReplyOn && !filterHere) return true;
      const shown = filterShown.current.ids;
      if (shown.has(th.id)) return true;
      if (needsReplyOn && !needsReply(th, inbox.judgments?.(th.id))) return false;
      if (filterHere && !filterKeepsThread(resolved, th)) return false;
      shown.add(th.id);
      return true;
    },
    [needsReplyOn, filterHere, resolved, inbox],
  );
  /** A facet's choices under the other chips: from the Cache, or over the Threads held. */
  const facetLimit = settings["inbox.filter_facet_limit"];
  const facets = useCallback(
    async (kind: FacetKind, needle: string) => {
      const others = withoutFacet(resolved, kind);
      if (inbox.facets && inbox.list) {
        const key = isFilterEmpty(others) ? baseKey : filterListKey(baseKey, others);
        return inbox.facets(key, kind, { needle, limit: facetLimit });
      }
      const held = cacheFilter ? NO_THREADS : liveThreads;
      return facetsOf(
        kind,
        held.filter((th) => filterKeepsThread(others, th)),
        { needle, limit: facetLimit, owner: ws.address },
      );
    },
    [resolved, inbox, baseKey, facetLimit, cacheFilter, liveThreads, ws.address],
  );

  // The inline search: the field in the list header runs the Cache search
  // (ADR 0011) as the user types, and the results replace the Sections with
  // one ranked list; clearing it puts the stream back where it was.
  const [searchText, setSearchText] = useState("");
  const searching = searchText.trim() !== "";
  const [hits, setHits] = useState<readonly SearchHit[] | null>(null);
  const [older, setOlder] = useState<readonly OlderMail[]>([]);
  const [olderRun, setOlderRun] = useState<OlderRun | null>(null);
  const olderAbort = useRef<AbortController | null>(null);
  const searchSeq = useRef(0);
  const searchLimit = settings["search.results_limit"];
  // Under chips the Cache search answers both at once, through its own operators.
  const searchQuery = cacheFilter ? `${searchText} ${filterSearchText(resolved)}` : searchText;
  const runSearch = useCallback(async () => {
    const mine = ++searchSeq.current;
    if (!search || !searchText.trim()) return;
    try {
      const r = await search.search(searchQuery, {
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
  }, [search, searchText, searchQuery, workspaceId, searchLimit, nowProp]);
  useEffect(() => {
    if (!searching) {
      searchSeq.current++;
      setHits(null);
      setOlder([]);
      return;
    }
    void runSearch();
  }, [searching, runSearch]);
  // A full search belongs to the query it ran for: a new query stops it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: searchQuery is the trigger, not a read
  useEffect(() => {
    olderAbort.current?.abort();
    olderAbort.current = null;
    setOlderRun(null);
  }, [searchQuery]);
  useEffect(() => () => olderAbort.current?.abort(), []);
  /** Starts the full search, or resumes it below `cursor`, keeping the hits found so far. */
  const searchOlder = useCallback(
    async (cursor: string | null) => {
      if (!search) return;
      olderAbort.current?.abort();
      const abort = new AbortController();
      olderAbort.current = abort;
      // Only this run's own events count; decided when they arrive, since a
      // queued updater may run after the run has already let go of the ref.
      const mine = (update: (run: OlderRun) => OlderRun) => {
        if (olderAbort.current !== abort) return;
        setOlderRun((run) => (run ? update(run) : run));
      };
      setOlderRun((run) => ({
        status: "running",
        hits: cursor ? (run?.hits ?? []) : [],
        scanned: cursor ? (run?.scanned ?? 0) : 0,
        total: cursor ? (run?.total ?? 0) : 0,
        cursor,
        error: null,
      }));
      try {
        const done = await search.searchOlder(searchQuery, {
          workspace: workspaceId,
          cursor,
          limit: settings["search.full_limit"],
          ...(nowProp ? { now: nowProp } : {}),
          signal: abort.signal,
          onHit: (hit) => mine((run) => ({ ...run, hits: [...run.hits, hit] })),
          onProgress: (p) =>
            mine((run) => ({
              ...run,
              scanned: p.scanned,
              total: p.total,
              cursor: p.cursor ?? run.cursor,
            })),
        });
        if (!done) return;
        mine((run) => ({
          ...run,
          status: done.reason === "limit" ? "paused" : "done",
          scanned: done.scanned,
          total: done.total,
          cursor: done.cursor,
        }));
      } catch (error) {
        const message =
          error instanceof FullSearchError && error.code === "locked"
            ? String(settings["strings.search.older_locked"])
            : error instanceof Error
              ? error.message
              : String(error);
        mine((run) => ({ ...run, status: "error", error: message }));
      } finally {
        if (olderAbort.current === abort) olderAbort.current = null;
      }
    },
    [search, searchQuery, workspaceId, settings, nowProp],
  );
  /** Stop: the request closes, the Server stops scanning, the hits stay. */
  const stopOlder = useCallback(() => {
    const abort = olderAbort.current;
    olderAbort.current = null;
    abort?.abort();
    setOlderRun((run) => (run ? { ...run, status: "paused" } : run));
  }, []);
  const highlight = useMemo(
    () => (searching ? searchTerms(searchText) : undefined),
    [searching, searchText],
  );
  const liveById = useMemo(() => new Map(allThreads.map((th) => [th.id, th])), [allThreads]);
  /** The results as rows: the live Thread where the list has it, the hit's passage as its snippet. */
  const searchRows = useMemo<DisplayRow[] | null>(() => {
    if (!searching) return null;
    const shown = olderRun ? mergeHits(hits ?? [], olderRun.hits) : (hits ?? []);
    const found: Thread[] = search
      ? shown.map((h) => {
          const live = liveById.get(h.thread.id) ?? inbox.thread(h.thread.id) ?? h.thread;
          return h.snippet ? { ...live, snippet: h.snippet } : live;
        })
      : localSearch(allThreads, searchText);
    return found.filter(keeps).map((th) => ({ thread: th, leaving: false }));
  }, [searching, search, hits, olderRun, liveById, inbox, allThreads, searchText, keeps]);

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
      sectionsOn
        ? orderedSectionRules(settings["sections.rules"], settings["sections.order"])
            .filter((r) => !r.hidden)
            .map((r) => ({ id: r.id, name: sectionName(settings, r) }))
        : [],
    [settings, sectionsOn],
  );

  /** The list order the keyboard walks. Leaving rows are not in it. */
  const prefetchReach = settings["inbox.prefetch_neighbors"];
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
  // "Select all N": the whole list over the Cache is selected, by its key,
  // not only the rows held. It lasts while the selection does, on that list.
  const [selectAll, setSelectAll] = useState<ThreadListKey | null>(null);
  /** The row a shift-click ranges from: the last one toggled, by click or X. */
  const anchor = useRef<string | null>(null);
  const selecting = selection.length > 0;
  const allMode = selecting && selectAll === listKey;
  useEffect(() => {
    if (!selecting) setSelectAll(null);
  }, [selecting]);
  const clearSelection = useCallback(() => {
    setSelection([]);
    setSelectAll(null);
  }, []);
  // "Select all N" reaches past the rows held only where the list is the
  // seam's own query: not a search, a Section lens or a filter decided here.
  const byQuery =
    inbox.listIds !== undefined &&
    !searching &&
    !sectionLens &&
    !needsReplyOn &&
    !filterHere &&
    !(lens && !groupList);
  const selTotalOf = useCallback(
    () => (selecting && byQuery ? (inbox.listTotal?.(listKey) ?? null) : null),
    [selecting, byQuery, inbox, listKey],
  );
  const selTotal = useSyncExternalStore(subscribeList, selTotalOf, selTotalOf);
  const [readerOpen, setReaderOpen] = useState(!stream || urlSel !== null);
  /** The Message a View row opened its Thread on, scrolled to in the reader. */
  const [focusMessage, setFocusMessage] = useState<{ thread: string; message: string } | null>(
    null,
  );
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
  const [picker, setPicker] = useState<"snooze" | "move" | "more" | "filter" | "row" | null>(() =>
    typeof location !== "undefined" &&
    new URLSearchParams(location.search).get("overlay") === "filter"
      ? "filter"
      : null,
  );
  const [pickerIds, setPickerIds] = useState<string[]>([]);
  const [batch, setBatch] = useState<Batch | null>(null);
  const [intentCard, setIntentCard] = useState<IntentCard | null>(null);
  /** The open Thread's meeting options, as the Server worked them out for its newest Message. */
  const [meetingOptions, setMeetingOptions] = useState<{
    key: string;
    options: MeetingOptions | null;
  } | null>(null);
  /** Threads whose Schedule chip was approved: the chip goes, the reply chip stays. */
  const [meetingDone, setMeetingDone] = useState<Readonly<Record<string, true>>>({});
  const [toast, setToast] = useState<ToastState | null>(null);
  /** Reports what became of a Thread's chips when it was dealt with some other way; set below. */
  const doneRef = useRef<((threadId: string, done: RecommendationArgs) => void) | null>(null);
  const lastToken = useRef<UndoToken | null>(null);
  /** A token that stands for several (a custom action run on each selected Thread). */
  const multiUndo = useRef(new Map<UndoToken, UndoToken[]>());
  const toastSeq = useRef(0);

  // The focus follows the list: a focus that left it (without an action moving
  // it first) lands on the first row. A Thread the list does not hold (a
  // link, a notification) is read from the Cache first: it stays in focus
  // when the Cache has it.
  useEffect(() => {
    if (focus === null || order.includes(focus) || inbox.thread(focus)) return;
    if (!inbox.resolve) {
      setFocus(order[0] ?? null);
      return;
    }
    let live = true;
    void inbox.resolve(focus).then((found) => {
      if (live && !found) setFocus((f) => (f === focus ? (order[0] ?? null) : f));
    });
    return () => {
      live = false;
    };
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
    const field = () => {
      searchInput.current?.focus();
      searchInput.current?.select();
    };
    // The selection bar holds the header's place: asking to search ends the
    // selection, and the field is focused once the header is back.
    if (cursor.current.selection.length > 0) {
      setSelection([]);
      setTimeout(field, 0);
    }
    queueMicrotask(field);
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

  const thread = focus ? (inbox.thread(focus) ?? viewThreads?.get(focus)) : undefined;
  const showReader = stream ? readerOpen && thread !== undefined : true;
  const openThreadId = showReader && thread ? thread.id : null;
  // The rows next to the one in hand stay warm, so j and k (or a click on a
  // neighbour) show a Thread without waiting on the Cache.
  const prefetchAround = openThreadIdForPrefetch(showReader, thread?.id ?? null, focus);
  // The row the pointer rests on is read ahead too, so the click that follows opens it whole.
  const [hovered, setHovered] = useState<string | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverDelay = settings["inbox.prefetch_hover_ms"];
  const onListPointerOver = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (hoverDelay < 0) return;
      const id = (e.target as Element).closest?.("[data-thread]")?.getAttribute("data-thread");
      if (!id) return;
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
      hoverTimer.current = setTimeout(() => setHovered(id), hoverDelay);
    },
    [hoverDelay],
  );
  useEffect(
    () => () => {
      if (hoverTimer.current) clearTimeout(hoverTimer.current);
    },
    [],
  );
  useEffect(() => {
    if (!inbox.prefetch) return;
    const at = prefetchAround && prefetchReach > 0 ? order.indexOf(prefetchAround) : -1;
    if (at < 0 && !hovered) return;
    const ids: string[] = hovered ? [hovered] : [];
    for (let d = 1; at >= 0 && d <= prefetchReach; d++) {
      const next = order[at + d];
      const prev = order[at - d];
      if (next) ids.push(next);
      if (prev) ids.push(prev);
    }
    const timer = setTimeout(() => inbox.prefetch?.(ids), 80);
    return () => clearTimeout(timer);
  }, [inbox, order, prefetchAround, prefetchReach, hovered]);
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

  /* ------------------------------ Drafts on Threads ------------------------------ */

  // The Cache's open Drafts: a Thread with one is marked in the list, and its
  // reader ends with each one as a draft card (the one in the reply box aside).
  const allDrafts = useSyncExternalStore(composer.subscribe, composer.drafts, composer.drafts);
  const openThreadDrafts = useMemo(
    () => allDrafts.filter((d) => d.status === "open" && d.threadId !== null),
    [allDrafts],
  );
  const draftThreads = useMemo(
    () =>
      s["inbox.draft_marker"]
        ? new Set(openThreadDrafts.map((d) => d.threadId as string))
        : new Set<string>(),
    [openThreadDrafts, s],
  );
  const replyDraftId = compose.reply?.draftId ?? null;
  const shownDrafts = useMemo(
    () =>
      shownThreadId && s["reader.show_drafts"]
        ? openThreadDrafts
            .filter((d) => d.threadId === shownThreadId && d.id !== replyDraftId)
            .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
        : [],
    [openThreadDrafts, shownThreadId, replyDraftId, s],
  );

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
      } else if (kind === "unarchive") {
        token = await inbox.unarchive(ids);
        text = t("strings.inbox.toast.unarchived");
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

  /** Star, unstar, read or unread on ids, with the toast; the selection stays. */
  const flag = useCallback(
    async (kind: FlagKind, ids: readonly string[]) => {
      if (ids.length === 0) return;
      const token =
        kind === "star"
          ? await inbox.star(ids)
          : kind === "unstar"
            ? await inbox.unstar(ids)
            : kind === "read"
              ? await inbox.markRead(ids)
              : await inbox.markUnread(ids);
      showToast(countText(t(FLAG_TOAST[kind]), ids.length), token);
    },
    [inbox, showToast, countText, t],
  );

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

  /** A custom action over several Threads; set once the custom action runner exists, below. */
  const customBatch = useRef<(actionId: string, ids: readonly string[]) => Promise<void>>(
    async () => {},
  );
  /** Runs a batch now: the same calls, toasts and undo as one Thread's. */
  const runBatch = useCallback(
    async (b: Batch) => {
      switch (b.kind) {
        case "archive":
        case "unarchive":
        case "delete":
        case "snooze":
          return remove(b.kind, b.ids, b.until);
        case "move":
          return moveTo(b.ids, b.group ?? null);
        case "custom":
          return b.action ? customBatch.current(b.action, b.ids) : undefined;
        default:
          return flag(b.kind, b.ids);
      }
    },
    [remove, moveTo, flag],
  );

  /**
   * Every action on Threads comes this way, from a key, a row, the reader or
   * the selection bar: above the Setting it previews first (ADR 0002), else
   * it runs.
   */
  const request = useCallback(
    (
      kind: BatchKind,
      ids: readonly string[],
      until?: Date,
      extra: { group?: string | null; action?: string } = {},
    ) => {
      if (ids.length === 0) return;
      // The Threads were dealt with some other way than their chips: what became of those.
      if (kind === "archive" || kind === "snooze") {
        for (const id of ids) {
          doneRef.current?.(
            id,
            kind === "archive"
              ? { kind: "archive" }
              : { kind: "snooze", until: until?.toISOString() ?? null, anchor: "none" },
          );
        }
      }
      const b: Batch = {
        kind,
        ids: [...ids],
        ...(until ? { until } : {}),
        ...(extra.group !== undefined ? { group: extra.group } : {}),
        ...(extra.action !== undefined ? { action: extra.action } : {}),
        ...(allMode ? { byQuery: true } : {}),
      };
      if (needsPreview(ids.length, s["inbox.batch_preview_above"])) {
        setBatch(b);
        return;
      }
      void runBatch(b);
    },
    [s, runBatch, allMode],
  );

  /**
   * The Threads of ids the list holds. Under "Select all N" the rest are not
   * read one by one: star and read decide on the ones shown.
   */
  const heldOf = useCallback(
    (ids: readonly string[]) =>
      ids.flatMap((id) => {
        const th = liveById.get(id) ?? (allMode ? undefined : inbox.thread(id));
        return th ? [th] : [];
      }),
    [liveById, allMode, inbox],
  );
  /** S: unstar when every one is starred, else star. */
  const toggleStar = useCallback(
    (ids: readonly string[]) => {
      const held = heldOf(ids);
      request(held.length > 0 && held.every((th) => th.starred) ? "unstar" : "star", ids);
    },
    [heldOf, request],
  );
  /** Mark read when any is unread, else mark unread. */
  const toggleRead = useCallback(
    (ids: readonly string[]) => {
      request(heldOf(ids).some((th) => th.unread) ? "read" : "unread", ids);
    },
    [heldOf, request],
  );

  const undo = useCallback(async () => {
    const token = lastToken.current;
    if (!token) return;
    lastToken.current = null;
    // A custom action over several Threads undoes each one's, last first.
    const several = multiUndo.current.get(token);
    multiUndo.current.delete(token);
    for (const one of several ? [...several].reverse() : [token]) await inbox.undo(one);
    setToast({ text: t("strings.inbox.toast.undone"), token: null, id: ++toastSeq.current });
  }, [inbox, t]);

  const applyBatch = useCallback(async () => {
    const b = batch;
    setBatch(null);
    if (b) await runBatch(b);
  }, [batch, runBatch]);

  const openPicker = useCallback(
    (which: "snooze" | "move" | "more" | "filter" | "row", ids: readonly string[]) => {
      if (which !== "more" && which !== "filter" && ids.length === 0) return;
      setPickerIds([...ids]);
      setPicker(which);
    },
    [],
  );
  const closePicker = useCallback(() => setPicker(null), []);

  const focusAgent = useCallback(() => {
    setAgentOpen(true);
    queueMicrotask(() =>
      document.querySelector<HTMLTextAreaElement>(".agent-bar textarea")?.focus(),
    );
  }, []);

  const startReply = useCallback(
    (kind: "reply" | "forward", replyAll?: boolean, seed?: ComposeSeed) => {
      if (!thread) return;
      doneRef.current?.(
        thread.id,
        kind === "reply"
          ? { kind: "reply" }
          : { kind: "forward", to: { name: "", email: "" }, confidence: 0 },
      );
      setReaderOpen(true);
      compose.startReply(thread, inbox.messages(thread.id), kind, replyAll, seed);
    },
    [thread, inbox, compose],
  );

  // The attachment open in the viewer: the files of its message and which one.
  const [viewing, setViewing] = useState<{
    files: readonly ViewerFile[];
    index: number;
  } | null>(null);
  const downloadAttachment = useCallback(
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
  // Opening an attachment previews it inside monday (reader.attachment_preview),
  // else downloads it as before.
  const openAttachment = useCallback(
    async (attachmentId: string) => {
      const owner = messages.find((m) => m.attachments.some((a) => a.id === attachmentId));
      if (!owner || !settings["reader.attachment_preview"]) {
        await downloadAttachment(attachmentId);
        return;
      }
      const files = owner.attachments.map((a) => ({
        id: a.id,
        name: a.name,
        mediaType: a.mediaType,
        size: a.size,
      }));
      setViewing({ files, index: files.findIndex((f) => f.id === attachmentId) });
    },
    [messages, settings, downloadAttachment],
  );
  const viewerStrings = useMemo<ViewerStrings>(
    () => ({
      close: t("strings.viewer.close"),
      download: t("strings.viewer.download"),
      previous: t("strings.viewer.previous"),
      next: t("strings.viewer.next"),
      loading: t("strings.viewer.loading"),
      noPreview: t("strings.viewer.no_preview"),
      tooLarge: t("strings.viewer.too_large"),
      failed: t("strings.viewer.failed"),
      rowsMore: t("strings.viewer.rows_more"),
      pageOf: t("strings.viewer.page_of"),
      zipFiles: t("strings.viewer.zip_files"),
      from: t("strings.viewer.from"),
      to: t("strings.viewer.to"),
      date: t("strings.viewer.date"),
      zoomIn: t("strings.viewer.zoom_in"),
      zoomOut: t("strings.viewer.zoom_out"),
      label: t("strings.viewer.label"),
    }),
    [t],
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
  /**
   * Draft a reply, under the open Thread or in the inline reply: a "Reply" chip for
   * this Thread waits in the agent's input, where the user adds how to reply.
   */
  const draftWithAgent = useCallback(() => {
    if (!thread) return;
    setAgentOpen(true);
    composerAttach.attach(workspaceId, [
      {
        id: thread.id,
        type: "reply",
        label: `${t("strings.agent.reply_chip")} ${cleanLabel(thread.subject)}`,
      },
    ]);
  }, [thread, t, workspaceId]);
  // The open Thread's Judgments (slice 25), for the on-open Template suggestion.
  const judgments = useThreadJudgments(inbox, shownThreadId);

  /* ------------------------------ Meetings (docs/spec/meetings.md) ------------------------------ */

  const meetingsLive = meetings && meetingsOn(s) ? meetings : null;
  const deviceZone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return null;
    }
  }, []);
  // The open Thread's options, asked on open and again when a newer Message lands.
  const newestMessageId = messages[messages.length - 1]?.id ?? "";
  const meetingKey = shownThreadId ? `${shownThreadId}:${newestMessageId}` : null;
  useEffect(() => {
    if (!meetingsLive || !meetingKey || !shownThreadId) return;
    let live = true;
    meetingsLive
      .options(workspaceId, shownThreadId, deviceZone ?? undefined)
      .then((options) => {
        if (live) setMeetingOptions({ key: meetingKey, options });
      })
      .catch(() => {
        if (live) setMeetingOptions({ key: meetingKey, options: null });
      });
    return () => {
      live = false;
    };
  }, [meetingsLive, meetingKey, shownThreadId, workspaceId, deviceZone]);
  const shownMeeting =
    meetingsLive && meetingOptions && meetingOptions.key === meetingKey
      ? meetingOptions.options
      : null;
  const meetingChipViews = useMemo(
    () =>
      readerMeetingChips(
        shownMeeting,
        s,
        now,
        shownThreadId && meetingDone[shownThreadId] ? new Set(["schedule"] as const) : undefined,
      ),
    [shownMeeting, s, now, shownThreadId, meetingDone],
  );
  /** Runs a meeting chip as its tool call; `options` null means it came from a list row and is re-checked. */
  const runMeeting = useCallback(
    async (threadId: string, chip: MeetingChip, options: MeetingOptions | null) => {
      if (!meetingsLive) return;
      const target = inbox.thread(threadId);
      await runMeetingChip(chip, options, {
        settings: s,
        now,
        zone: deviceZone,
        refresh: () => meetingsLive.options(workspaceId, threadId, deviceZone ?? undefined),
        draft: (kind, slots) =>
          meetingsLive.draft(threadId, {
            workspace: workspaceId,
            kind,
            slots,
            ...(deviceZone ? { zone: deviceZone } : {}),
          }),
        // The reply opens on the Thread with the text; the user still sends (ADR 0002).
        reply: (text) => {
          if (!target) return;
          setFocus(threadId);
          setReaderOpen(true);
          compose.startReply(target, inbox.messages(threadId), "reply", false, { opening: text });
        },
        schedule: (preview, fresh) => {
          // The card lives in the bottom composer; in a column Layout the editor asks instead.
          if (shell.layout.agent !== "bottom") {
            onNavigate?.(
              calendarNewTarget({
                start: preview.start,
                end: preview.end,
                title: fresh.title,
                attendees: fresh.attendees,
              }),
            );
            return;
          }
          setIntentCard({
            id: `meeting-${Date.now()}`,
            fallback: t("strings.chips.call_prompt"),
            meeting: { threadId },
            preview,
            status: "waiting",
          });
          setAgentOpen(true);
        },
        pick: (where) => {
          if (onNavigate) onNavigate(calendarNewTarget(where));
          else showToast(t("strings.reader.brief_action.unavailable"), null);
        },
        toast: (text) => showToast(text, null),
      });
    },
    [
      meetingsLive,
      inbox,
      s,
      t,
      now,
      deviceZone,
      workspaceId,
      compose,
      shell.layout.agent,
      onNavigate,
      showToast,
    ],
  );

  // Templates (slice 37): the Reply chip named by the Template that fits, and the palette's rows.
  const templateLink = useTemplateLink(composer);
  const replyTemplate = useReplyTemplate(
    templateLink,
    shownThreadId,
    judgments?.needsReply ?? null,
  );
  const replyWith = t("strings.templates.reply_with");
  const ownSent = messages.filter((m) => m.from.email.toLowerCase() === ws.address.toLowerCase());
  const makeTemplate =
    templateLink?.enabled && ownSent.length > 0
      ? {
          label: t("strings.templates.from_message"),
          run: () => {
            const last = ownSent[ownSent.length - 1];
            if (last) templateLink.draftFrom({ messageIds: [last.id] });
          },
        }
      : undefined;
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

  /* ------------------------------ Recommended actions (docs/spec/actions.md) ------------------------------ */

  const recWords = useMemo(() => wordsOf(s), [s]);
  const shownRecs = useThreadRecommendations(inbox, shownThreadId);
  // The reader asks once per Thread version on open: a Thread outside the Signal scope,
  // or at the assist level, gets its answers then; the rest are worked out again.
  const recsKey = shownThreadId ? `${shownThreadId}:${newestMessageId}` : null;
  useEffect(() => {
    if (!recsKey || !shownThreadId || s["ai.level"] === "off") return;
    if (!s["actions.recommended.enabled"]) return;
    void inbox.askRecommendations?.(shownThreadId, deviceZone ?? undefined);
  }, [inbox, recsKey, shownThreadId, deviceZone, s]);
  /** "Not this" per Thread, at once; the Server remembers it for the Thread version too. */
  const [dismissed, setDismissed] = useState<Readonly<Record<string, readonly string[]>>>({});
  /** The unsubscribe card on show: the list and the exact request it asks about. */
  const [unsubCard, setUnsubCard] = useState<{
    threadId: string;
    rec: Extract<Recommendation, { kind: "unsubscribe" }>;
    exit: ListExit | null;
    status: "asking" | "running" | "done" | "failed";
    text?: string | undefined;
  } | null>(null);
  /** A pay chip armed by its first click (the page's domain shown); the second opens it. */
  const armed = useRef<string | null>(null);
  /** A hand-off's offered follow-up snooze, per Thread. */
  const [followUps, setFollowUps] = useState<Readonly<Record<string, string>>>({});
  /** A chip clicked on a Thread that changed since it was worked out: the second click runs it. */
  const recheck = useRef<string | null>(null);
  const customArchives = threadActions.some((a) => a.action.tool === "archive_threads");
  const recommendedHere = useMemo(
    () =>
      shownThread && shownRecs
        ? shownRecommendations({
            settings: s,
            recommendations: shownRecs.actions,
            fromDomain: shownRecs.fromDomain,
            dismissed: new Set(dismissed[shownThread.id] ?? []),
            customArchives,
          }).filter(
            // A Custom action that forwards to the same person renders once, as the Custom action;
            // where the meeting chips show, they take the place of Add to calendar.
            (r) =>
              !(r.kind === "calendar" && meetingChipViews.length > 0) &&
              !(
                (r.kind === "forward" || r.kind === "delegate") &&
                threadActions.some(
                  (a) =>
                    a.action.tool === "forward_thread" &&
                    JSON.stringify(a.action.args).toLowerCase().includes(r.to.email.toLowerCase()),
                )
              ),
          )
        : [],
    [shownThread, shownRecs, s, dismissed, customArchives, threadActions, meetingChipViews],
  );
  const followUpHere =
    shownThread && followUps[shownThread.id]
      ? {
          label: fill(t("strings.actions.recommended.follow_up"), {
            when: formatWake(new Date(followUps[shownThread.id] as string), now),
          }),
          until: followUps[shownThread.id] as string,
        }
      : null;
  const menuWords = useMemo(
    () => ({
      notThis: t("strings.actions.recommended.not_this"),
      notFor: t("strings.actions.recommended.not_for"),
      remindPay: t("strings.actions.recommended.remind_pay"),
      file: t("strings.actions.recommended.file"),
      trackSnooze: t("strings.actions.recommended.track_snooze"),
    }),
    [t],
  );
  const payFileAction = s["actions.pay.file_action"];
  const clashWords = t("strings.actions.recommended.clashes");
  const chipRow = useMemo<ReaderChip[]>(
    () =>
      buildReaderChips({
        custom: threadActions.map((a) => a.reader),
        meetings: meetingChipViews.map((m) => ({
          kind: m.chip.kind,
          label: m.label,
          title: m.title,
        })),
        meetingMax: s["meetings.max_in_reader"],
        recommended: recommendedHere,
        followUp: followUpHere,
        max: s["actions.recommended.max_in_reader"],
        words: recWords,
        now,
        replyTemplate: replyTemplate?.name ?? null,
        replyWith,
        timeConfidence: s["actions.recommended.calendar.time_confidence"],
        menu: (rec) =>
          chipMenu(rec, shownRecs?.fromDomain ?? null, menuWords, {
            fileAction: payFileAction !== "" && customActions.some((a) => a.id === payFileAction),
          }),
      }).map((c) =>
        // An Invite that clashes says with what ("Clashes with Design review").
        c.kind === "recommended" && c.rec.kind === "rsvp" && c.rec.clash
          ? { ...c, title: fill(clashWords, { event: c.rec.clash }) }
          : c,
      ),
    [
      threadActions,
      meetingChipViews,
      s,
      recommendedHere,
      followUpHere,
      recWords,
      now,
      replyTemplate,
      replyWith,
      shownRecs,
      menuWords,
      payFileAction,
      customActions,
      clashWords,
    ],
  );
  // Every chip shown is a row the Server learns from, once per Thread version.
  const shownReported = useRef<string | null>(null);
  const shownKinds = chipRow.flatMap((c) => (c.kind === "recommended" ? [c.rec] : []));
  const shownKey = shownThreadId
    ? `${shownThreadId}:${newestMessageId}:${shownKinds.map((r) => r.kind).join(",")}`
    : null;
  useEffect(() => {
    if (!shownKey || !shownThreadId || shownKey === shownReported.current) return;
    shownReported.current = shownKey;
    if (shownKinds.length === 0) return;
    inbox.recommendationEvents?.({
      threadId: shownThreadId,
      shown: shownKinds.map((r) => ({ kind: r.kind, fit: r.fit, args: outcomeArgs(r) })),
    });
  });
  /** What the user did with a Thread some other way: each chip it showed was used, other_used or ignored. */
  const reportDone = useCallback(
    (threadId: string, done: RecommendationArgs) => {
      const held = inbox.recommendations?.(threadId);
      if (!held) return;
      for (const rec of held.actions) {
        const outcome = outcomeOf(rec, done);
        inbox.recommendationEvents?.({
          threadId,
          outcome: {
            kind: rec.kind,
            outcome,
            args: outcome === "ignored" ? outcomeArgs(rec) : outcomeArgs(done),
          },
        });
      }
    },
    [inbox],
  );
  doneRef.current = reportDone;
  const chipKeys = s["actions.recommended.keys"];

  /** Opens compose on a Thread (the reader's or a row's) with a seed; nothing is sent (ADR 0002). */
  const composeOn = useCallback(
    (threadId: string, kind: "reply" | "forward", seed: ComposeSeed) => {
      const target = inbox.thread(threadId);
      if (!target) return;
      setFocus(threadId);
      setReaderOpen(true);
      compose.startReply(target, inbox.messages(threadId), kind, false, seed);
    },
    [inbox, compose],
  );
  const recRunner = useMemo(
    () =>
      createRecommendationRunner({
        reply: (threadId, opening) => {
          // A Reply chip named by a Template opens the reply with that Template in it.
          if (replyTemplate?.threadId === threadId)
            queueTemplate(composer, replyTemplate.templateId);
          composeOn(threadId, "reply", opening ? { opening } : {});
        },
        // A forward to the person with a short note from the Brief; the user still sends.
        forward: (threadId, to) =>
          composeOn(threadId, "forward", {
            to: [to],
            opening: handOverNote(
              {
                note: t("strings.actions.recommended.forward_note"),
                plain: t("strings.actions.recommended.forward_note_plain"),
              },
              to,
              (threadId === shownThreadId ? brief : inbox.brief(threadId))?.bullets,
            ),
          }),
        // Ask: a forward to the person asking them to answer; the user still sends.
        handOff: (threadId, to: Person) => {
          composeOn(threadId, "forward", {
            to: [to],
            opening: handOverNote(
              {
                note: t("strings.actions.recommended.ask_note"),
                plain: t("strings.actions.recommended.ask_note_plain"),
              },
              to,
              (threadId === shownThreadId ? brief : inbox.brief(threadId))?.bullets,
            ),
          });
          const until = followUpUntil(
            now,
            s["actions.delegate.follow_up_days"],
            s["inbox.snooze.morning_hour"],
          );
          if (until) setFollowUps((f) => ({ ...f, [threadId]: until.toISOString() }));
        },
        archive: (threadId) => inbox.archive([threadId]),
        snooze: (threadId, until) => inbox.snooze([threadId], until),
        pickSnooze: (threadId) => openPicker("snooze", [threadId]),
        replyLine: (threadId) =>
          (threadId === shownThreadId ? brief?.replyLine : inbox.brief(threadId)?.replyLine) ??
          null,
        openLink: (url) => openExternal(url),
        timeConfidence: s["actions.recommended.calendar.time_confidence"],
        ...(calendar
          ? {
              rsvp: (inviteId: string, response: "accepted" | "tentative" | "declined") =>
                calendar.rsvp(inviteId, response),
              // The chip is the user's own click and invites nobody: the Event goes on their calendar.
              createEvent: async (event: { title: string; start: string; end: string }) => {
                await calendar.create({
                  ...event,
                  timeZone: deviceZone ?? "UTC",
                });
              },
            }
          : {}),
        openEditor: ({ day, title }: { day: string; title: string }) => {
          const start = new Date(`${day}T09:00:00`);
          const end = new Date(start.getTime() + s["actions.calendar.default_minutes"] * 60_000);
          onNavigate?.(
            calendarNewTarget({
              start: start.toISOString(),
              end: end.toISOString(),
              title,
              attendees: [],
            }),
          );
        },
        unsubscribe: (threadId, rec) => {
          // A list with only a page opens in the browser; monday never fetches it.
          if (rec.method === "browser") {
            void openExternal(rec.target);
            return;
          }
          setUnsubCard({ threadId, rec, exit: null, status: "asking" });
          void inbox
            .listExit?.(threadId)
            .then((exit) =>
              setUnsubCard((c) => (c && c.threadId === threadId ? { ...c, exit } : c)),
            );
        },
        runWorkflow: (workflowId, threadId) =>
          inbox.runWorkflow ? inbox.runWorkflow(workflowId, threadId) : Promise.reject(),
      }),
    [
      composeOn,
      replyTemplate,
      composer,
      t,
      now,
      s,
      inbox,
      openPicker,
      shownThreadId,
      brief,
      calendar,
      deviceZone,
      onNavigate,
    ],
  );
  /**
   * What a View's action buttons act through (docs/spec/views.md, "Actions on
   * items"): the same InboxActions, compose, Custom action runner, Workflow
   * runner and calendar as the reader's chips; nothing is sent from here.
   */
  const viewHost = useMemo((): InboxViewHost => {
    const customOn = createCustomActionRunner({
      inbox,
      compose: (kind, threadId, seed) => composeOn(threadId, kind, seed),
      groups: () => groups,
      tags: () => tags,
    });
    return {
      archive: (ids) => inbox.archive(ids),
      markRead: (ids, read) => (read ? inbox.markRead(ids) : inbox.markUnread(ids)),
      snooze: (ids, until) => inbox.snooze(ids, until),
      move: (ids, groupId) => inbox.moveToGroup(ids, groupId),
      tag: async (ids, name) => {
        const found = tags.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
        if (!found || !inbox.setTags) return "unavailable";
        const setTags = inbox.setTags;
        let last: UndoToken | null = null;
        for (const id of ids) {
          const current = inbox.thread(id)?.tags ?? [];
          last = await setTags([id], [...new Set([...current, found.id])]);
        }
        return last;
      },
      compose: (kind, threadId, seed) => {
        if (seed.templateId) queueTemplate(composer, seed.templateId);
        composeOn(threadId, kind, seed.to ? { to: seed.to } : {});
      },
      runWorkflow: (workflowId, threadId, inputs) =>
        inbox.runWorkflow ? inbox.runWorkflow(workflowId, threadId, inputs) : Promise.reject(),
      customAction: async (actionId, threadId) => {
        const action = s["actions.custom"].find((a) => a.id === actionId);
        const target = inbox.thread(threadId);
        if (!action || !target) return false;
        return (await customOn.run(action, target)).ok;
      },
      openLink: (url) => openExternal(url),
      ...(calendar
        ? {
            createEvent: async (event: { title: string; start: string; end: string }) => {
              await calendar.create({ ...event, timeZone: deviceZone ?? "UTC" });
            },
          }
        : {}),
      toast: (text, undo) => showToast(text, undo),
    };
  }, [inbox, composeOn, groups, tags, composer, s, calendar, deviceZone, showToast]);
  /** Runs a Recommended action as its tool call; a Thread that changed since is checked again first. */
  const runRecommended = useCallback(
    async (threadId: string, rec: Recommendation, option?: string) => {
      const held = inbox.recommendations?.(threadId);
      const current = inbox.thread(threadId);
      const key = `${threadId}:${rec.kind}`;
      if (
        held &&
        current &&
        held.messageCount !== current.messageCount &&
        recheck.current !== key
      ) {
        recheck.current = key;
        void inbox.askRecommendations?.(threadId, deviceZone ?? undefined);
        showToast(
          fill(t("strings.actions.recommended.changed"), {
            label: recommendedChipLabel(rec, recWords, now),
          }),
          null,
        );
        return;
      }
      recheck.current = null;
      // A payment page opens only after its domain was shown: the first click arms, the second opens.
      if (rec.kind === "pay" && rec.link && armed.current !== key) {
        armed.current = key;
        showToast(
          fill(t("strings.actions.recommended.pay_opens"), { domain: rec.link.domain }),
          null,
        );
        return;
      }
      armed.current = null;
      const outcome = await recRunner.run(rec, threadId, option);
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
      // The card asks first; the chip is used once the user approves it there.
      if (outcome.applied !== "card") {
        inbox.recommendationEvents?.({
          threadId,
          outcome: { kind: rec.kind, outcome: "used", args: outcomeArgs(rec) },
        });
      }
      if (outcome.applied === "calendar" && rec.kind === "calendar") {
        showToast(
          fill(t("strings.actions.recommended.calendar_added"), { title: rec.title }),
          null,
        );
      } else if (outcome.applied === "workflow" && rec.kind === "workflow") {
        showToast(
          fill(t("strings.actions.recommended.workflow_started"), { workflow: rec.name }),
          null,
        );
      }
      if (outcome.applied === "archive") {
        advanceAfter([threadId]);
        showToast(t("strings.inbox.toast.archived"), outcome.undo);
      } else if (outcome.applied === "snooze" && outcome.until) {
        advanceAfter([threadId]);
        showToast(
          fill(t("strings.inbox.toast.snoozed"), {
            when: formatWake(new Date(outcome.until), now),
          }),
          outcome.undo,
        );
      }
    },
    [inbox, deviceZone, showToast, t, recWords, now, recRunner, advanceAfter],
  );
  /** A chip's menu: "Not this", "Not for mail from X", and the action's own items. */
  const runChipMenu = useCallback(
    (threadId: string, rec: Recommendation, item: string, fromDomain: string | null) => {
      if (item === "not_this" || item === "not_for") {
        setDismissed((d) => ({ ...d, [threadId]: [...(d[threadId] ?? []), rec.kind] }));
        inbox.recommendationEvents?.({
          threadId,
          outcome: { kind: rec.kind, outcome: "dismissed", args: outcomeArgs(rec) },
        });
        if (item === "not_for" && fromDomain) {
          const key = `actions.recommended.${rec.kind}.muted_senders` as const;
          const muted = s[key];
          if (!muted.includes(fromDomain)) void shell.set(key, [...muted, fromDomain]);
        }
        return;
      }
      if (item === "remind" && rec.kind === "pay") {
        void runRecommended(threadId, { ...rec, link: null });
        return;
      }
      if (item === "file") {
        void runCustomAction(payFileAction);
        return;
      }
      if (item === "delivery" && rec.kind === "track" && rec.deliveryDay) {
        const day = new Date(rec.deliveryDay);
        day.setHours(s["inbox.snooze.morning_hour"], 0, 0, 0);
        void runRecommended(threadId, {
          kind: "snooze",
          until: day.toISOString(),
          anchor: "date",
          fit: rec.fit,
          rank: rec.rank,
        });
      }
    },
    [inbox, s, shell, runRecommended, runCustomAction, payFileAction],
  );
  /** The unsubscribe card's answer: approved, the exact request goes through the tool; else nothing. */
  const answerUnsubscribe = useCallback(
    async (approve: boolean) => {
      const card = unsubCard;
      if (!card) return;
      if (!approve || !card.exit || card.exit.method === "browser") {
        setUnsubCard(null);
        return;
      }
      if (card.status !== "asking") return;
      setUnsubCard({ ...card, status: "running" });
      const result = (await inbox.unsubscribe?.(card.threadId, {
        method: card.exit.method,
        target: card.exit.target,
      })) ?? { ok: false, text: "" };
      if (result.ok) {
        inbox.recommendationEvents?.({
          threadId: card.threadId,
          outcome: { kind: "unsubscribe", outcome: "used" },
        });
        showToast(
          fill(t("strings.actions.recommended.unsubscribed"), { list: card.exit.listName }),
          null,
        );
      }
      setUnsubCard({
        ...card,
        status: result.ok ? "done" : "failed",
        text: result.ok ? undefined : t("strings.actions.recommended.unsubscribe_failed"),
      });
    },
    [unsubCard, inbox, showToast, t],
  );
  /** After leaving a list: its issues still in the Inbox, archived together with Undo. */
  const archiveIssues = useCallback(async () => {
    const card = unsubCard;
    if (!card?.exit || !inbox.listThreads) return;
    const ids = await inbox.listThreads(card.exit.listId);
    setUnsubCard(null);
    if (ids.length > 0) request("archive", ids);
  }, [unsubCard, inbox, request]);
  const runFollowUp = useCallback(
    async (threadId: string, until: string) => {
      setFollowUps(({ [threadId]: _gone, ...rest }) => rest);
      const token = await inbox.snooze([threadId], new Date(until));
      advanceAfter([threadId]);
      showToast(
        fill(t("strings.inbox.toast.snoozed"), { when: formatWake(new Date(until), now) }),
        token,
      );
    },
    [inbox, advanceAfter, showToast, t, now],
  );
  /** One chip of the reader's row, by its kind; `option` is an RSVP's answer. */
  const runChip = useCallback(
    (chip: ReaderChip, option?: string) => {
      if (!shownThread) return;
      if (chip.kind === "custom") void runCustomAction(chip.id);
      else if (chip.kind === "meeting") {
        const view = meetingChipViews[chip.index];
        if (view && shownMeeting) void runMeeting(shownThread.id, view.chip, shownMeeting);
      } else if (chip.kind === "recommended") {
        // An RSVP's key or plain click opens nothing by itself: the user picks the answer.
        if (chip.rec.kind === "rsvp" && !option) return;
        void runRecommended(shownThread.id, chip.rec, option);
      } else void runFollowUp(shownThread.id, chip.until);
    },
    [
      shownThread,
      runCustomAction,
      meetingChipViews,
      shownMeeting,
      runMeeting,
      runRecommended,
      runFollowUp,
    ],
  );
  /** A row's one suggestion: its meeting chip when it has one, else its top Recommended action. */
  const rowRecommendation = useCallback(
    (th: Thread): Recommendation | null => {
      if (listMode(s) === "off") return null;
      const held = inbox.recommendations?.(th.id);
      if (!held) return null;
      return (
        shownRecommendations({
          settings: s,
          // A row cannot hold the RSVP's three answers, and monday does not pick one.
          recommendations: held.actions.filter((r) => r.kind !== "rsvp"),
          fromDomain: held.fromDomain,
          dismissed: new Set(dismissed[th.id] ?? []),
        })[0] ?? null
      );
    },
    [inbox, s, dismissed],
  );

  // The selection's Threads the list holds, and the custom actions every one
  // of them carries (the selection bar's More menu). One that hands a draft
  // to compose stays with one Thread at a time, in the reader.
  const selectedHeld = useMemo(() => heldOf(selection), [heldOf, selection]);
  const selectionActions = useMemo<CustomActionSetting[]>(() => {
    if (allMode || selectedHeld.length === 0 || selectedHeld.length !== selection.length) return [];
    const per = selectedHeld.map((th) =>
      customActionsFor(customActions, th, {
        groupNames,
        judged: inbox.judged?.(th.id),
        judgeThreshold,
      }).filter((a) => a.tool !== "forward_thread" && a.tool !== "draft_message"),
    );
    const [first, ...rest] = per;
    return (first ?? []).filter((a) => rest.every((list) => list.some((b) => b.id === a.id)));
  }, [allMode, selectedHeld, selection.length, customActions, groupNames, inbox, judgeThreshold]);
  customBatch.current = async (actionId, ids) => {
    const action = customActions.find((a) => a.id === actionId);
    if (!action) return;
    const tokens: UndoToken[] = [];
    let failed = 0;
    for (const th of heldOf(ids)) {
      const outcome = await customRunner.run(action, th);
      if (!outcome.ok) failed += 1;
      else if (outcome.undo) tokens.push(outcome.undo);
    }
    if (tokens.length === 0 && failed > 0) {
      showToast(fill(t("strings.actions.toast.unavailable"), { label: action.label }), null);
      return;
    }
    if (
      action.tool === "archive_threads" ||
      action.tool === "snooze_threads" ||
      action.tool === "trash_threads"
    ) {
      advanceAfter(ids);
    }
    let token: UndoToken | null = tokens[0] ?? null;
    if (tokens.length > 1) {
      token = `several:${tokens.join("+")}`;
      multiUndo.current.set(token, tokens);
    }
    showToast(
      countText(fill(t("strings.actions.toast.done"), { label: action.label }), ids.length),
      token,
    );
  };

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
  /**
   * Runs fn on the Threads an action applies to: the whole list over the
   * Cache under "Select all N", else the selection or the focus row.
   */
  const withTargets = (fn: (ids: string[]) => void) => {
    if (allMode && inbox.listIds) {
      void inbox.listIds(listKey).then(fn);
      return;
    }
    fn(acting());
  };
  /** X or a row's checkbox: one row joins or leaves; under "Select all N" the rest of the rows shown stay. */
  const toggleRow = (id: string, range = false) => {
    if (allMode) {
      setSelectAll(null);
      setSelection(order.filter((x) => x !== id));
    } else {
      setSelection(
        range ? rangeSelect(order, selection, anchor.current, id) : toggleSelected(selection, id),
      );
    }
    anchor.current = id;
  };

  /* ------------------------------ The phone form ------------------------------ */

  // One column at a time: the reader and the agent sheet are layers back
  // closes, and the list takes touch: a swipe runs inbox.swipe.right or
  // inbox.swipe.left with the usual Undo, a long press starts a selection,
  // and a pull from the top syncs.
  const phone = shell.form === "phone";
  useBack(phone && showReader, () => setReaderOpen(false));
  useBack(phone && agentOpen, () => setAgentOpen(false));
  const listRef = useRef<HTMLElement>(null);
  const swipeAct = (id: string, direction: SwipeDirection) => {
    const action = s[direction === "right" ? "inbox.swipe.right" : "inbox.swipe.left"];
    if (action === "archive") request(folder === "archive" ? "unarchive" : "archive", [id]);
    else if (action === "delete") request("delete", [id]);
    else if (action === "snooze") openPicker("snooze", [id]);
    else if (action === "read") toggleRead([id]);
    else if (action === "star") toggleStar([id]);
  };
  const gestures = useListGestures(listRef, {
    enabled: phone,
    distance: s["inbox.swipe.distance_px"],
    longPressMs: s["inbox.long_press_ms"],
    pullPx: s["inbox.pull_refresh_px"],
    onSwipe: swipeAct,
    onLongPress: (id) => {
      setFocus(id);
      if (!selection.includes(id)) toggleRow(id);
    },
    onPull: onRefresh,
  });
  /** The row whose actions button opened the row menu, with its suggested action. */
  const rowMenu = useRef<{ id: string; chip: { label: string; onRun: () => void } | null }>({
    id: "",
    chip: null,
  });

  const handlers: KeyHandlers = {
    "move.down": () => {
      if (overlay) return false;
      // Walking near the end of what the list holds reads its next Threads.
      if (!searching && focus !== null && order.indexOf(focus) >= order.length - 1 - growAt) {
        readMore();
      }
      setFocus(neighbor(order, focus, 1));
    },
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
      else if (selection.length) clearSelection();
      else if (searching) closeSearch();
      else if (filterChips.length) setFilterChips(filterChips.slice(0, -1));
    },
    "thread.archive": () => !overlay && withTargets((ids) => request("archive", ids)),
    "thread.snooze": () => !overlay && withTargets((ids) => openPicker("snooze", ids)),
    "thread.delete": () => !overlay && withTargets((ids) => request("delete", ids)),
    "thread.star": () => !overlay && withTargets(toggleStar),
    "thread.toggle_read": () => !overlay && withTargets(toggleRead),
    "thread.label": () => {
      if (overlay) return false;
      setPaletteQuery(t("strings.inbox.action.label"));
      setPaletteOpen(true);
    },
    "thread.move": () => !overlay && withTargets((ids) => openPicker("move", ids)),
    "list.filter": () => {
      if (overlay) return false;
      openPicker("filter", []);
    },
    "compose.new": () => !overlay && compose.openNew(),
    "compose.reply": () => !overlay && focus && startReply("reply"),
    "compose.reply_all": () => !overlay && focus && startReply("reply", true),
    "compose.forward": () => !overlay && focus && startReply("forward"),
    "select.toggle": () => !overlay && focus && toggleRow(focus),
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

  // The chip keys (actions.recommended.keys, docs/spec/actions.md): with a Thread open they run
  // the reader's chips in order; in the list, the selected row's chip. Read at press time.
  const chipKeysLive = useRef({
    chipRow,
    runChip,
    rowRecommendation,
    runRecommended,
    focus,
    overlay,
    shown: shownThreadId,
  });
  chipKeysLive.current = {
    chipRow,
    runChip,
    rowRecommendation,
    runRecommended,
    focus,
    overlay,
    shown: shownThreadId,
  };
  const activePane = useIsActivePane();
  const chipKeysOn = useRef(activePane);
  chipKeysOn.current = activePane;
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!chipKeysOn.current || e.defaultPrevented || e.isComposing) return;
      if (isTypingTarget(e.target)) return;
      const live = chipKeysLive.current;
      if (live.overlay) return;
      const index = recommendedKeyIndex(s["actions.recommended.keys"], e);
      if (index < 0) return;
      if (live.shown) {
        const chip = live.chipRow[index];
        if (!chip) return;
        e.preventDefault();
        live.runChip(chip);
        return;
      }
      const row = live.focus ? inbox.thread(live.focus) : undefined;
      const rec = row && index === 0 ? live.rowRecommendation(row) : null;
      if (!row || !rec) return;
      e.preventDefault();
      void live.runRecommended(row.id, rec);
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [inbox, s]);

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
        else if (command.action.startsWith("template:")) {
          // A Template from the palette: a reply on the open Thread, else a new Message.
          const picked = templateLink?.library.find((x) => `template:${x.id}` === command.action);
          if (!picked) break;
          queueTemplate(composer, picked.id);
          if (picked.kind === "reply" && thread) startReply("reply");
          else compose.openNew();
        } else if (command.action.startsWith("chip:")) {
          // A chip of the open Thread from the palette ("Snooze until Mon 09:00"): run as if clicked.
          const chip = chipRow.find((c) => `chip:${c.key}` === command.action);
          if (chip) runChip(chip);
        } else if (command.action === "workflow.from_thread") {
          askAgent(t("strings.palette.workflow_from_thread"));
        }
        break;
      case "navigate":
        onNavigate?.(command.target);
        break;
      case "open":
        openAnywhere(command.threadId);
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
        fallback: intent.text,
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
      askAgent(card.fallback);
      return;
    }
    setIntentCard({ ...card, status: "running" });
    try {
      // A meeting's card leaves the link off when meetings.add_link says so.
      const link = card.meeting && !s["meetings.add_link"] ? "none" : s["calendar.meeting_link"];
      await calendar.create({
        title: card.preview.title,
        start: card.preview.start,
        end: card.preview.end,
        timeZone: card.preview.timeZone,
        attendees: card.preview.attendees,
        ...(link === "provider" ? {} : { meetingLink: link }),
      });
      setIntentCard({ ...card, status: "done", result: t("strings.agent.applied") });
      if (card.meeting) {
        // Scheduled: the Schedule chip goes, the "works for me" reply chip stays.
        const threadId = card.meeting.threadId;
        setMeetingDone((d) => ({ ...d, [threadId]: true }));
        showToast(fill(t("strings.meetings.scheduled"), { title: card.preview.title }), null);
      } else {
        showToast(
          fill(t("strings.reader.brief_action.calendar_added"), { title: card.preview.title }),
          null,
        );
      }
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
  /** Opens a Thread here, read from the Cache when the list does not hold it; elsewhere when there is none. */
  function openAnywhere(id: string, messageId?: string | null) {
    setFocusMessage(messageId ? { thread: id, message: messageId } : null);
    if (inbox.thread(id)) return open(id);
    if (!inbox.resolve) return onNavigate?.(`thread:${id}`);
    void inbox.resolve(id).then((found) => {
      if (found) open(id);
      else onNavigate?.(`thread:${id}`);
    });
  }
  const runtime = runtimeLine(agent.runtimeInfo, s, ws.address);
  const agentStrings = useMemo(() => composerStrings(s), [s]);
  const chips = useMemo(
    () =>
      suggestionsFor({
        settings: s,
        waiting: agent.waiting,
        external: externalPending,
        // Sections are decided on the client, so this counts within the Threads the list holds.
        needsReply: sectionsOn ? threads.filter((th) => th.section === "needs-reply") : [],
      }),
    [s, agent.waiting, externalPending, threads, sectionsOn],
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
    view?.name ??
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
  const headCount = searching
    ? order.length
    : filtering
      ? // Counted over the whole Cache, unless a filter here narrows the list further.
        !needsReplyOn && !sectionLens && filteredTotal !== null
        ? filteredTotal
        : order.length
      : threads.length;
  /** An action's name with its key, for a tooltip. */
  const titled = (label: string, action: KeyAction) => {
    const k = key(action);
    return k ? `${label} (${k})` : label;
  };
  const checkLabel = titled(t("strings.inbox.select.row"), "select.toggle");
  const firstChip = filterChips[0];
  const olderMissing = older.reduce((n, o) => n + o.missing, 0);
  const renderItem = (item: ListItem) => {
    const { thread: th, leaving } = item.row;
    const checked = allMode || selection.includes(th.id);
    // At most one suggested action on a row (docs/spec/actions.md): the Cache's meeting chip,
    // else the row's top Recommended action, on hover by default.
    const meetingChip = meetingsLive ? listMeetingChip(inbox.meeting?.(th.id), s, now) : null;
    const rowRec = meetingChip ? null : rowRecommendation(th);
    const rowChip = meetingChip
      ? { label: meetingChip.label, onRun: () => void runMeeting(th.id, meetingChip.chip, null) }
      : rowRec
        ? {
            label: recommendedChipLabel(rowRec, recWords, now),
            onRun: () => void runRecommended(th.id, rowRec),
          }
        : null;
    return (
      <MessageRow
        onMore={
          phone
            ? (id) => {
                rowMenu.current = { id, chip: rowChip };
                setFocus(id);
                openPicker("row", [id]);
              }
            : undefined
        }
        moreLabel={t("strings.phone.row_more")}
        key={th.id}
        thread={th}
        draft={draftThreads.has(th.id) ? t("strings.drafts.badge") : undefined}
        tags={tagsOf(th)}
        selected={th.id === focus}
        className={
          [checked && "picked", leaving && "leaving"].filter(Boolean).join(" ") || undefined
        }
        checked={checked}
        checkLabel={checkLabel}
        onCheck={(id, e) => toggleRow(id, e.shiftKey)}
        now={now}
        titles={rowTitles}
        highlight={highlight}
        action={
          meetingChip
            ? {
                label: meetingChip.label,
                title: meetingChip.title,
                always: meetingChip.always,
                onRun: () => void runMeeting(th.id, meetingChip.chip, null),
              }
            : rowRec
              ? {
                  label: recommendedChipLabel(rowRec, recWords, now),
                  // The first chip key runs the selected row's chip.
                  ...(chipKeys[0]
                    ? {
                        title: `${recommendedChipLabel(rowRec, recWords, now)} (${chordLabel(normalizeChord(chipKeys[0]), mac)})`,
                      }
                    : {}),
                  always: listMode(s) === "always",
                  onRun: () => void runRecommended(th.id, rowRec),
                }
              : undefined
        }
        onOpen={(id) => {
          // On a phone, while a selection is open, a tap picks a row instead of opening it.
          if (phone && selecting) {
            toggleRow(id);
            return;
          }
          if (searching && search) void search.remember(searchText);
          // A full search hit may be a Thread the list does not hold: read it
          // from the Cache like any Thread outside the window.
          if (searching) openAnywhere(id);
          else open(id);
        }}
        onArchive={(id) => request("archive", [id])}
        onSnooze={(id) => openPicker("snooze", [id])}
        onDragStart={(id, e) => {
          const ids = selection.includes(id) ? selection : [id];
          writeThreadDrag(
            e.dataTransfer,
            ids.map((x) => ({ id: x, subject: inbox.thread(x)?.subject ?? "" })),
          );
          // The Agent lights up as the place to drop while the drag lasts.
          document.documentElement.setAttribute("data-dragging", "threads");
        }}
        onDragEnd={() => document.documentElement.removeAttribute("data-dragging")}
        onAsk={() => {
          setFocus(th.id);
          focusAgent();
        }}
      />
    );
  };

  const shownBatch = batchExit.value;
  // Over the whole list the preview names the Threads held; the count says how many in all.
  const batchThreads = shownBatch
    ? shownBatch.ids.flatMap((id) => {
        const th = liveById.get(id) ?? (shownBatch.byQuery ? undefined : inbox.thread(id));
        return th ? [th] : [];
      })
    : [];
  const batchAction = !shownBatch
    ? ""
    : shownBatch.kind === "custom"
      ? (customActions.find((a) => a.id === shownBatch.action)?.label ?? "")
      : t(BATCH_WORD[shownBatch.kind]);

  /* The selection bar: what is selected, and what applies to all of it. */
  const selectedSet = new Set(selection);
  const shownPicked = allMode ? order.length : order.filter((id) => selectedSet.has(id)).length;
  const shownState: "none" | "some" | "all" =
    allMode || (order.length > 0 && shownPicked === order.length)
      ? "all"
      : shownPicked > 0
        ? "some"
        : "none";
  // Read and star show the one that fits most of the selection; the other is under More.
  const unreadHeld = selectedHeld.filter((th) => th.unread).length;
  const readFirst: FlagKind = unreadHeld * 2 >= selectedHeld.length ? "read" : "unread";
  const starFirst: FlagKind =
    selectedHeld.length > 0 && selectedHeld.every((th) => th.starred) ? "unstar" : "star";
  const readOther: FlagKind = readFirst === "read" ? "unread" : "read";
  const starOther: FlagKind = starFirst === "star" ? "unstar" : "star";
  const onBar = (kind: BatchKind) => () => withTargets((ids) => request(kind, ids));
  const moreItems = [
    { key: readOther, label: t(BATCH_WORD[readOther]) },
    { key: starOther, label: t(BATCH_WORD[starOther]) },
    { key: "label", label: t("strings.inbox.action.label"), detail: key("thread.label") },
    ...selectionActions.map((a) => ({
      key: `custom:${a.id}`,
      label: a.label,
      detail:
        customActionTier(a, alwaysAsk) === "always-ask"
          ? t("strings.actions.tier.always_ask")
          : undefined,
    })),
  ];
  /** A custom action from the More menu: one that asks first confirms on a second pick, as in the reader. */
  const pickSelectionAction = (actionId: string) => {
    const action = selectionActions.find((a) => a.id === actionId);
    if (!action) return;
    const asked = confirming?.id === actionId && confirming.threadId === SELECTION;
    if (customActionTier(action, alwaysAsk) === "always-ask" && !asked) {
      setConfirming({ id: actionId, threadId: SELECTION });
      showToast(fill(t("strings.actions.toast.confirm"), { label: action.label }), null);
      return;
    }
    setConfirming(null);
    withTargets((ids) => request("custom", ids, undefined, { action: actionId }));
  };
  const pickMore = (k: string) => {
    closePicker();
    if (k === "label") {
      setPaletteQuery(t("strings.inbox.action.label"));
      setPaletteOpen(true);
    } else if (k.startsWith("custom:")) {
      pickSelectionAction(k.slice("custom:".length));
    } else if (k === "read" || k === "unread" || k === "star" || k === "unstar") {
      withTargets((ids) => request(k, ids));
    }
  };
  /** The row menu's items: the hover actions, the row's suggested action, and Select. */
  const rowMenuItems = () => {
    const th = inbox.thread(rowMenu.current.id) ?? liveById.get(rowMenu.current.id);
    const chip = rowMenu.current.chip;
    return [
      ...(chip ? [{ key: "chip", label: chip.label }] : []),
      folder === "archive"
        ? { key: "unarchive", label: t("strings.inbox.select.unarchive") }
        : { key: "archive", label: t("strings.inbox.action.archive") },
      { key: "snooze", label: t("strings.inbox.action.snooze") },
      { key: "delete", label: t("strings.inbox.action.delete") },
      {
        key: th?.unread ? "read" : "unread",
        label: t(th?.unread ? "strings.inbox.action.read" : "strings.inbox.action.unread"),
      },
      {
        key: th?.starred ? "unstar" : "star",
        label: t(th?.starred ? "strings.inbox.action.unstar" : "strings.inbox.action.star"),
      },
      { key: "move", label: t("strings.inbox.move.title") },
      ...(aiOff ? [] : [{ key: "ask", label: t("strings.inbox.action.ask") }]),
      { key: "select", label: t("strings.phone.select") },
    ];
  };
  const pickRow = (k: string) => {
    const id = rowMenu.current.id;
    closePicker();
    if (!id) return;
    if (k === "chip") rowMenu.current.chip?.onRun();
    else if (k === "snooze" || k === "move") openPicker(k, [id]);
    else if (k === "ask") {
      setFocus(id);
      focusAgent();
    } else if (k === "select") toggleRow(id);
    else if (
      k === "archive" ||
      k === "unarchive" ||
      k === "delete" ||
      k === "read" ||
      k === "unread" ||
      k === "star" ||
      k === "unstar"
    ) {
      request(k, [id]);
    }
  };
  const selectionBar = selecting ? (
    <SelectionBar
      label={t("strings.inbox.select.bar")}
      title={
        allMode
          ? fill(t("strings.inbox.select.all_selected"), {
              n: (selTotal ?? selection.length).toLocaleString("en-US"),
              list: listTitle,
            })
          : fill(t("strings.inbox.selected"), { n: selection.length })
      }
      shown={shownState}
      checkLabel={t(
        shownState === "all" ? "strings.inbox.select.none" : "strings.inbox.select.all",
      )}
      onCheck={() => {
        if (shownState === "all") clearSelection();
        else setSelection([...selection, ...order.filter((id) => !selectedSet.has(id))]);
      }}
      offer={
        !allMode && shownState === "all" && byQuery && selTotal !== null && selTotal > order.length
          ? {
              label: fill(t("strings.inbox.select.all_in_list"), {
                n: selTotal.toLocaleString("en-US"),
                list: listTitle,
              }),
              onClick: () => setSelectAll(listKey),
            }
          : undefined
      }
      actions={[
        folder === "archive"
          ? {
              key: "unarchive",
              label: t("strings.inbox.select.unarchive"),
              title: t("strings.inbox.select.unarchive"),
              icon: <TrayArrowUpIcon />,
              onClick: onBar("unarchive"),
            }
          : {
              key: "archive",
              label: t("strings.inbox.action.archive"),
              title: titled(t("strings.inbox.action.archive"), "thread.archive"),
              icon: <ArchiveIcon />,
              onClick: onBar("archive"),
            },
        {
          key: "delete",
          label: t("strings.inbox.action.delete"),
          title: titled(t("strings.inbox.action.delete"), "thread.delete"),
          icon: <TrashIcon />,
          onClick: onBar("delete"),
        },
        {
          key: readFirst,
          label: t(BATCH_WORD[readFirst]),
          title: titled(t(BATCH_WORD[readFirst]), "thread.toggle_read"),
          icon: readFirst === "read" ? <EnvelopeSimpleOpenIcon /> : <EnvelopeSimpleIcon />,
          onClick: onBar(readFirst),
        },
        {
          key: starFirst,
          label: t(BATCH_WORD[starFirst]),
          title: titled(t(BATCH_WORD[starFirst]), "thread.star"),
          icon: <StarIcon weight={starFirst === "unstar" ? "fill" : "regular"} />,
          onClick: onBar(starFirst),
        },
        {
          key: "snooze",
          label: t("strings.inbox.action.snooze"),
          title: titled(t("strings.inbox.action.snooze"), "thread.snooze"),
          icon: <ClockIcon />,
          onClick: () => withTargets((ids) => openPicker("snooze", ids)),
        },
        {
          key: "move",
          label: t("strings.inbox.move.title"),
          title: titled(t("strings.inbox.move.title"), "thread.move"),
          icon: <FolderSimpleIcon />,
          onClick: () => withTargets((ids) => openPicker("move", ids)),
        },
      ]}
      more={{ label: t("strings.inbox.select.more"), onClick: () => openPicker("more", []) }}
      clear={{
        label: t("strings.inbox.select.clear"),
        title: titled(t("strings.inbox.select.clear"), "sheet.close"),
        onClick: clearSelection,
      }}
    />
  ) : null;

  return (
    <div
      className={`main inbox ${stream && readerExit.mounted ? "has-sheet" : ""}`}
      data-pane={pane}
    >
      <section
        ref={listRef}
        className={`col list${selecting ? " selecting" : ""}`}
        data-fields={fields}
        data-pull={gestures.pull === "idle" ? undefined : gestures.pull}
        aria-label={listTitle}
        onPointerOver={onListPointerOver}
      >
        {selectionBar ?? (
          <ColHead title={listTitle} count={headCount} leading={<DrawerButton />}>
            {view ? view.header : null}
            {view ? null : (
              <>
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
                    on={filtering}
                    className="filter-btn"
                    aria-haspopup="menu"
                    title={`${t("strings.inbox.filter")} (${key("list.filter")})`}
                    onClick={() => openPicker("filter", [])}
                  >
                    <FunnelSimpleIcon />{" "}
                    {filterChips.length === 1 && firstChip
                      ? chipLabel(firstChip, t, now)
                      : t("strings.inbox.filter")}
                    {filterChips.length > 1 ? (
                      <span className="filter-n">{filterChips.length}</span>
                    ) : null}
                  </Btn>
                ) : null}
              </>
            )}
            {phone ? (
              // The phone has no sidebar on show: New message sits in the list header.
              <Btn
                icon
                className="phone-compose"
                title={t("strings.phone.compose")}
                aria-label={t("strings.phone.compose")}
                onClick={() => compose.openNew()}
              >
                <PencilSimpleLineIcon />
              </Btn>
            ) : null}
          </ColHead>
        )}
        <FilterChips chips={filterChips} t={t} now={now} onChange={setFilterChips} />
        {pickerExit.value === "filter" ? (
          <FilterMenu
            chips={filterChips}
            t={t}
            now={now}
            needsReply={sectionsOn}
            facets={facets}
            onChange={setFilterChips}
            onClose={closePicker}
            leaving={pickerExit.leaving}
            onLeft={pickerExit.onEnd}
          />
        ) : null}
        {pickerExit.value === "more" ? (
          <Picker
            label={t("strings.inbox.select.more")}
            items={moreItems}
            onPick={pickMore}
            onClose={closePicker}
            leaving={pickerExit.leaving}
            onLeft={pickerExit.onEnd}
          />
        ) : null}
        {pickerExit.value === "row" ? (
          // A row's actions on touch, where the hover actions never show.
          <Picker
            label={t("strings.phone.row_more")}
            items={rowMenuItems()}
            onPick={pickRow}
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
              request("move", pickerIds, undefined, { group: k === "" ? null : k });
            }}
            onClose={closePicker}
            leaving={pickerExit.leaving}
            onLeft={pickerExit.onEnd}
          />
        ) : null}
        {view ? (
          <div className="view-body" role="listbox" aria-label={listTitle} tabIndex={-1}>
            {view.above}
            {view.render({
              row: (th) => renderItem({ key: th.id, row: { thread: th, leaving: false } }),
              focus,
              open: openAnywhere,
              host: viewHost,
            })}
          </div>
        ) : (
          <VirtualList
            role="listbox"
            aria-label={listTitle}
            items={items}
            render={renderItem}
            overscan={s["inbox.overscan_rows"]}
            focusKey={focus}
            scrollKey={searching ? "search" : `stream:${listKey}|${needsReplyOn}`}
            onNearEnd={searching ? undefined : readMore}
            nearEnd={growAt}
            layoutKey={`${shell.density}|${stream ? "stream" : "split"}|${fields}`}
            before={
              <>
                {gestures.pull !== "idle" ? (
                  <div
                    className="pull"
                    role="status"
                    data-state={gestures.pull}
                    style={{ height: gestures.pulled }}
                  >
                    {t(
                      gestures.pull === "syncing"
                        ? "strings.phone.syncing"
                        : gestures.pull === "ready"
                          ? "strings.phone.release"
                          : "strings.phone.pull",
                    )}
                  </div>
                ) : null}
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
                {searching && olderRun ? (
                  <div
                    className="search-older"
                    role="status"
                    aria-live="polite"
                    data-state={olderRun.status}
                  >
                    <span>
                      {olderRun.status === "error"
                        ? olderRun.error
                        : fill(
                            t(
                              olderRun.status === "running"
                                ? "strings.search.older_progress"
                                : olderRun.status === "done"
                                  ? "strings.search.older_done"
                                  : "strings.search.older_stopped",
                            ),
                            {
                              scanned: olderRun.scanned.toLocaleString("en-US"),
                              total: olderRun.total.toLocaleString("en-US"),
                              n: olderRun.hits.length.toLocaleString("en-US"),
                            },
                          )}
                    </span>
                    {olderRun.status === "running" ? (
                      <Btn sm outline className="older-stop" onClick={stopOlder}>
                        {t("strings.search.older_stop")}
                      </Btn>
                    ) : olderRun.status === "paused" && olderRun.cursor ? (
                      <Btn
                        sm
                        outline
                        className="older-further"
                        onClick={() => void searchOlder(olderRun.cursor)}
                      >
                        {t("strings.search.older_further")}
                      </Btn>
                    ) : olderRun.status === "error" ? (
                      <Btn
                        sm
                        outline
                        className="older-further"
                        onClick={() => void searchOlder(olderRun.cursor)}
                      >
                        {t("strings.search.older")}
                      </Btn>
                    ) : null}
                  </div>
                ) : searching && olderMissing > 0 ? (
                  <div className="search-older">
                    <span>{t("strings.search.older_help")}</span>
                    <Btn sm outline className="older-start" onClick={() => void searchOlder(null)}>
                      {t("strings.search.older")}
                    </Btn>
                  </div>
                ) : null}
                {calendar && s["calendar.today_panel"] && !searching ? (
                  <StreamTodayPanel calendar={calendar} now={now} settings={settings} />
                ) : null}
                {!searching ? panels : null}
                {items.length === 0 && !syncing && listLoading && !searching ? (
                  <div className="empty-line" role="status">
                    {t("strings.inbox.list_loading")}
                  </div>
                ) : items.length === 0 && !syncing ? (
                  lens && !searching && !filtering ? (
                    // A Group routes new mail as it arrives; what was already here moves
                    // only when it is sorted, which the Agent does with a preview first.
                    <div className="empty-line group-empty">
                      <span>{fill(t("strings.inbox.group_empty"), { group: lens.name })}</span>
                      {!aiOff ? (
                        <Btn
                          sm
                          onClick={() =>
                            askAgent(
                              fill(t("strings.inbox.group_sort_prompt"), { group: lens.name }),
                            )
                          }
                        >
                          {fill(t("strings.inbox.group_sort"), { group: lens.name })}
                        </Btn>
                      ) : null}
                    </div>
                  ) : (
                    <div className="empty-line">
                      {searching
                        ? t("strings.search.empty")
                        : filtering
                          ? t("strings.inbox.filter.empty")
                          : t(folder ? `strings.folder.${folder}.empty` : "strings.inbox.empty")}
                    </div>
                  )
                ) : null}
              </>
            }
          />
        )}
      </section>

      {shownThread ? (
        <Reader
          focusMessage={focusMessage?.thread === shownThread.id ? focusMessage.message : null}
          loadRemoteImages={settings["reader.load_remote_images"]}
          banner={
            calendar ? (
              <ThreadInviteBar calendar={calendar} threadId={shownThread.id} settings={settings} />
            ) : null
          }
          thread={shownThread}
          messages={messages}
          brief={brief}
          chips={chipRow}
          chipsAt={s["actions.recommended.position"]}
          suggestedLabel={t("strings.actions.recommended.suggested")}
          onChipMenu={(chip, item) => {
            if (chip.kind === "recommended")
              runChipMenu(shownThread.id, chip.rec, item, shownRecs?.fromDomain ?? null);
          }}
          chipCard={
            unsubCard && unsubCard.threadId === shownThread.id ? (
              <UnsubscribeCard
                card={unsubCard}
                strings={{
                  title: t("strings.actions.recommended.unsubscribe_card"),
                  post: t("strings.actions.recommended.unsubscribe_post"),
                  mail: t("strings.actions.recommended.unsubscribe_mail"),
                  approve: t("strings.actions.recommended.unsubscribe_approve"),
                  cancel: t("strings.actions.recommended.unsubscribe_cancel"),
                  archiveIssues: t("strings.actions.recommended.archive_issues"),
                }}
                onAnswer={(yes) => void answerUnsubscribe(yes)}
                onArchiveIssues={() => void archiveIssues()}
              />
            ) : null
          }
          chipKeys={chipKeys
            .slice(0, chipRow.length)
            .map((k) => chordLabel(normalizeChord(k), mac))}
          onChip={runChip}
          makeTemplate={makeTemplate}
          tags={tagsOf(shownThread)}
          sheet={stream}
          phone={phone ? { back: t("strings.phone.back") } : undefined}
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
          actions={threadActions.map((a) => a.reader)}
          onAction={(id) => void runCustomAction(id)}
          onOpenAttachment={(id) => void openAttachment(id)}
          onOpenLink={(href) => void openExternal(href)}
          attachmentSrc={attachmentSrc}
          drafts={shownDrafts.map((d) => (
            <DraftCard
              key={d.id}
              draftId={d.id}
              recipients={[...d.to, ...d.cc]}
              bodyText={d.bodyText}
              updatedAt={d.updatedAt}
              author={d.updatedBy === "agent" ? "agent" : "user"}
              now={now}
              strings={{
                badge: t("strings.drafts.badge"),
                byline:
                  d.updatedBy === "agent"
                    ? t("strings.compose.drafted_by_agent")
                    : t("strings.compose.drafted_by_you"),
                to: t("strings.drafts.to"),
                noRecipient: t("strings.drafts.no_recipient"),
                saved: t("strings.drafts.saved"),
                emptyBody: t("strings.drafts.empty_body"),
                edit: t("strings.drafts.edit"),
                send: t("strings.compose.send"),
                discard: t("strings.compose.discard"),
              }}
              onEdit={(id) => void compose.openDraft(id, shownThread.id)}
              onSend={(id) => void compose.sendDraft(id)}
              onDiscard={compose.discardDraft}
            />
          ))}
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
                onDraft={draftWithAgent}
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
            read: key("thread.toggle_read"),
          }}
          onClose={() => setReaderOpen(false)}
          onAsk={focusAgent}
          onDraftReply={draftWithAgent}
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
          onOpenThread={openAnywhere}
          onSuggest={applySuggestionLayout}
          onOpenRuntime={() => onNavigate?.("settings:ai")}
          card={intentCardNode}
        />
      ) : null}

      {ownsCompose && compose.pending ? (
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
      ) : ownsCompose && compose.notice ? (
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

      {ownsCompose && overlayExit.value ? (
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
          templates={templateLink?.library}
          chips={shownThread ? chipRow.map((c) => ({ key: c.key, label: c.label })) : undefined}
        />
      ) : null}
      {viewing ? (
        <AttachmentViewer
          files={viewing.files}
          index={viewing.index}
          onIndex={(index) => setViewing((v) => (v ? { ...v, index } : v))}
          onClose={() => setViewing(null)}
          load={(id) => inbox.attachmentBytes(id)}
          onDownload={(f) => void downloadAttachment(f.id)}
          strings={viewerStrings}
          maxBytes={settings["reader.preview_max_mb"] * 1024 * 1024}
          maxRows={settings["reader.preview_max_rows"]}
        />
      ) : null}
    </div>
  );
}
