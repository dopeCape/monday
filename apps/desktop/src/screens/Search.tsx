// The search results screen (ADR 0011): the stream's visual language over
// the Cache search. The query sits in the list header with the all-accounts
// toggle, the filter chips narrow the set live, and the "search older mail"
// line appears when the query reaches into bodies the Cache does not hold,
// pulling them in and re-running the query as they land. The palette opens
// here too, so a new query is one ⌘K away.

import type { Settings, Thread } from "@monday/shared";
import { Btn, Chip, ColHead, MessageRow } from "@monday/ui";
import { tagsOf } from "@monday/ui/fixtures";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type KeyContext,
  type KeyHandlers,
  useActiveKeymap,
  useKeymap,
} from "../keyboard/useKeymap.ts";
import type {
  OlderMail,
  PullProgress,
  SearchChips,
  SearchHit,
  SearchModule,
} from "../search/index.ts";
import type { AgentAsk } from "../search/palette.ts";
import { useShell } from "../shell/Shell.tsx";
import { fill, neighbor } from "./inbox/triage.ts";
import { Palette, type PaletteCommand } from "./Palette.tsx";

export interface SearchProps {
  search: SearchModule;
  workspaceId: string;
  query: string;
  onQuery: (query: string) => void;
  /** Opens a Thread in the inbox screen; the Workspace is where the hit came from. */
  onOpen: (threadId: string, workspaceId: string) => void;
  onBack: () => void;
  onCommand: (command: PaletteCommand) => void;
  onAsk: (ask: AgentAsk) => void;
  recentThreads?: readonly Thread[] | undefined;
  now?: Date | undefined;
}

type Pull = { older: OlderMail; progress: PullProgress | null; error: string | null };

