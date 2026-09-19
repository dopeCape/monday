// The schema-driven Settings renderer (docs/spec/settings.md, ADR 0004). A page
// is one section of the schema: its groups in SETTING_GROUPS order, each a
// stack of cards, one card per key, chosen from the key's control shape
// (switch, segmented control or select, number with its range, text, list,
// record, JSON) or from the `controls` registry when the schema names a
// special one (palette swatches, the binding table, the task-to-Role map).
// Panels that are not Settings (the Accounts list, the Meter, the Activity
// log) hang off a group name and say what they are searchable by. A card's
// footer carries the secondary line: the scope, the Pinned state with the
// file line (ADR 0001), the default with Reset when changed, and any
// validation error. Every control carries data-setting with its key, which is
// what the coverage test walks. There is no hand-built settings screen.

import {
  type AiLevel,
  type ControlShape,
  describeSetting,
  groupsInSectionAt,
  indexLines,
  isSettingKey,
  levelAtLeast,
  lineOf,
  type SettingEntry,
  type SettingGroup,
  type SettingKey,
  type SettingSection,
  settingsSchema,
  splitKey,
  validateSetting,
} from "@monday/shared";
import { Btn, cx, type IconComponent, Input, Seg, Switch, Tag } from "@monday/ui";
import { MonitorIcon, MoonIcon, SunIcon, XIcon } from "@phosphor-icons/react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { DeviceProviderKeys } from "../../platform/providerKeys.ts";
import { type SetResult, type ShellState, useShell } from "../../shell/Shell.tsx";
import type { ServerProps } from "./Server.tsx";
import { fill } from "./wizard.ts";

/* ------------------------------ The screen's seam ------------------------------ */

/** One installed command-line agent as the Runtime group lists it (slice 15 fills this in). */
export interface DetectedCli {
  cli: "claude-code" | "codex" | "opencode";
  version: string | null;
  path: string | null;
  status: "connected" | "available" | "missing";
}

/** The Local runtime detection seam. Slice 15 provides the real one; without it every CLI reads as not found. */
export interface RuntimeDetection {
  detect(): Promise<DetectedCli[]>;
}

/** What every control and panel on the Settings screens can reach. */
export interface SettingsScreen {
  workspaceId: string;
  /** Writes a Setting through the Shell and offers Undo from the toast. */
  change(key: SettingKey, value: unknown): Promise<SetResult>;
  /** Several keys as one change with one toast, whose Undo restores all of them. */
  changeMany(changes: Array<[SettingKey, unknown]>, label: string): Promise<SetResult>;
  /** Routes an "Ask monday" text to the composer, prefilled. */
  onAsk(text: string): void;
  runtimes: RuntimeDetection | null;
  /** This Device's provider keys in the keychain; null in the browser before the platform answers. */
  keys: DeviceProviderKeys | null;
  version: string;
  now(): Date;
  /** The Server panel's seams (the pairing fetch, the Device name, the browser opener); tests script them. */
  serverProps?: ServerProps | undefined;
  /** Opens a section and scrolls to a card or group; the search results' "Show in section". Absent outside the Settings page. */
  navigate?: ((section: SettingSection, target?: string) => void) | undefined;
  /** The newest release for "Check for updates"; GitHub's releases API by default. Tests script it. */
  latestRelease?:
    | ((source: string) => Promise<{ version: string; url: string } | null>)
    | undefined;
}

const ScreenContext = createContext<SettingsScreen | null>(null);

export function SettingsScreenProvider({
  value,
  children,
}: {
  value: SettingsScreen;
  children: ReactNode;
}) {
  return <ScreenContext.Provider value={value}>{children}</ScreenContext.Provider>;
}

export function useSettingsScreen(): SettingsScreen {
  const s = useContext(ScreenContext);
  if (!s) throw new Error("useSettingsScreen outside a Settings screen");
  return s;
}

/* ------------------------------ Shared key state ------------------------------ */

/**
 * The Device's provider keys change from more than one card (the key itself,
 * the provider list, the runtime step). Each write bumps a version every
 * reader of the keychain re-checks on, so no card shows a stale "Add key".
 */
export interface KeyStateContext {
  version: number;
  bump(): void;
}

const KeyState = createContext<KeyStateContext>({ version: 0, bump: () => {} });

