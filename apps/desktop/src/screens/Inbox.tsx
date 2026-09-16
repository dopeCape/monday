// The inbox screen: the stream or split list, the reader, the agent dock, and
// every triage behavior from docs/spec/inbox.md that needs no Server. Reads
// Threads through InboxSource and acts through InboxActions (screens/inbox/
// actions.ts); slice 6 swaps the fixture implementation for the Store.

import type { Settings } from "@monday/shared";
import {
  AgentBar,
  AgentDock,
  AgentPanel,
  AgentThread,
  Btn,
  ColHead,
  CommandPalette,
  MessageRow,
  SectionLabel,
} from "@monday/ui";
import {
  agentThread,
  briefOf,
  commands,
  groups,
  messagesOf,
  NOW,
  sections,
  suggestions,
  tagsOf,
  workspace,
} from "@monday/ui/fixtures";
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
import { chordLabel, type KeyAction } from "../keyboard/keymaps.ts";
import {
  type KeyContext,
  type KeyHandlers,
  type Pane,
  useActiveKeymap,
  useKeymap,
} from "../keyboard/useKeymap.ts";
import { useShell } from "../shell/Shell.tsx";
import { fixtureInbox, type Inbox as InboxData, type UndoToken } from "./inbox/actions.ts";
import { BatchPreview } from "./inbox/BatchPreview.tsx";
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
import { reducedMotion, useLeavingRows } from "./inbox/useLeaving.ts";

export interface SyncProgress {
  done: number;
  total: number;
}

export interface InboxProps {
  /** The data seam. Defaults to the in-memory fixtures. */
  inbox?: InboxData | undefined;
  /** First-sync progress for the thin line at the top, or null when not syncing. */
  syncing?: SyncProgress | null | undefined;
  /** Offline flips the agent bar's placeholder; the workspace dot is the App's. */
  online?: boolean | undefined;
  /** The wall clock for relative times. Defaults to the fixtures' NOW. */
  now?: Date | undefined;
  /** Opens this Thread in the reader on mount. Defaults to `?sel=` in the URL. */
  initialOpen?: string | null | undefined;
  /** Rows in the multi-select on mount. Defaults to `?multi=a,b` in the URL. */
  initialSelection?: readonly string[] | undefined;
  /** For tests: the collapse and toast delays in ms override the Settings. */
  timing?: { collapse?: number; toast?: number } | undefined;
}

type RemovingKind = "archive" | "snooze" | "delete";
type ToastState = { text: string; token: UndoToken | null; id: number };
type Batch = { kind: RemovingKind | "read"; ids: string[]; until?: Date };

const defaultInbox = fixtureInbox();

const RUNTIME_LABEL: Record<Settings["ai.local.cli"], string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
};

function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
}

