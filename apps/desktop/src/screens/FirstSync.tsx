// The first sync (docs/spec/onboarding.md, "First sync"): the screen right
// after the first Account is connected, and on any launch where the current
// Workspace's first sync has not finished. It stands in for the whole app:
// the gate mounts nothing behind it, so there is no nav, palette, agent bar
// or keymap to reach. Two ways out stay open the whole time: the account
// header opens the workspace switcher (another Account, or a new one), and
// Settings opens the app's Settings, with a way back here. It reads the Server's progress (the engine's mirror and
// body_state, never a client guess) every `sync.first_run_poll_seconds`, and
// once the phase `sync.first_run_wait` names is complete it steps aside with
// one slow beat of the motion tokens (none with transitions off).
//
// An error shows the reason in plain words and adds Retry (clears the failure
// and syncs now); Settings then opens on the Accounts section, where the
// Account can be reconnected or removed.

import type { FirstSyncProgress, Provider, Settings as SettingsValues } from "@monday/shared";
import { firstSyncComplete } from "@monday/shared";
import { Btn, cx, Icon, motionMs, WorkspaceMenu, type WorkspaceMenuAccount } from "@monday/ui";
import {
  ArrowLeftIcon,
  CaretUpDownIcon,
  EnvelopeSimpleIcon,
  GearSixIcon,
  GoogleLogoIcon,
  WarningCircleIcon,
  WindowsLogoIcon,
} from "@phosphor-icons/react";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { type AccountView, ApiError } from "../platform/api.ts";
import { useShell } from "../shell/Shell.tsx";
import {
  emptyTracker,
  etaSettings,
  fill,
  formatEta,
  type PhaseLine,
  phaseLines,
  steadyEta,
  type Tracker,
  track,
} from "./first-sync/model.ts";
import { Settings } from "./Settings.tsx";

/* ------------------------------ The view ------------------------------ */

export interface FirstSyncViewProps {
  address: string;
  provider: Provider;
  lines: readonly PhaseLine[];
  /** The time remaining, already worded; null hides it. */
  eta: string | null;
  /** The Provider is pacing for quota. */
  pacing: boolean;
  /** Older Inbox Messages the wait does not cover; they arrive after the app opens. */
  later?: number | undefined;
  /** The reason the sync stopped, in plain words; null while it runs. */
  error: string | null;
  /** Retry was pressed and the Server has not answered yet. */
  retrying?: boolean | undefined;
  /** The wait is over and the screen is stepping aside. */
  leaving?: boolean | undefined;
  onRetry: () => void;
  onSettings: () => void;
  /** Every connected Account, for the switcher on the account header. */
  accounts?: readonly WorkspaceMenuAccount[] | undefined;
  onPick?: ((accountId: string) => void) | undefined;
  onAdd?: (() => void) | undefined;
  s: SettingsValues;
}

export function providerName(provider: Provider, s: SettingsValues): string {
  return s[`strings.first_sync.provider.${provider}`];
}

function Glyph({ provider }: { provider: Provider }) {
  const G =
    provider === "gmail"
      ? GoogleLogoIcon
      : provider === "graph"
        ? WindowsLogoIcon
        : EnvelopeSimpleIcon;
  return <G />;
}

function ProviderMark({ provider }: { provider: Provider }) {
  return (
    <span className="lg" aria-hidden="true">
      <Glyph provider={provider} />
    </span>
  );
}

function Line({ line }: { line: PhaseLine }) {
  const pct = line.fraction === null ? null : Math.round(line.fraction * 1000) / 10;
  return (
    <div className="first-sync-line" data-phase={line.phase} data-state={line.state}>
      <div className="first-sync-row">
        <span className="first-sync-label">{line.label}</span>
        <span className="first-sync-detail">{line.detail}</span>
      </div>
      <div
        className={cx("first-sync-bar", pct === null && "unknown")}
        role="progressbar"
        aria-label={line.label}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(pct === null ? {} : { "aria-valuenow": pct })}
      >
        <span style={{ "--p": String(line.fraction ?? 0) } as CSSProperties} />
      </div>
    </div>
  );
}

