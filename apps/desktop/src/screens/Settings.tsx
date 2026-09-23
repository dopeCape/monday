// Settings over the Shell (docs/spec/settings.md, ADR 0001, ADR 0004): three
// columns, the section nav on the left, one schema-rendered page of card
// stacks in the middle, the "On this page" index on the right, and a search
// field over everything at the top. Every control comes from the settings
// schema through settings/render.tsx; the special controls and the panels
// register there from settings/controls.tsx and settings/panels.tsx. The
// search index is built once from the schema plus the panels' own terms
// (settings/search.ts) and its results are the same cards, grouped by
// section. Nothing here is a hand-built settings screen. "Ask monday" inputs
// hand their text to the composer through `onAsk`; nothing on these pages
// calls a model.

import {
  SETTING_SECTIONS,
  type SettingKey,
  type SettingSection,
  type Settings as SettingValues,
  settingsSchema,
} from "@monday/shared";
import { Btn, EmptyState, Kbd, Toast } from "@monday/ui";
import {
  AtIcon,
  CloudIcon,
  CpuIcon,
  FlowArrowIcon,
  InfoIcon,
  KeyboardIcon,
  MagnifyingGlassIcon,
  PaletteIcon,
  ShuffleIcon,
  XIcon,
} from "@phosphor-icons/react";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { chordLabel, chordOf, type KeymapName, resolveKeymap } from "../keyboard/keymaps.ts";
import { isTypingTarget } from "../keyboard/useKeymap.ts";
import { type DeviceProviderKeys, deviceProviderKeys } from "../platform/providerKeys.ts";
import { platform } from "../platform/tauri.ts";
import { type SetResult, useShell } from "../shell/Shell.tsx";

import "./settings/controls.tsx";
import "./settings/panels.tsx";
import {
  Card,
  groupId,
  Highlighted,
  HighlightProvider,
  KeyStateProvider,
  pageGroups,
  panelLevel,
  panels,
  type RuntimeDetection,
  SettingControl,
  SettingsPage,
  type SettingsScreen,
  SettingsScreenProvider,
} from "./settings/render.tsx";
import type { ServerProps } from "./settings/Server.tsx";
import {
  buildSearchIndex,
  groupHits,
  type PanelIndexEntry,
  queryWords,
  type SearchHit,
  searchSettings,
} from "./settings/search.ts";
import { fill } from "./settings/wizard.ts";

const ICONS: Record<SettingSection, ReactNode> = {
  accounts: <AtIcon />,
  appearance: <PaletteIcon />,
  routing: <ShuffleIcon />,
  ai: <CpuIcon />,
  workflows: <FlowArrowIcon />,
  server: <CloudIcon />,
  shortcuts: <KeyboardIcon />,
  about: <InfoIcon />,
};

export interface SettingsProps {
  initialSection?: string | undefined;
  /** Opens with the search field focused; the palette's "Settings: search". */
  initialSearch?: boolean | undefined;
  /** Routes an "Ask monday" text to the composer, prefilled. Inert when absent. */
  onAsk?: ((text: string) => void) | undefined;
  /** The bottom agent the App owns, shown over the page once something was asked here. */
  agent?: ReactNode | undefined;
  /** The Local runtime detection seam: what this Device found of the three CLIs. */
  runtimes?: RuntimeDetection | undefined;
  /** This Device's provider keys; defaults to the platform keychain. */
  keys?: DeviceProviderKeys | undefined;
  serverProps?: ServerProps | undefined;
  /** The newest release for "Check for updates"; tests script it. */
  latestRelease?:
    | ((source: string) => Promise<{ version: string; url: string } | null>)
    | undefined;
  workspaceId?: string | undefined;
  version?: string | undefined;
  now?: (() => Date) | undefined;
}

interface ToastState {
  id: number;
  text: string;
  undo: () => void;
}

function sectionOf(name: string | undefined): SettingSection {
  return (SETTING_SECTIONS as readonly string[]).includes(name ?? "")
    ? (name as SettingSection)
    : "appearance";
}

/**
 * Writes several keys as one change: in order, and when one is refused in the
 * middle (an invalid value the Shell rejects) the keys already written go back
 * to `previous`, so a preset or a View never half-applies. The first refusal
 * is the result.
 */
