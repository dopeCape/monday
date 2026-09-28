// Whether an AI can sort this Workspace's mail, and so whether Sections show
// (docs/spec/inbox.md, "Sections live in the nav only"). An AI can sort when
// this Device reaches any runtime: a TypeSafe key for the Judge, a language
// model key, here or shared with the Server, or a coding agent CLI (Claude
// Code, Codex, OpenCode). The same reading drives onboarding's runtime step
// and the AI settings (screens/settings/controls.tsx, useRuntimeState). With
// `sections.require_ai` on, Sections without such a runtime would be header
// guesses (a shipment notice "needs a reply"), so the Inbox is one list and
// the nav shows no Sections, only a line saying how to turn them on.

import {
  type AiLevel,
  HOSTED_PROVIDERS,
  JUDGE_PROVIDERS,
  KEY_PROVIDERS,
  type KeyProvider,
} from "@monday/shared";
import { useEffect, useState } from "react";
import type { DeviceProviderKeys } from "../platform/providerKeys.ts";
import type { RuntimeDetection } from "../screens/settings/render.tsx";

/** What this Device can run on: a detected CLI, a language model key, a TypeSafe key (here or shared). */
export interface RuntimeState {
  cli: boolean;
  /** A language model's key on this Device or shared with the Server. */
  language: boolean;
  /** A TypeSafe key on this Device or shared with the Server (ADR 0012). */
  judge: boolean;
}

/** The seams the runtime state is read through; any of them may be missing. */
export interface RuntimeSeams {
  runtimes: RuntimeDetection | null | undefined;
  keys: DeviceProviderKeys | null | undefined;
  /** The keys this Workspace shared with the Server. */
  shared: (() => Promise<{ shared: readonly KeyProvider[] }>) | null | undefined;
}

/** Reads the runtimes reachable from this Device. Never throws: a seam that fails reads as nothing found. */
export async function readRuntimeState(seams: RuntimeSeams): Promise<RuntimeState> {
  const detected = await (seams.runtimes?.detect() ?? Promise.resolve([])).catch(() => []);
  const cli = detected.some((d) => d.status !== "missing");
  const have = new Set<KeyProvider>();
  if (seams.keys) {
    for (const p of KEY_PROVIDERS) {
      try {
        if (await seams.keys.get(p)) have.add(p);
      } catch {}
    }
  }
  try {
    for (const p of (await seams.shared?.())?.shared ?? []) have.add(p);
  } catch {}
  return {
    cli,
    language: HOSTED_PROVIDERS.some((p) => have.has(p)),
    judge: JUDGE_PROVIDERS.some((p) => have.has(p)),
  };
}

/** Whether any runtime at hand can sort: the Judge (TypeSafe), a language model key, or a coding agent. */
export function canSort(state: RuntimeState): boolean {
  return state.cli || state.language || state.judge;
}

/**
 * Whether Sections show. With `requireAi` off they always do (rule-only
 * Sections the user opted into). With it on they need an AI level above
 * Just mail and a runtime that can sort; null (still reading) counts as no,
 * so the nav never shows Sections that then vanish.
 */
export function sectionsShown(input: {
  requireAi: boolean;
  level: AiLevel;
  state: RuntimeState | null;
}): boolean {
  if (!input.requireAi) return true;
  if (input.level === "off") return false;
  return input.state !== null && canSort(input.state);
}

/**
 * The runtime state for the App, outside the Settings screen: read once the
 * seams are there and again whenever `refresh` changes (the App passes the
 * open screen, so a key added in Settings counts on the way back). Null
 * while reading.
 */
export function useRuntimeStateOf(seams: RuntimeSeams, refresh: unknown): RuntimeState | null {
  const [state, setState] = useState<RuntimeState | null>(null);
  const { runtimes, keys, shared } = seams;
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh re-reads on purpose
  useEffect(() => {
    let live = true;
    void readRuntimeState({ runtimes, keys, shared }).then((next) => {
      if (!live) return;
      setState((prev) =>
        prev &&
        prev.cli === next.cli &&
        prev.language === next.language &&
        prev.judge === next.judge
          ? prev
          : next,
      );
    });
    return () => {
      live = false;
    };
  }, [runtimes, keys, shared, refresh]);
  return state;
}