/** The screen itself, over what the gate read. The dev server renders it on fixtures. */
export function FirstSyncView(props: FirstSyncViewProps) {
  const { s } = props;
  const failed = props.error !== null;
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const accountButton = useRef<HTMLButtonElement>(null);
  const accounts: readonly WorkspaceMenuAccount[] = props.accounts ?? [];
  return (
    <div
      className="main page"
      data-screen="first-sync"
      data-state={failed ? "error" : props.pacing ? "pacing" : "syncing"}
      data-leaving={props.leaving ? "true" : undefined}
    >
      <div className="first-sync">
        <div className="first-sync-top">
          <button
            ref={accountButton}
            type="button"
            className="first-sync-account"
            aria-label={s["strings.switcher.label"]}
            aria-haspopup="menu"
            aria-expanded={switcherOpen}
            onClick={() => setSwitcherOpen((open) => !open)}
          >
            <ProviderMark provider={props.provider} />
            <div>
              <b>{props.address}</b>
              <span>{providerName(props.provider, s)}</span>
            </div>
            <Icon icon={CaretUpDownIcon} />
          </button>
          <Btn onClick={props.onSettings}>
            <GearSixIcon /> {s["strings.switcher.settings"]}
          </Btn>
          {switcherOpen ? (
            <WorkspaceMenu
              className="first-sync-menu"
              accounts={accounts}
              labels={{
                label: s["strings.switcher.label"],
                title: s["strings.switcher.title"],
                add: s["strings.switcher.add"],
                settings: s["strings.switcher.settings"],
              }}
              anchor={accountButton}
              onPick={(id) => {
                setSwitcherOpen(false);
                props.onPick?.(id);
              }}
              onAdd={() => {
                setSwitcherOpen(false);
                props.onAdd?.();
              }}
              onSettings={() => {
                setSwitcherOpen(false);
                props.onSettings();
              }}
              onClose={() => setSwitcherOpen(false)}
            />
          ) : null}
        </div>
        <div className="first-sync-stage">
          <div className="first-sync-in">
            <header className="first-sync-head">
              <ProviderMark provider={props.provider} />
              <h1>{s["strings.first_sync.title"]}</h1>
              <p>{s["strings.first_sync.why"]}</p>
            </header>
            <div className="first-sync-lines">
              {props.lines.map((line) => (
                <Line key={line.phase} line={line} />
              ))}
            </div>
            {props.later && props.later > 0 ? (
              <p className="first-sync-note" data-note="later">
                {fill(s["strings.first_sync.later"], {
                  count: props.later.toLocaleString("en-US"),
                })}
              </p>
            ) : null}
            {failed ? (
              <div className="first-sync-error" role="alert">
                <WarningCircleIcon />
                <div>
                  <b>{s["strings.first_sync.error_title"]}</b>
                  <span>{props.error}</span>
                </div>
              </div>
            ) : props.pacing ? (
              <p className="first-sync-note" data-note="pacing">
                {fill(s["strings.first_sync.pacing"], {
                  provider: providerName(props.provider, s),
                })}
              </p>
            ) : props.eta ? (
              <p className="first-sync-note" data-note="eta">
                {props.eta}
              </p>
            ) : null}
            {failed ? (
              <div className="actions">
                <span className="sp" />
                {/* Retry takes the focus: it is what the screen asks for. */}
                <Btn primary autoFocus disabled={props.retrying} onClick={props.onRetry}>
                  {s["strings.first_sync.retry"]}
                </Btn>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ The gate ------------------------------ */

export interface FirstSyncAccount {
  id: string;
  address: string;
  provider: Provider;
}

/**
 * Per Account, what the screen has shown, kept across remounts so a reopened
 * screen never draws less than before and the rate keeps its history.
 */
const trackers = new Map<string, Tracker>();

/** For tests: forget what every screen has shown. */
export function resetFirstSyncMemory(): void {
  trackers.clear();
}

function errorText(
  progress: FirstSyncProgress | null,
  unreachable: boolean,
  s: SettingsValues,
): string | null {
  if (progress?.error) {
    const vars = {
      provider: providerName(progress.provider, s),
      address: progress.address,
      message: progress.error.message,
    };
    return fill(s[`strings.first_sync.error.${progress.error.kind}`], vars);
  }
  if (unreachable) return s["strings.first_sync.error.server"];
  return null;
}

type Stage = "checking" | "waiting" | "leaving" | "open";

export interface FirstSyncGateProps {
  account: FirstSyncAccount;
  /** Every connected Account, for the switcher; the current one is `account`. */
  accounts?: readonly AccountView[] | undefined;
  /** The app. Not mounted at all until the wait is over. */
  children: ReactNode;
  /** Told once when the app opens. */
  onOpen?: (() => void) | undefined;
  /** The client clock for the rate; tests pass a fake one. */
  now?: (() => number) | undefined;
}

export function FirstSyncGate({
  account,
  accounts,
  children,
  onOpen,
  now = Date.now,
}: FirstSyncGateProps) {
  const shell = useShell();
  const s = shell.settings;
  const wait = s["sync.first_run_wait"];
  const pollMs = s["sync.first_run_poll_seconds"] * 1000;
  const [stage, setStage] = useState<Stage>("checking");
  const [progress, setProgress] = useState<FirstSyncProgress | null>(null);
  const [tracker, setTracker] = useState<Tracker>(() => trackers.get(account.id) ?? emptyTracker());
  const [unreachable, setUnreachable] = useState(false);
  const [retrying, setRetrying] = useState(false);
  // The Settings section open over the screen, or null for the screen itself.
  const [settingsAt, setSettingsAt] = useState<string | null>(null);
  const stageRef = useRef(stage);
  stageRef.current = stage;
  const settingsRef = useRef(s);
  settingsRef.current = s;
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;
  const nowRef = useRef(now);
  nowRef.current = now;
  const [tick, setTick] = useState(0);

  const open = useCallback(() => {
    setStage("open");
    onOpenRef.current?.();
  }, []);

  const polling = stage === "checking" || stage === "waiting";
  // One read of the Server, then the next after the Setting's interval.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` asks for a read now (Retry)
  useEffect(() => {
    if (!polling) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = async () => {
      try {
        const r = await shell.api.accounts.sync(account.id);
        if (stopped) return;
        const p = r.progress;
        setUnreachable(false);
        setProgress(p);
        const next = track(
          trackers.get(account.id) ?? emptyTracker(),
          p,
          wait,
          nowRef.current(),
          etaSettings(settingsRef.current),
        );
        trackers.set(account.id, next);
        setTracker(next);
        if (p.error === null) setRetrying(false);
        if (firstSyncComplete(p, wait)) {
          if (stageRef.current === "checking") {
            open();
          } else {
            setStage("leaving");
          }
          return;
        }
        setStage("waiting");
      } catch (error) {
        if (stopped) return;
        // A Server without the route (or an Account it no longer has) never blocks the app.
        if (error instanceof ApiError && error.status === 404) {
          open();
          return;
        }
        setUnreachable(true);
        setRetrying(false);
        setStage("waiting");
      }
      if (!stopped) timer = setTimeout(read, pollMs);
    };
    void read();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [shell.api, account.id, wait, pollMs, open, polling, tick]);

  // The calm exit: one slow beat of the motion tokens, none with transitions off.
  useEffect(() => {
    if (stage !== "leaving") return;
    const timer = setTimeout(open, motionMs("--t-slow"));
    return () => clearTimeout(timer);
  }, [stage, open]);

  const retry = useCallback(() => {
    setRetrying(true);
    const again = () => setTick((n) => n + 1);
    shell.api.accounts.retrySync(account.id).then(again, again);
  }, [shell.api, account.id]);

  if (stage === "open") return <>{children}</>;
  if (stage === "checking") return null;
  if (settingsAt !== null) {
    return (
      <div className="app first-sync-settings" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
        <div className="first-sync-back">
          <Btn onClick={() => setSettingsAt(null)}>
            <ArrowLeftIcon /> {s["strings.first_sync.back"]}
          </Btn>
        </div>
        <Settings key={settingsAt} initialSection={settingsAt || undefined} />
      </div>
    );
  }
  const failed = errorText(progress, unreachable, s) !== null;
  const switchable = (accounts ?? []).map(
    (a): WorkspaceMenuAccount => ({
      id: a.id,
      address: a.address,
      mark: <Glyph provider={a.provider} />,
      state: a.lastError
        ? s["strings.switcher.error"]
        : !a.connected
          ? s["strings.switcher.disconnected"]
          : a.id === account.id
            ? s["strings.nav.status.syncing"]
            : s["strings.nav.status.online"],
      tone: a.lastError ? "warn" : !a.connected ? "off" : "ok",
      current: a.id === account.id,
    }),
  );
  if (!switchable.some((a) => a.current)) {
    switchable.unshift({
      id: account.id,
      address: account.address,
      mark: <Glyph provider={account.provider} />,
      state: s["strings.nav.status.syncing"],
      tone: "ok",
      current: true,
    });
  }
  const eta = steadyEta(tracker, etaSettings(s));
  return (
    <div className="app" style={{ gridTemplateColumns: "minmax(0, 1fr)" }}>
      <FirstSyncView
        address={progress?.address ?? account.address}
        provider={progress?.provider ?? account.provider}
        lines={progress ? phaseLines(progress, tracker, wait, s) : []}
        eta={eta === null ? null : formatEta(eta, s)}
        pacing={progress?.pacing ?? false}
        later={
          progress?.headers.inboxTotal !== undefined && progress.headers.total !== null
            ? progress.headers.inboxTotal - progress.headers.total
            : undefined
        }
        error={errorText(progress, unreachable, s)}
        retrying={retrying}
        leaving={stage === "leaving"}
        onRetry={retry}
        // With an error Settings opens where the Account can be fixed; else on its first section.
        onSettings={() => setSettingsAt(failed ? "accounts" : "")}
        accounts={switchable}
        // The gate is keyed on the Account, so the one picked mounts its own screen (or the app).
        onPick={(id) => {
          if (id !== account.id) void shell.set("workspace.current", id);
        }}
        onAdd={() => setSettingsAt("accounts")}
        s={s}
      />
    </div>
  );
}
