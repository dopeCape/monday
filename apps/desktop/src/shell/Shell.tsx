// The Shell owns settings resolution, layout knobs, theming and the server connection
// (ADR 0001, ADR 0004, ADR 0009). It merges three layers, defaults under Server settings
// under the Config file, applies the result to the document root, and is the only path
// screens use to read or change a Setting.

import {
  type ConfigWarning,
  type Density,
  defaultSettings,
  isSettingKey,
  type Layout,
  PALETTE_TOKENS,
  type Palette,
  type PartialSettings,
  parseConfig,
  parsePaletteFile,
  resolveSettings,
  type SettingKey,
  type Settings,
  settingScope,
  type ThemeMode,
  validateSetting,
} from "@monday/shared";
import { paletteKeys } from "@monday/ui";
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
import { type Api, ApiError, createApi, type ServerTarget } from "../platform/api.ts";
import {
  type CloudTarget,
  createTargetPicker,
  loadCloudTarget,
  type Picked,
  saveCloudTarget,
} from "../platform/cloud.ts";
import {
  type ConfigFile,
  type Platform,
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

/**
 * The palette file `appearance.palette` names when it is not a shipped key
 * (docs/spec/settings.md, "Custom from file"): what was loaded, or why not.
 */
export interface CustomPalette {
  /** The path as the Setting names it. */
  path: string;
  /** The palette's name once it parsed, null while loading or on a problem. */
  name: string | null;
  /** The first problem, for the palette card's footer; null when the file applied. */
  error: string | null;
}

export interface ShellState {
  settings: Settings;
  pinned: ReadonlySet<SettingKey>;
  layout: Layout;
  density: Density;
  mode: ThemeMode;
  /** The mode in effect: "system" resolved against the OS preference. */
  resolvedMode: "light" | "dark";
  palette: string;
  /** Null on a shipped palette; the file's state otherwise. */
  customPalette: CustomPalette | null;
  config: ConfigState;
  sidecar: SidecarInfo | null;
  /** Why the Sidecar did not start, from the host; null while it is starting or once it runs. */
  sidecarError: string | null;
  /** Spawns a Local runtime's CLI on this Device; null where there is no host to spawn from. */
  spawn: ProcessRunner | null;
  /**
   * What runs the webview: the Tauri app, or a browser (the dev server over
   * the fake platform). Null until the platform has answered. Fixture data may
   * only ever load under "browser".
   */
  host: "tauri" | "browser" | null;
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
  /** Applied; `queued` when the Server has not taken it yet and will on the next contact. */
  { ok: true; queued?: boolean } | { ok: false; reason: "pinned" | "invalid"; message: string };

const ShellContext = createContext<ShellState | null>(null);

export function useShell(): ShellState {
  const s = useContext(ShellContext);
  if (!s) throw new Error("useShell outside Shell");
  return s;
}

/** The tokens the base size scales; the schema default (14) is the comfortable --fs-md. */
const SIZE_TOKENS = ["--fs-xs", "--fs-sm", "--fs-md", "--fs-lg", "--fs-xl", "--fs-2xl", "--fs-3xl"];
const BASE_FONT_SIZE = 14;

/**
 * Writes the Type Settings onto the root: the font families as the two font
 * tokens (with the shipped stacks as fallbacks), and the base size as a scale
 * over the density's own sizes, read after the inline overrides are cleared
 * so a density change re-derives them.
 */
export function applyType(
  root: HTMLElement,
  type: { font: string; mono: string; fontSize: number; density: Density },
) {
  const quote = (f: string) => (/[\s"']/.test(f) && !/^["']/.test(f) ? `"${f}"` : f);
  root.style.setProperty(
    "--font-sans",
    `${quote(type.font)}, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`,
  );
  root.style.setProperty(
    "--font-mono",
    `${quote(type.mono)}, ui-monospace, "JetBrains Mono", "SF Mono", Menlo, monospace`,
  );
  for (const t of SIZE_TOKENS) root.style.removeProperty(t);
  root.dataset.density = type.density;
  const scale = type.fontSize / BASE_FONT_SIZE;
  if (Math.abs(scale - 1) < 0.001 || typeof getComputedStyle !== "function") return;
  const computed = getComputedStyle(root);
  for (const t of SIZE_TOKENS) {
    const px = Number.parseFloat(computed.getPropertyValue(t));
    if (Number.isFinite(px) && px > 0) root.style.setProperty(t, `${(px * scale).toFixed(2)}px`);
  }
}

/**
 * The Server's two buckets as one layer (ADR 0001): the global row for every
 * key, and this Device's own row on top for the keys the schema scopes per
 * device. A device row for a global key (a leftover from an older schema) is
 * ignored, and keys the schema no longer has are dropped rather than carried.
 */
export function mergeStored(
  global: Record<string, unknown>,
  device: Record<string, unknown>,
): PartialSettings {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(global)) {
    if (isSettingKey(key)) out[key] = value;
  }
  for (const [key, value] of Object.entries(device)) {
    if (isSettingKey(key) && settingScope(key) === "device") out[key] = value;
  }
  return out as PartialSettings;
}

function systemPrefersDark(): boolean {
  return typeof matchMedia !== "undefined" && matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolveMode(mode: ThemeMode, prefersDark: boolean): "light" | "dark" {
  if (mode !== "system") return mode;
  return prefersDark ? "dark" : "light";
}

/** Whether `appearance.palette` names one of the shipped palettes rather than a file. */
export function isShippedPalette(palette: string): boolean {
  return (paletteKeys as readonly string[]).includes(palette);
}

/**
 * Writes a palette's half onto the root as the color tokens, over the shipped
 * palette the CSS would otherwise pick, then the token overrides
 * (`appearance.overrides`) on top. With no custom palette the inline tokens
 * are cleared so the shipped palette shows through, and only the overrides
 * stay. Tokens tokens.css does not know are ignored.
 */
export function applyPalette(
  root: HTMLElement,
  palette: Palette | null,
  half: "light" | "dark",
  overrides: Readonly<Record<string, string>>,
): void {
  const tokens: Record<string, string> = palette ? { ...palette[half] } : {};
  for (const [token, value] of Object.entries(overrides)) {
    if ((PALETTE_TOKENS as readonly string[]).includes(token)) tokens[token] = value;
  }
  for (const token of PALETTE_TOKENS) {
    const value = tokens[token];
    if (value === undefined) root.style.removeProperty(`--${token}`);
    else root.style.setProperty(`--${token}`, value);
  }
}

/** The palette file's outcome as the Shell keeps it. */
export function loadPalette(
  path: string,
  file: ConfigFile,
): { palette: Palette | null; state: CustomPalette } {
  if (!file.exists) {
    return { palette: null, state: { path, name: null, error: `no palette file at ${file.path}` } };
  }
  const result = parsePaletteFile(file.text, file.path);
  if (!result.ok) {
    const first = result.problems[0];
    const where = first?.half && first.token ? `[${first.half}] ` : "";
    return {
      palette: null,
      state: { path, name: null, error: `${where}${first?.message ?? "invalid palette"}` },
    };
  }
  return { palette: result.palette, state: { path, name: result.palette.name, error: null } };
}

/**
 * The duration of a motion token on the root, in milliseconds, as the CSS
 * resolved it: 0 when transitions are off or the token is unreadable.
 */
export function tokenMs(root: HTMLElement, token: string): number {
  if (typeof getComputedStyle !== "function") return 0;
  const value = getComputedStyle(root).getPropertyValue(token).trim();
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return 0;
  return value.endsWith("ms") ? n : n * 1000;
}

function parseFile(file: ConfigFile, last: ConfigState): ConfigState {
  if (!file.exists || file.text.trim() === "") {
    return { file, values: {}, warnings: [], error: null };
  }
  const r = parseConfig(file.text);
  if (r.ok) return { file, values: r.values, warnings: r.warnings, error: null };
  return { ...last, file, error: { line: r.error.line, message: r.error.message } };
}

/**
 * The real Shell over the platform. `host` is the seam a test uses to hand it
 * a fake platform (a config file, a palette file, a keychain); the app leaves
 * it out and gets the Tauri host or the browser fake.
 */
export function Shell({ children, host }: { children: ReactNode; host?: Platform | undefined }) {
  const hostRef = useRef(host);
  hostRef.current = host;
  const platformOf = useCallback(
    () => (hostRef.current ? Promise.resolve(hostRef.current) : platform()),
    [],
  );
  const [config, setConfig] = useState<ConfigState>({
    file: null,
    values: {},
    warnings: [],
    error: null,
  });
  const [stored, setStored] = useState<PartialSettings>({});
  const [sidecar, setSidecar] = useState<SidecarInfo | null>(null);
  const [sidecarError, setSidecarError] = useState<string | null>(null);
  const [spawn, setSpawn] = useState<ProcessRunner | null>(null);
  const [hostKind, setHostKind] = useState<"tauri" | "browser" | null>(null);
  const [cloud, setCloudState] = useState<CloudTarget | null>(null);
  const [server, setServer] = useState<Picked | null>(null);
  const configRef = useRef(config);
  configRef.current = config;

  useEffect(() => {
    let alive = true;
    const dispose: Array<() => void> = [];
    // A subscription made after the cleanup ran (StrictMode's double mount, a
    // fast unmount) is dropped at once rather than leaking a listener.
    const keep = (un: () => void) => {
      if (alive) dispose.push(un);
      else un();
    };
    void platformOf().then(async (p) => {
      if (!alive) return;
      // Only a Tauri host can spawn a Local runtime's CLI; the browser dev server cannot.
      if (p.isTauri) setSpawn(() => p.spawn);
      setHostKind(p.isTauri ? "tauri" : "browser");
      // The browser dev server is the design fixture, whose world has the assistant
      // everywhere: its Workspace's saved Settings say the full AI level.
      if (!p.isTauri) setStored((s) => ({ "ai.level": "automate", ...s }));
      const first = await p.readConfig();
      if (!alive) return;
      setConfig((last) => parseFile(first, last));
      keep(p.onConfigChanged((f) => setConfig((last) => parseFile(f, last))));
      setCloudState(await loadCloudTarget(p));
      const info = await p.sidecarInfo();
      if (!alive) return;
      if (info.running) setSidecar(info);
      keep(
        p.onSidecarReady((i) => {
          setSidecarError(null);
          setSidecar(i);
        }),
      );
      keep(p.onSidecarFailed(setSidecarError));
    });
    return () => {
      alive = false;
      for (const d of dispose) d();
      dispose.length = 0;
    };
  }, [platformOf]);

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

  const api = useMemo(
    () =>
      createApi(() => picker.current()?.target ?? null, {
        onUnreachable: (t) => picker.markUnreachable(t),
      }),
    [picker],
  );

  // Writes the Server has not taken yet (offline, or no Server picked): they
  // stay in effect here, ride over every refresh, and go out once a Server
  // answers, so a change made offline is not lost on the next pull. The count
  // is state so the probe below runs while any wait.
  const pendingWrites = useRef(new Map<SettingKey, unknown>());
  const [pendingCount, setPendingCount] = useState(0);
  const notePending = useCallback(() => setPendingCount(pendingWrites.current.size), []);

  const refresh = useCallback(async () => {
    try {
      const { global, device } = await api.settings.all();
      setStored({
        ...mergeStored(global, device),
        ...Object.fromEntries(pendingWrites.current),
      } as PartialSettings);
    } catch {
      // No Server yet, or offline: the Settings in hand stay.
    }
  }, [api]);

  const flushPending = useCallback(async () => {
    for (const [key, value] of [...pendingWrites.current]) {
      try {
        await api.settings.set(key, value as Settings[typeof key], settingScope(key));
        pendingWrites.current.delete(key);
      } catch (e) {
        if (e instanceof ApiError && e.permanent) pendingWrites.current.delete(key);
        else break;
      }
    }
    setPendingCount(pendingWrites.current.size);
  }, [api]);

  useEffect(() => {
    if (!server) return;
    void flushPending().then(refresh);
  }, [flushPending, refresh, server]);

  // Reachability: both targets are probed on a timer while a Cloud is configured
  // (so the picker can move between them) or while writes wait for a Server; a
  // single Sidecar with nothing pending needs no probing, a failed request says
  // enough. Every probe also pushes what waits.
  const probeSeconds = settings["server.probe_seconds"];
  const probe = useCallback(async () => {
    await picker.refresh();
    if (pendingWrites.current.size > 0) await flushPending().then(refresh);
  }, [picker, flushPending, refresh]);
  useEffect(() => {
    if (!cloud && pendingCount === 0) return;
    const timer = setInterval(() => void probe(), probeSeconds * 1000);
    void probe();
    return () => clearInterval(timer);
  }, [probe, cloud, pendingCount, probeSeconds]);

  const setCloud = useCallback(
    async (target: CloudTarget | null) => {
      const p = await platformOf();
      await saveCloudTarget(p, target);
      setCloudState(target);
    },
    [platformOf],
  );

  const refreshServers = useCallback(async () => {
    await probe();
  }, [probe]);
  const nav = settings["layout.nav"];
  const agent = settings["layout.agent"];
  const list = settings["layout.list"];
  const layout = useMemo<Layout>(() => ({ nav, agent, list }), [nav, agent, list]);
  const density = settings["appearance.density"];
  const mode = settings["appearance.mode"];
  const palette = settings["appearance.palette"];
  const overrides = settings["appearance.overrides"];
  const transitions = settings["appearance.transitions"];
  const [prefersDark, setPrefersDark] = useState(systemPrefersDark);
  const resolvedMode = resolveMode(mode, prefersDark);

  useEffect(() => {
    const r = document.documentElement;
    r.dataset.theme = resolvedMode;
    // A file palette writes its tokens inline; the attribute names no shipped palette then.
    r.dataset.palette = isShippedPalette(palette) ? palette : "custom";
    r.dataset.density = density;
    r.dataset.nav = layout.nav;
    r.dataset.agent = layout.agent;
    r.dataset.list = layout.list;
    // "auto" still honours the system's reduce-motion preference (tokens.css); "off" stops everything.
    r.dataset.transitions = transitions ? "auto" : "off";
  }, [resolvedMode, palette, density, layout.nav, layout.agent, layout.list, transitions]);

  // Light to dark and back crossfade: the root carries data-theme-fade for one
  // slow beat after the mode flips, and app.css transitions colors under it.
  // Never on the first paint, and a zero token (transitions off) skips it.
  const paintedMode = useRef<"light" | "dark" | null>(null);
  useEffect(() => {
    const r = document.documentElement;
    if (paintedMode.current === null || paintedMode.current === resolvedMode) {
      paintedMode.current = resolvedMode;
      return;
    }
    paintedMode.current = resolvedMode;
    const ms = tokenMs(r, "--t-slow");
    if (ms <= 0) return;
    r.dataset.themeFade = "true";
    const timer = setTimeout(() => {
      delete r.dataset.themeFade;
    }, ms);
    return () => {
      clearTimeout(timer);
      delete r.dataset.themeFade;
    };
  }, [resolvedMode]);

  // A palette from a file (docs/spec/settings.md, "Custom from file"): read
  // through the platform whenever the Setting names a path, and again when the
  // Config file changes, since the palette usually lives beside it.
  const [loaded, setLoaded] = useState<{ palette: Palette | null; state: CustomPalette } | null>(
    null,
  );
  const configText = config.file?.text;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the Config file's text is the re-read trigger, not a value the effect reads
  useEffect(() => {
    if (isShippedPalette(palette)) {
      setLoaded(null);
      return;
    }
    let live = true;
    setLoaded((current) =>
      current?.state.path === palette
        ? current
        : { palette: null, state: { path: palette, name: null, error: null } },
    );
    void platformOf().then(async (p) => {
      const file = await p.readPaletteFile(palette).catch(
        (e): ConfigFile => ({
          path: palette,
          exists: false,
          text: e instanceof Error ? e.message : String(e),
        }),
      );
      if (live) setLoaded(loadPalette(palette, file));
    });
    return () => {
      live = false;
    };
  }, [palette, configText, platformOf]);
  const customPalette = loaded?.state ?? null;
  const filePalette = loaded?.palette ?? null;
  useEffect(() => {
    applyPalette(document.documentElement, filePalette, resolvedMode, overrides);
  }, [filePalette, resolvedMode, overrides]);

  // The Type Settings: the families as the font tokens, and the base size as a
  // scale over the density's sizes, so the Settings page itself follows them.
  const font = settings["appearance.font"];
  const mono = settings["appearance.monospace"];
  const fontSize = settings["appearance.font_size"];
  useEffect(() => {
    applyType(document.documentElement, { font, mono, fontSize, density });
  }, [font, mono, fontSize, density]);

  useEffect(() => {
    if (mode !== "system" || typeof matchMedia === "undefined") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = () => setPrefersDark(mq.matches);
    on();
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
      pendingWrites.current.set(key, value);
      try {
        await api.settings.set(key, value, settingScope(key));
        pendingWrites.current.delete(key);
        // A Server that took this one takes what waited too.
        if (pendingWrites.current.size > 0) void flushPending();
        else notePending();
        return { ok: true };
      } catch (e) {
        if (e instanceof ApiError && e.permanent) {
          // The Server refused the value for good: nothing to retry, and it never applied there.
          pendingWrites.current.delete(key);
          notePending();
          setStored((s) => {
            const { [key]: _gone, ...rest } = s;
            return rest as PartialSettings;
          });
          return { ok: false, reason: "invalid", message: e.message };
        }
        // Offline, or no Server picked yet: applied here, sent when one answers.
        notePending();
        return { ok: true, queued: true };
      }
    },
    [api, resolved.pinned, flushPending, notePending],
  );

  const value = useMemo<ShellState>(
    () => ({
      settings,
      pinned: resolved.pinned,
      layout,
      density,
      mode,
      resolvedMode,
      palette,
      customPalette,
      config,
      sidecar,
      sidecarError,
      spawn,
      host: hostKind,
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
      resolvedMode,
      palette,
      customPalette,
      config,
      sidecar,
      sidecarError,
      spawn,
      hostKind,
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
          | "api"
          | "sidecar"
          | "sidecarError"
          | "spawn"
          | "host"
          | "cloud"
          | "server"
          | "setCloud"
          | "pinned"
          | "config"
          | "customPalette"
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
      setLocal((s) => ({ ...s, ...mergeStored(global, device) }) as PartialSettings);
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
      resolvedMode: settings["appearance.mode"] === "dark" ? "dark" : "light",
      palette: settings["appearance.palette"],
      customPalette: null,
      config: { file: null, values: {}, warnings: [], error: null },
      sidecar: null,
      sidecarError: null,
      spawn: null,
      host: "browser",
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
