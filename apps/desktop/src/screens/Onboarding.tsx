// Onboarding (docs/spec/onboarding.md, CONTEXT.md "AI level", "Onboarding").
//
// The welcome runs before any Account exists: the AI level, the runtime step
// only when the level needs one and none is configured, the keymap, then
// connecting the first Account. One idea per screen, centered, with a slim
// progress line at the top; Enter continues, Esc goes back, the arrow keys
// move between cards. Every step has "Skip, use sensible defaults": it sets
// whatever was not chosen yet from the onboarding.defaults.* Settings and
// goes straight to connecting an Account (or, with one, to the Inbox).
//
// After an Account's first sync, `assist` and `automate` get the conversation:
// the Agent asks a few questions in the composer on a Session of its own, the
// answers' chips wait above the input as quick replies, proposals arrive as
// cards, and the header counts the questions. `off` has nothing to ask.
// "Set me up" runs it again from the level. Every string and knob is a
// Setting (ADR 0004).

import type { AiLevel, Density, OnboardingState, SettingKey, Settings } from "@monday/shared";
import { Btn, type ChoiceCard, ChoiceCards, cx, Kbd } from "@monday/ui";
import {
  ArrowLeftIcon,
  CaretDownIcon,
  ChatCircleTextIcon,
  EnvelopeSimpleIcon,
  FlowArrowIcon,
} from "@phosphor-icons/react";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Composer, composerStrings } from "../agent/Composer.tsx";
import type { AgentClient } from "../agent/client.ts";
import { desiredRuntime, runtimeLine } from "../agent/runtimeLine.ts";
import { useAgentSession } from "../agent/useAgentSession.ts";
import { chordLabel, KEYMAPS, type KeyAction } from "../keyboard/keymaps.ts";
import type { DeviceProviderKeys } from "../platform/providerKeys.ts";
import { type SetResult, useShell } from "../shell/Shell.tsx";
import { AddAccount } from "./settings/AddAccount.tsx";
import {
  levelCards,
  RuntimeStep,
  runtimeSatisfies,
  useRuntimeState,
} from "./settings/controls.tsx";
import {
  KeyStateProvider,
  type RuntimeDetection,
  type SettingsScreen,
  SettingsScreenProvider,
} from "./settings/render.tsx";

export type KeymapChoice = "vim" | "gmail" | "natural";

export interface OnboardingProps {
  /** The Account this offer belongs to; its onboarding.state entry is written here. */
  accountId: string;
  workspaceId: string;
  address: string;
  /** The composer's seam to the Agent host; null keeps the conversation inert. */
  agentClient: AgentClient | null;
  /** Detection and keys for the runtime step; null where nothing can be spawned or stored. */
  runtimes?: RuntimeDetection | null | undefined;
  keys?: DeviceProviderKeys | null | undefined;
  /** The top senders already synced, most active first, for the what-matters chips. */
  senders?: readonly string[] | undefined;
  /** How many Threads are synced: at or above the Setting, monday counts it as lots of mail. */
  threadCount?: number | undefined;
  /** Whether this is the first run for the Account (seeds density) or "Set me up" again. */
  rerun?: boolean | undefined;
  /** The window width, for density; defaults to the browser's. */
  screenWidth?: number | undefined;
  /**
   * Opens on the conversation at once (the dev server's fixture state), or on
   * the runtime step with "sorts and acts" chosen; the level is not touched.
   */
  initialStep?: "chat" | "runtime" | undefined;
  /**
   * `welcome` is the first run before any Account exists: level, runtime, keymap,
   * then connecting the first Account. `account` (default) is the offer each new
   * Account gets; after a welcome it opens on the conversation.
   */
  mode?: "welcome" | "account" | undefined;
  now?: Date | undefined;
  /** Leaves the screen: after Done, Skip, or when nothing is left to ask. */
  onDone: () => void;
}

type Step = "level" | "runtime" | "keymap" | "connect" | "chat";

/** The onboarding.state key of the welcome run, which belongs to no Account. */
export const WELCOME_KEY = "welcome";

/** Density from the screen size (docs/spec/onboarding.md, "What it seeds"). */
export function densityFor(width: number): Density {
  if (width < 1280) return "compact";
  if (width >= 1900) return "spacious";
  return "comfortable";
}

