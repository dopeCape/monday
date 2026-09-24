// The special controls the schema names where a plain type is not enough
// (docs/spec/settings.md): palette swatches with Custom from file, the layout
// preset over the three knobs, the Views list, the Section rules with rename,
// hide and reorder, per-Account maps, the runtime mode cards and CLI list,
// per-provider Roles and keys (never displayed), the task-to-Role map, the
// Permissions tier list, the keymap binding table and the MCP servers list.
// Each is still keyed by a schema entry and registers under the name that
// entry's `control` gives, so the renderer walks the schema and nothing else.

import {
  type AiLevel,
  type Calendar,
  type CustomActionValue,
  type Effort,
  HOSTED_PROVIDERS,
  type HostedProvider,
  isSettingKey,
  JUDGE_PROVIDERS,
  KEY_PROVIDERS,
  type KeyProvider,
  type Layout,
  type McpServerSetting,
  orderedSectionRules,
  PRESETS,
  PROVIDER_LABELS,
  presetForLayout,
  type Role,
  type SectionRuleValue,
  type SettingKey,
  type Settings,
  settingsSchema,
  TASKS,
  type TaskModel,
  TOOL_TIERS,
  tierOf,
  type ViewSetting,
} from "@monday/shared";
import {
  Btn,
  type ChoiceCard,
  ChoiceCards,
  CustomSwatch,
  Input,
  Kbd,
  palettes,
  Seg,
  Swatch,
  Switch,
  Tag,
} from "@monday/ui";
import { KeyIcon, TerminalWindowIcon, XIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  chordLabel,
  chordOf,
  conflicts,
  KEY_ACTIONS,
  type KeyAction,
  type KeymapName,
  normalizeChord,
  resolveKeymap,
} from "../../keyboard/keymaps.ts";
import { type AccountView, ApiError } from "../../platform/api.ts";
import { useShell } from "../../shell/Shell.tsx";
import { ActionsBlock, SectionsBlock, sectionNameOf } from "../routing/OrganizeBlocks.tsx";
import { Disclosure } from "./disclosure.tsx";
import {
  AskInput,
  type ControlProps,
  controlKinds,
  DangerAction,
  type DetectedCli,
  EnumPicker,
  foldBadges,
  foldLines,
  messageOf,
  optionLabel,
  type PanelProps,
  RecordEditor,
  Row,
  registerPanel,
  SettingControl,
  useDraft,
  useKeyStateVersion,
  useSetting,
  useSettingsScreen,
} from "./render.tsx";
import { fill } from "./wizard.ts";

/* ------------------------------ Shared data hooks ------------------------------ */

/** The Accounts of this Server, for per-Account maps. Empty without a Server. */
export function useAccounts(): AccountView[] {
  const shell = useShell();
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  useEffect(() => {
    let live = true;
    shell.api.accounts
      .list()
      .then((r) => {
        if (live) setAccounts(r.accounts);
      })
      .catch(() => {
        if (live) setAccounts([]);
      });
    return () => {
      live = false;
    };
  }, [shell.api]);
  return accounts;
}

/** The Groups of this Workspace by id, for Group pickers. Empty without a Server. */
export function useGroupNames(): Record<string, string> {
  const shell = useShell();
  const screen = useSettingsScreen();
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    shell.api.routing
      .groups(screen.workspaceId)
      .then((groups) => {
        if (live) setNames(Object.fromEntries(groups.map((g) => [g.id, g.name])));
      })
      .catch(() => {
        if (live) setNames({});
      });
    return () => {
      live = false;
    };
  }, [shell.api, screen.workspaceId]);
  return names;
}

/* ------------------------------ Appearance ------------------------------ */

const PALETTE_KEYS = new Set<string>(palettes.map((p) => p.key));

/** Swatches for the shipped palettes plus Custom from file (a token TOML or base16 path). */
function PaletteControl({ k }: ControlProps) {
  const { value, change, error, shell } = useSetting(k);
  const s = shell.settings;
  const current = String(value);
  const custom = !PALETTE_KEYS.has(current);
  const [editing, setEditing] = useState(custom);
  const resolved: "light" | "dark" =
    shell.mode === "system"
      ? typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : shell.mode;
  const path = useDraft(custom ? current : "", (text) =>
    text.trim() ? change(text.trim()) : undefined,
  );
  // The file's outcome: its name once it applied, or the first problem in the footer.
  const file = custom ? shell.customPalette : null;
  return (
    <Row
      k={k}
      block
      error={error ?? file?.error}
      foot={
        file?.name ? (
          <span className="palette-name" data-palette-name={file.name}>
            {fill(s["strings.settings.palette.from_file"], { name: file.name })}
          </span>
        ) : undefined
      }
    >
      <div className="swatches">
        {palettes.map((p) => (
          <Swatch
            key={p.key}
            palette={p}
            mode={resolved}
            on={current === p.key}
            onSelect={(key) => {
              setEditing(false);
              void change(key);
            }}
          />
        ))}
        <CustomSwatch className={custom ? "on" : undefined} onSelect={() => setEditing(true)} />
      </div>
      {editing || custom ? (
        <div className="palette-path">
          <b>{s["strings.settings.palette.path"]}</b>
          <Input
            value={path.draft}
            placeholder="~/.config/monday/palette.toml"
            spellCheck={false}
            onChange={(e) => path.onChange(e.target.value)}
            onBlur={path.flush}
            onKeyDown={(e) => {
              if (e.key === "Enter") path.flush();
            }}
          />
          <span>{s["strings.settings.palette.path_help"]}</span>
        </div>
      ) : null}
    </Row>
  );
}
controlKinds.palette = PaletteControl;

const PRESET_NAMES = Object.keys(PRESETS) as Array<keyof typeof PRESETS>;

/** The named Layouts: picking one writes the three knobs and the preset as one change. */
function LayoutPresetControl({ k }: ControlProps) {
  const shell = useShell();
  const screen = useSettingsScreen();
  const s = shell.settings;
  const entry = settingsSchema[k];
  const [error, setError] = useState<string | null>(null);
  const current = presetForLayout(shell.layout);
  const options = [
    ...PRESET_NAMES.map((p) => ({ value: p, label: optionLabel(p) })),
    ...(current === "custom"
      ? [{ value: "custom", label: s["strings.settings.layout.custom"] }]
      : []),
  ];
  return (
    <Row k={k} error={error}>
      <Seg
        options={options}
        value={current}
        onChange={(p) => {
          const preset = PRESETS[p as keyof typeof PRESETS];
          if (!preset) return;
          void screen
            .changeMany(
              [
                ["layout.preset", p],
                ["layout.nav", preset.nav],
                ["layout.agent", preset.agent],
                ["layout.list", preset.list],
              ],
              entry.label,
            )
            .then((r) => setError(r.ok ? null : r.message));
        }}
      />
    </Row>
  );
}
controlKinds["layout-preset"] = LayoutPresetControl;

