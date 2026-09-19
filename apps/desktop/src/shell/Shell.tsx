// The Shell owns settings resolution, layout knobs, theming and the server connection
// (ADR 0001, ADR 0004, ADR 0009). It merges three layers, defaults under Server settings
// under the Config file, applies the result to the document root, and is the only path
// screens use to read or change a Setting.

import {
  type ConfigWarning,
  type Density,
  defaultSettings,
  type Layout,
  type PartialSettings,
  parseConfig,
  resolveSettings,
  type SettingKey,
  type Settings,
  settingScope,
  type ThemeMode,
  validateSetting,
} from "@monday/shared";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { type Api, createApi, type ServerTarget } from "../platform/api.ts";
import {
  type CloudTarget,
  createTargetPicker,
  loadCloudTarget,
  type Picked,
  saveCloudTarget,
} from "../platform/cloud.ts";
import {
  type ConfigFile,
  type ProcessRunner,
  platform,
  type SidecarInfo,
} from "../platform/tauri.ts";

export interface ConfigState {
  file: ConfigFile | null;
  /** Values from the last good parse. A syntax error keeps these (ADR 0001). */
  values: PartialSettings;
  warnings: ConfigWarning[];
  error: { line: number | null; message: string } | null;
}

export interface ShellState {
  settings: Settings;
  pinned: ReadonlySet<SettingKey>;
  layout: Layout;
  density: Density;
  mode: ThemeMode;
  palette: string;
  config: ConfigState;
  sidecar: SidecarInfo | null;
  /** Spawns a Local runtime's CLI on this Device; null where there is no host to spawn from. */
  spawn: ProcessRunner | null;
  /** The Cloud this Device paired with (ADR 0008), or null on a Sidecar-only install. */
  cloud: CloudTarget | null;
  /** Where requests go right now: the Sidecar or the Cloud, by preference and reachability. */
  server: Picked | null;
  api: Api;
  /** Records or forgets the Cloud target in the keychain; the picker follows at once. */
  setCloud(target: CloudTarget | null): Promise<void>;
  /** Probes both targets now and re-picks. */
  refreshServers(): Promise<void>;
  /**
   * Change a Setting. Applies at once, then persists to the Server. Refuses a pinned
   * key: the file wins and only the user may edit it (ADR 0001).
   */
  set<K extends SettingKey>(key: K, value: Settings[K]): Promise<SetResult>;
  /** Re-reads the Server's Settings, after the Agent changed some on the Server. */
  refresh(): Promise<void>;
}

export type SetResult =
  | { ok: true }
  | { ok: false; reason: "pinned" | "invalid" | "offline"; message: string };

const ShellContext = createContext<ShellState | null>(null);

export function useShell(): ShellState {
  const s = useContext(ShellContext);
  if (!s) throw new Error("useShell outside Shell");
  return s;
}