export function KeyStateProvider({ children }: { children: ReactNode }) {
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const value = useMemo(() => ({ version, bump }), [version, bump]);
  return <KeyState.Provider value={value}>{children}</KeyState.Provider>;
}

export function useKeyStateVersion(): KeyStateContext {
  return useContext(KeyState);
}

/* ------------------------------ Highlighting ------------------------------ */

/** The words the search results highlight in labels and help; empty on a page. */
const Highlight = createContext<readonly string[]>([]);

export function HighlightProvider({
  words,
  children,
}: {
  words: readonly string[];
  children: ReactNode;
}) {
  return <Highlight.Provider value={words}>{children}</Highlight.Provider>;
}

/** The text with every occurrence of a highlighted word wrapped in a mark. */
export function Highlighted({ text }: { text: string }) {
  const words = useContext(Highlight);
  const parts = useMemo(() => splitHighlights(text, words), [text, words]);
  if (!parts.some((p) => p.hit)) return <>{text}</>;
  return (
    <>
      {parts.map((p, i) =>
        p.hit ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the pieces are positional
          <mark key={i}>{p.text}</mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: the pieces are positional
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

/** Splits text into plain and hit pieces for the given words, case-insensitively. */
export function splitHighlights(
  text: string,
  words: readonly string[],
): Array<{ text: string; hit: boolean }> {
  const needles = words.map((w) => w.toLowerCase()).filter((w) => w.length > 0);
  if (needles.length === 0 || !text) return [{ text, hit: false }];
  const lower = text.toLowerCase();
  const out: Array<{ text: string; hit: boolean }> = [];
  let at = 0;
  while (at < text.length) {
    let best: { start: number; end: number } | null = null;
    for (const n of needles) {
      const i = lower.indexOf(n, at);
      if (i >= 0 && (best === null || i < best.start)) best = { start: i, end: i + n.length };
    }
    if (!best) break;
    if (best.start > at) out.push({ text: text.slice(at, best.start), hit: false });
    out.push({ text: text.slice(best.start, best.end), hit: true });
    at = best.end;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });
  return out.length > 0 ? out : [{ text, hit: false }];
}

/* ------------------------------ Registries ------------------------------ */

export interface ControlProps {
  k: SettingKey;
  entry: SettingEntry;
  shape: ControlShape;
}

export type ControlComponent = (props: ControlProps) => ReactNode;

/**
 * Special controls by setting key. A key whose schema entry names a `control`
 * resolves here (through `controlKinds` by name); a key without one renders
 * from its shape. Registered by controls.tsx at import time.
 */
export const controls: Partial<Record<SettingKey, ControlComponent>> = {};

/** Special controls by the name a schema entry gives in `control`. */
export const controlKinds: Record<string, ControlComponent> = {};

export interface PanelProps {
  section: SettingSection;
  group: SettingGroup;
}

export type PanelComponent = (props: PanelProps) => ReactNode;

/** What the settings search knows about a panel: its title, a line, and extra words. */
export interface PanelSearch {
  /** The string key of the title shown in search results and the page index. */
  title: SettingKey;
  /** The string key of the one-line description under it. */
  description?: SettingKey | undefined;
  /** Extra words the panel answers to: "devices", "pairing", "revoke". */
  searchTerms: readonly string[];
}

export interface RegisteredPanel {
  component: PanelComponent;
  search: PanelSearch;
}

/** Panels by section and group name: rendered above the group's controls. */
export const panels: Partial<Record<SettingSection, Record<string, RegisteredPanel>>> = {};

export function registerPanel(
  section: SettingSection,
  group: string,
  panel: PanelComponent,
  search: PanelSearch,
) {
  const bySection = panels[section] ?? {};
  bySection[group] = { component: panel, search };
  panels[section] = bySection;
}

/* ------------------------------ The page ------------------------------ */

/**
 * The lowest AI level a panel shows at (docs/spec/settings.md: the rest of AI
 * and agent hides under `off`). Panels not listed show at every level: the
 * Accounts list, the Groups tree (hand-made Groups stay), the Server ones.
 */
const PANEL_LEVELS: Partial<Record<SettingSection, Record<string, AiLevel>>> = {
  ai: { Meter: "assist", "Activity log": "assist", "External MCP": "assist" },
  workflows: { "MCP servers": "automate" },
};

export function panelLevel(section: SettingSection, group: string): AiLevel {
  return PANEL_LEVELS[section]?.[group] ?? "off";
}

/** The groups a section page shows at an AI level: with keys, or with a panel the level allows. */
export function pageGroups(section: SettingSection, level: AiLevel): SettingGroup[] {
  return groupsInSectionAt(section, level).filter(
    (g) =>
      g.keys.length > 0 ||
      g.advanced.length > 0 ||
      (panels[section]?.[g.name] !== undefined && levelAtLeast(level, panelLevel(section, g.name))),
  );
}

/** The DOM id of a group's anchor on its page. */
export function groupId(group: string): string {
  return `group-${group.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`;
}

export function SettingsPage({ section }: { section: SettingSection }) {
  const shell = useShell();
  const s = shell.settings;
  const level = s["ai.level"];
  const groups = useMemo(() => pageGroups(section, level), [section, level]);
  return (
    <>
      <header className="settings-head">
        <h1>{s[`strings.settings.section.${section}`]}</h1>
        <p>{s[`strings.settings.intro.${section}`]}</p>
      </header>
      {groups.map((group) => (
        <Group key={group.name} section={section} group={group} />
      ))}
    </>
  );
}

/** The string key of a group's intro paragraph, when the schema has one. */
function introKey(section: SettingSection, group: string): SettingKey | null {
  const key = `strings.settings.intro.${section}.${group.toLowerCase().replaceAll(/\s+/g, "-")}`;
  return isSettingKey(key) ? key : null;
}

function Group({ section, group }: { section: SettingSection; group: SettingGroup }) {
  const s = useShell().settings;
  const registered = panels[section]?.[group.name];
  const Panel = registered?.component;
  const showHeading = group.keys.length > 0 || group.advanced.length > 0 || Panel;
  if (!showHeading) return null;
  const intro = introKey(section, group.name);
  // A group named like its section (Accounts, About) is the page itself: no second heading.
  const own = group.name === s[`strings.settings.section.${section}`];
  return (
    <section className="sgroup" id={groupId(group.name)} data-group={group.name}>
      {own ? null : <h3>{group.name}</h3>}
      {intro ? <p>{String(s[intro])}</p> : null}
      <div className="stack">
        {Panel ? <Panel section={section} group={group} /> : null}
        {group.keys.map((k) => (
          <SettingControl key={k} k={k} />
        ))}
        {group.advanced.length > 0 ? (
          <details className="advanced">
            <summary>{s["strings.settings.advanced"]}</summary>
            <div className="stack">
              {group.advanced.map((k) => (
                <SettingControl key={k} k={k} />
              ))}
            </div>
          </details>
        ) : null}
      </div>
    </section>
  );
}

/** One key's control: the registered special one, else the one its shape picks. */
export function SettingControl({ k }: { k: SettingKey }) {
  const entry = settingsSchema[k] as SettingEntry;
  const shape = useMemo(() => describeSetting(k), [k]);
  const Special = controls[k] ?? (entry.control ? controlKinds[entry.control] : undefined);
  if (Special) return <Special k={k} entry={entry} shape={shape} />;
  return <ShapeControl k={k} entry={entry} shape={shape} />;
}

function ShapeControl({ k, entry, shape }: ControlProps) {
  switch (shape.kind) {
    case "boolean":
      return <BooleanControl k={k} entry={entry} shape={shape} />;
    case "enum":
      return <EnumControl k={k} entry={entry} shape={shape} />;
    case "number":
      return <NumberControl k={k} entry={entry} shape={shape} />;
    case "string":
      return <StringControl k={k} entry={entry} shape={shape} />;
    case "list":
      return <ListControl k={k} entry={entry} shape={shape} />;
    case "record":
      return <RecordControl k={k} entry={entry} shape={shape} />;
    default:
      return <JsonControl k={k} entry={entry} shape={shape} />;
  }
}

/* ------------------------------ The card ------------------------------ */

export interface CardProps {
  /** The card's title. */
  title: ReactNode;
  /** The one-line description under it. */
  hint?: ReactNode | undefined;
  /** A wide control that sits under the text instead of beside it. */
  block?: boolean | undefined;
  /** Danger actions: the footer turns a subdued red. */
  danger?: boolean | undefined;
  /** The footer's contents; the scope, default and errors for a Setting. */
  foot?: ReactNode | undefined;
  className?: string | undefined;
  /** data-* attributes and an id for the coverage test and the page index. */
  attrs?: Record<string, string | undefined> | undefined;
  children?: ReactNode | undefined;
}

/**
 * One card: title and description on the left, the control on the right (or
 * below when wide), and a footer for the secondary line. Panels use it for
 * their own rows so every row on the page reads the same.
 */
export function Card({ title, hint, block, danger, foot, className, attrs, children }: CardProps) {
  return (
    <div
      className={cx("scard", block && "block", danger && "danger", className)}
      {...(attrs ?? {})}
    >
      <div className="scard-main">
        <div className="scard-text">
          <b className="scard-title">{title}</b>
          {hint ? <span className="scard-hint">{hint}</span> : null}
        </div>
        {children !== undefined && children !== null ? (
          <div className="scard-ctl">{children}</div>
        ) : null}
      </div>
      {foot ? <div className="scard-foot">{foot}</div> : null}
    </div>
  );
}

/* ------------------------------ Row and Pinned ------------------------------ */

export interface RowProps {
  k: SettingKey;
  /** Overrides the schema label. */
  label?: string | undefined;
  /** Overrides the schema help. */
  hint?: ReactNode | undefined;
  /** A wide control that sits under the label instead of beside it. */
  block?: boolean | undefined;
  /** No card chrome: the control is the whole row (the swatches, the level cards). */
  bare?: boolean | undefined;
  /** A validation or save problem shown in the footer. */
  error?: string | null | undefined;
  /** Extra footer content after the standard line. */
  foot?: ReactNode | undefined;
  children?: ReactNode | undefined;
}

/** Whether a value equals the schema default, by structure. */
export function isDefault(k: SettingKey, value: unknown): boolean {
  return JSON.stringify(value) === JSON.stringify(settingsSchema[k].default);
}

/** "google-meet" as "Google meet", "on_open" as "On open". */
export function optionLabel(option: string): string {
  const text = option.replaceAll(/[-_]/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The default of a key as a short phrase for the footer. */
export function describeDefault(k: SettingKey, s: ShellState["settings"]): string {
  const d = settingsSchema[k].default as unknown;
  const shape = describeSetting(k);
  if (shape.kind === "boolean") return d ? s["strings.settings.on"] : s["strings.settings.off"];
  if (shape.kind === "enum") return optionLabel(String(d));
  if (shape.kind === "number") return String(d);
  if (shape.kind === "string") {
    const text = String(d);
    if (text === "") return s["strings.settings.default.empty"];
    return text.length > 40 ? `${text.slice(0, 40)}...` : text;
  }
  if (Array.isArray(d)) {
    if (d.length === 0) return s["strings.settings.default.none"];
    const flat = d.every((x) => typeof x !== "object");
    return flat && d.length <= 6
      ? d.map(String).join(", ")
      : fill(s["strings.settings.default.items"], { n: d.length });
  }
  if (d && typeof d === "object") {
    const entries = Object.entries(d as Record<string, unknown>);
    if (shape.kind === "record") {
      return entries.length === 0
        ? s["strings.settings.default.none"]
        : fill(s["strings.settings.default.entries"], { n: entries.length });
    }
    // A small flat object (a Task's role, model and effort; a provider's Roles) reads as its pairs.
    if (entries.length <= 4 && entries.every(([, v]) => typeof v !== "object")) {
      return entries
        .map(([key, v]) => `${key}: ${v === "" ? s["strings.settings.default.empty"] : String(v)}`)
        .join(", ");
    }
    return s["strings.settings.default.custom"];
  }
  return String(d);
}

/**
 * The card every control renders in: the schema label and help (highlighted
 * in search results), the control, data-setting, and the footer with the
 * scope, the Pinned lock, the default with Reset, and any error.
 */
export function Row({ k, label, hint, block, bare, error, foot, children }: RowProps) {
  const shell = useShell();
  const screen = useSettingsScreen();
  const s = shell.settings;
  const entry = settingsSchema[k] as SettingEntry;
  const pinned = shell.pinned.has(k);
  const value = shell.settings[k];
  const changed = !isDefault(k, value);
  const line = pinned ? pinnedLine(shell, k) : null;
  const path = shell.config.file?.path ?? "monday.toml";
  const footer = (
    <>
      <span className="scope">
        {entry.scope === "device"
          ? s["strings.settings.scope.device"]
          : s["strings.settings.scope.global"]}
      </span>
      {pinned ? (
        <span className="pinned-foot">
          {line
            ? fill(s["strings.settings.pinned_foot"], { path, line })
            : fill(s["strings.settings.pinned_file"], { path })}
        </span>
      ) : null}
      {error ? (
        <span className="err">{fill(s["strings.settings.invalid"], { message: error })}</span>
      ) : null}
      {foot}
      <span className="sp" />
      <span className="dflt">
        {fill(s["strings.settings.default"], { value: describeDefault(k, s) })}
      </span>
      {changed && !pinned ? (
        <button
          type="button"
          className="link"
          onClick={() => void screen.change(k, structuredClone(settingsSchema[k].default))}
        >
          {s["strings.settings.reset"]}
        </button>
      ) : null}
    </>
  );
  const attrs = {
    "data-setting": k,
    "data-scope": entry.scope,
    "data-pinned": pinned ? "true" : undefined,
  };
  if (bare) {
    return (
      <div className="scard bare" {...attrs}>
        <div className="scard-main">
          <Pinned k={k}>{children}</Pinned>
        </div>
        <div className="scard-foot">{footer}</div>
      </div>
    );
  }
  return (
    <Card
      title={<Highlighted text={label ?? entry.label} />}
      hint={hint === undefined ? <Highlighted text={entry.help} /> : hint}
      block={block}
      foot={footer}
      attrs={attrs}
    >
      <Pinned k={k}>{children}</Pinned>
    </Card>
  );
}

/** The line a key is set on in the Config file, one-based, or null. */
export function pinnedLine(shell: ShellState, k: SettingKey): number | null {
  const text = shell.config.file?.text;
  if (!text) return null;
  return lineOf(indexLines(text), splitKey(k));
}

/**
 * Locks a control whose key the Config file sets (ADR 0001): the file value
 * is in effect, the control is dimmed and inert, and hovering shows the line.
 */
export function Pinned({ k, children }: { k: SettingKey; children: ReactNode }) {
  const shell = useShell();
  if (!shell.pinned.has(k)) return <>{children}</>;
  const path = shell.config.file?.path ?? "monday.toml";
  const line = pinnedLine(shell, k);
  const lineText = line ? (shell.config.file?.text.split("\n")[line - 1] ?? "").trim() : "";
  const title = line
    ? fill(shell.settings["strings.settings.pinned_line"], { path, line, text: lineText })
    : fill(shell.settings["strings.settings.pinned_file"], { path });
  return (
    <span className="pinned" title={title}>
      <Tag>{shell.settings["strings.settings.pinned"]}</Tag>
      <span className="pinned-control">{children}</span>
    </span>
  );
}

/* ------------------------------ Value hooks ------------------------------ */

/** The current value of a key and a change that validates before it writes. */
export function useSetting<K extends SettingKey>(k: K) {
  const shell = useShell();
  const screen = useSettingsScreen();
  const [error, setError] = useState<string | null>(null);
  const value = shell.settings[k];
  const change = useCallback(
    async (next: unknown) => {
      const v = validateSetting(k, next);
      if (!v.ok) {
        setError(v.error);
        return false;
      }
      const result = await screen.change(k, v.value);
      setError(result.ok ? null : result.message);
      return result.ok;
    },
    [k, screen],
  );
  return { value, change, error, shell };
}

/**
 * Text that commits on blur or Enter, so typing does not write on every key.
 * A commit that was refused (`commit` resolves false) snaps the draft back to
 * the value in effect, so the box never shows a number that was not saved.
 */
export function useDraft(current: string, commit: (text: string) => Promise<boolean> | undefined) {
  const [draft, setDraft] = useState(current);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setDraft(current);
  }, [current, dirty]);
  const onChange = (text: string) => {
    setDraft(text);
    setDirty(true);
  };
  const flush = () => {
    if (!dirty) return;
    setDirty(false);
    if (draft === current) return;
    const result = commit(draft);
    if (result && typeof result.then === "function") {
      void result.then((ok) => {
        if (!ok) setDraft(current);
      });
    }
  };
  return { draft, onChange, flush };
}

/* ------------------------------ Generic controls ------------------------------ */

function BooleanControl({ k }: ControlProps) {
  const { value, change, error } = useSetting(k);
  return (
    <Row k={k} error={error}>
      <Switch on={Boolean(value)} onChange={(on) => void change(on)} />
    </Row>
  );
}

export function EnumPicker({
  options,
  value,
  onChange,
  labels,
  icons,
}: {
  options: readonly string[];
  value: string;
  onChange: (v: string) => void;
  labels?: ((option: string) => string) | undefined;
  icons?: Record<string, IconComponent> | undefined;
}) {
  const label = labels ?? optionLabel;
  if (options.length <= 4) {
    return (
      <Seg
        options={options.map((o) => ({ value: o, label: label(o), icon: icons?.[o] }))}
        value={value}
        onChange={onChange}
      />
    );
  }
  return (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
      {options.map((o) => (
        <option key={o} value={o}>
          {label(o)}
        </option>
      ))}
    </select>
  );
}

/** Icons for an enum's options, by setting key; the mode picker has them in the mock. */
export const enumIcons: Partial<Record<SettingKey, Record<string, IconComponent>>> = {
  "appearance.mode": { system: MonitorIcon, light: SunIcon, dark: MoonIcon },
};

function EnumControl({ k, shape }: ControlProps) {
  const { value, change, error } = useSetting(k);
  if (shape.kind !== "enum") return null;
  return (
    <Row k={k} error={error}>
      <EnumPicker
        options={shape.options}
        value={String(value)}
        onChange={(v) => void change(v)}
        icons={enumIcons[k]}
      />
    </Row>
  );
}

function NumberControl({ k, shape }: ControlProps) {
  const { value, change, error } = useSetting(k);
  const { draft, onChange, flush } = useDraft(String(value), (text) => {
    const n = Number(text);
    return change(text.trim() === "" || Number.isNaN(n) ? text : n);
  });
  if (shape.kind !== "number") return null;
  const step = shape.integer ? 1 : shape.max !== null && shape.max <= 1 ? 0.05 : 0.1;
  return (
    <Row k={k} error={error}>
      <Input
        type="number"
        className="num"
        value={draft}
        min={shape.min ?? undefined}
        max={shape.max ?? undefined}
        step={step}
        onChange={(e) => onChange(e.target.value)}
        onBlur={flush}
        onKeyDown={(e) => {
          if (e.key === "Enter") flush();
        }}
      />
    </Row>
  );
}

function StringControl({ k, shape }: ControlProps) {
  const { value, change, error } = useSetting(k);
  const { draft, onChange, flush } = useDraft(String(value), (text) => change(text));
  if (shape.kind !== "string") return null;
  return (
    <Row k={k} error={error}>
      <Input
        type={shape.url ? "url" : "text"}
        className="text"
        value={draft}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onBlur={flush}
        onKeyDown={(e) => {
          if (e.key === "Enter") flush();
        }}
      />
    </Row>
  );
}

/** A multi-line string: a rule sentence, a prompt, a signature. Registered as "sentence". */
export function SentenceControl({ k }: ControlProps) {
  const { value, change, error } = useSetting(k);
  const { draft, onChange, flush } = useDraft(String(value), (text) => change(text));
  return (
    <Row k={k} block error={error}>
      <textarea
        className="input area"
        value={draft}
        spellCheck={false}
        rows={Math.min(8, Math.max(2, draft.split("\n").length + 1))}
        onChange={(e) => onChange(e.target.value)}
        onBlur={flush}
      />
    </Row>
  );
}
controlKinds.sentence = SentenceControl;

/** An editor for one value of a shape, used inside lists and records. */
function ItemEditor({
  shape,
  value,
  onChange,
  placeholder,
}: {
  shape: ControlShape;
  value: unknown;
  onChange: (v: unknown) => void;
  placeholder?: string | undefined;
}) {
  if (shape.kind === "enum") {
    return (
      <select className="select" value={String(value)} onChange={(e) => onChange(e.target.value)}>
        {shape.options.map((o) => (
          <option key={o} value={o}>
            {optionLabel(o)}
          </option>
        ))}
      </select>
    );
  }
  if (shape.kind === "number") {
    return (
      <Input
        type="number"
        className="num"
        value={String(value ?? "")}
        min={shape.min ?? undefined}
        max={shape.max ?? undefined}
        step={shape.integer ? 1 : 0.1}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
      />
    );
  }
  if (shape.kind === "boolean") {
    return <Switch on={Boolean(value)} onChange={onChange} />;
  }
  return (
    <Input
      className="text"
      value={String(value ?? "")}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function ListControl({ k, shape }: ControlProps) {
  const { value, change, error, shell } = useSetting(k);
  const s = shell.settings;
  const items = Array.isArray(value) ? (value as unknown[]) : [];
  const item = shape.kind === "list" ? shape.item : ({ kind: "json" } as ControlShape);
  const [adding, setAdding] = useState<unknown>(item.kind === "enum" ? item.options[0] : "");
  if (item.kind !== "string" && item.kind !== "enum" && item.kind !== "number") {
    return <JsonControl k={k} entry={settingsSchema[k] as SettingEntry} shape={shape} />;
  }
  const add = () => {
    if (adding === "" || adding === undefined) return;
    void change([...items, adding]);
    setAdding(item.kind === "enum" ? item.options[0] : "");
  };
  return (
    <Row k={k} block error={error}>
      <div className="set-list">
        {items.map((it, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a list may repeat a value; the position is the identity
          <span className="chip on" key={`${String(it)}-${i}`}>
            {String(it)}
            <button
              type="button"
              className="x"
              aria-label={s["strings.settings.list.remove"]}
              onClick={() => void change(items.filter((_, j) => j !== i))}
            >
              <XIcon />
            </button>
          </span>
        ))}
        <span className="set-list-add">
          <ItemEditor
            shape={item}
            value={adding}
            onChange={setAdding}
            placeholder={s["strings.settings.list.placeholder"]}
          />
          <Btn sm onClick={add}>
            {s["strings.settings.list.add"]}
          </Btn>
        </span>
      </div>
    </Row>
  );
}

/** Key to value rows; the value editor follows the record's value shape. */
export function RecordEditor({
  k,
  value,
  valueShape,
  onChange,
  keyLabel,
  keyOptions,
}: {
  k: SettingKey;
  value: Record<string, unknown>;
  valueShape: ControlShape;
  onChange: (next: Record<string, unknown>) => void;
  keyLabel?: ((key: string) => string) | undefined;
  /** When the keys come from a known set (Accounts, Groups), an add picks one instead of typing. */
  keyOptions?: string[] | undefined;
}) {
  const s = useShell().settings;
  const entries = Object.entries(value);
  const free = keyOptions?.filter((o) => !(o in value));
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState<unknown>(
    valueShape.kind === "enum" ? valueShape.options[0] : "",
  );
  const add = () => {
    const key = (free ? newKey || (free[0] ?? "") : newKey).trim();
    if (!key || newValue === "") return;
    onChange({ ...value, [key]: newValue });
    setNewKey("");
    setNewValue(valueShape.kind === "enum" ? valueShape.options[0] : "");
  };
  return (
    <div className="record" data-record={k}>
      {entries.map(([key, v]) => (
        <div className="record-row" key={key}>
          <span className="record-key">{keyLabel ? keyLabel(key) : key}</span>
          <ItemEditor
            shape={valueShape}
            value={v}
            onChange={(next) => onChange({ ...value, [key]: next })}
          />
          <Btn
            sm
            icon
            aria-label={s["strings.settings.list.remove"]}
            onClick={() => {
              const { [key]: _gone, ...rest } = value;
              onChange(rest);
            }}
          >
            <XIcon />
          </Btn>
        </div>
      ))}
      {free && free.length === 0 ? null : (
        <div className="record-row add">
          {free ? (
            <select
              className="select"
              value={newKey || free[0]}
              onChange={(e) => setNewKey(e.target.value)}
            >
              {free.map((o) => (
                <option key={o} value={o}>
                  {keyLabel ? keyLabel(o) : o}
                </option>
              ))}
            </select>
          ) : (
            <Input
              className="text"
              value={newKey}
              placeholder={s["strings.settings.record.key"]}
              spellCheck={false}
              onChange={(e) => setNewKey(e.target.value)}
            />
          )}
          <ItemEditor
            shape={valueShape}
            value={newValue}
            onChange={setNewValue}
            placeholder={s["strings.settings.record.value"]}
          />
          <Btn sm onClick={add}>
            {s["strings.settings.list.add"]}
          </Btn>
        </div>
      )}
    </div>
  );
}

function RecordControl({ k, shape }: ControlProps) {
  const { value, change, error } = useSetting(k);
  const valueShape = shape.kind === "record" ? shape.value : ({ kind: "json" } as ControlShape);
  if (valueShape.kind !== "string" && valueShape.kind !== "enum" && valueShape.kind !== "number") {
    return <JsonControl k={k} entry={settingsSchema[k] as SettingEntry} shape={shape} />;
  }
  return (
    <Row k={k} block error={error}>
      <RecordEditor
        k={k}
        value={(value ?? {}) as Record<string, unknown>}
        valueShape={valueShape}
        onChange={(next) => void change(next)}
      />
    </Row>
  );
}

/** Anything without a plain shape: edited as JSON, validated by the schema on blur. */
export function JsonControl({ k }: ControlProps) {
  const { value, change, error, shell } = useSetting(k);
  const [bad, setBad] = useState<string | null>(null);
  const { draft, onChange, flush } = useDraft(JSON.stringify(value, null, 2), (text) => {
    try {
      setBad(null);
      return change(JSON.parse(text));
    } catch {
      setBad(shell.settings["strings.settings.json.invalid"]);
      return Promise.resolve(true);
    }
  });
  return (
    <Row k={k} block error={bad ?? error}>
      <textarea
        className="input area mono"
        value={draft}
        spellCheck={false}
        rows={Math.min(14, Math.max(3, draft.split("\n").length))}
        onChange={(e) => onChange(e.target.value)}
        onBlur={flush}
      />
    </Row>
  );
}

/* ------------------------------ Danger actions ------------------------------ */

/**
 * A destructive button that asks first, inline: the first click shows the
 * question with Confirm and Cancel; the second runs the action. A failure
 * shows its message in plain words next to the button.
 */
export function DangerAction({
  label,
  confirm,
  onConfirm,
  busy,
  disabled,
}: {
  label: string;
  /** The question shown before the action runs. */
  confirm: string;
  onConfirm: () => Promise<void> | void;
  busy?: boolean | undefined;
  disabled?: boolean | undefined;
}) {
  const s = useShell().settings;
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setError(null);
    try {
      await onConfirm();
      setAsking(false);
    } catch (e) {
      setError(fill(s["strings.settings.failed"], { message: messageOf(e) }));
    }
  };
  if (asking) {
    return (
      <span className="danger-ask" role="alertdialog">
        <span className="q">{confirm}</span>
        <Btn sm className="danger" disabled={busy} onClick={() => void run()}>
          {s["strings.settings.confirm"]}
        </Btn>
        <Btn sm disabled={busy} onClick={() => setAsking(false)}>
          {s["strings.settings.cancel"]}
        </Btn>
        {error ? <span className="err">{error}</span> : null}
      </span>
    );
  }
  return (
    <span className="danger-ask">
      <Btn sm className="danger" disabled={disabled || busy} onClick={() => setAsking(true)}>
        {label}
      </Btn>
      {error ? <span className="err">{error}</span> : null}
    </span>
  );
}

/** The message of a thrown value, for the plain-words error lines. */
export function messageOf(e: unknown): string {
  if (e instanceof Error) {
    try {
      const body = JSON.parse(e.message) as { message?: string; error?: string };
      return body.message ?? body.error ?? e.message;
    } catch {
      return e.message || "unknown error";
    }
  }
  return String(e);
}

/* ------------------------------ Ask monday ------------------------------ */

/** An "Ask monday" input: the text goes to the composer, prefilled; nothing runs here. */
export function AskInput({
  label,
  placeholder,
  prompt,
}: {
  label: string;
  placeholder: string;
  /** The composer text with {text} for what was typed. */
  prompt: string;
}) {
  const screen = useSettingsScreen();
  const s = useShell().settings;
  const [text, setText] = useState("");
  // Just mail: there is no Agent to ask (CONTEXT.md "AI level").
  if (s["ai.level"] === "off") return null;
  const send = () => {
    if (!text.trim()) return;
    screen.onAsk(fill(prompt, { text: text.trim() }));
    setText("");
  };
  return (
    <div className="set-ask">
      <div>
        <b>{label}</b>
        <span className="set-ask-row">
          <Input
            value={text}
            placeholder={placeholder}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") send();
            }}
          />
          <Btn sm primary disabled={!text.trim()} onClick={send}>
            {s["strings.settings.ask.send"]}
          </Btn>
        </span>
      </div>
    </div>
  );
}