const FONTS = ["Geist Variable", "Inter", "IBM Plex Sans", "system-ui"];
const MONO_FONTS = ["Geist Mono Variable", "JetBrains Mono", "IBM Plex Mono", "monospace"];

/** A font picker: the shipped choices, or Other with a family typed in. */
function FontControl({ k }: ControlProps) {
  const { value, change, error, shell } = useSetting(k);
  const s = shell.settings;
  const choices = k === "appearance.monospace" ? MONO_FONTS : FONTS;
  const current = String(value);
  const known = choices.includes(current);
  const [other, setOther] = useState(!known);
  const typed = useDraft(known ? "" : current, (text) =>
    text.trim() ? change(text.trim()) : undefined,
  );
  return (
    <Row k={k} error={error}>
      <span className="font-pick">
        <select
          className="select"
          value={known && !other ? current : "other"}
          onChange={(e) => {
            if (e.target.value === "other") setOther(true);
            else {
              setOther(false);
              void change(e.target.value);
            }
          }}
        >
          {choices.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
          <option value="other">{s["strings.settings.font.other"]}</option>
        </select>
        {other || !known ? (
          <Input
            className="text"
            value={typed.draft}
            placeholder="Font family"
            onChange={(e) => typed.onChange(e.target.value)}
            onBlur={typed.flush}
            onKeyDown={(e) => {
              if (e.key === "Enter") typed.flush();
            }}
          />
        ) : null}
      </span>
    </Row>
  );
}
controlKinds.font = FontControl;

const VIEW_SLOTS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

function knobSummary(layout: Layout): string {
  return `${layout.list} · ${layout.nav} nav · agent ${layout.agent}`;
}

/** Saved Layouts: rename, reassign the shortcut, delete, and ask monday for a new one. */
function ViewsControl({ k }: ControlProps) {
  const { value, change, error, shell } = useSetting(k);
  const s = shell.settings;
  const views = (value ?? []) as ViewSetting[];
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const mac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
  const update = (id: string, patch: Partial<ViewSetting>) =>
    void change(views.map((v) => (v.id === id ? { ...v, ...patch } : v)));
  return (
    <Row k={k} block error={error}>
      <div className="views">
        {views.length === 0 ? (
          <div className="note">{s["strings.settings.views.empty"]}</div>
        ) : null}
        {views.map((v) => {
          const current =
            v.layout.nav === shell.layout.nav &&
            v.layout.agent === shell.layout.agent &&
            v.layout.list === shell.layout.list;
          return (
            <div className="v" key={v.id} data-view={v.id}>
              <div>
                {renaming?.id === v.id ? (
                  <Input
                    value={renaming.name}
                    autoFocus
                    onChange={(e) => setRenaming({ id: v.id, name: e.target.value })}
                    onBlur={() => {
                      if (renaming.name.trim()) update(v.id, { name: renaming.name.trim() });
                      setRenaming(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") setRenaming(null);
                    }}
                  />
                ) : (
                  <b>{v.name}</b>
                )}
                <span>{knobSummary(v.layout)}</span>
              </div>
              <span className="tag">
                {current ? s["strings.settings.views.current"] : s["strings.settings.views.by"]}
              </span>
              <span className="view-actions">
                <select
                  className="select"
                  aria-label={s["strings.settings.views.shortcut"]}
                  value={v.shortcut ?? ""}
                  onChange={(e) => update(v.id, { shortcut: e.target.value || null })}
                >
                  <option value="">{s["strings.settings.views.none"]}</option>
                  {VIEW_SLOTS.map((n) => (
                    <option key={n} value={`mod+${n}`}>
                      {chordLabel(`mod+${n}`, mac)}
                    </option>
                  ))}
                </select>
                <Btn sm onClick={() => setRenaming({ id: v.id, name: v.name })}>
                  {s["strings.settings.views.rename"]}
                </Btn>
                <DangerAction
                  label={s["strings.settings.views.delete"]}
                  confirm={fill(s["strings.settings.views.delete_confirm"], { name: v.name })}
                  onConfirm={async () => {
                    const ok = await change(views.filter((x) => x.id !== v.id));
                    if (!ok) throw new Error(error ?? "not saved");
                  }}
                />
              </span>
            </div>
          );
        })}
      </div>
      <AskInput
        label={s["strings.settings.views.ask"]}
        placeholder={s["strings.settings.views.ask_placeholder"]}
        prompt={s["strings.settings.views.ask_prompt"]}
      />
    </Row>
  );
}
controlKinds.views = ViewsControl;

/* ------------------------------ Routing ------------------------------ */

/**
 * The Section rules in their order (sections.rules with sections.order
 * rendered inside): the same block the Routing page shows, so rename, hide,
 * reorder, placement, the judge statement, delete and "Ask monday to change"
 * live in one place. A shipped Section renames through its string Setting.
 */
function SectionRulesControl({ k }: ControlProps) {
  const { value, error, shell } = useSetting(k);
  const screen = useSettingsScreen();
  const s = shell.settings;
  const rules = (value ?? []) as SectionRuleValue[];
  return (
    <Row k={k} block error={error}>
      <SectionsBlock
        settings={s}
        rules={rules}
        order={s["sections.order"]}
        onChange={(nextRules, nextOrder) =>
          screen.changeMany(
            [
              ["sections.rules", nextRules],
              ["sections.order", nextOrder],
            ],
            settingsSchema["sections.rules"].label,
          )
        }
        onRenameString={(key, name) => screen.change(key as SettingKey, name)}
        onAsk={(text) => screen.onAsk(text)}
      />
    </Row>
  );
}
controlKinds["section-rules"] = SectionRulesControl;

/** The custom actions (actions.custom): the same block the Routing page shows. */
function CustomActionsControl({ k }: ControlProps) {
  const { value, change, error, shell } = useSetting(k);
  const screen = useSettingsScreen();
  const s = shell.settings;
  const names = useGroupNames();
  const actions = (value ?? []) as CustomActionValue[];
  const sections = orderedSectionRules(s["sections.rules"], s["sections.order"]).map((r) => ({
    id: r.id,
    name: sectionNameOf(s, r),
  }));
  return (
    <Row k={k} block error={error}>
      <ActionsBlock
        settings={s}
        actions={actions}
        onChange={(next) => change(next)}
        groups={Object.entries(names).map(([id, name]) => ({ id, name }))}
        sections={sections}
        onAsk={(text) => screen.onAsk(text)}
      />
    </Row>
  );
}
controlKinds["custom-actions"] = CustomActionsControl;

/** The Group a Thread stays in when no rule is confident: a pick from the Workspace's Groups. */
function GroupPickControl({ k }: ControlProps) {
  const { value, change, error, shell } = useSetting(k);
  const names = useGroupNames();
  const current = String(value ?? "");
  const options = Object.keys(names);
  if (current && !options.includes(current)) options.push(current);
  return (
    <Row k={k} error={error}>
      <select className="select" value={current} onChange={(e) => void change(e.target.value)}>
        <option value="">{shell.settings["strings.settings.groups.none"]}</option>
        {options.map((id) => (
          <option key={id} value={id}>
            {names[id] ?? id}
          </option>
        ))}
      </select>
    </Row>
  );
}
controlKinds["group-pick"] = GroupPickControl;

/** Per-Group brief policy: Group name to always, on_open or never. */
function GroupPoliciesControl({ k, shape }: ControlProps) {
  const { value, change, error } = useSetting(k);
  const names = useGroupNames();
  if (shape.kind !== "record") return null;
  return (
    <Row k={k} block error={error}>
      <RecordEditor
        k={k}
        value={(value ?? {}) as Record<string, unknown>}
        valueShape={shape.value}
        keyOptions={Object.keys(names)}
        keyLabel={(id) => names[id] ?? id}
        onChange={(next) => void change(next)}
      />
    </Row>
  );
}
controlKinds["group-policies"] = GroupPoliciesControl;

/* ------------------------------ Accounts ------------------------------ */

/** An Account address to a value (a signature, a meeting link kind), keyed by the Accounts that exist. */
function PerAccountControl({ k, shape }: ControlProps) {
  const { value, change, error } = useSetting(k);
  const accounts = useAccounts();
  if (shape.kind !== "record") return null;
  const valueShape = shape.value;
  const current = (value ?? {}) as Record<string, unknown>;
  if (valueShape.kind === "string") {
    // A signature per Account: one textarea each, for the Accounts that exist plus any already set.
    const addresses = [
      ...accounts.map((a) => a.address),
      ...Object.keys(current).filter((a) => !accounts.some((x) => x.address === a)),
    ];
    return (
      <Row k={k} block error={error}>
        <div className="record">
          {addresses.map((address) => (
            <PerAccountText
              key={address}
              address={address}
              text={String(current[address] ?? "")}
              onCommit={(text) => {
                const next = { ...current };
                if (text.trim()) next[address] = text;
                else delete next[address];
                return change(next);
              }}
            />
          ))}
        </div>
      </Row>
    );
  }
  return (
    <Row k={k} block error={error}>
      <RecordEditor
        k={k}
        value={current}
        valueShape={valueShape}
        keyOptions={accounts.map((a) => a.address)}
        onChange={(next) => void change(next)}
      />
    </Row>
  );
}
controlKinds["per-account"] = PerAccountControl;

function PerAccountText({
  address,
  text,
  onCommit,
}: {
  address: string;
  text: string;
  onCommit: (text: string) => Promise<boolean>;
}) {
  const s = useShell().settings;
  const d = useDraft(text, onCommit);
  return (
    <label className="record-row block" data-account={address}>
      <span className="record-key">{address}</span>
      <textarea
        className="input area"
        rows={2}
        value={d.draft}
        placeholder={s["strings.settings.accounts.shared"]}
        onChange={(e) => d.onChange(e.target.value)}
        onBlur={d.flush}
      />
    </label>
  );
}

/* ------------------------------ AI and agent ------------------------------ */

/** What this Device can run on: a detected CLI, a language model key, a TypeSafe key (here or shared). */
export interface RuntimeState {
  cli: boolean;
  /** A language model's key on this Device or shared with the Server. */
  language: boolean;
  /** A TypeSafe key on this Device or shared with the Server (ADR 0012). */
  judge: boolean;
}

/**
 * The runtimes reachable from this Device: a detected CLI, Device keys, and
 * keys shared with the Server. Null while the seams are still answering; a key
 * write bumps the key-state version and re-reads.
 */
export function useRuntimeState(): RuntimeState | null {
  const shell = useShell();
  const screen = useSettingsScreen();
  const { version } = useKeyStateVersion();
  const [state, setState] = useState<RuntimeState | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a key write bumps the version, which re-runs the check
  useEffect(() => {
    let live = true;
    const run = async (): Promise<RuntimeState> => {
      const detected = await (screen.runtimes?.detect() ?? Promise.resolve([])).catch(() => []);
      const cli = detected.some((d) => d.status !== "missing");
      const have = new Set<KeyProvider>();
      if (screen.keys) {
        for (const p of KEY_PROVIDERS) if (await screen.keys.get(p)) have.add(p);
      }
      try {
        for (const p of (await shell.api.keys.shared()).shared) have.add(p);
      } catch {}
      return {
        cli,
        language: HOSTED_PROVIDERS.some((p) => have.has(p)),
        judge: JUDGE_PROVIDERS.some((p) => have.has(p)),
      };
    };
    void run().then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
    };
  }, [screen.runtimes, screen.keys, shell.api, version]);
  return state;
}

/**
 * Whether the runtimes at hand satisfy an AI level (docs/spec/onboarding.md,
 * the runtime step): `assist` needs a language model (a CLI or a key), since
 * the assistant writes; `automate` is satisfied by TypeSafe alone, which
 * sorts, or by a language model; `off` needs nothing.
 */
export function runtimeSatisfies(state: RuntimeState, level: AiLevel): boolean {
  if (level === "off") return true;
  const language = state.cli || state.language;
  return level === "automate" ? language || state.judge : language;
}

/**
 * Whether a runtime for `level` is configured on this Device. Null while the
 * seams are still answering. Moving up from `off` asks for one only when this
 * is false (docs/spec/onboarding.md, "First screen").
 */
export function useRuntimeConfigured(level: AiLevel = "assist"): boolean | null {
  const state = useRuntimeState();
  return state === null ? null : runtimeSatisfies(state, level);
}

/** The three AI level cards' copy, from the strings Settings. */
export function levelCards(s: Settings): ChoiceCard<AiLevel>[] {
  return [
    { value: "off", title: s["strings.ai.level.off"], body: s["strings.ai.level.off_sub"] },
    {
      value: "assist",
      title: s["strings.ai.level.assist"],
      body: s["strings.ai.level.assist_sub"],
    },
    {
      value: "automate",
      title: s["strings.ai.level.automate"],
      body: s["strings.ai.level.automate_sub"],
    },
  ];
}

/** The three ways in on the runtime step (docs/spec/onboarding.md). */
export type RuntimeWay = "typesafe" | "llm" | "both";

/** The three runtime cards' copy; "both" is recommended when the level sorts and acts. */
export function runtimeCards(s: Settings, level: AiLevel): ChoiceCard<RuntimeWay>[] {
  const recommended = level === "automate" ? s["strings.ai.level.runtime.recommended"] : undefined;
  return [
    {
      value: "typesafe",
      title: s["strings.ai.level.runtime.typesafe"],
      body: s["strings.ai.level.runtime.typesafe_sub"],
    },
    {
      value: "llm",
      title: s["strings.ai.level.runtime.llm"],
      body: s["strings.ai.level.runtime.llm_sub"],
    },
    {
      value: "both",
      title: s["strings.ai.level.runtime.both"],
      body: s["strings.ai.level.runtime.both_sub"],
      adds: recommended,
    },
  ];
}

/**
 * The runtime step: three cards, TypeSafe (a key, validated live, kept in the
 * keychain and shared with the Server when the switch is on), a language
 * model (a Local CLI from the detected list or a Hosted provider with its
 * key, through the same controls the Runtime group renders), or both, the
 * recommended card when the level sorts and acts. Continue follows the level:
 * `assist` needs a language model; `automate` runs sorting on TypeSafe alone,
 * and the step says the composer still needs a language model. Shown under
 * the level cards when moving up from `off` with nothing configured.
 */
export function RuntimeStep({
  level,
  onContinue,
  onBack,
}: {
  level: AiLevel;
  onContinue: () => void;
  onBack?: (() => void) | undefined;
}) {
  const s = useShell().settings;
  const state = useRuntimeState();
  const configured = state === null ? null : runtimeSatisfies(state, level);
  const [way, setWay] = useState<RuntimeWay>(level === "automate" ? "both" : "llm");
  const mode = s["ai.mode"];
  const provider = s["ai.hosted.provider"];
  const judgeOnly = state?.judge === true && !state.cli && !state.language;
  const note =
    judgeOnly && level === "automate"
      ? s["strings.ai.level.runtime.composer_needs_llm"]
      : judgeOnly && level === "assist"
        ? s["strings.ai.level.runtime.assist_needs_llm"]
        : configured === false
          ? s["strings.ai.level.runtime_missing"]
          : null;
  return (
    <div className="level-runtime" data-panel="runtime-step" data-way={way}>
      <h4>{s["strings.ai.level.runtime_title"]}</h4>
      <p>{s["strings.ai.level.runtime_intro"]}</p>
      <ChoiceCards cards={runtimeCards(s, level)} value={way} onChange={setWay} />
      {way !== "llm" ? (
        <div className="runtime-way" data-way="typesafe">
          <p className="choice-note">{s["strings.ai.level.runtime.typesafe_intro"]}</p>
          <ProviderKeyRow k="ai.share_key.typesafe" shareOnSave={s["ai.judge.share_by_default"]} />
        </div>
      ) : null}
      {way !== "typesafe" ? (
        <div className="runtime-way" data-way="llm">
          <SettingControl k="ai.mode" />
          {mode === "local" ? (
            <SettingControl k="ai.local.cli" />
          ) : (
            <>
              <SettingControl k="ai.hosted.provider" />
              <SettingControl k={`ai.share_key.${provider}`} />
            </>
          )}
        </div>
      ) : null}
      {note ? (
        <p className={configured ? "choice-note" : "err"} data-note>
          {note}
        </p>
      ) : null}
      <div className="actions">
        <Btn primary disabled={!configured} onClick={onContinue}>
          {s["strings.ai.level.runtime_continue"]}
        </Btn>
        {onBack ? <Btn onClick={onBack}>{s["strings.ai.level.runtime_back"]}</Btn> : null}
      </div>
    </div>
  );
}

/**
 * The AI level (CONTEXT.md): the three cards from onboarding's first screen,
 * at the top of AI and agent. Moving up from `off` with no runtime configured
 * shows the runtime step first; the level is saved after it.
 */
function AiLevelControl({ k }: ControlProps) {
  const { value, change, error, shell } = useSetting(k);
  const s = shell.settings;
  const current = value as AiLevel;
  const state = useRuntimeState();
  const [pending, setPending] = useState<AiLevel | null>(null);
  const pick = (level: AiLevel) => {
    if (level === current) {
      setPending(null);
      return;
    }
    if (current === "off" && state !== null && !runtimeSatisfies(state, level)) {
      setPending(level);
      return;
    }
    setPending(null);
    void change(level);
  };
  return (
    <Row k={k} bare error={error}>
      <ChoiceCards cards={levelCards(s)} value={pending ?? current} onChange={pick} />
      <p className="choice-note">{s["strings.ai.level.change_note"]}</p>
      {pending ? (
        <RuntimeStep
          level={pending}
          onContinue={() => {
            void change(pending);
            setPending(null);
          }}
          onBack={() => setPending(null)}
        />
      ) : null}
    </Row>
  );
}
controlKinds["ai-level"] = AiLevelControl;

/** Local CLI or API key: the two cards from the mock. */
function RuntimeModeControl({ k }: ControlProps) {
  const { value, change, error, shell } = useSetting(k);
  const s = shell.settings;
  const cards: Array<{ value: "local" | "hosted"; icon: React.ReactNode; b: string; sub: string }> =
    [
      {
        value: "local",
        icon: <TerminalWindowIcon />,
        b: s["strings.settings.runtime.local"],
        sub: s["strings.settings.runtime.local_sub"],
      },
      {
        value: "hosted",
        icon: <KeyIcon />,
        b: s["strings.settings.runtime.hosted"],
        sub: s["strings.settings.runtime.hosted_sub"],
      },
    ];
  return (
    <Row k={k} bare error={error}>
      <div className="mode">
        {cards.map((c) => (
          <button
            type="button"
            key={c.value}
            className={value === c.value ? "on" : ""}
            aria-pressed={value === c.value}
            onClick={() => void change(c.value)}
          >
            {c.icon}
            <b>{c.b}</b>
            <span>{c.sub}</span>
          </button>
        ))}
      </div>
    </Row>
  );
}
controlKinds["runtime-mode"] = RuntimeModeControl;

const CLI_NAMES: Record<DetectedCli["cli"], { label: string; lg: string }> = {
  "claude-code": { label: "Claude Code", lg: "CC" },
  codex: { label: "Codex", lg: "CX" },
  opencode: { label: "OpenCode", lg: "OC" },
};

/**
 * The installed command-line agents with their status. Detection is the
 * screen's `runtimes` seam (slice 15); without it every CLI reads as not found.
 */
function LocalCliControl({ k }: ControlProps) {
  const { value, change, error, shell } = useSetting(k);
  const screen = useSettingsScreen();
  const s = shell.settings;
  const [detected, setDetected] = useState<DetectedCli[] | null>(null);
  useEffect(() => {
    let live = true;
    const detect = screen.runtimes?.detect() ?? Promise.resolve([]);
    detect
      .then((list) => {
        if (live) setDetected(list);
      })
      .catch(() => {
        if (live) setDetected([]);
      });
    return () => {
      live = false;
    };
  }, [screen.runtimes]);
  const status = (cli: DetectedCli["cli"]): { text: string; ok: boolean; sub: string } => {
    if (detected === null)
      return { text: s["strings.settings.runtime.detecting"], ok: false, sub: "" };
    const d = detected.find((x) => x.cli === cli);
    if (!d || d.status === "missing") {
      return {
        text: s["strings.settings.runtime.install"],
        ok: false,
        sub: s["strings.settings.runtime.not_found"],
      };
    }
    const sub = [d.version, d.path].filter((x): x is string => !!x).join(" · ");
    return {
      text:
        d.status === "connected"
          ? s["strings.settings.runtime.connected"]
          : s["strings.settings.runtime.available"],
      ok: true,
      sub,
    };
  };
  return (
    <Row k={k} block hint={s["strings.settings.runtime.detected"]} error={error}>
      <div className="providers">
        {(Object.keys(CLI_NAMES) as DetectedCli["cli"][]).map((cli) => {
          const st = status(cli);
          return (
            <button
              type="button"
              className={`prov ${value === cli ? "on" : ""}`}
              key={cli}
              aria-pressed={value === cli}
              onClick={() => void change(cli)}
            >
              <span className="lg">{CLI_NAMES[cli].lg}</span>
              <div>
                <b>{CLI_NAMES[cli].label}</b>
                <span>{st.sub}</span>
              </div>
              <span className={`st ${st.ok ? "ok" : ""}`}>{st.text}</span>
            </button>
          );
        })}
      </div>
    </Row>
  );
}
controlKinds["local-cli"] = LocalCliControl;

const PROVIDER_LG: Record<HostedProvider, string> = {
  anthropic: "A",
  gemini: "G",
  openai: "O",
  kimi: "K",
  openrouter: "OR",
};

/** Which providers hold a key on this Device and which are shared with the Server; TypeSafe among them. */
export function useKeyState() {
  const shell = useShell();
  const screen = useSettingsScreen();
  const { version, bump } = useKeyStateVersion();
  const [onDevice, setOnDevice] = useState<Set<KeyProvider>>(new Set());
  const [shared, setShared] = useState<Set<KeyProvider>>(new Set());
  const read = useCallback(async () => {
    const keys = screen.keys;
    if (keys) {
      const have = await Promise.all(
        KEY_PROVIDERS.map(async (p) => [p, await keys.get(p)] as const),
      );
      setOnDevice(new Set(have.filter(([, v]) => v).map(([p]) => p)));
    }
    try {
      setShared(new Set((await shell.api.keys.shared()).shared));
    } catch {
      setShared(new Set());
    }
  }, [screen.keys, shell.api]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: every key write bumps the version so every reader re-reads
  useEffect(() => {
    void read();
  }, [read, version]);
  return { onDevice, shared, refresh: bump };
}

/** The Hosted provider list with key state; picking one makes it the runtime's provider. */
function HostedProviderControl({ k }: ControlProps) {
  const { value, change, error, shell } = useSetting(k);
  const s = shell.settings;
  const { onDevice, shared } = useKeyState();
  return (
    <Row k={k} block hint={s["strings.settings.keys.intro"]} error={error}>
      <div className="providers">
        {HOSTED_PROVIDERS.map((p) => {
          const has = onDevice.has(p) || shared.has(p);
          return (
            <button
              type="button"
              className={`prov ${value === p ? "on" : ""}`}
              key={p}
              aria-pressed={value === p}
              onClick={() => void change(p)}
            >
              <span className="lg">{PROVIDER_LG[p]}</span>
              <div>
                <b>{PROVIDER_LABELS[p]}</b>
                <span>{s[`ai.roles.${p}`].main}</span>
              </div>
              <span className={`st ${has ? "ok" : ""}`}>
                {has ? s["strings.settings.keys.set"] : s["strings.settings.keys.add"]}
              </span>
            </button>
          );
        })}
      </div>
    </Row>
  );
}
controlKinds["hosted-provider"] = HostedProviderControl;

/** A provider group's name back to its provider: "OpenRouter" is openrouter. */
function providerNamed(group: string): HostedProvider | undefined {
  return HOSTED_PROVIDERS.find((p) => PROVIDER_LABELS[p] === group);
}

/**
 * The "Other providers" row: which of the folded providers hold a key, so a
 * user sees at a glance whether anything is set up there without opening it.
 */
foldLines["Other providers"] = function OtherProvidersLine({ groups }) {
  const s = useShell().settings;
  const { onDevice, shared } = useKeyState();
  const withKey = groups.filter((g) => {
    const p = providerNamed(g);
    return p !== undefined && (onDevice.has(p) || shared.has(p));
  });
  return withKey.length === 0
    ? fill(s["strings.settings.fold.providers_none"], { names: groups.join(", ") })
    : fill(s["strings.settings.fold.providers_keys"], { names: withKey.join(", ") });
};

/** Each folded provider's row carries its key state. */
foldBadges["Other providers"] = function ProviderBadge({ group }) {
  const s = useShell().settings;
  const { onDevice, shared } = useKeyState();
  const p = providerNamed(group);
  const has = p !== undefined && (onDevice.has(p) || shared.has(p));
  return (
    <Tag kind={has ? "ok" : undefined}>
      {has ? s["strings.settings.keys.set"] : s["strings.settings.keys.none"]}
    </Tag>
  );
};

function providerOf(k: SettingKey): KeyProvider {
  return k.split(".").at(-1) as KeyProvider;
}

/** The providers whose key the Server checks live before it is saved (slice 24). */
const VALIDATED: ReadonlySet<KeyProvider> = new Set<KeyProvider>(JUDGE_PROVIDERS);

/** The main and fast Roles of one provider: two model ids. */
function RolesControl({ k }: ControlProps) {
  const { value, change, error, shell } = useSetting(k);
  const s = shell.settings;
  const roles = value as { main: string; fast: string };
  const main = useDraft(roles.main, (text) => change({ ...roles, main: text.trim() }));
  const fast = useDraft(roles.fast, (text) => change({ ...roles, fast: text.trim() }));
  const field = (label: string, d: ReturnType<typeof useDraft>) => (
    <span className="role">
      <span>{label}</span>
      <Input
        className="text"
        value={d.draft}
        spellCheck={false}
        onChange={(e) => d.onChange(e.target.value)}
        onBlur={d.flush}
        onKeyDown={(e) => {
          if (e.key === "Enter") d.flush();
        }}
      />
    </span>
  );
  return (
    <Row k={k} block error={error}>
      <div className="roles">
        {field(s["strings.settings.roles.main"], main)}
        {field(s["strings.settings.roles.fast"], fast)}
      </div>
    </Row>
  );
}
controlKinds.roles = RolesControl;

/**
 * The key itself (add, replace, remove; never displayed) and the "Let the
 * server use this key" switch with its threat model, which is the Setting.
 * Sharing sends the Device key to the Server; unsharing forgets the copy. A
 * TypeSafe key is checked live through the Server before it is saved. With
 * `shareOnSave` (onboarding's TypeSafe card) the switch starts on and a saved
 * key is shared at once.
 */
export function ProviderKeyRow({
  k,
  shareOnSave = false,
}: {
  k: SettingKey;
  shareOnSave?: boolean | undefined;
}) {
  const { value, change, error, shell } = useSetting(k);
  const screen = useSettingsScreen();
  const s = shell.settings;
  const provider = providerOf(k);
  const { onDevice, shared, refresh } = useKeyState();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [accepted, setAccepted] = useState(false);
  // Before a key exists the switch is a wish; once one is saved it is the Setting.
  const [wantShare, setWantShare] = useState(shareOnSave);
  const has = onDevice.has(provider);
  const switchOn = has ? Boolean(value) : wantShare;
  const shareNow = async (): Promise<boolean> => {
    if (!screen.keys) return false;
    const ok = await screen.keys.share(shell.api, screen.workspaceId, provider);
    if (!ok) {
      setProblem(s["strings.settings.keys.none"]);
      return false;
    }
    await change(true);
    return true;
  };
  const save = async () => {
    const key = draft.trim();
    if (!key || !screen.keys) return;
    setProblem(null);
    setAccepted(false);
    if (VALIDATED.has(provider)) {
      setChecking(true);
      try {
        const result = await shell.api.keys.validate(provider, key);
        if (!result.ok) {
          setProblem(result.reason);
          return;
        }
      } catch (e) {
        // A Server without the check saves as the others do; anything else is reported.
        if (!(e instanceof ApiError && e.status === 404)) {
          setProblem(fill(s["strings.settings.keys.failed"], { message: messageOf(e) }));
          return;
        }
      } finally {
        setChecking(false);
      }
      setAccepted(true);
    }
    try {
      await screen.keys.set(provider, key);
    } catch (e) {
      setProblem(fill(s["strings.settings.keys.failed"], { message: messageOf(e) }));
      return;
    }
    setDraft("");
    setEditing(false);
    if (wantShare && !value) {
      try {
        await shareNow();
      } catch (e) {
        setProblem(e instanceof Error ? e.message : String(e));
      }
    }
    refresh();
  };
  const remove = async () => {
    if (!screen.keys) return;
    setProblem(null);
    try {
      await screen.keys.remove(provider);
      if (value) {
        await screen.keys.unshare(shell.api, provider).catch(() => {});
        await change(false);
      }
    } catch (e) {
      setProblem(fill(s["strings.settings.keys.failed"], { message: messageOf(e) }));
    }
    refresh();
  };
  const share = async (on: boolean) => {
    setProblem(null);
    if (!has) {
      // No key yet: the switch records what to do once one is saved.
      setWantShare(on);
      return;
    }
    if (on) {
      try {
        if (!(await shareNow())) return;
      } catch (e) {
        setProblem(e instanceof Error ? e.message : String(e));
        return;
      }
    } else {
      await screen.keys?.unshare(shell.api, provider).catch(() => {});
      await change(false);
    }
    refresh();
  };
  return (
    <Row k={k} error={problem ?? error} foot={<span>{s["strings.settings.keys.threat"]}</span>}>
      <span className="key-row">
        {editing ? (
          <>
            <Input
              type="password"
              className="text"
              value={draft}
              placeholder={s["strings.settings.keys.placeholder"]}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save();
                if (e.key === "Escape") setEditing(false);
              }}
            />
            <Btn sm primary disabled={!draft.trim() || checking} onClick={() => void save()}>
              {checking ? s["strings.settings.keys.checking"] : s["strings.settings.keys.save"]}
            </Btn>
            <Btn sm disabled={checking} onClick={() => setEditing(false)}>
              {s["strings.settings.keys.cancel"]}
            </Btn>
          </>
        ) : (
          <>
            <Tag kind={has ? "ok" : undefined}>
              {has
                ? shared.has(provider)
                  ? s["strings.settings.keys.shared"]
                  : accepted
                    ? s["strings.settings.keys.validated"]
                    : s["strings.settings.keys.set"]
                : s["strings.settings.keys.none"]}
            </Tag>
            <Btn sm disabled={!screen.keys} onClick={() => setEditing(true)}>
              {has ? s["strings.settings.keys.replace"] : s["strings.settings.keys.add"]}
            </Btn>
            {has ? (
              <DangerAction
                label={s["strings.settings.keys.remove"]}
                confirm={fill(s["strings.settings.keys.remove_confirm"], {
                  provider: PROVIDER_LABELS[provider],
                })}
                onConfirm={remove}
              />
            ) : null}
          </>
        )}
        <Switch on={switchOn} onChange={(on) => void share(on)} />
      </span>
    </Row>
  );
}
controlKinds["provider-key"] = ({ k }: ControlProps) => <ProviderKeyRow k={k} />;

