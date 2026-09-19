// Onboarding (docs/spec/onboarding.md, CONTEXT.md "AI level", "Onboarding"):
// shown once per Account after it is added and syncing, and again from "Set
// me up". The first screen is the three choices, the only step that is not a
// chat because it decides whether there is a chat at all. `off` ends with the
// keymap question. `assist` and `automate` continue as the conversation in the
// composer on a Session of its own, with chips built from the top senders
// already synced and the tools, every step skippable, closing skipping the
// rest; the Agent's onboarding tools propose Groups (with move counts) and
// catalog Workflows (with Dry runs) and nothing applies until approved.
// Moving up from `off` with no runtime configured shows the runtime step
// before the level is saved. Every string and knob is a Setting (ADR 0004).

import type { AiLevel, Density, OnboardingState, SettingKey, Settings } from "@monday/shared";
import { Btn, Chip, type ChoiceCard, ChoiceCards } from "@monday/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Composer, composerStrings } from "../agent/Composer.tsx";
import type { AgentClient } from "../agent/client.ts";
import { desiredRuntime, runtimeLine } from "../agent/runtimeLine.ts";
import { useAgentSession } from "../agent/useAgentSession.ts";
import type { DeviceProviderKeys } from "../platform/providerKeys.ts";
import { type SetResult, useShell } from "../shell/Shell.tsx";
import { levelCards, RuntimeStep, useRuntimeConfigured } from "./settings/controls.tsx";
import {
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
  /** Opens on the conversation at once (the dev server's fixture state); the level is not touched. */
  initialStep?: "chat" | undefined;
  now?: Date | undefined;
  /** Leaves the screen: after Done, Skip the rest, or when nothing is left to ask. */
  onDone: () => void;
}

