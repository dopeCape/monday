// Intelligence (ADR 0009): routing, sections, briefs, LangGraph, Roles and
// the Meter behind one interface. Slice 11 shipped the Hosted runtime, the
// shared provider keys, the Meter and the Brief Task; slice 12 adds Routing
// (Groups, the classify and route Tasks, Needs a decision); slice 13 adds the
// brief policy and the background Job around it; slice 14 adds the Agent host
// (the tool server, Sessions, the Activity log and the LangGraph loop) over
// the same runtime.

import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { HostedState } from "@monday/shared";
import { HOSTED_PROVIDERS, HOSTED_SETTING_KEYS, rolesFor } from "@monday/shared";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { accounts, workspaces } from "../db/schema.ts";
import { createDrafts, type Drafts } from "../drafts/index.ts";
import type { Jobs } from "../jobs/index.ts";
import type { Mailstore } from "../mailstore/index.ts";
import { readGlobalSettings } from "../settings/read.ts";
import {
  type AgentHost,
  createActivityLog,
  createAgentHost,
  createServerToolHost,
  createSessionStore,
} from "./agent/index.ts";
import { type BriefSettings, type Briefs, createBriefs } from "./brief.ts";
import { createProviderKeyStore, type ProviderKeyStore } from "./keys.ts";
import { createMeter, type Meter } from "./meter.ts";
import { type BriefPolicyRule, type BriefPolicySettings, createBriefPolicyRule } from "./policy.ts";
import { createRouting, type Routing, type RoutingSettings } from "./routing/index.ts";
import {
  type ChatModel,
  type ConverseModel,
  createHostedRuntime,
  type HostedRuntime,
  type KeysResolver,
} from "./runtime/index.ts";
import { createLangChainChat, createLangChainConverse } from "./runtime/langchain.ts";

export type { AgentHost, AgentSettings, TurnResult } from "./agent/index.ts";
export { SessionNotFoundError, TurnBusyError } from "./agent/index.ts";
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
  AgentMessage,
  AgentToolCall,
  ChatCall,
  ChatModel,
  ChatResponse,
  ConverseCall,
  ConverseModel,
  ConverseResponse,
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
  /** The agent loop's seam; defaults to LangChain with tools bound. Tests pass a script. */
  converse?: ConverseModel;
  /** Where the runtime's keys come from; defaults to the shared-key store. */
  keys?: KeysResolver;
  /** The brief policy seam; defaults to the rule over Settings with the model behind it. */
  policy?: BriefPolicyRule;
  /** The Drafts module the Agent's draft and send tools go through; defaults to one over `db`. */
  drafts?: Drafts;
  /** LangGraph's checkpointer; the entry passes PostgresSaver, the default keeps checkpoints in memory. */
  checkpointer?: BaseCheckpointSaver;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface Intelligence {
  runtime: HostedRuntime;
  keys: ProviderKeyStore;
  meter: Meter;
  briefs: Briefs;
  policy: BriefPolicyRule;
  routing: Routing;
  agent: AgentHost;
  /** The runtime as /capabilities reports it. Works locked. */
  hostedState(): Promise<HostedState>;
  registerSteps(jobs: Jobs): void;
}

const AGENT_SETTING_KEYS = [
  "agent.system_prompt",
  "agent.preview_above",
  "agent.always_ask",
  "agent.max_steps",
  "agent.search_limit",
] as const;

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
  const log = options.log ?? (() => {});
  const keys = createProviderKeyStore(db, mailstore);
  const meter = createMeter(db, { now });
  const hostedSettings = () => readGlobalSettings(db, HOSTED_SETTING_KEYS);
  const resolveKey: KeysResolver = options.keys ?? ((provider) => keys.load(provider));
  const runtime = createHostedRuntime({
    chat: options.chat ?? createLangChainChat(),
    converse: options.converse ?? createLangChainConverse(),
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

  const drafts = options.drafts ?? createDrafts({ db, mailstore, now });
  const agent = createAgentHost({
    runtime,
    activity: createActivityLog(db, { now }),
    sessions: createSessionStore(db, { now }),
    hostFor: (workspaceId) => createServerToolHost({ db, mailstore, drafts, workspaceId, now }),
    ...(options.checkpointer ? { checkpointer: options.checkpointer } : {}),
    now,
    settings: async () => {
      const s = await readGlobalSettings(db, AGENT_SETTING_KEYS);
      return {
        systemPrompt: s["agent.system_prompt"],
        previewAbove: s["agent.preview_above"],
        alwaysAsk: s["agent.always_ask"],
        maxSteps: s["agent.max_steps"],
        searchLimit: s["agent.search_limit"],
      };
    },
    workspaceAddress: async (workspaceId) => {
      const rows = await db
        .select({ address: accounts.address })
        .from(workspaces)
        .innerJoin(accounts, eq(accounts.id, workspaces.accountId))
        .where(eq(workspaces.id, workspaceId));
      return rows[0]?.address ?? workspaceId;
    },
  });

  return {
    runtime,
    keys,
    meter,
    briefs,
    policy,
    routing,
    agent,
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