export async function writeAll(
  set: <K extends SettingKey>(key: K, value: SettingValues[K]) => Promise<SetResult>,
  changes: ReadonlyArray<[SettingKey, unknown]>,
  previous: ReadonlyArray<[SettingKey, unknown]>,
): Promise<SetResult> {
  const applied: SettingKey[] = [];
  for (const [k, v] of changes) {
    const result = await set(k, v as never);
    if (!result.ok) {
      for (const key of applied) {
        const before = previous.find(([p]) => p === key);
        if (before) await set(key, before[1] as never);
      }
      return result;
    }
    applied.push(k);
  }
  return { ok: true };
}

/** Where the page should scroll after a navigation: a group anchor or a card's key. */
interface Target {
  section: SettingSection;
  /** A schema key (a card) or a group name; the section top when absent. */
  target: string | undefined;
  seq: number;
}

export function Settings({
  initialSection,
  initialSearch,
  onAsk,
  agent,
  runtimes,
  keys: keysProp,
  serverProps,
  latestRelease,
  workspaceId = "ws-1",
  version = "0.1.0",
  now = () => new Date(),
}: SettingsProps) {
  const shell = useShell();
  const s = shell.settings;
  const params =
    typeof location !== "undefined" ? new URLSearchParams(location.search) : new URLSearchParams();
  const [section, setSection] = useState<SettingSection>(() =>
    sectionOf(initialSection ?? params.get("section") ?? undefined),
  );
  const [query, setQuery] = useState(() => params.get("q") ?? "");
  const [target, setTarget] = useState<Target | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const toastSeq = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<ResultsHandle>(null);
  const [keys, setKeys] = useState<DeviceProviderKeys | null>(keysProp ?? null);
  useEffect(() => {
    if (keysProp) return;
    let live = true;
    void platform().then((p) => {
      if (live) setKeys(deviceProviderKeys(p));
    });
    return () => {
      live = false;
    };
  }, [keysProp]);

  const changeMany = useCallback(
    async (changes: Array<[SettingKey, unknown]>, label: string): Promise<SetResult> => {
      // A Pinned key refuses the whole change before anything is written, so a
      // preset never half-applies (ADR 0001).
      const locked = changes.find(([k]) => shell.pinned.has(k));
      if (locked) {
        return {
          ok: false,
          reason: "pinned",
          message: fill(s["strings.settings.pinned_file"], {
            path: shell.config.file?.path ?? "monday.toml",
          }),
        };
      }
      const previous = changes.map(
        ([k]) => [k, structuredClone(shell.settings[k])] as [SettingKey, unknown],
      );
      const result = await writeAll(shell.set, changes, previous);
      if (result.ok) {
        setToast({
          id: ++toastSeq.current,
          text: fill(shell.settings["strings.settings.changed"], { label }),
          undo: () => {
            void (async () => {
              for (const [k, v] of previous) await shell.set(k, v as never);
            })();
            setToast({
              id: ++toastSeq.current,
              text: shell.settings["strings.settings.undone"],
              undo: () => {},
            });
          },
        });
      }
      return result;
    },
    [shell, s],
  );

  const navigate = useCallback((to: SettingSection, at?: string) => {
    setQuery("");
    setSection(to);
    setTarget((t) => ({ section: to, target: at, seq: (t?.seq ?? 0) + 1 }));
  }, []);

  const screen = useMemo<SettingsScreen>(
    () => ({
      workspaceId,
      change: (key, value) => changeMany([[key, value]], settingsSchema[key].label),
      changeMany,
      onAsk: onAsk ?? (() => {}),
      runtimes: runtimes ?? null,
      keys,
      version,
      now,
      serverProps,
      navigate,
      latestRelease,
    }),
    [
      workspaceId,
      changeMany,
      onAsk,
      runtimes,
      keys,
      version,
      now,
      serverProps,
      navigate,
      latestRelease,
    ],
  );

  // The keymap's undo chord undoes the last change while its toast shows; the
  // search key focuses the search field.
  const undoChord = useMemo(
    () => resolveKeymap(s["keyboard.keymap"] as KeymapName, s["keyboard.bindings"]).undo,
    [s["keyboard.keymap"], s["keyboard.bindings"]],
  );
  const searchChord = s["settings.search_key"];
  const mac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target === searchRef.current) {
      if (e.key === "Escape") {
        e.preventDefault();
        setQuery("");
        searchRef.current?.blur();
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        resultsRef.current?.move(e.key === "ArrowDown" ? 1 : -1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        resultsRef.current?.enter();
      }
      return;
    }
    if (isTypingTarget(e.target)) return;
    const chord = chordOf(e);
    if (chord === searchChord) {
      e.preventDefault();
      searchRef.current?.focus();
      return;
    }
    if (toast && chord === undoChord) {
      e.preventDefault();
      toast.undo();
    }
  };
  useEffect(() => {
    if (initialSearch) searchRef.current?.focus();
  }, [initialSearch]);

  // The index collapses under the Setting's width; the breakpoint is a number, not a media query.
  const minWidth = s["settings.index_min_width"];
  const [wide, setWide] = useState(true);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setWide(el.clientWidth >= minWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [minWidth]);

  // Scroll to the card or group a navigation asked for, once it is on the page.
  const flashMs = s["settings.flash_ms"];
  useLayoutEffect(() => {
    if (!target || target.section !== section || query) return;
    const body = bodyRef.current;
    if (!body) return;
    const el = target.target
      ? (body.querySelector<HTMLElement>(`[data-setting="${CSS.escape(target.target)}"]`) ??
        body.querySelector<HTMLElement>(`#${groupId(target.target)}`))
      : null;
    if (!el) {
      body.scrollTo?.({ top: 0 });
      return;
    }
    el.scrollIntoView?.({ behavior: "smooth", block: "start" });
    if (el.classList.contains("scard")) {
      el.classList.add("flash");
      const timer = setTimeout(() => el.classList.remove("flash"), flashMs);
      return () => clearTimeout(timer);
    }
  }, [target, section, query, flashMs]);

  const expire = useCallback(() => setToast(null), []);
  const level = s["ai.level"];
  const groups = useMemo(() => pageGroups(section, level), [section, level]);
  const searching = queryWords(query).length > 0;

  return (
    <SettingsScreenProvider value={screen}>
      <KeyStateProvider>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: the undo and search chords are page-level shortcuts */}
        <div className="main page" onKeyDown={onKeyDown}>
          <div className="settings">
            <nav className="settings-nav">
              <h4>{s["strings.settings.title"]}</h4>
              {SETTING_SECTIONS.map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`nav-item ${section === n && !searching ? "on" : ""}`}
                  onClick={() => navigate(n)}
                >
                  {ICONS[n]}
                  <span>{s[`strings.settings.section.${n}`]}</span>
                </button>
              ))}
            </nav>
            <div className="settings-body" ref={bodyRef} data-index={wide ? "shown" : "hidden"}>
              <div className="settings-in" data-section={section} data-searching={searching}>
                <div className="settings-search">
                  <label className="settings-search-box">
                    <span className="search-ic" aria-hidden="true">
                      <MagnifyingGlassIcon />
                    </span>
                    <input
                      ref={searchRef}
                      type="search"
                      value={query}
                      placeholder={s["strings.settings.search.placeholder"]}
                      aria-label={s["strings.settings.search.label"]}
                      spellCheck={false}
                      autoComplete="off"
                      onChange={(e) => setQuery(e.target.value)}
                    />
                    {query ? (
                      <Btn
                        sm
                        icon
                        aria-label={s["strings.settings.search.clear"]}
                        onClick={() => {
                          setQuery("");
                          searchRef.current?.focus();
                        }}
                      >
                        <XIcon />
                      </Btn>
                    ) : (
                      <Kbd className="search-key">{chordLabel(searchChord, mac)}</Kbd>
                    )}
                  </label>
                </div>
                <div className="settings-cols">
                  {searching ? (
                    <SearchResults
                      ref={resultsRef}
                      query={query}
                      section={section}
                      onOpen={navigate}
                    />
                  ) : (
                    <>
                      <div className="settings-content">
                        <SettingsPage section={section} />
                      </div>
                      <PageIndex
                        key={section}
                        groups={groups.map((g) => g.name)}
                        scroller={bodyRef}
                        onJump={(name) => navigate(section, name)}
                      />
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
          {toast ? (
            <Toast
              key={toast.id}
              text={toast.text}
              undoLabel={s["strings.settings.undo"]}
              undoKey={chordLabel(undoChord, mac)}
              ms={s["inbox.undo_toast_ms"]}
              onUndo={toast.text === s["strings.settings.undone"] ? undefined : toast.undo}
              onExpire={expire}
            />
          ) : null}
          {agent}
        </div>
      </KeyStateProvider>
    </SettingsScreenProvider>
  );
}

