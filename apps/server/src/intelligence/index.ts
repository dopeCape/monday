// Intelligence (ADR 0009): routing, sections, briefs, LangGraph, Roles and
// the Meter behind one interface. Slice 11 shipped the Hosted runtime, the
// shared provider keys, the Meter and the Brief Task; slice 12 adds Routing
// (Groups, the classify and route Tasks, Needs a decision). The agent loop
// comes later and plugs into the same runtime.

import type { HostedState } from "@monday/shared";
import { HOSTED_PROVIDERS, HOSTED_SETTING_KEYS, rolesFor } from "@monday/shared";
import type { Db } from "../db/client.ts";
import type { Jobs } from "../jobs/index.ts";
import type { Mailstore } from "../mailstore/index.ts";
import { readGlobalSettings } from "../settings/read.ts";
import { type BriefSettings, type Briefs, createBriefs } from "./brief.ts";
import { createProviderKeyStore, type ProviderKeyStore } from "./keys.ts";
import { createMeter, type Meter } from "./meter.ts";
import { createRouting, type Routing, type RoutingSettings } from "./routing/index.ts";
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
  RouteJobPayload,
  Routing,
  RoutingCallOptions,
  RoutingSettings,
  Scored,
} from "./routing/index.ts";
export {
  ClassifyOutputError,
  createRouting,
  GroupNestingError,
  ROUTE_STEP,
} from "./routing/index.ts";
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
  log?: (message: string) => void;
}

export interface Intelligence {
  runtime: HostedRuntime;
  keys: ProviderKeyStore;
  meter: Meter;
  briefs: Briefs;
  routing: Routing;
  /** The runtime as /capabilities reports it. Works locked. */
  hostedState(): Promise<HostedState>;
  registerSteps(jobs: Jobs): void;
}

const BRIEF_SETTING_KEYS = [
  "briefs.bullets_max",
  "briefs.actions_max",
  "briefs.input_chars_max",
] as const;

const ROUTING_SETTING_KEYS = [
  "routing.threshold.route",
  "routing.threshold.ask",
  "routing.threshold.tie_margin",
  "routing.decisions.cap",
  "routing.learn_from_corrections",
  "routing.on_arrival",
  "routing.predicate_first",
  "routing.default_group",
  "routing.classify.snippet_chars",
  "routing.examples_in_prompt",
  "routing.rerun.recent",
  "routing.lookback_days",
  "routing.brief_policy.default",
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

  const routing = createRouting({
    db,
    mailstore,
    runtime,
    now,
    ...(options.log ? { log: options.log } : {}),
    settings: async (): Promise<RoutingSettings> => {
      const s = await readGlobalSettings(db, ROUTING_SETTING_KEYS);
      return {
        thresholds: {
          route: s["routing.threshold.route"],
          ask: s["routing.threshold.ask"],
          tieMargin: s["routing.threshold.tie_margin"],
        },
        decisionsCap: s["routing.decisions.cap"],
        learnFromCorrections: s["routing.learn_from_corrections"],
        onArrival: s["routing.on_arrival"],
        predicateFirst: s["routing.predicate_first"],
        defaultGroup: s["routing.default_group"],
        snippetChars: s["routing.classify.snippet_chars"],
        examplesInPrompt: s["routing.examples_in_prompt"],
        rerunRecent: s["routing.rerun.recent"],
        lookbackDays: s["routing.lookback_days"],
        briefPolicyDefault: s["routing.brief_policy.default"],
      };
    },
  });

  return {
    runtime,
    keys,
    meter,
    briefs,
    routing,
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
      routing.registerSteps(jobs);
    },
  };
}