/** The chips for the nth question of the conversation, in the spec's order. */
export function chipsForQuestion(
  n: number,
  s: Pick<
    Settings,
    | "strings.onboarding.chip.yes"
    | "strings.onboarding.chip.no"
    | "strings.onboarding.chip.lots"
    | "strings.onboarding.tools"
  >,
  senders: readonly string[],
): string[] {
  switch (n) {
    case 2:
      return [...senders, s["strings.onboarding.chip.lots"]];
    case 3:
      return s["strings.onboarding.tools"]
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    case 4:
    case 5:
      return [s["strings.onboarding.chip.yes"], s["strings.onboarding.chip.no"]];
    default:
      return [];
  }
}

/* ------------------------------ The sensible defaults ------------------------------ */

export interface SkipDefaults {
  level: AiLevel;
  keymap: KeymapChoice;
  density: Density;
  notifications: boolean;
}

/**
 * What skipping sets, from the onboarding.defaults.* Settings: `auto` level is
 * an assistant when a runtime for one is already configured here (so it works
 * at once) and Just mail otherwise; `auto` density comes from the screen.
 */
export function skipDefaults(
  s: Pick<
    Settings,
    | "onboarding.defaults.level"
    | "onboarding.defaults.keymap"
    | "onboarding.defaults.density"
    | "onboarding.defaults.notifications"
  >,
  assistReady: boolean,
  width: number,
): SkipDefaults {
  const level = s["onboarding.defaults.level"];
  const density = s["onboarding.defaults.density"];
  return {
    level: level === "auto" ? (assistReady ? "assist" : "off") : level,
    keymap: s["onboarding.defaults.keymap"],
    density: density === "auto" ? densityFor(width) : density,
    notifications: s["onboarding.defaults.notifications"],
  };
}

/** The one line that says what the defaults are. */
export function defaultsLine(s: Settings, d: SkipDefaults): string {
  const level = levelCards(s).find((c) => c.value === d.level)?.title ?? d.level;
  return fill(s["strings.onboarding.defaults_line"], {
    level,
    keymap: s[`strings.onboarding.keymap.${d.keymap}`],
    density: s[`strings.onboarding.density.${d.density}`],
    notifications: d.notifications
      ? s["strings.onboarding.defaults_on"]
      : s["strings.onboarding.defaults_off"],
  });
}

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) =>
    values[k] === undefined ? m : String(values[k]),
  );
}

/** The keys a keymap card shows: its own chords for moving and archiving. */
const SAMPLE_KEYS: readonly KeyAction[] = ["move.down", "move.up", "thread.archive"];

function KeySample({ keymap }: { keymap: KeymapChoice }) {
  const mac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
  return (
    <span className="onb-keys">
      {SAMPLE_KEYS.map((a) => (
        <Kbd key={a}>{chordLabel(KEYMAPS[keymap][a], mac)}</Kbd>
      ))}
    </span>
  );
}

const LEVEL_ICONS: Record<AiLevel, ReactNode> = {
  off: <EnvelopeSimpleIcon />,
  assist: <ChatCircleTextIcon />,
  automate: <FlowArrowIcon />,
};

/* ------------------------------ The screen ------------------------------ */

/** The screen: the Settings seams for the runtime step around the body. */
export function Onboarding(props: OnboardingProps) {
  const shell = useShell();
  const { workspaceId, runtimes = null, keys = null } = props;
  const now = props.now ?? new Date();
  const changeMany = useCallback(
    async (changes: Array<[SettingKey, unknown]>): Promise<SetResult> => {
      let result: SetResult = { ok: true };
      for (const [k, v] of changes) {
        result = await shell.set(k, v as never);
        if (!result.ok) break;
      }
      return result;
    },
    [shell],
  );
  const screen = useMemo<SettingsScreen>(
    () => ({
      workspaceId,
      change: (key, value) => changeMany([[key, value]]),
      changeMany,
      onAsk: () => {},
      runtimes,
      keys,
      version: "",
      now: () => now,
    }),
    [workspaceId, changeMany, runtimes, keys, now],
  );
  // The key-state version: a key saved on the runtime step re-runs the runtime check at once.
  return (
    <SettingsScreenProvider value={screen}>
      <KeyStateProvider>
        <OnboardingBody {...props} now={now} />
      </KeyStateProvider>
    </SettingsScreenProvider>
  );
}