export function Search({
  search,
  workspaceId,
  query,
  onQuery,
  onOpen,
  onBack,
  onCommand,
  onAsk,
  recentThreads = [],
  now,
}: SearchProps) {
  const shell = useShell();
  const { settings } = shell;
  const t = useCallback(<K extends keyof Settings>(k: K) => String(settings[k]), [settings]);
  const keymap = useActiveKeymap();
  const all = settings["search.all_accounts"];
  const [chips, setChips] = useState<SearchChips>({});
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [older, setOlder] = useState<OlderMail[]>([]);
  const [pull, setPull] = useState<Pull | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const seq = useRef(0);

  const run = useCallback(async () => {
    const mine = ++seq.current;
    const r = await search.search(query, {
      workspace: all ? "all" : workspaceId,
      chips,
      limit: settings["search.results_limit"],
      ...(now ? { now } : {}),
    });
    if (mine !== seq.current) return;
    setHits(r.hits);
    setOlder(r.older);
  }, [search, query, all, workspaceId, chips, settings, now]);

  useEffect(() => {
    void run();
  }, [run]);

  useEffect(() => {
    if (query.trim() !== "") void search.remember(query);
  }, [query, search]);

  const order = useMemo(() => hits.map((h) => `${h.workspaceId}:${h.thread.id}`), [hits]);
  useEffect(() => {
    if (focus === null || !order.includes(focus)) setFocus(order[0] ?? null);
  }, [order, focus]);

  const pullOlder = useCallback(
    async (o: OlderMail) => {
      setPull({ older: o, progress: { done: 0, total: o.missing }, error: null });
      try {
        await search.pullOlder(o, (p) => {
          setPull({ older: o, progress: p, error: null });
          void run();
        });
        setPull(null);
        await run();
      } catch (error) {
        const message =
          error instanceof Error && /423|locked/i.test(error.message)
            ? t("strings.search.older_locked")
            : error instanceof Error
              ? error.message
              : String(error);
        setPull({ older: o, progress: null, error: message });
      }
    },
    [search, run, t],
  );

  const openFocus = () => {
    const hit = hits.find((h) => `${h.workspaceId}:${h.thread.id}` === focus);
    if (hit) onOpen(hit.thread.id, hit.workspaceId);
  };

  const ctx: KeyContext = { pane: paletteOpen ? "overlay" : "list", focus, selection: [] };
  const handlers: KeyHandlers = {
    "move.down": () => !paletteOpen && setFocus(neighbor(order, focus, 1)),
    "move.up": () => !paletteOpen && setFocus(neighbor(order, focus, -1)),
    "thread.open": () => !paletteOpen && openFocus(),
    "sheet.close": () => (paletteOpen ? setPaletteOpen(false) : onBack()),
    "palette.open": () => {
      setPaletteQuery(query);
      setPaletteOpen((o) => !o);
    },
  };
  useKeymap(handlers, ctx);

  const stream = shell.layout.list === "stream";
  const fields = settings["inbox.rows"][shell.density][stream ? "stream" : "split"].join(" ");
  const title = query.trim() === "" ? t("strings.search.title") : query;
  const count =
    hits.length === 1
      ? t("strings.search.result")
      : fill(t("strings.search.results"), { n: hits.length });
  const toggle = (key: keyof SearchChips) => setChips((c) => ({ ...c, [key]: !c[key] }));
  const missing = older.reduce((n, o) => n + o.missing, 0);

  return (
    <div className="main inbox search" data-pane={ctx.pane}>
      <section className="col list" data-fields={fields} aria-label={t("strings.search.title")}>
        <ColHead
          title={title}
          count={count}
          leading={
            <Btn icon title={t("strings.inbox.action.close")} onClick={onBack}>
              <ArrowLeftIcon />
            </Btn>
          }
        >
          <Chip on={all} onClick={() => void shell.set("search.all_accounts", !all)}>
            {t("strings.search.all_accounts")}
          </Chip>
        </ColHead>
        <div className="search-chips">
          <Chip on={Boolean(chips.unread)} onClick={() => toggle("unread")}>
            {t("strings.search.chip.unread")}
          </Chip>
          <Chip on={Boolean(chips.attachments)} onClick={() => toggle("attachments")}>
            {t("strings.search.chip.attachments")}
          </Chip>
          <Chip on={Boolean(chips.group)} onClick={() => toggle("group")}>
            {t("strings.search.chip.group")}
          </Chip>
        </div>
        {pull ? (
          <div className="search-older" role="status">
            {pull.error ? (
              <span>{pull.error}</span>
            ) : (
              <span>
                {fill(t("strings.search.older_pulling"), {
                  done: pull.progress?.done ?? 0,
                  total: pull.progress?.total ?? pull.older.missing,
                })}
              </span>
            )}
          </div>
        ) : missing > 0 ? (
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
        <div className="col-body" role="listbox" aria-label={t("strings.search.title")}>
          {hits.length === 0 && query.trim() !== "" ? (
            <div className="empty-line">{t("strings.search.empty")}</div>
          ) : null}
          {hits.map((h) => {
            const key = `${h.workspaceId}:${h.thread.id}`;
            return (
              <MessageRow
                key={key}
                thread={h.snippet ? { ...h.thread, snippet: h.snippet } : h.thread}
                tags={tagsOf(h.thread)}
                selected={key === focus}
                now={now}
                account={all ? h.account : undefined}
                onOpen={() => onOpen(h.thread.id, h.workspaceId)}
              />
            );
          })}
        </div>
      </section>
      {paletteOpen ? (
        <Palette
          query={paletteQuery}
          onQuery={setPaletteQuery}
          onClose={() => setPaletteOpen(false)}
          keymap={keymap}
          search={search}
          workspaceId={workspaceId}
          recentThreads={recentThreads}
          now={now}
          onCommand={(command) => {
            setPaletteOpen(false);
            if (command.type === "search") onQuery(command.text);
            else if (command.type === "open")
              onOpen(command.threadId, command.workspaceId ?? workspaceId);
            else onCommand(command);
          }}
          onAsk={(ask) => {
            setPaletteOpen(false);
            onAsk(ask);
          }}
        />
      ) : null}
    </div>
  );
}