/** Who answers judgments (ADR 0012): auto, TypeSafe, or the language model, as a segmented choice. */
function JudgeProviderControl({ k, shape }: ControlProps) {
  const { value, change, error, shell } = useSetting(k);
  const s = shell.settings;
  if (shape.kind !== "enum") return null;
  const label = (option: string) => {
    const key = `strings.settings.judge.option.${option}`;
    return isSettingKey(key) ? String(s[key]) : optionLabel(option);
  };
  return (
    <Row k={k} error={error}>
      <Seg
        options={shape.options.map((o) => ({ value: o, label: label(o) }))}
        value={String(value)}
        onChange={(v) => void change(v)}
      />
    </Row>
  );
}
controlKinds["judge-provider"] = JudgeProviderControl;

/**
 * One line above the TypeSafe group saying who answers judgments (ADR 0012):
 * TypeSafe on its pinned model when a key exists and Settings allow it, the
 * language model otherwise, or no key when Settings pin TypeSafe without one.
 */
export function JudgeStatusPanel(_: PanelProps) {
  const s = useShell().settings;
  const { onDevice, shared } = useKeyState();
  const choice = s["ai.judge.provider"];
  const here = onDevice.has("typesafe");
  const there = shared.has("typesafe");
  const status =
    choice === "llm" ? "llm" : here || there ? "typesafe" : choice === "auto" ? "llm" : "none";
  const line =
    status === "typesafe"
      ? fill(s["strings.settings.judge.status.typesafe"], { model: s["ai.judge.model"] })
      : status === "llm"
        ? s["strings.settings.judge.status.llm"]
        : s["strings.settings.judge.status.none"];
  const deviceOnly = status === "typesafe" && !there && s["ai.level"] === "automate";
  return (
    <div className="note" data-panel="judge-status" data-judge={status}>
      {line}
      {deviceOnly ? ` ${s["strings.settings.judge.status.device_only"]}` : null}
    </div>
  );
}
registerPanel("ai", "TypeSafe", JudgeStatusPanel, {
  title: "strings.ai.level.runtime.typesafe",
  description: "strings.settings.intro.ai.typesafe",
  searchTerms: ["typesafe", "judge", "judgment", "jev", "system one", "sorting", "key"],
});

