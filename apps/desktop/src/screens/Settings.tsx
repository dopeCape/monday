// Settings over the Shell (docs/spec/settings.md, ADR 0001, ADR 0004): the
// section nav, one schema-rendered page per section, and the undo toast every
// change offers. Every control comes from the settings schema through
// settings/render.tsx; the special controls and the panels register there
// from settings/controls.tsx and settings/panels.tsx. Nothing here is a
// hand-built settings screen. "Ask monday" inputs hand their text to the
// composer through `onAsk`; nothing on these pages calls a model.

import {
  SETTING_SECTIONS,
  type SettingKey,
  type SettingSection,
  settingsSchema,
} from "@monday/shared";
import {
  AtIcon,
  CloudIcon,
  CpuIcon,
  FlowArrowIcon,
  InfoIcon,
  KeyboardIcon,
  PaletteIcon,
  ShuffleIcon,
} from "@phosphor-icons/react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { chordLabel, chordOf, type KeymapName, resolveKeymap } from "../keyboard/keymaps.ts";
import { type DeviceProviderKeys, deviceProviderKeys } from "../platform/providerKeys.ts";
import { platform } from "../platform/tauri.ts";
import { type SetResult, useShell } from "../shell/Shell.tsx";
import { Toast } from "./inbox/Toast.tsx";
import "./settings/controls.tsx";
import "./settings/panels.tsx";
import {
  type RuntimeDetection,
  SettingsPage,
  type SettingsScreen,
  SettingsScreenProvider,
} from "./settings/render.tsx";
import type { ServerProps } from "./settings/Server.tsx";
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
  /** Routes an "Ask monday" text to the composer, prefilled. Inert when absent. */
  onAsk?: ((text: string) => void) | undefined;
  /** The Local runtime detection seam (slice 15). */
  runtimes?: RuntimeDetection | undefined;
  /** This Device's provider keys; defaults to the platform keychain. */
  keys?: DeviceProviderKeys | undefined;
  serverProps?: ServerProps | undefined;
  workspaceId?: string | undefined;
  version?: string | undefined;
  now?: (() => Date) | undefined;
}

interface ToastState {
  id: number;
  text: string;
  undo: () => void;
}

function sectionOf(name: string | undefined): SettingsSection {
  return (SETTING_SECTIONS as readonly string[]).includes(name ?? "")
    ? (name as SettingSection)
    : "appearance";
}

type SettingsSection = SettingSection;

export function Settings({
  initialSection,
  onAsk,
  runtimes,
  keys: keysProp,
  serverProps,
  workspaceId = "ws-1",
  version = "0.1.0",
  now = () => new Date(),
}: SettingsProps) {
  const shell = useShell();
  const s = shell.settings;
  const [section, setSection] = useState<SettingsSection>(() =>
    sectionOf(
      initialSection ??
        (typeof location !== "undefined"
          ? (new URLSearchParams(location.search).get("section") ?? undefined)
          : undefined),
    ),
  );
  const [toast, setToast] = useState<ToastState | null>(null);
  const toastSeq = useRef(0);
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
      const previous = changes.map(([k]) => [k, shell.settings[k]] as [SettingKey, unknown]);
      let result: SetResult = { ok: true };
      for (const [k, v] of changes) {
        result = await shell.set(k, v as never);
        if (!result.ok) break;
      }
      if (result.ok) {
        setToast({
          id: ++toastSeq.current,
          text: fill(shell.settings["strings.settings.changed"], { label }),
          undo: () => {
            for (const [k, v] of previous) void shell.set(k, v as never);
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
    [shell],
  );

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
    }),
    [workspaceId, changeMany, onAsk, runtimes, keys, version, now, serverProps],
  );

  // The keymap's undo chord undoes the last change while its toast shows.
  const undoChord = useMemo(
    () => resolveKeymap(s["keyboard.keymap"] as KeymapName, s["keyboard.bindings"]).undo,
    [s["keyboard.keymap"], s["keyboard.bindings"]],
  );
  const mac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
  const onKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT"
    ) {
      return;
    }
    if (toast && chordOf(e) === undoChord) {
      e.preventDefault();
      toast.undo();
    }
  };

  const expire = useCallback(() => setToast(null), []);

  return (
    <SettingsScreenProvider value={screen}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the undo chord is a page-level shortcut */}
      <div className="main page" onKeyDown={onKeyDown}>
        <div className="settings">
          <nav className="settings-nav">
            <h4>{s["strings.settings.title"]}</h4>
            {SETTING_SECTIONS.map((n) => (
              <button
                key={n}
                type="button"
                className={`nav-item ${section === n ? "on" : ""}`}
                onClick={() => setSection(n)}
              >
                {ICONS[n]}
                <span>{s[`strings.settings.section.${n}`]}</span>
              </button>
            ))}
          </nav>
          <div className="settings-body">
            <div className="settings-in" data-section={section}>
              <SettingsPage section={section} />
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
      </div>
    </SettingsScreenProvider>
  );
}