function resolveMode(mode: ThemeMode): "light" | "dark" {
  if (mode !== "system") return mode;
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function parseFile(file: ConfigFile, last: ConfigState): ConfigState {
  if (!file.exists || file.text.trim() === "") {
    return { file, values: {}, warnings: [], error: null };
  }
  const r = parseConfig(file.text);
  if (r.ok) return { file, values: r.values, warnings: r.warnings, error: null };
  return { ...last, file, error: { line: r.error.line, message: r.error.message } };
}

export function Shell({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<ConfigState>({
    file: null,
    values: {},
    warnings: [],
    error: null,
  });
  const [stored, setStored] = useState<PartialSettings>({});
  const [sidecar, setSidecar] = useState<SidecarInfo | null>(null);
  const [spawn, setSpawn] = useState<ProcessRunner | null>(null);
  const [cloud, setCloudState] = useState<CloudTarget | null>(null);
  const [server, setServer] = useState<Picked | null>(null);
  const configRef = useRef(config);
  configRef.current = config;

  useEffect(() => {
    let dispose: Array<() => void> = [];
    void platform().then(async (p) => {
      // Only a Tauri host can spawn a Local runtime's CLI; the browser dev server cannot.
      if (p.isTauri) setSpawn(() => p.spawn);
      // The browser dev server is the design fixture, whose world has the assistant
      // everywhere: its Workspace's saved Settings say the full AI level (slice 20).
      if (!p.isTauri) setStored((s) => ({ "ai.level": "automate", ...s }));
      const first = await p.readConfig();
      setConfig((last) => parseFile(first, last));
      dispose.push(p.onConfigChanged((f) => setConfig((last) => parseFile(f, last))));
      setCloudState(await loadCloudTarget(p));
      const info = await p.sidecarInfo();
      if (info.running) setSidecar(info);
      dispose.push(p.onSidecarReady(setSidecar));
    });
    return () => {
      for (const d of dispose) d();
      dispose = [];
    };
  }, []);

  const resolved = useMemo(
    () => resolveSettings(config.values, stored, defaultSettings()),
    [config.values, stored],
  );
  const settings = resolved.settings;

  // A new picker (and so a new api) only when a target or the preference changes.
  const prefer = settings["server.prefer"];
  const picker = useMemo(() => {
    const sidecarTarget: ServerTarget | null = sidecar?.running
      ? { baseUrl: `http://127.0.0.1:${sidecar.port}`, token: sidecar.token }
      : null;
    return createTargetPicker({
      targets: () => ({ sidecar: sidecarTarget, cloud }),
      prefer: () => prefer,
      probe: (t) =>
        fetch(`${t.baseUrl}/health`)
          .then((r) => r.ok)
          .catch(() => false),
    });
  }, [sidecar, cloud, prefer]);

  useEffect(() => {
    const unsubscribe = picker.subscribe(setServer);
    setServer(picker.current());
    return unsubscribe;
  }, [picker]);

  const probeSeconds = settings["server.probe_seconds"];
  useEffect(() => {
    if (!cloud) return; // one target needs no probing; a failed request already says enough
    const timer = setInterval(() => void picker.refresh(), probeSeconds * 1000);
    void picker.refresh();
    return () => clearInterval(timer);
  }, [picker, cloud, probeSeconds]);

  const api = useMemo(
    () =>
      createApi(() => picker.current()?.target ?? null, {
        onUnreachable: (t) => picker.markUnreachable(t),
      }),
    [picker],
  );

  const refresh = useCallback(async () => {
    try {
      const { global, device } = await api.settings.all();
      setStored({ ...global, ...device } as PartialSettings);
    } catch {
      // No Server yet, or offline: the Settings in hand stay.
    }
  }, [api]);

  useEffect(() => {
    if (!server) return;
    void refresh();
  }, [refresh, server]);

  const setCloud = useCallback(async (target: CloudTarget | null) => {
    const p = await platform();
    await saveCloudTarget(p, target);
    setCloudState(target);
  }, []);

  const refreshServers = useCallback(async () => {
    await picker.refresh();
  }, [picker]);
  const nav = settings["layout.nav"];
  const agent = settings["layout.agent"];
  const list = settings["layout.list"];
  const layout = useMemo<Layout>(() => ({ nav, agent, list }), [nav, agent, list]);
  const density = settings["appearance.density"];
  const mode = settings["appearance.mode"];
  const palette = settings["appearance.palette"];

  useEffect(() => {
    const r = document.documentElement;
    r.dataset.theme = resolveMode(mode);
    r.dataset.palette = palette;
    r.dataset.density = density;
    r.dataset.nav = layout.nav;
    r.dataset.agent = layout.agent;
    r.dataset.list = layout.list;
  }, [mode, palette, density, layout.nav, layout.agent, layout.list]);

  useEffect(() => {
    if (mode !== "system") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => {
      document.documentElement.dataset.theme = resolveMode(mode);
    };
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [mode]);

  const set = useCallback(
    async <K extends SettingKey>(key: K, value: Settings[K]): Promise<SetResult> => {
      if (resolved.pinned.has(key)) {
        return {
          ok: false,
          reason: "pinned",
          message: `${key} is set in ${configRef.current.file?.path ?? "monday.toml"}`,
        };
      }
      const v = validateSetting(key, value);
      if (!v.ok) return { ok: false, reason: "invalid", message: v.error };
      setStored((s) => ({ ...s, [key]: value }));
      try {
        await api.settings.set(key, value, settingScope(key));
        return { ok: true };
      } catch (e) {
        return {
          ok: false,
          reason: "offline",
          message: e instanceof Error ? e.message : String(e),
        };
      }
    },
    [api, resolved.pinned],
  );

  const value = useMemo<ShellState>(
    () => ({
      settings,
      pinned: resolved.pinned,
      layout,
      density,
      mode,
      palette,
      config,
      sidecar,
      spawn,
      cloud,
      server,
      api,
      setCloud,
      refreshServers,
      set,
      refresh,
    }),
    [
      settings,
      resolved.pinned,
      layout,
      density,
      mode,
      palette,
      config,
      sidecar,
      spawn,
      cloud,
      server,
      api,
      setCloud,
      refreshServers,
      set,
      refresh,
    ],
  );

  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

/**
 * A Shell over given Settings with no platform behind it. For tests and
 * stories: `set` applies in memory (and writes through to a scripted api when
 * one is given), `refresh` pulls from that api the way the real Shell does,
 * and nothing is pinned unless the test says so.
 */
export function StaticShell({
  settings: overrides = {},
  shell: shellOverrides = {},
  children,
}: {
  settings?: PartialSettings | undefined;
  /** Connection state for a test: a scripted api, a Sidecar, a Cloud target, a spy setCloud, pinned keys, a Config file. */
  shell?:
    | Partial<
        Pick<
          ShellState,
          "api" | "sidecar" | "spawn" | "cloud" | "server" | "setCloud" | "pinned" | "config"
        >
      >
    | undefined;
  children: ReactNode;
}) {
  const [local, setLocal] = useState<PartialSettings>({});
  const settings = useMemo(
    () => ({ ...defaultSettings(), ...overrides, ...local }) as Settings,
    [overrides, local],
  );
  const fallbackApi = useMemo(() => createApi(() => null), []);
  const api = shellOverrides.api ?? fallbackApi;
  const scripted = shellOverrides.api !== undefined;
  const pinned = shellOverrides.pinned ?? EMPTY_PINNED;
  const set = useCallback(
    async <K extends SettingKey>(key: K, value: Settings[K]): Promise<SetResult> => {
      if (pinned.has(key)) {
        return { ok: false, reason: "pinned", message: `${key} is set in monday.toml` };
      }
      const v = validateSetting(key, value);
      if (!v.ok) return { ok: false, reason: "invalid", message: v.error };
      setLocal((s) => ({ ...s, [key]: value }));
      if (scripted) await api.settings.set(key, value, settingScope(key)).catch(() => {});
      return { ok: true };
    },
    [api, scripted, pinned],
  );
  const refresh = useCallback(async () => {
    if (!scripted) return;
    try {
      const { global, device } = await api.settings.all();
      setLocal((s) => ({ ...s, ...global, ...device }) as PartialSettings);
    } catch {
      // Offline: the Settings in hand stay.
    }
  }, [api, scripted]);
  const value = useMemo<ShellState>(
    () => ({
      settings,
      pinned,
      layout: {
        nav: settings["layout.nav"],
        agent: settings["layout.agent"],
        list: settings["layout.list"],
      },
      density: settings["appearance.density"],
      mode: settings["appearance.mode"],
      palette: settings["appearance.palette"],
      config: { file: null, values: {}, warnings: [], error: null },
      sidecar: null,
      spawn: null,
      cloud: null,
      server: null,
      setCloud: async () => {},
      refreshServers: async () => {},
      ...shellOverrides,
      api,
      set,
      refresh,
    }),
    [settings, api, set, refresh, pinned, shellOverrides],
  );
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

const EMPTY_PINNED: ReadonlySet<SettingKey> = new Set<SettingKey>();