/* ------------------------------ On this page ------------------------------ */

/**
 * The right-hand index of the current section's groups. The active group
 * follows the scroll position: an IntersectionObserver over the group
 * anchors inside the page's scroller fires as they cross the viewport, and
 * the group whose top is closest above the reading line (a third of the way
 * down) is the one being read. A click scrolls smoothly to the group and
 * holds it active while the scroll settles.
 */
export function PageIndex({
  groups,
  scroller,
  onJump,
}: {
  groups: readonly string[];
  scroller: React.RefObject<HTMLElement | null>;
  onJump: (group: string) => void;
}) {
  const s = useShell().settings;
  const holdMs = s["settings.index_hold_ms"];
  const [active, setActive] = useState<string | null>(groups[0] ?? null);
  const holdUntil = useRef(0);
  const key = groups.join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: the group list is compared by its names
  useEffect(() => {
    const root = scroller.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const anchors = groups
      .map((name) => root.querySelector<HTMLElement>(`#${groupId(name)}`))
      .filter((el): el is HTMLElement => el !== null);
    const read = () => {
      if (Date.now() < holdUntil.current) return;
      // Scrolled to the end: the last group is the one being read, even when the
      // page is too short for its anchor to ever reach the reading line.
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 1 && root.scrollTop > 0) {
        setActive(anchors.at(-1)?.dataset.group ?? null);
        return;
      }
      const top = root.getBoundingClientRect().top;
      const line = top + root.clientHeight * 0.33;
      let current: string | null = null;
      for (const el of anchors) {
        if (el.getBoundingClientRect().top <= line) current = el.dataset.group ?? null;
        else break;
      }
      setActive(current ?? anchors[0]?.dataset.group ?? null);
    };
    const io = new IntersectionObserver(read, { root, threshold: [0, 0.25, 0.5, 0.75, 1] });
    for (const el of anchors) io.observe(el);
    // The observer fires as anchors cross the edges; the end of the page needs the scroll itself.
    root.addEventListener("scroll", read, { passive: true });
    return () => {
      io.disconnect();
      root.removeEventListener("scroll", read);
    };
  }, [key, scroller]);
  if (groups.length < 2) return <aside className="settings-index" aria-hidden="true" />;
  return (
    <aside className="settings-index" aria-label={s["strings.settings.index.title"]}>
      <h5>{s["strings.settings.index.title"]}</h5>
      {groups.map((g) => (
        <a
          key={g}
          href={`#${groupId(g)}`}
          className={active === g ? "on" : ""}
          data-index-group={g}
          onClick={(e) => {
            e.preventDefault();
            holdUntil.current = Date.now() + holdMs;
            setActive(g);
            onJump(g);
          }}
        >
          {g}
        </a>
      ))}
    </aside>
  );
}

