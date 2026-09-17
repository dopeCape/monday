// Intelligence (ADR 0009): routing, sections, briefs, LangGraph, Roles and
// the Meter behind one interface. Slice 11 shipped the Hosted runtime, the
// shared provider keys, the Meter and the Brief Task; slice 13 adds the brief
// policy and the background Job around it. Routing and the agent loop come
// in their own slices and plug into the same runtime.

import type { HostedState } from "@monday/shared";
import { HOSTED_PROVIDERS, HOSTED_SETTING_KEYS, rolesFor } from "@monday/shared";
import type { Db } from "../db/client.ts";
import type { Jobs } from "../jobs/index.ts";
import type { Mailstore } from "../mailstore/index.ts";
import { readGlobalSettings } from "../settings/read.ts";
import { type BriefSettings, type Briefs, createBriefs } from "./brief.ts";
import { createProviderKeyStore, type ProviderKeyStore } from "./keys.ts";
import { createMeter, type Meter } from "./meter.ts";
import { type BriefPolicyRule, type BriefPolicySettings, createBriefPolicyRule } from "./policy.ts";
import {
  type ChatModel,
  createHostedRuntime,
  type HostedRuntime,
  type KeysResolver,
} from "./runtime/index.ts";
import { createLangChainChat } from "./runtime/langchain.ts";

export type { BriefRequest, BriefSettings, Briefs, ThreadVersion } from "./brief.ts";
export {
  BRIEF_STEP,
  BriefNotReadyError,
  BriefOutputError,
  briefJobId,
  parseBriefOutput,
  richTextOf,
} from "./brief.ts";
export type { ProviderKeyStore } from "./keys.ts";
export { createProviderKeyStore } from "./keys.ts";
export type { Meter } from "./meter.ts";
export { createMeter, isMonth, monthOf } from "./meter.ts";
export type { BriefPolicyRule, BriefPolicySettings, BriefThreadFacts } from "./policy.ts";
export { createBriefPolicyRule, rulePolicy, shouldCompute } from "./policy.ts";
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
  /** The brief policy seam; defaults to the rule over Settings with the model behind it. */
  policy?: BriefPolicyRule;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface Intelligence {
  runtime: HostedRuntime;
  keys: ProviderKeyStore;
  meter: Meter;
  briefs: Briefs;
  policy: BriefPolicyRule;
  /** The runtime as /capabilities reports it. Works locked. */
  hostedState(): Promise<HostedState>;
  registerSteps(jobs: Jobs): void;
}

const BRIEF_SETTING_KEYS = [
  "briefs.bullets_max",
  "briefs.actions_max",
  "briefs.input_chars_max",
] as const;

const POLICY_SETTING_KEYS = [
  "briefs.policy_mode",
  "briefs.policy_default",
  "briefs.policy_groups",
  "briefs.prompt",
  "briefs.background",
  "briefs.background_lookback_days",
  "briefs.skip_under_words",
  "briefs.fyi_min_messages",
  "briefs.fyi_min_words",
  "briefs.automated_senders",
] as const;

export function createIntelligence(options: IntelligenceOptions): Intelligence {
  const { db, mailstore } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const keys = createProviderKeyStore(db, mailstore);
  const meter = createMeter(db, { now });
  const hostedSettings = () => readGlobalSettings(db, HOSTED_SETTING_KEYS);
  const resolveKey: KeysResolver = options.keys ?? ((provider) => keys.load(provider));
  const runtime = createHostedRuntime({
    chat: options.chat ?? createLangChainChat(),
    keys: resolveKey,
    settings: hostedSettings,
    meter,
    now: () => now().getTime(),
  });
  const policySettings = async (): Promise<BriefPolicySettings> => {
    const s = await readGlobalSettings(db, POLICY_SETTING_KEYS);
    return {
      mode: s["briefs.policy_mode"],
      defaultPolicy: s["briefs.policy_default"],
      groups: s["briefs.policy_groups"],
      prompt: s["briefs.prompt"],
      background: s["briefs.background"],
      lookbackDays: s["briefs.background_lookback_days"],
      skipUnderWords: s["briefs.skip_under_words"],
      fyiMinMessages: s["briefs.fyi_min_messages"],
      fyiMinWords: s["briefs.fyi_min_words"],
      automatedSenders: s["briefs.automated_senders"],
    };
  };
  const policy =
    options.policy ?? createBriefPolicyRule({ settings: policySettings, runtime, log });
  const briefs = createBriefs({
    db,
    mailstore,
    runtime,
    policy,
    now,
    log,
    settings: async (): Promise<BriefSettings> => {
      const s = await readGlobalSettings(db, BRIEF_SETTING_KEYS);
      return {
        bulletsMax: s["briefs.bullets_max"],
        actionsMax: s["briefs.actions_max"],
        inputCharsMax: s["briefs.input_chars_max"],
      };
    },
    policySettings,
    // A locked Server or one without the provider's key computes no Brief.
    keyAvailable: async () => {
      try {
        const choice = await runtime.resolve("brief");
        return (await resolveKey(choice.provider)) !== null;
      } catch {
        return false;
      }
    },
  });

  return {
    runtime,
    keys,
    meter,
    briefs,
    policy,
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