const EFFORTS: readonly Effort[] = ["low", "medium", "high"];
const ROLES: readonly Role[] = ["main", "fast"];

/** One Task's row of the task-to-Role map: Role, exact-model override, effort. */
function TaskModelControl({ k }: ControlProps) {
  const { value, change, error, shell } = useSetting(k);
  const s = shell.settings;
  const tm = value as TaskModel;
  const model = useDraft(tm.model, (text) => change({ ...tm, model: text.trim() }));
  return (
    <Row k={k} hint={null} error={error}>
      <span className="task-row">
        <Seg<Role>
          options={ROLES.map((r) => ({ value: r, label: optionLabel(r) }))}
          value={tm.role}
          onChange={(role) => void change({ ...tm, role })}
        />
        <Input
          className="text"
          value={model.draft}
          placeholder={s["strings.settings.tasks.model"]}
          spellCheck={false}
          onChange={(e) => model.onChange(e.target.value)}
          onBlur={model.flush}
          onKeyDown={(e) => {
            if (e.key === "Enter") model.flush();
          }}
        />
        <select
          className="select"
          aria-label={s["strings.settings.tasks.effort"]}
          value={tm.effort}
          onChange={(e) => void change({ ...tm, effort: e.target.value })}
        >
          {EFFORTS.map((e) => (
            <option key={e} value={e}>
              {optionLabel(e)}
            </option>
          ))}
        </select>
      </span>
    </Row>
  );
}
controlKinds["task-model"] = TaskModelControl;
// Every Task is in the map; the schema test says so, and the registration is by name anyway.
void TASKS;