type Step = "level" | "runtime" | "chat" | "keymap";

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
  return (
    <SettingsScreenProvider value={screen}>
      <OnboardingBody {...props} now={now} />
    </SettingsScreenProvider>
  );
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
  now: nowProp,
  onDone,
}: OnboardingProps) {
  const shell = useShell();
  const s = shell.settings;
  const now = nowProp ?? new Date();
  const current = s["ai.level"];
  const [step, setStep] = useState<Step>(initialStep ?? "level");
  const [chosen, setChosen] = useState<AiLevel | null>(rerun ? current : null);
  const [finished, setFinished] = useState(false);
  const seeded = useRef(false);

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

  // Density from the screen size, once, on the first run only; a pinned key stays the file's.
  useEffect(() => {
    if (rerun || seeded.current || shell.pinned.has("appearance.density")) return;
    seeded.current = true;
    const width = screenWidth ?? (typeof window !== "undefined" ? window.innerWidth : 1440);
    const density = densityFor(width);
    if (density !== s["appearance.density"]) void shell.set("appearance.density", density);
  }, [rerun, screenWidth, shell, s["appearance.density"]]);

  const finish = (status: "completed" | "skipped") => {
    record(status);
    onDone();
  };

  /* ------------------------------ The conversation ------------------------------ */

  const runtime = useMemo(() => desiredRuntime(s), [s]);
  const agent = useAgentSession({
    client: step === "chat" ? agentClient : null,
    workspaceId,
    context: () => ({ pinned: [...shell.pinned], onboarding: true }),
    newAfterHours: s["ai.session.new_after_hours"],
    runtime,
    developerModeDefault: false,
    onSettingsChanged: () => void shell.refresh(),
  });
  const kicked = useRef(false);
  useEffect(() => {
    if (step !== "chat" || kicked.current || !agentClient) return;
    kicked.current = true;
    void agent.newSession().then(() => agent.send(s["strings.onboarding.kickoff"]));
  }, [step, agentClient, agent, s["strings.onboarding.kickoff"]]);
  // The conversation is over once the Agent stopped after a turn with no card waiting and
  // it set the keymap, or once it cannot go on.
  useEffect(() => {
    if (step !== "chat" || agent.busy) return;
    const done = agent.events.some(
      (e) => e.kind === "tool" && e.call.tool === "set_keymap" && e.call.status === "done",
    );
    if (done) setFinished(true);
  }, [step, agent.busy, agent.events]);
  const questions = useMemo(
    () => agent.events.filter((e) => e.kind === "text").length,
    [agent.events],
  );
  const chips = useMemo(
    () => chipsForQuestion(questions, s, senders.slice(0, s["onboarding.sender_chips"])),
    [questions, s, senders],
  );
  const agentStrings = useMemo(() => composerStrings(s), [s]);
  const [text, setText] = useState("");
  const runtimeText = runtimeLine(agent.runtimeInfo, s, address);

  /* ------------------------------ Steps ------------------------------ */

  const configured = useRuntimeConfigured();
  const pickLevel = (level: AiLevel) => setChosen(level);
  const continueFromLevel = async () => {
    const level = chosen ?? "off";
    if (level !== "off" && current === "off" && configured === false) {
      setStep("runtime");
      return;
    }
    await applyLevel(level);
  };
  const applyLevel = async (level: AiLevel) => {
    if (level !== current) await shell.set("ai.level", level);
    if (level === "off") setStep("keymap");
    else setStep("chat");
  };

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

  const lots = threadCount >= s["onboarding.focus_view_threads"];

  return (
    <div className="main page" data-screen="onboarding" data-step={step}>
      <div className="onboarding">
        <div className="onboarding-in">
          {step === "level" ? (
            <>
              <h1>{s["strings.onboarding.title"]}</h1>
              <p>{s["strings.onboarding.intro"]}</p>
              <ChoiceCards cards={levelCards(s)} value={chosen} onChange={pickLevel} />
              <p className="choice-note">{s["strings.ai.level.change_note"]}</p>
              <div className="actions">
                <span className="sp" />
                <Btn onClick={() => finish("skipped")}>{s["strings.onboarding.skip"]}</Btn>
                <Btn primary disabled={chosen === null} onClick={() => void continueFromLevel()}>
                  {s["strings.onboarding.continue"]}
                </Btn>
              </div>
            </>
          ) : null}

          {step === "runtime" ? (
            <>
              <h1>{s["strings.ai.level.runtime_title"]}</h1>
              <RuntimeStep
                configured={configured}
                onContinue={() => void applyLevel(chosen ?? "assist")}
                onBack={() => setStep("level")}
              />
            </>
          ) : null}

          {step === "chat" ? (
            <>
              <h1>{s["strings.onboarding.chat_title"]}</h1>
              <p>{s["strings.onboarding.chat_intro"]}</p>
              <div className="onboarding-chat" data-lots={lots ? "true" : undefined}>
                {!finished ? (
                  <div className="onboarding-chips">
                    {chips.map((c) => (
                      <Chip key={c} onClick={() => void agent.send(c)}>
                        {c}
                      </Chip>
                    ))}
                    <Chip onClick={() => void agent.send(s["strings.onboarding.skip"])}>
                      {s["strings.onboarding.skip"]}
                    </Chip>
                  </div>
                ) : null}
                <Composer
                  agent={agent}
                  mode="right"
                  runtime={runtimeText}
                  strings={agentStrings}
                  suggestions={[]}
                  now={now}
                  placeholder={s["strings.agent.placeholder_open"]}
                  text={text}
                  onTextChange={setText}
                  plain
                />
              </div>
              <div className="actions">
                <span className="sp" />
                {finished ? (
                  <Btn primary onClick={() => finish("completed")}>
                    {s["strings.onboarding.done"]}
                  </Btn>
                ) : (
                  <Btn onClick={() => finish("skipped")}>{s["strings.onboarding.skip_rest"]}</Btn>
                )}
              </div>
            </>
          ) : null}

          {step === "keymap" ? (
            <>
              <h1>{s["strings.onboarding.keymap_title"]}</h1>
              <p>{s["strings.onboarding.keymap_intro"]}</p>
              <ChoiceCards
                cards={keymaps}
                value={s["keyboard.keymap"]}
                onChange={(k) => void shell.set("keyboard.keymap", k)}
              />
              <div className="actions">
                <span className="sp" />
                <Btn primary onClick={() => finish("completed")}>
                  {s["strings.onboarding.done"]}
                </Btn>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
