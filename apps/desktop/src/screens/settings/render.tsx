// The schema-driven Settings renderer (docs/spec/settings.md, ADR 0004). A page
// is one section of the schema: its groups in SETTING_GROUPS order, one
// control per key chosen from the key's control shape (switch, segmented
// control or select, number with its range, text, list, record, JSON) or from
// the `controls` registry when the schema names a special one (palette
// swatches, the binding table, the task-to-Role map). Panels that are not
// Settings (the Accounts list, the Meter, the Activity log) hang off a group
// name. A Pinned key renders locked with "set in monday.toml" and the line it
// is set on (ADR 0001). Every control carries data-setting with its key, which
// is what the coverage test walks. There is no hand-built settings screen.

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

/** Panels by section and group name: rendered above the group's controls. */
export const panels: Partial<Record<SettingSection, Record<string, PanelComponent>>> = {};

export function registerPanel(section: SettingSection, group: string, panel: PanelComponent) {
  const bySection = panels[section] ?? {};
  bySection[group] = panel;
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

export function SettingsPage({ section }: { section: SettingSection }) {
  const shell = useShell();
  const s = shell.settings;
  const level = s["ai.level"];
  const groups = useMemo(
    () =>
      groupsInSectionAt(section, level).filter(
        (g) =>
          g.keys.length > 0 ||
          g.advanced.length > 0 ||
          levelAtLeast(level, panelLevel(section, g.name)),
      ),
    [section, level],
  );
  return (
    <>
      <h1>{s[`strings.settings.section.${section}`]}</h1>
      <p>{s[`strings.settings.intro.${section}`]}</p>
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
  const Panel = panels[section]?.[group.name];
  const showHeading = group.keys.length > 0 || group.advanced.length > 0 || Panel;
  if (!showHeading) return null;
  const intro = introKey(section, group.name);
  return (
    <div className="sect" data-group={group.name}>
      <h3>{group.name}</h3>
      {intro ? <p>{String(s[intro])}</p> : null}
      {Panel ? <Panel section={section} group={group} /> : null}
      {group.keys.map((k) => (
        <SettingControl key={k} k={k} />
      ))}
      {group.advanced.length > 0 ? (
        <details className="advanced">
          <summary>{s["strings.settings.advanced"]}</summary>
          {group.advanced.map((k) => (
            <SettingControl key={k} k={k} />
          ))}
        </details>
      ) : null}
    </div>
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

/* ------------------------------ Row and Pinned ------------------------------ */

export interface RowProps {
  k: SettingKey;
  /** Overrides the schema label. */
  label?: string | undefined;
  /** Overrides the schema help. */
  hint?: ReactNode | undefined;
  /** A wide control that sits under the label instead of beside it. */
  block?: boolean | undefined;
  /** No label at all: the control is the whole row (the swatches, the runtime cards). */
  bare?: boolean | undefined;
  /** A validation or save problem shown under the control. */
  error?: string | null | undefined;
  children?: ReactNode | undefined;
}

/**
 * The labelled row every control renders in: the same markup as the ui
 * package's SettingsField, plus data-setting and the Pinned lock.
 */
export function Row({ k, label, hint, block, bare, error, children }: RowProps) {
  const shell = useShell();
  const entry = settingsSchema[k] as SettingEntry;
  const problem = error ? (
    <span className="err">
      {fill(shell.settings["strings.settings.invalid"], { message: error })}
    </span>
  ) : null;
  return (
    <div
      className={cx("field", (block || bare) && "block", bare && "bare")}
      data-setting={k}
      data-scope={entry.scope}
      data-pinned={shell.pinned.has(k) ? "true" : undefined}
    >
      {bare ? (
        problem
      ) : (
        <div className="l">
          <b>{label ?? entry.label}</b>
          {hint === undefined ? <span>{entry.help}</span> : hint ? <span>{hint}</span> : null}
          {problem}
        </div>
      )}
      <Pinned k={k}>{children}</Pinned>
    </div>
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
    : `Set in ${path}`;
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

/** Text that commits on blur or Enter, so typing does not write on every key. */
export function useDraft(current: string, commit: (text: string) => void) {
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
    if (draft !== current) commit(draft);
  };
  return { draft, onChange, flush };
}

/** "google-meet" as "Google meet", "on_open" as "On open". */
export function optionLabel(option: string): string {
  const text = option.replaceAll(/[-_]/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
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
    void change(Number.isNaN(n) ? text : n);
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
  const { draft, onChange, flush } = useDraft(String(value), (text) => void change(text));
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
  const { draft, onChange, flush } = useDraft(String(value), (text) => void change(text));
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
      void change(JSON.parse(text));
    } catch {
      setBad(shell.settings["strings.settings.json.invalid"]);
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