/** The Tier list: every tool with its tier, and a promote-to-always-ask switch per reversible one. */
function AlwaysAskControl({ k }: ControlProps) {
  const { value, change, error, shell } = useSetting(k);
  const s = shell.settings;
  const promoted = new Set((value ?? []) as string[]);
  const tierLabel = (tool: string) => {
    if (promoted.has(tool)) return s["strings.settings.tier.always_ask"];
    const tier = tierOf(TOOL_TIERS[tool] ?? "read");
    return tier === "always-ask"
      ? s["strings.settings.tier.always_ask"]
      : tier === "reversible"
        ? s["strings.settings.tier.reversible"]
        : s["strings.settings.tier.read_only"];
  };
  return (
    <Row k={k} block hint={s["strings.settings.permissions.intro"]} error={error}>
      <div className="tiers">
        {Object.entries(TOOL_TIERS).map(([tool, tier]) => (
          <div className="tier" key={tool} data-tool={tool}>
            <code>{tool}</code>
            <Tag kind={promoted.has(tool) || tierOf(tier) === "always-ask" ? "warn" : undefined}>
              {tierLabel(tool)}
            </Tag>
            {tier === "reversible" ? (
              <span className="tier-ask">
                <span>{s["strings.settings.permissions.ask"]}</span>
                <Switch
                  on={promoted.has(tool)}
                  onChange={(on) => {
                    const next = new Set(promoted);
                    if (on) next.add(tool);
                    else next.delete(tool);
                    void change([...next]);
                  }}
                />
              </span>
            ) : (
              <span />
            )}
          </div>
        ))}
      </div>
    </Row>
  );
}
controlKinds["always-ask"] = AlwaysAskControl;

