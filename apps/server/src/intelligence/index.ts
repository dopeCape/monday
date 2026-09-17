// Intelligence (ADR 0009): routing, sections, briefs, LangGraph, Roles and
// the Meter behind one interface. This slice ships the Hosted runtime, the
// shared provider keys, the Meter and the Brief Task; routing and the agent
// loop come in later slices and plug into the same runtime.

import type { HostedState } from "@monday/shared";
import { HOSTED_PROVIDERS, HOSTED_SETTING_KEYS, rolesFor } from "@monday/shared";
import type { Db } from "../db/client.ts";
import type { Jobs } from "../jobs/index.ts";
import type { Mailstore } from "../mailstore/index.ts";
import { readGlobalSettings } from "../settings/read.ts";
import { type BriefSettings, type Briefs, createBriefs } from "./brief.ts";
import { createProviderKeyStore, type ProviderKeyStore } from "./keys.ts";
import { createMeter, type Meter } from "./meter.ts";
import {
  type ChatModel,
  createHostedRuntime,
  type HostedRuntime,
  type KeysResolver,
} from "./runtime/index.ts";
import { createLangChainChat } from "./runtime/langchain.ts";

export type { BriefSettings, Briefs } from "./brief.ts";
export { BRIEF_STEP, BriefOutputError, parseBriefOutput, richTextOf } from "./brief.ts";
export type { ProviderKeyStore } from "./keys.ts";
export { createProviderKeyStore } from "./keys.ts";
export type { Meter } from "./meter.ts";
export { createMeter, isMonth, monthOf } from "./meter.ts";
export type {
  ChatCall,
  ChatModel,
  ChatResponse,
  HostedRuntime,
  KeysResolver,
  RunInput,
  RunOptions,
  RunResult,
} from "./runtime/index.ts";
export { createHostedRuntime, NoProviderKeyError } from "./runtime/index.ts";

export interface IntelligenceOptions {
  db: Db;
  mailstore: Mailstore;
  /** The seam under the runtime; defaults to LangChain. Tests pass a fake. */
  chat?: ChatModel;
  /** Where the runtime's keys come from; defaults to the shared-key store. */
  keys?: KeysResolver;
  now?: () => Date;
}

export interface Intelligence {
  runtime: HostedRuntime;
  keys: ProviderKeyStore;
  meter: Meter;
  briefs: Briefs;
  /** The runtime as /capabilities reports it. Works locked. */
  hostedState(): Promise<HostedState>;
  registerSteps(jobs: Jobs): void;
}

const BRIEF_SETTING_KEYS = [
  "briefs.bullets_max",
  "briefs.actions_max",
  "briefs.input_chars_max",
] as const;

export function createIntelligence(options: IntelligenceOptions): Intelligence {
  const { db, mailstore } = options;
  const now = options.now ?? (() => new Date());
  const keys = createProviderKeyStore(db, mailstore);
  const meter = createMeter(db, { now });
  const hostedSettings = () => readGlobalSettings(db, HOSTED_SETTING_KEYS);
  const runtime = createHostedRuntime({
    chat: options.chat ?? createLangChainChat(),
    keys: options.keys ?? ((provider) => keys.load(provider)),
    settings: hostedSettings,
    meter,
    now: () => now().getTime(),
  });
  const briefs = createBriefs({
    db,
    mailstore,
    runtime,
    now,
    settings: async (): Promise<BriefSettings> => {
      const s = await readGlobalSettings(db, BRIEF_SETTING_KEYS);
      return {
        bulletsMax: s["briefs.bullets_max"],
        actionsMax: s["briefs.actions_max"],
        inputCharsMax: s["briefs.input_chars_max"],
      };
    },
  });

  return {
    runtime,
    keys,
    meter,
    briefs,
    async hostedState() {
      const settings = await hostedSettings();
      const roles = Object.fromEntries(
        HOSTED_PROVIDERS.map((p) => [p, rolesFor(settings, p)]),
      ) as HostedState["roles"];
      return {
        provider: settings["ai.hosted.provider"],
        roles,
        sharedKeys: await keys.list(),
      };
    },
    registerSteps(jobs) {
      briefs.registerSteps(jobs);
    },
  };
}
