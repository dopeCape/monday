// The special controls the schema names where a plain type is not enough
// (docs/spec/settings.md): palette swatches with Custom from file, the layout
// preset over the three knobs, the Views list, the Section rules with rename,
// hide and reorder, per-Account maps, the runtime mode cards and CLI list,
// per-provider Roles and keys (never displayed), the task-to-Role map, the
// Permissions tier list, the keymap binding table and the MCP servers list.
// Each is still keyed by a schema entry and registers under the name that
// entry's `control` gives, so the renderer walks the schema and nothing else.

import {
  type Effort,
  HOSTED_PROVIDERS,
  type HostedProvider,
  isSettingKey,
  type Layout,
  type McpServerSetting,
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
import { Btn, CustomSwatch, Input, Kbd, palettes, Seg, Swatch, Switch, Tag } from "@monday/ui";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  KeyIcon,
  TerminalWindowIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  chordLabel,
  conflicts,
  KEY_ACTIONS,
  type KeyAction,
  type KeymapName,
  normalizeChord,
  resolveKeymap,
} from "../../keyboard/keymaps.ts";
import type { AccountView } from "../../platform/api.ts";
import { useShell } from "../../shell/Shell.tsx";
import {
  AskInput,
  type ControlProps,
  controlKinds,
  type DetectedCli,
  EnumPicker,
  optionLabel,
  RecordEditor,
  Row,
  useDraft,
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
  const path = useDraft(custom ? current : "", (text) => {
    if (text.trim()) void change(text.trim());
  });
  return (
    <Row k={k} bare error={error}>
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
  const current = presetForLayout(shell.layout);
  const options = [
    ...PRESET_NAMES.map((p) => ({ value: p, label: optionLabel(p) })),
    ...(current === "custom"
      ? [{ value: "custom", label: s["strings.settings.layout.custom"] }]
      : []),
  ];
  return (
    <Row k={k}>
      <Seg
        options={options}
        value={current}
        onChange={(p) => {
          const preset = PRESETS[p as keyof typeof PRESETS];
          if (!preset) return;
          void screen.changeMany(
            [
              ["layout.preset", p],
              ["layout.nav", preset.nav],
              ["layout.agent", preset.agent],
              ["layout.list", preset.list],
            ],
            entry.label,
          );
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
  const typed = useDraft(known ? "" : current, (text) => {
    if (text.trim()) void change(text.trim());
  });
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
    <Row k={k} block hint={null} error={error}>
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
                <Btn sm onClick={() => void change(views.filter((x) => x.id !== v.id))}>
                  {s["strings.settings.views.delete"]}
                </Btn>
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

function sectionName(settings: Settings, id: string): string {
  const key = `strings.section.${id}`;
  return isSettingKey(key) ? String(settings[key]) : id;
}

/**
 * The Section rules in their order: rename (the Section's string Setting),
 * hide, reorder (sections.order, rendered inside this control) and "Ask monday
 * to change" for anything structural.
 */
function SectionRulesControl({ k }: ControlProps) {
  const { value, change, error, shell } = useSetting(k);
  const screen = useSettingsScreen();
  const s = shell.settings;
  const rules = (value ?? []) as SectionRuleValue[];
  const order = s["sections.order"];
  const ordered = [
    ...order.map((id) => rules.find((r) => r.id === id)).filter((r): r is SectionRuleValue => !!r),
    ...rules.filter((r) => !order.includes(r.id)),
  ];
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const move = (id: string, by: -1 | 1) => {
    const ids = ordered.map((r) => r.id);
    const at = ids.indexOf(id);
    const to = at + by;
    if (at < 0 || to < 0 || to >= ids.length) return;
    const next = [...ids];
    next.splice(at, 1);
    next.splice(to, 0, id);
    void screen.change("sections.order", next);
  };
  return (
    <Row k={k} block error={error}>
      <div className="rules" data-setting="sections.order">
        {ordered.map((r, i) => {
          const nameKey = `strings.section.${r.id}`;
          const renamable = isSettingKey(nameKey);
          const conditions = Object.keys(r.when).length;
          return (
            <div className={`rule ${r.hidden ? "off" : ""}`} key={r.id} data-rule={r.id}>
              <div>
                {renaming?.id === r.id ? (
                  <Input
                    value={renaming.name}
                    autoFocus
                    onChange={(e) => setRenaming({ id: r.id, name: e.target.value })}
                    onBlur={() => {
                      if (renaming.name.trim() && renamable) {
                        void screen.change(nameKey as SettingKey, renaming.name.trim());
                      }
                      setRenaming(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") setRenaming(null);
                    }}
                  />
                ) : (
                  <b>{sectionName(s, r.id)}</b>
                )}
                <span>
                  {r.sentence
                    ? `${s["strings.settings.sections.model"]}: ${r.sentence}`
                    : fill(s["strings.settings.sections.conditions"], { n: conditions })}
                </span>
              </div>
              <Btn
                sm
                icon
                aria-label={s["strings.settings.sections.up"]}
                disabled={i === 0}
                onClick={() => move(r.id, -1)}
              >
                <ArrowUpIcon />
              </Btn>
              <Btn
                sm
                icon
                aria-label={s["strings.settings.sections.down"]}
                disabled={i === ordered.length - 1}
                onClick={() => move(r.id, 1)}
              >
                <ArrowDownIcon />
              </Btn>
              <Btn
                sm
                disabled={!renamable}
                onClick={() => setRenaming({ id: r.id, name: sectionName(s, r.id) })}
              >
                {s["strings.settings.views.rename"]}
              </Btn>
              <span className="rule-hide">
                <span>{s["strings.settings.sections.hidden"]}</span>
                <Switch
                  on={Boolean(r.hidden)}
                  onChange={(hidden) =>
                    void change(rules.map((x) => (x.id === r.id ? { ...x, hidden } : x)))
                  }
                />
              </span>
            </div>
          );
        })}
      </div>
      <AskInput
        label={s["strings.settings.sections.ask"]}
        placeholder={s["strings.settings.sections.ask_placeholder"]}
        prompt={s["strings.settings.sections.ask_prompt"]}
      />
    </Row>
  );
}
controlKinds["section-rules"] = SectionRulesControl;

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
                void change(next);
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
  onCommit: (text: string) => void;
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

/** Which Hosted providers hold a key on this Device and which are shared with the Server. */
function useKeyState() {
  const shell = useShell();
  const screen = useSettingsScreen();
  const [onDevice, setOnDevice] = useState<Set<HostedProvider>>(new Set());
  const [shared, setShared] = useState<Set<HostedProvider>>(new Set());
  const refresh = useCallback(async () => {
    const keys = screen.keys;
    if (keys) {
      const have = await Promise.all(
        HOSTED_PROVIDERS.map(async (p) => [p, await keys.get(p)] as const),
      );
      setOnDevice(new Set(have.filter(([, v]) => v).map(([p]) => p)));
    }
    try {
      setShared(new Set((await shell.api.keys.shared()).shared));
    } catch {
      setShared(new Set());
    }
  }, [screen.keys, shell.api]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { onDevice, shared, refresh };
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

function providerOf(k: SettingKey): HostedProvider {
  return k.split(".").at(-1) as HostedProvider;
}

/** The main and fast Roles of one provider: two model ids. */
function RolesControl({ k }: ControlProps) {
  const { value, change, error, shell } = useSetting(k);
  const s = shell.settings;
  const roles = value as { main: string; fast: string };
  const main = useDraft(roles.main, (text) => void change({ ...roles, main: text.trim() }));
  const fast = useDraft(roles.fast, (text) => void change({ ...roles, fast: text.trim() }));
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
 * Sharing sends the Device key to the Server; unsharing forgets the copy.
 */
function ProviderKeyControl({ k }: ControlProps) {
  const { value, change, error, shell } = useSetting(k);
  const screen = useSettingsScreen();
  const s = shell.settings;
  const provider = providerOf(k);
  const { onDevice, shared, refresh } = useKeyState();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const has = onDevice.has(provider);
  const save = async () => {
    const key = draft.trim();
    if (!key || !screen.keys) return;
    await screen.keys.set(provider, key);
    setDraft("");
    setEditing(false);
    await refresh();
  };
  const remove = async () => {
    if (!screen.keys) return;
    await screen.keys.remove(provider);
    if (value) {
      await screen.keys.unshare(shell.api, provider).catch(() => {});
      await change(false);
    }
    await refresh();
  };
  const share = async (on: boolean) => {
    setProblem(null);
    if (on) {
      if (!screen.keys) return;
      try {
        const ok = await screen.keys.share(shell.api, screen.workspaceId, provider);
        if (!ok) {
          setProblem(s["strings.settings.keys.none"]);
          return;
        }
      } catch (e) {
        setProblem(e instanceof Error ? e.message : String(e));
        return;
      }
    } else {
      await screen.keys?.unshare(shell.api, provider).catch(() => {});
    }
    await change(on);
    await refresh();
  };
  return (
    <Row k={k} error={problem ?? error}>
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
            <Btn sm primary disabled={!draft.trim()} onClick={() => void save()}>
              {s["strings.settings.keys.save"]}
            </Btn>
            <Btn sm onClick={() => setEditing(false)}>
              {s["strings.settings.keys.cancel"]}
            </Btn>
          </>
        ) : (
          <>
            <Tag kind={has ? "ok" : undefined}>
              {has
                ? shared.has(provider)
                  ? s["strings.settings.keys.shared"]
                  : s["strings.settings.keys.set"]
                : s["strings.settings.keys.none"]}
            </Tag>
            <Btn sm disabled={!screen.keys} onClick={() => setEditing(true)}>
              {has ? s["strings.settings.keys.replace"] : s["strings.settings.keys.add"]}
            </Btn>
            {has ? (
              <Btn sm onClick={() => void remove()}>
                {s["strings.settings.keys.remove"]}
              </Btn>
            ) : null}
          </>
        )}
        <Switch on={Boolean(value)} onChange={(on) => void share(on)} />
      </span>
    </Row>
  );
}
controlKinds["provider-key"] = ProviderKeyControl;

const EFFORTS: readonly Effort[] = ["low", "medium", "high"];
const ROLES: readonly Role[] = ["main", "fast"];

/** One Task's row of the task-to-Role map: Role, exact-model override, effort. */
function TaskModelControl({ k }: ControlProps) {
  const { value, change, error, shell } = useSetting(k);
  const s = shell.settings;
  const tm = value as TaskModel;
  const task = k.split(".").at(-1) ?? k;
  const model = useDraft(tm.model, (text) => void change({ ...tm, model: text.trim() }));
  return (
    <Row k={k} label={task} hint={null} error={error}>
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
    <Row k={k} block hint={null} error={error}>
      {AREAS.map((area) => (
        <div className="bindings" key={area.key}>
          <h4>{s[`strings.settings.shortcuts.${area.key}` as SettingKey] as string}</h4>
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
                    onChange={(e) => setEditing({ action, chord: e.target.value })}
                    onBlur={commit}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commit();
                      if (e.key === "Escape") setEditing(null);
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
      ))}
    </Row>
  );
}
controlKinds.bindings = BindingsControl;

/* ------------------------------ Workflows ------------------------------ */

const EMPTY_MCP: McpServerSetting = { name: "", target: "", auth: "", tools: [] };

/** MCP servers as schema-backed records: add by command or URL, auth, tools, remove. */
function McpServersControl({ k }: ControlProps) {
  const { value, change, error, shell } = useSetting(k);
  const s = shell.settings;
  const servers = (value ?? []) as McpServerSetting[];
  const [draft, setDraft] = useState<McpServerSetting>(EMPTY_MCP);
  const [tools, setTools] = useState("");
  const add = () => {
    if (!draft.name.trim() || !draft.target.trim()) return;
    const next: McpServerSetting = {
      ...draft,
      name: draft.name.trim(),
      target: draft.target.trim(),
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
                {m.target}
                {m.auth ? ` · ${m.auth}` : ""} ·{" "}
                {m.tools.length > 0 ? m.tools.join(", ") : s["strings.settings.mcp.all_tools"]}
              </span>
            </span>
            <Btn sm onClick={() => void change(servers.filter((_, j) => j !== i))}>
              {s["strings.settings.mcp.remove"]}
            </Btn>
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
            value={draft.auth}
            placeholder={s["strings.settings.mcp.auth"]}
            spellCheck={false}
            onChange={(e) => setDraft({ ...draft, auth: e.target.value })}
          />
          <Input
            className="text"
            value={tools}
            placeholder={s["strings.settings.mcp.tools"]}
            spellCheck={false}
            onChange={(e) => setTools(e.target.value)}
          />
          <Btn sm disabled={!draft.name.trim() || !draft.target.trim()} onClick={add}>
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