/* ------------------------------ Shortcuts ------------------------------ */

const AREAS: Array<{ key: string; actions: KeyAction[] }> = [
  {
    key: "navigate",
    actions: ["move.down", "move.up", "thread.open", "sheet.close", "palette.open", "agent.focus"],
  },
  {
    key: "act",
    actions: [
      "thread.archive",
      "thread.snooze",
      "thread.star",
      "thread.toggle_read",
      "thread.delete",
      "thread.label",
      "thread.move",
      "undo",
    ],
  },
  {
    key: "compose",
    actions: ["compose.new", "compose.reply", "compose.reply_all", "compose.forward"],
  },
  { key: "select", actions: ["select.toggle", "select.extend_down", "select.extend_up"] },
  {
    key: "views",
    actions: KEY_ACTIONS.filter((a) => a.startsWith("view.")),
  },
  { key: "calendar", actions: KEY_ACTIONS.filter((a) => a.startsWith("calendar.")) },
];

function actionLabel(settings: Settings, action: KeyAction): string {
  const view = /^view\.(\d)$/.exec(action);
  if (view) return fill(settings["strings.action.view"], { n: view[1] ?? "" });
  const key = `strings.action.${action}`;
  return isSettingKey(key) ? String(settings[key]) : action;
}

/** The full binding table grouped by area: each chord remappable, conflicts highlighted. */
function BindingsControl({ k }: ControlProps) {
  const { value, change, error, shell } = useSetting(k);
  const s = shell.settings;
  const overrides = (value ?? {}) as Record<string, string>;
  const map = useMemo(
    () => resolveKeymap(s["keyboard.keymap"] as KeymapName, overrides),
    [s["keyboard.keymap"], overrides],
  );
  const clashes = useMemo(() => conflicts(map), [map]);
  const [editing, setEditing] = useState<{ action: KeyAction; chord: string } | null>(null);
  const mac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
  const commit = () => {
    if (!editing) return;
    const chord = normalizeChord(editing.chord);
    const next = { ...overrides };
    if (chord) next[editing.action] = chord;
    else delete next[editing.action];
    setEditing(null);
    void change(next);
  };
  return (
    <Row k={k} block error={error}>
      {AREAS.map((area) => (
        // Each area folds; the first, and any with a clash, start open.
        <Disclosure
          key={area.key}
          id={`shortcuts/area/${area.key}`}
          byDefault={
            area.key === AREAS[0]?.key ||
            area.actions.some((a) => clashes.some((c) => c.actions.includes(a)))
          }
          className="bindings-area"
          summary={
            <>
              <span className="g-name">
                {s[`strings.settings.shortcuts.${area.key}` as SettingKey] as string}
              </span>
              <span className="g-line">
                {fill(s["strings.settings.shortcuts.count"], { n: area.actions.length })}
              </span>
            </>
          }
        >
          <div className="bindings">
            {area.actions.map((action) => {
              const chord = map[action];
              const clash = clashes.find((c) => c.chord === chord);
              const others = clash?.actions.filter((a) => a !== action) ?? [];
              const overridden = action in overrides;
              return (
                <div
                  className={`binding ${others.length > 0 ? "clash" : ""}`}
                  key={action}
                  data-action={action}
                >
                  <div className="l">
                    <b>{actionLabel(s, action)}</b>
                    {others.length > 0 ? (
                      <span>
                        {fill(s["strings.settings.shortcuts.conflict"], {
                          action: others.map((a) => actionLabel(s, a)).join(", "),
                        })}
                      </span>
                    ) : null}
                  </div>
                  {editing?.action === action ? (
                    <Input
                      className="chord"
                      value={editing.chord}
                      autoFocus
                      spellCheck={false}
                      placeholder={s["strings.settings.shortcuts.press"]}
                      onChange={(e) => setEditing({ action, chord: e.target.value })}
                      onBlur={commit}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") return commit();
                        if (e.key === "Escape") return setEditing(null);
                        if (e.key === "Backspace" || e.key === "Delete" || e.key === "Tab") return;
                        // The key pressed is the chord: no need to spell "mod+shift+k".
                        if (["Shift", "Control", "Meta", "Alt"].includes(e.key)) return;
                        e.preventDefault();
                        setEditing({ action, chord: chordOf(e) });
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="chord-btn"
                      onClick={() => setEditing({ action, chord })}
                    >
                      <Kbd>{chordLabel(chord, mac)}</Kbd>
                    </button>
                  )}
                  {overridden ? (
                    <Btn
                      sm
                      icon
                      aria-label={s["strings.settings.reset"]}
                      onClick={() => {
                        const { [action]: _gone, ...rest } = overrides;
                        void change(rest);
                      }}
                    >
                      <XIcon />
                    </Btn>
                  ) : (
                    <span className="reset-slot" />
                  )}
                </div>
              );
            })}
          </div>
        </Disclosure>
      ))}
    </Row>
  );
}
controlKinds.bindings = BindingsControl;