/** Whether a key press belongs to a field the user is typing in. */
function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  return el.closest("input, textarea, select, [contenteditable='true'], form") !== null;
}

function OnboardingBody({
  accountId,
  workspaceId,
  address,
  agentClient,
  senders = [],
  threadCount = 0,
  rerun = false,
  screenWidth,
  initialStep,
  mode = "account",
  now: nowProp,
  onDone,
}: OnboardingProps) {
  const shell = useShell();
  const s = shell.settings;
  const now = nowProp ?? new Date();
  const current = s["ai.level"];
  const [step, setStep] = useState<Step>(initialStep ?? "level");
  const [dir, setDir] = useState<"forward" | "back">("forward");
  const [chosen, setChosen] = useState<AiLevel | null>(
    initialStep === "runtime" ? "automate" : rerun || initialStep === "chat" ? current : null,
  );
  const [details, setDetails] = useState(false);
  const seeded = useRef(false);
  // What the user chose themselves this run; skipping never overrides it.
  const picked = useRef({ level: false, keymap: false });
  const skipped = useRef(false);
  const width = screenWidth ?? (typeof window !== "undefined" ? window.innerWidth : 1440);

  const go = useCallback((next: Step, direction: "forward" | "back" = "forward") => {
    setDir(direction);
    setStep(next);
  }, []);

  /* ------------------------------ State and seeds ------------------------------ */

  const record = useCallback(
    (status: OnboardingState[string]["status"]) => {
      const state: OnboardingState = {
        ...s["onboarding.state"],
        [accountId]: { status, at: now.toISOString() },
      };
      void shell.set("onboarding.state", state);
    },
    [shell, s["onboarding.state"], accountId, now],
  );

  // Density from the screen size, once, on the first run only (the welcome, or the
  // first Account on an install that never had one); a later Account's offer and
  // "Set me up" leave the user's choice alone, and a pinned key stays the file's.
  const firstRun = Object.keys(s["onboarding.state"]).every((k) => k === accountId);
  useEffect(() => {
    if (rerun || !firstRun || seeded.current || shell.pinned.has("appearance.density")) return;
    seeded.current = true;
    const density = densityFor(width);
    if (density !== s["appearance.density"]) void shell.set("appearance.density", density);
  }, [rerun, firstRun, width, shell, s["appearance.density"]]);

  const finish = (status: "completed" | "skipped") => {
    record(skipped.current ? "skipped" : status);
    onDone();
  };

  /* ------------------------------ The runtime ------------------------------ */

  // Level-aware (docs/spec/onboarding.md): an assistant needs a language model; sorting runs on TypeSafe alone.
  const runtimeState = useRuntimeState();
  const satisfied = (level: AiLevel) =>
    runtimeState === null ? null : runtimeSatisfies(runtimeState, level);
  const configured = satisfied(chosen ?? "assist");
  /** Moving up from off needs to know whether a runtime exists; Continue waits for detection. */
  const needsRuntimeAnswer = chosen !== null && chosen !== "off" && current === "off";
  const needsRuntime = needsRuntimeAnswer && configured === false;

  /* ------------------------------ The plan and the progress ------------------------------ */

  const conversationOnly = initialStep === "chat" && !rerun;
  const plan = useMemo<Step[]>(() => {
    if (conversationOnly) return ["chat"];
    const steps: Step[] = ["level"];
    if (needsRuntime || step === "runtime") steps.push("runtime");
    if (mode === "welcome") steps.push("keymap", "connect");
    else steps.push((chosen ?? current) === "off" ? "keymap" : "chat");
    return steps;
  }, [conversationOnly, needsRuntime, step, mode, chosen, current]);
  const at = Math.max(0, plan.indexOf(step));
  const previous = at > 0 ? plan[at - 1] : undefined;

  /* ------------------------------ Moves ------------------------------ */

  const applyLevel = async (level: AiLevel) => {
    picked.current.level = true;
    if (level !== current) await shell.set("ai.level", level);
    if (level === "off" || mode === "welcome") go("keymap");
    else go("chat");
  };
  const continueFromLevel = async (level: AiLevel | null = chosen) => {
    if (level === null) return;
    if (level !== "off" && current === "off" && satisfied(level) !== true) {
      if (satisfied(level) === null) return;
      go("runtime");
      return;
    }
    await applyLevel(level);
  };
  /** After the keymap: the welcome connects the first Account; an Account's offer is done. */
  const afterKeymap = () => {
    picked.current.keymap = true;
    if (mode === "welcome") go("connect");
    else finish("completed");
  };

  const defaults = skipDefaults(s, satisfied("assist") === true, width);
  /**
   * Skip, use sensible defaults: what was not chosen yet takes its default,
   * then the welcome connects an Account and an Account's offer ends. "Set me
   * up" again changes nothing on Skip; the user's Settings stay as they are.
   */
  const skip = async () => {
    skipped.current = true;
    if (!rerun) {
      const set = (key: SettingKey, value: unknown) =>
        shell.pinned.has(key) ? Promise.resolve() : shell.set(key, value as never);
      if (!picked.current.level && defaults.level !== current)
        await set("ai.level", defaults.level);
      if (!picked.current.keymap && defaults.keymap !== s["keyboard.keymap"])
        await set("keyboard.keymap", defaults.keymap);
      if (defaults.density !== s["appearance.density"])
        await set("appearance.density", defaults.density);
      if (defaults.notifications !== s["notifications.enabled"])
        await set("notifications.enabled", defaults.notifications);
    }
    if (mode === "welcome") go("connect");
    else finish("skipped");
  };

  const primary = (card?: string) => {
    if (step === "level") {
      const level = (card as AiLevel | undefined) ?? chosen;
      if (card) setChosen(level);
      void continueFromLevel(level);
    } else if (step === "runtime") {
      if (configured) void applyLevel(chosen ?? "assist");
    } else if (step === "keymap") {
      if (card) void shell.set("keyboard.keymap", card as KeymapChoice);
      afterKeymap();
    }
  };
  const back = () => {
    if (previous) go(previous, "back");
  };

  /* ------------------------------ Cards ------------------------------ */

  const keymaps: ChoiceCard<KeymapChoice>[] = [
    {
      value: "vim",
      title: s["strings.onboarding.keymap.vim"],
      body: s["strings.onboarding.keymap.vim_sub"],
    },
    {
      value: "gmail",
      title: s["strings.onboarding.keymap.gmail"],
      body: s["strings.onboarding.keymap.gmail_sub"],
    },
    {
      value: "natural",
      title: s["strings.onboarding.keymap.natural"],
      body: s["strings.onboarding.keymap.natural_sub"],
    },
  ];
  const levels = levelCards(s).map((c) => ({ ...c, icon: LEVEL_ICONS[c.value] }));

  // The keys: Enter continues, Esc goes back, arrows move between the cards.
  const keysRef = useRef({ primary, back, step, chosen, keymap: s["keyboard.keymap"] });
  keysRef.current = { primary, back, step, chosen, keymap: s["keyboard.keymap"] };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = keysRef.current;
      if (k.step === "chat" || typing(e.target)) return;
      const card = (e.target as HTMLElement | null)?.closest?.<HTMLElement>(".choice-card");
      if (e.key === "Enter") {
        const onButton = (e.target as HTMLElement | null)?.closest?.("button");
        // Another button takes Enter as its own click; a card continues with itself.
        if (onButton && !card) return;
        e.preventDefault();
        k.primary(card?.dataset.value);
      } else if (e.key === "Escape") {
        e.preventDefault();
        k.back();
      } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
        if (k.step !== "level" && k.step !== "keymap") return;
        const cards = [
          ...document.querySelectorAll<HTMLButtonElement>(
            '[data-screen="onboarding"] .onb-step .choice-cards > .choice-card',
          ),
        ];
        if (cards.length === 0) return;
        e.preventDefault();
        const on = k.step === "level" ? k.chosen : k.keymap;
        const from = cards.findIndex((c) => c.dataset.value === (card?.dataset.value ?? on));
        const delta = e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 1;
        const next = cards[(from + delta + cards.length) % cards.length];
        next?.focus();
        next?.click();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (step === "chat") {
    return (
      <div className="main page" data-screen="onboarding" data-step="chat">
        <Conversation
          workspaceId={workspaceId}
          address={address}
          agentClient={agentClient}
          senders={senders}
          threadCount={threadCount}
          now={now}
          onFinish={finish}
        />
      </div>
    );
  }

  /* ------------------------------ One step ------------------------------ */

  let title = "";
  let intro: string | null = null;
  let body: ReactNode = null;
  let next: ReactNode = null;
  const cont = s["strings.onboarding.continue"];
  if (step === "level") {
    title = s["strings.onboarding.title"];
    intro = s["strings.onboarding.intro"];
    body = (
      <>
        <ChoiceCards
          cards={levels}
          value={chosen}
          onChange={setChosen}
          details={details}
          className="onb-cards"
        />
        <button
          type="button"
          className="onb-disclose"
          aria-expanded={details}
          onClick={() => setDetails((d) => !d)}
        >
          {s["strings.onboarding.included"]}
          <CaretDownIcon aria-hidden="true" />
        </button>
      </>
    );
    next = (
      <Btn
        primary
        data-action="continue"
        disabled={chosen === null || (needsRuntimeAnswer && configured === null)}
        onClick={() => void continueFromLevel()}
      >
        {cont} <Kbd>Enter</Kbd>
      </Btn>
    );
  } else if (step === "runtime") {
    title = s["strings.ai.level.runtime_title"];
    intro = s["strings.onboarding.runtime_intro"];
    body = (
      <RuntimeStep
        bare
        level={chosen ?? "assist"}
        onContinue={() => void applyLevel(chosen ?? "assist")}
        onBack={() => go("level", "back")}
      />
    );
    next = (
      <Btn
        primary
        data-action="continue"
        disabled={!configured}
        onClick={() => void applyLevel(chosen ?? "assist")}
      >
        {s["strings.ai.level.runtime_continue"]} <Kbd>Enter</Kbd>
      </Btn>
    );
  } else if (step === "keymap") {
    title = s["strings.onboarding.keymap_title"];
    intro = s["strings.onboarding.keymap_intro"];
    body = (
      <ChoiceCards
        cards={keymaps.map((c) => ({ ...c, icon: <KeySample keymap={c.value} /> }))}
        value={s["keyboard.keymap"]}
        onChange={(k) => {
          picked.current.keymap = true;
          void shell.set("keyboard.keymap", k);
        }}
        className="onb-cards"
      />
    );
    next = (
      <Btn primary data-action="continue" onClick={afterKeymap}>
        {mode === "welcome" ? cont : s["strings.onboarding.done"]} <Kbd>Enter</Kbd>
      </Btn>
    );
  } else if (step === "connect") {
    title = s["strings.onboarding.connect_title"];
    intro = s["strings.onboarding.connect_intro"];
    body = (
      <div className="onb-connect">
        <AddAccount onAdded={() => finish("completed")} />
      </div>
    );
    next = <Btn onClick={() => finish("skipped")}>{s["strings.onboarding.connect_later"]}</Btn>;
  }

  const showSkip = step !== "connect";
  return (
    <div className="main page" data-screen="onboarding" data-step={step}>
      <div className="onboarding">
        <Progress
          steps={plan.length}
          at={at}
          label={fill(s["strings.onboarding.step"], { n: at + 1, total: plan.length })}
        />
        <div className="onb-stage">
          <section className="onb-step" key={step} data-dir={dir} aria-labelledby="onb-title">
            <header className="onb-head">
              <h1 id="onb-title">{title}</h1>
              {intro ? <p>{intro}</p> : null}
            </header>
            {body}
            <div className="actions">
              {previous ? (
                <Btn data-action="back" onClick={back}>
                  <ArrowLeftIcon /> {s["strings.onboarding.back"]}
                </Btn>
              ) : null}
              <span className="sp" />
              {next}
            </div>
          </section>
        </div>
        <footer className="onb-foot">
          {showSkip ? (
            <>
              <button
                type="button"
                className="onb-skip"
                data-action="skip"
                onClick={() => void skip()}
              >
                {rerun ? s["strings.onboarding.skip"] : s["strings.onboarding.skip_defaults"]}
              </button>
              {rerun ? null : <span className="onb-defaults">{defaultsLine(s, defaults)}</span>}
            </>
          ) : null}
        </footer>
      </div>
    </div>
  );
}