export function Inbox({
  inbox = defaultInbox,
  syncing = null,
  online = true,
  now = NOW,
  initialOpen,
  initialSelection,
  timing,
}: InboxProps) {
  const shell = useShell();
  const { settings } = shell;
  const stream = shell.layout.list === "stream";
  const mac = isMac();
  const keymap = useActiveKeymap();
  const key = (action: KeyAction) => chordLabel(keymap[action], mac);

  /* ------------------------------ Data ------------------------------ */

  const threads = useSyncExternalStore(inbox.subscribe, inbox.threads, inbox.threads);
  const collapseMs = timing?.collapse ?? (reducedMotion() ? 0 : settings["inbox.row_collapse_ms"]);
  const toastMs = timing?.toast ?? settings["inbox.undo_toast_ms"];
  const rows = useLeavingRows(threads, collapseMs);

  const orderedSections = useMemo(() => {
    const byId = new Map(sections.map((s) => [s.id, s]));
    return settings["sections.order"].flatMap((id) => {
      const s = byId.get(id);
      if (!s || s.hidden) return [];
      const nameKey = `strings.section.${id}`;
      const name = nameKey in settings ? String(settings[nameKey as keyof Settings]) : s.name;
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
  const [agentOpen, setAgentOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
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

  /** Runs one removing action on ids, advances the focus and shows the toast. */
  const remove = useCallback(
    async (kind: RemovingKind, ids: readonly string[], until?: Date) => {
      if (ids.length === 0) return;
      const next = nextFocus(order, focus, ids, s["inbox.after_action.direction"]);
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
      setSelection([]);
      setFocus(next);
      if (stream && readerOpen && focus !== null && ids.includes(focus)) {
        if (!s["inbox.after_action.open_next"] || next === null) setReaderOpen(false);
      }
      showToast(countText(text, ids.length), token);
    },
    [order, focus, s, t, inbox, now, stream, readerOpen, showToast, countText],
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
    [inbox, showToast, countText, t],
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

  const focusReply = useCallback(() => {
    setReaderOpen(true);
    queueMicrotask(() =>
      document.querySelector<HTMLTextAreaElement>(".reader .reply textarea")?.focus(),
    );
  }, []);

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
    batch || picker || paletteOpen
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
      if (overlay) return;
      setPaletteQuery(t("strings.inbox.action.label"));
      setPaletteOpen(true);
    },
    "thread.move": () => !overlay && openPicker("move", acting()),
    "compose.reply": () => !overlay && focus && focusReply(),
    "compose.reply_all": () => !overlay && focus && focusReply(),
    "compose.forward": () => !overlay && focus && focusReply(),
    "select.toggle": () => !overlay && focus && setSelection(toggleSelected(selection, focus)),
    "select.extend_down": () => {
      if (overlay) return;
      const r = extendSelection(order, selection, focus, 1);
      setSelection(r.selection);
      setFocus(r.focus);
    },
    "select.extend_up": () => {
      if (overlay) return;
      const r = extendSelection(order, selection, focus, -1);
      setSelection(r.selection);
      setFocus(r.focus);
    },
    undo: () => !overlay && void undo(),
    "agent.focus": () => !overlay && focusAgent(),
    "palette.open": () => {
      setPaletteQuery("");
      setPaletteOpen((o) => !o);
    },
  };
  for (let n = 1; n <= 9; n++) handlers[`view.${n}` as KeyAction] = () => applyView(n);

  useKeymap(handlers, ctx);

  /* ------------------------------ Render ------------------------------ */

  const open = (id: string) => {
    setFocus(id);
    setReaderOpen(true);
  };
  const runtime = RUNTIME_LABEL[s["ai.local.cli"]];
  const listTitle = t("strings.inbox.title");
  const headCount = selection.length
    ? fill(t("strings.inbox.selected"), { n: selection.length })
    : threads.length;

  const batchThreads = batch
    ? batch.ids.flatMap((id) => {
        const th = inbox.thread(id);
        return th ? [th] : [];
      })
    : [];
  const batchAction = batch
    ? t(
        batch.kind === "archive"
          ? "strings.inbox.action.archive"
          : batch.kind === "delete"
            ? "strings.inbox.action.delete"
            : batch.kind === "snooze"
              ? "strings.inbox.action.snooze"
              : "strings.inbox.action.read",
      )
    : "";

  return (
    <div className={`main inbox ${stream && showReader ? "has-sheet" : ""}`} data-pane={pane}>
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
        {picker === "more" ? (
          <Picker
            label={t("strings.inbox.more")}
            items={[{ key: "read-all", label: t("strings.inbox.mark_all_read") }]}
            onPick={() => {
              closePicker();
              void markAllRead();
            }}
            onClose={closePicker}
          />
        ) : null}
        {picker === "snooze" ? (
          <SnoozePicker
            settings={s}
            now={now}
            onSnooze={(until) => {
              closePicker();
              request("snooze", pickerIds, until);
            }}
            onClose={closePicker}
          />
        ) : null}
        {picker === "move" ? (
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
          {rows.length === 0 && !syncing ? (
            <div className="empty-line">{t("strings.inbox.empty")}</div>
          ) : null}
          {orderedSections.map((sec) =>
            sec.rows.length === 0 ? null : (
              <Fragment key={sec.id}>
                <SectionLabel>{sec.name}</SectionLabel>
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

      {showReader && thread ? (
        <Reader
          thread={thread}
          messages={messagesOf(thread.id)}
          brief={briefOf(thread.id)}
          tags={tagsOf(thread)}
          sheet={stream}
          now={now}
          strings={{
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
          }}
          keys={{
            archive: key("thread.archive"),
            snooze: key("thread.snooze"),
            delete: key("thread.delete"),
            close: key("sheet.close"),
          }}
          onClose={() => setReaderOpen(false)}
          onAsk={focusAgent}
          onArchive={() => request("archive", [thread.id])}
          onSnooze={() => openPicker("snooze", [thread.id])}
          onMove={() => openPicker("move", [thread.id])}
          onDelete={() => request("delete", [thread.id])}
          onStar={() => void toggleStar([thread.id])}
          onToggleRead={() => void toggleRead([thread.id])}
        />
      ) : null}

      {shell.layout.agent === "bottom" ? (
        <AgentDock>
          {agentOpen ? (
            <AgentPanel
              runtime={`${runtime} · ${workspace.accountId}`}
              suggestions={suggestions}
              onClose={() => setAgentOpen(false)}
            >
              <AgentThread turns={agentThread} now={now} />
            </AgentPanel>
          ) : null}
          <AgentBar
            placeholder={
              !online
                ? t("strings.agent.offline")
                : agentOpen
                  ? t("strings.agent.placeholder_open")
                  : t("strings.agent.placeholder")
            }
            onFocus={() => setAgentOpen(true)}
          />
        </AgentDock>
      ) : null}

      {toast ? (
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

      {batch ? (
        <BatchPreview
          title={fill(t("strings.inbox.batch.title"), { action: batchAction, n: batch.ids.length })}
          threads={batchThreads}
          applyLabel={t("strings.inbox.batch.apply")}
          cancelLabel={t("strings.inbox.batch.cancel")}
          onApply={() => void applyBatch()}
          onCancel={() => setBatch(null)}
        />
      ) : null}

      {paletteOpen ? (
        <CommandPalette
          sections={commands}
          query={paletteQuery}
          onQuery={setPaletteQuery}
          onClose={() => setPaletteOpen(false)}
          onSelect={(item) => {
            setPaletteOpen(false);
            if (item.key === "archive") request("archive", acting());
            else if (item.key === "snooze") openPicker("snooze", acting());
          }}
        />
      ) : null}
    </div>
  );
}