/* ------------------------------ Search results ------------------------------ */

/** The panels as the index sees them: their titles and terms from the registry, at their levels. */
function panelIndex(s: ReturnType<typeof useShell>["settings"]): PanelIndexEntry[] {
  const out: PanelIndexEntry[] = [];
  for (const section of SETTING_SECTIONS) {
    for (const [group, p] of Object.entries(panels[section] ?? {})) {
      out.push({
        section,
        group,
        label: String(s[p.search.title]),
        help: p.search.description ? String(s[p.search.description]) : "",
        terms: p.search.searchTerms,
        level: panelLevel(section, group),
      });
    }
  }
  return out;
}

/**
 * The results page: the same cards the sections render, grouped under the
 * section they live in, with the matched words highlighted and a "Show in
 * section" link per card. Arrows move the active card, Enter focuses its
 * control, Escape clears the search.
 */
/** What the search field drives on the results: the active card and its control. */
export interface ResultsHandle {
  move(delta: 1 | -1): void;
  enter(): void;
}

function SearchResults({
  ref,
  query,
  section,
  onOpen,
}: {
  ref: RefObject<ResultsHandle | null>;
  query: string;
  section: SettingSection;
  onOpen: (section: SettingSection, target?: string) => void;
}) {
  const shell = useShell();
  const s = shell.settings;
  const names = useMemo(
    () =>
      Object.fromEntries(
        SETTING_SECTIONS.map((n) => [n, s[`strings.settings.section.${n}`]]),
      ) as Record<SettingSection, string>,
    [s],
  );
  const index = useMemo(() => buildSearchIndex(names, panelIndex(s)), [names, s]);
  const hits = useMemo(
    () =>
      searchSettings(index, query, {
        level: s["ai.level"],
        current: section,
        limit: s["settings.search_limit"],
      }),
    [index, query, s, section],
  );
  const grouped = useMemo(() => groupHits(hits, section), [hits, section]);
  const words = useMemo(() => queryWords(query), [query]);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new query starts at the top
  useEffect(() => setActive(0), [query]);
  const flat = useMemo(() => grouped.flatMap((g) => g.hits), [grouped]);
  const keyOf = (h: SearchHit) =>
    h.entry.kind === "setting" ? h.entry.key : `${h.entry.section}:${h.entry.group}`;

  useImperativeHandle(
    ref,
    () => ({
      move: (delta) => {
        if (flat.length === 0) return;
        const next = (active + delta + flat.length) % flat.length;
        setActive(next);
        listRef.current
          ?.querySelector<HTMLElement>(`[data-result="${next}"]`)
          ?.scrollIntoView?.({ block: "nearest" });
      },
      enter: () => {
        const card = listRef.current?.querySelector<HTMLElement>(`[data-result="${active}"]`);
        const control = card?.querySelector<HTMLElement>(
          "input, textarea, select, .switch, .seg button.on, .choice-card.on, .prov.on, button",
        );
        control?.focus();
      },
    }),
    [flat, active],
  );

  return (
    <div className="settings-results" ref={listRef}>
      <div className="settings-results-head">
        <span>
          {hits.length === 1
            ? s["strings.settings.search.one"]
            : fill(s["strings.settings.search.many"], { n: hits.length })}
        </span>
        <span className="sp" />
        <span className="hint">{s["strings.settings.search.hint"]}</span>
      </div>
      {hits.length === 0 ? (
        <EmptyState
          className="settings-empty"
          title={fill(s["strings.settings.search.empty"], { query: query.trim() })}
          body={s["strings.settings.search.suggest"]}
          attrs={{ "data-panel": "search-empty" }}
        />
      ) : null}
      <HighlightProvider words={words}>
        {grouped.map((g) => (
          <section className="sresult-section" key={g.section} data-result-section={g.section}>
            <h3>
              <span className="sec-ic">{ICONS[g.section]}</span>
              <span>{names[g.section]}</span>
            </h3>
            <div className="stack">
              {g.hits.map((h) => {
                const i = flat.indexOf(h);
                const key = keyOf(h);
                return (
                  <div
                    className={`sresult ${i === active ? "active" : ""}`}
                    key={key}
                    data-result={i}
                    data-result-key={key}
                  >
                    {h.entry.kind === "setting" ? (
                      <SettingControl k={h.entry.key} />
                    ) : (
                      <PanelResult
                        label={h.entry.label}
                        help={h.entry.help}
                        group={h.entry.group}
                      />
                    )}
                    <button
                      type="button"
                      className="link show-in"
                      onClick={() =>
                        onOpen(
                          h.entry.section,
                          h.entry.kind === "setting" ? h.entry.key : h.entry.group,
                        )
                      }
                    >
                      {s["strings.settings.search.show"]}
                      <span className="crumb">
                        {names[h.entry.section]} / {h.entry.group}
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </HighlightProvider>
    </div>
  );
}

/** A panel in the results: its title and line, standing in for the panel itself. */
function PanelResult({ label, help, group }: { label: string; help: string; group: string }) {
  return (
    <Card
      title={<Highlighted text={label} />}
      hint={help ? <Highlighted text={help} /> : undefined}
      attrs={{ "data-panel-result": group }}
    />
  );
}