/** The slim progress line: one segment per step, the ones behind and the current filled. */
function Progress({ steps, at, label }: { steps: number; at: number; label: string }) {
  if (steps < 2) return <div className="onb-progress" aria-hidden="true" />;
  return (
    <div
      className="onb-progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={1}
      aria-valuemax={steps}
      aria-valuenow={at + 1}
    >
      {Array.from({ length: steps }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the segments are positions, not items
        <span key={i} className={cx(i < at && "done", i === at && "on")} />
      ))}
    </div>
  );
}

/* ------------------------------ The conversation ------------------------------ */

function Conversation({
  workspaceId,
  address,
  agentClient,
  senders,
  threadCount,
  now,
  onFinish,
}: {
  workspaceId: string;
  address: string;
  agentClient: AgentClient | null;
  senders: readonly string[];
  threadCount: number;
  now: Date;
  onFinish: (status: "completed" | "skipped") => void;
}) {
  const shell = useShell();
  const s = shell.settings;
  const runtime = useMemo(() => desiredRuntime(s), [s]);
  const agent = useAgentSession({
    client: agentClient,
    workspaceId,
    context: () => ({ pinned: [...shell.pinned], onboarding: true }),
    newAfterHours: s["ai.session.new_after_hours"],
    runtime,
    developerModeDefault: false,
    onSettingsChanged: () => void shell.refresh(),
  });
  const kicked = useRef(false);
  useEffect(() => {
    if (kicked.current || !agentClient) return;
    kicked.current = true;
    void agent.newSession().then(() => agent.send(s["strings.onboarding.kickoff"]));
  }, [agentClient, agent, s["strings.onboarding.kickoff"]]);
  // The conversation is over once the Agent stopped after it set the keymap, its last step.
  const [finished, setFinished] = useState(false);
  useEffect(() => {
    if (agent.busy) return;
    const done = agent.events.some(
      (e) => e.kind === "tool" && e.call.tool === "set_keymap" && e.call.status === "done",
    );
    if (done) setFinished(true);
  }, [agent.busy, agent.events]);
  const texts = useMemo(() => agent.events.filter((e) => e.kind === "text"), [agent.events]);
  const asked = useMemo(
    () => agent.events.filter((e) => e.kind === "text" && e.text.trim().endsWith("?")).length,
    [agent.events],
  );
  const total = s["onboarding.questions_max"];
  const chips = useMemo(
    () => chipsForQuestion(texts.length, s, senders.slice(0, s["onboarding.sender_chips"])),
    [texts.length, s, senders],
  );
  const agentStrings = useMemo(() => composerStrings(s), [s]);
  const [text, setText] = useState("");
  const runtimeText = runtimeLine(agent.runtimeInfo, s, address);
  const reviewing = agent.waiting.length > 0;
  const status = finished
    ? s["strings.onboarding.chat_finished"]
    : reviewing
      ? s["strings.onboarding.chat_review"]
      : asked > 0
        ? fill(s["strings.onboarding.chat_progress"], { n: Math.min(asked, total), total })
        : s["strings.onboarding.chat_starting"];
  const share = finished
    ? 1
    : reviewing
      ? total / (total + 1)
      : Math.min(asked, total) / (total + 1);
  const lots = threadCount >= s["onboarding.focus_view_threads"];

  return (
    <div className="onboarding onb-convo-wrap">
      <div className="onb-convo" data-finished={finished ? "true" : undefined}>
        <header className="onb-convo-head">
          <div>
            <h1>{s["strings.onboarding.chat_title"]}</h1>
            <p>{s["strings.onboarding.chat_intro"]}</p>
          </div>
          <div className="onb-convo-progress" aria-live="polite">
            <span>{status}</span>
            <div
              className="onb-meter"
              role="progressbar"
              aria-label={status}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(share * 100)}
            >
              <span style={{ "--p": String(share) } as CSSProperties} />
            </div>
          </div>
        </header>
        <div className="onboarding-chat" data-lots={lots ? "true" : undefined}>
          <Composer
            agent={agent}
            mode="right"
            runtime={runtimeText}
            strings={agentStrings}
            suggestions={[]}
            replies={finished || reviewing ? [] : [...chips, s["strings.onboarding.skip"]]}
            now={now}
            placeholder={s["strings.agent.placeholder_open"]}
            text={text}
            onTextChange={setText}
            plain
          />
        </div>
        <footer className="onb-convo-foot">
          {finished ? null : (
            <Btn onClick={() => onFinish("skipped")}>{s["strings.onboarding.skip_rest"]}</Btn>
          )}
          <span className="sp" />
          {finished ? (
            <Btn primary autoFocus onClick={() => onFinish("completed")}>
              {s["strings.onboarding.done"]}
            </Btn>
          ) : null}
        </footer>
      </div>
    </div>
  );
}