/* ------------------------------ Workflows ------------------------------ */

/** The form's draft: one target field that becomes `url` when it is http(s), else `command`. */
interface McpDraft {
  name: string;
  target: string;
  token: string;
}
const EMPTY_MCP: McpDraft = { name: "", target: "", token: "" };
const mcpTarget = (m: McpServerSetting) => m.url ?? m.command ?? "";

/** MCP servers as schema-backed records: add by command or URL, auth, tools, remove. */
function McpServersControl({ k }: ControlProps) {
  const { value, change, error, shell } = useSetting(k);
  const s = shell.settings;
  const servers = (value ?? []) as McpServerSetting[];
  const [draft, setDraft] = useState<McpDraft>(EMPTY_MCP);
  const [tools, setTools] = useState("");
  const add = () => {
    if (!draft.name.trim() || !draft.target.trim()) return;
    const target = draft.target.trim();
    const token = draft.token.trim();
    const next: McpServerSetting = {
      name: draft.name.trim(),
      ...(/^https?:\/\//.test(target) ? { url: target } : { command: target }),
      ...(token ? { token } : {}),
      tools: tools
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0),
    };
    void change([...servers, next]);
    setDraft(EMPTY_MCP);
    setTools("");
  };
  return (
    <Row k={k} block error={error}>
      <div className="record">
        {servers.length === 0 ? (
          <div className="note">{s["strings.settings.mcp.empty"]}</div>
        ) : null}
        {servers.map((m, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: two servers may share a name; the position is the identity
          <div className="record-row" key={`${m.name}-${i}`} data-mcp={m.name}>
            <span className="record-key">
              <b>{m.name}</b>
              <span>
                {mcpTarget(m)}
                {m.token ? ` · ${s["strings.settings.mcp.has_token"]}` : ""} ·{" "}
                {m.tools.length > 0 ? m.tools.join(", ") : s["strings.settings.mcp.all_tools"]}
              </span>
            </span>
            <DangerAction
              label={s["strings.settings.mcp.remove"]}
              confirm={fill(s["strings.settings.mcp.remove_confirm"], { name: m.name })}
              onConfirm={async () => {
                const ok = await change(servers.filter((_, j) => j !== i));
                if (!ok) throw new Error(error ?? "not saved");
              }}
            />
          </div>
        ))}
        <div className="mcp-add">
          <Input
            className="text"
            value={draft.name}
            placeholder={s["strings.settings.mcp.name"]}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
          <Input
            className="text"
            value={draft.target}
            placeholder={s["strings.settings.mcp.target"]}
            spellCheck={false}
            onChange={(e) => setDraft({ ...draft, target: e.target.value })}
          />
          <Input
            className="text"
            value={draft.token}
            placeholder={s["strings.settings.mcp.auth"]}
            spellCheck={false}
            onChange={(e) => setDraft({ ...draft, token: e.target.value })}
          />
          <Input
            className="text"
            value={tools}
            placeholder={s["strings.settings.mcp.tools"]}
            spellCheck={false}
            onChange={(e) => setTools(e.target.value)}
          />
          <Btn
            sm
            className="mcp-add-btn"
            disabled={!draft.name.trim() || !draft.target.trim()}
            onClick={add}
          >
            {s["strings.settings.mcp.add"]}
          </Btn>
        </div>
      </div>
    </Row>
  );
}
controlKinds["mcp-servers"] = McpServersControl;

/** A re-export so a page can render the enum picker for a value it holds itself. */
export { EnumPicker };

/* ------------------------------ Calendars per Workspace ------------------------------ */

/**
 * Which connected calendars each Workspace shows (calendar.shown): one row
 * per calendar of every Account, shared ones marked, one column per
 * Workspace plus "Every workspace". A tick shows it there; the first column
 * sets every Workspace at once.
 */
function CalendarShownControl({ k }: ControlProps) {
  const { value, change, error, shell } = useSetting(k);
  const s = shell.settings;
  const accounts = useAccounts();
  const [calendars, setCalendars] = useState<Calendar[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (accounts.length === 0) return;
    let live = true;
    Promise.all(accounts.map((a) => shell.api.calendar.calendars(a.workspaceId).catch(() => [])))
      .then((lists) => {
        if (live) setCalendars(lists.flat());
      })
      .catch((e: unknown) => {
        if (live) setFailed(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [accounts, shell.api]);
  const shown = (value ?? {}) as Record<string, Record<string, boolean>>;
  const fillT = (t: string, vars: Record<string, string>) =>
    t.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? "");
  const on = (ws: string, id: string) => shown[ws]?.[id] ?? shown["*"]?.[id] ?? true;
  const set = (ws: string, id: string, v: boolean) => {
    const next: Record<string, Record<string, boolean>> = {
      ...shown,
      [ws]: { ...(shown[ws] ?? {}), [id]: v },
    };
    if (ws === "*") {
      // Every Workspace at once: their own choices for this calendar give way.
      for (const w of Object.keys(next)) {
        if (w === "*" || !next[w]) continue;
        const { [id]: _drop, ...rest } = next[w] as Record<string, boolean>;
        next[w] = rest;
      }
    }
    void change(next);
  };
  const address = (ws: string) => accounts.find((a) => a.workspaceId === ws)?.address ?? ws;
  return (
    <Row k={k} block error={error}>
      {failed ? (
        <p className="faint">
          {fillT(s["strings.settings.calendar_shown.failed"], { message: failed })}
        </p>
      ) : calendars === null ? (
        <p className="faint">{s["strings.settings.calendar_shown.loading"]}</p>
      ) : (
        <div className="cal-shown">
          <table>
            <thead>
              <tr>
                <th>{s["strings.settings.calendar_shown.title"]}</th>
                <th>{s["strings.settings.calendar_shown.everywhere"]}</th>
                {accounts.map((a) => (
                  <th key={a.workspaceId}>{a.address}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {calendars.map((c) => (
                <tr key={c.id}>
                  <td>
                    <b>{c.name}</b>
                    <span className="faint">
                      {address(c.workspaceId)}
                      {c.sharedBy ? ` · ${s["strings.settings.calendar_shown.shared"]}` : ""}
                    </span>
                  </td>
                  {["*", ...accounts.map((a) => a.workspaceId)].map((ws) => (
                    <td key={ws}>
                      <input
                        type="checkbox"
                        aria-label={`${c.name}, ${ws === "*" ? s["strings.settings.calendar_shown.everywhere"] : address(ws)}`}
                        checked={on(ws, c.id)}
                        onChange={(e) => set(ws, c.id, e.currentTarget.checked)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="faint">{s["strings.settings.calendar_shown.note"]}</p>
        </div>
      )}
    </Row>
  );
}
controlKinds["calendar-visibility"] = CalendarShownControl;
