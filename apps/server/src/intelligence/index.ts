// Intelligence (ADR 0009): routing, sections, briefs, LangGraph, Roles and
// the Meter behind one interface. Slice 11 shipped the Hosted runtime, the
// shared provider keys, the Meter and the Brief Task; slice 12 adds Routing
// (Groups, the classify and route Tasks, Needs a decision); slice 13 adds the
// brief policy and the background Job around it; slice 14 adds the Agent host
// (the tool server, Sessions, the Activity log and the LangGraph loop) over
// the same runtime. Slice 16 adds the Workflows module beside it: it needs
// the Agent host (the tool server, the graph) and the Agent host's tools
// need it back, so the module is made here and handed to the tool server's
// extension slot after both exist.

import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type {
  AiLevel,
  HostedState,
  IntentReading,
  IntentRequest,
  JudgeState,
  KeyProvider,
} from "@monday/shared";
import {
  HOSTED_PROVIDERS,
  HOSTED_SETTING_KEYS,
  type HostedSettings,
  resolveTaskModel,
  rolesFor,
} from "@monday/shared";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { accounts, workspaces } from "../db/schema.ts";
import { createDrafts, type Drafts } from "../drafts/index.ts";
import type { Jobs } from "../jobs/index.ts";
import type { Mailstore } from "../mailstore/index.ts";
import { readGlobalSetting, readGlobalSettings } from "../settings/read.ts";
import {
  createHttpIntegrations,
  createSdkMcpClients,
  createWorkflows,
  type Integrations,
  type McpClients,
  type WorkflowSettings,
  type Workflows,
} from "../workflows/index.ts";
import { createIntegrationSecretStore, type IntegrationSecretStore } from "../workflows/secrets.ts";
import {
  type ActivityLog,
  type AgentHost,
  type CalendarSeam,
  createActivityLog,
  createAgentHost,
  createServerToolHost,
  createSessionStore,
  type ToolExtensions,
} from "./agent/index.ts";
import { type BriefSettings, type Briefs, createBriefs } from "./brief.ts";
import { createBodyGuard, type GuardSeam, type GuardSettings } from "./guard.ts";
import { type IntentSettings, judgeIntent } from "./intent.ts";
import { createProviderKeyStore, type ProviderKeyStore } from "./keys.ts";
import { createMeter, type Meter } from "./meter.ts";
import { createOnboarding, type OnboardingSeam } from "./onboarding.ts";
import { type BriefPolicyRule, type BriefPolicySettings, createBriefPolicyRule } from "./policy.ts";
import { createRouting, type Routing, type RoutingSettings } from "./routing/index.ts";
import {
  type ChatModel,
  type ConverseModel,
  createHostedRuntime,
  type HostedRuntime,
  type JudgeModel,
  type KeysResolver,
} from "./runtime/index.ts";
import { createLangChainChat, createLangChainConverse } from "./runtime/langchain.ts";
import { type KeyValidation, validateTypeSafeKey } from "./runtime/typesafe.ts";
import { type BriefVerifier, createBriefVerifier, type VerifySettings } from "./verify.ts";
import { createVoiceBuilder, type VoiceSeam, type VoiceSettings } from "./voice.ts";

export type { WorkflowSettings, Workflows } from "../workflows/index.ts";
export {
  createFakeIntegrations,
  createFakeMcpClients,
  RunNotWaitingError,
  WORKFLOW_SCHEDULE_STEP,
  WORKFLOW_STEP_STEP,
  WORKFLOW_TRIGGER_STEP,
  WorkflowNotFoundError,
} from "../workflows/index.ts";
export type { ActivityLog, AgentHost, AgentSettings, TurnResult } from "./agent/index.ts";
export { BudgetExceededError, SessionNotFoundError, TurnBusyError } from "./agent/index.ts";
export type { BriefRequest, BriefSettings, Briefs, ThreadVersion } from "./brief.ts";
export {
  BRIEF_STEP,
  BriefNotReadyError,
  BriefOutputError,
  briefJobId,
  parseBriefOutput,
  richTextOf,
} from "./brief.ts";
export type { GuardSeam, GuardSettings, GuardVerdict } from "./guard.ts";
export { createBodyGuard } from "./guard.ts";
export type { IntentSettings } from "./intent.ts";
export { intentQuestions, intentState, judgeIntent } from "./intent.ts";
export type { ProviderKeyStore } from "./keys.ts";
export { createProviderKeyStore } from "./keys.ts";
export type { Meter } from "./meter.ts";
export { createMeter, isMonth, monthOf } from "./meter.ts";
export type { OnboardingSeam, TopSender } from "./onboarding.ts";
export { createOnboarding } from "./onboarding.ts";
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
  JudgeCall,
  JudgeModel,
  JudgeResult,
  KeysResolver,
  RunInput,
  RunOptions,
  RunResult,
} from "./runtime/index.ts";
export {
  AiOffError,
  createHostedRuntime,
  NoJudgeError,
  NoProviderKeyError,
} from "./runtime/index.ts";
export type { KeyValidation, TypeSafeErrorCode } from "./runtime/typesafe.ts";
export { createTypeSafeJudge, TypeSafeError, validateTypeSafeKey } from "./runtime/typesafe.ts";

/** The live check a pasted provider key gets before it is saved; TypeSafe has one, the others none yet. */
export type KeyValidator = (provider: KeyProvider, key: string) => Promise<KeyValidation | null>;
export type { BriefVerifier, VerifySettings } from "./verify.ts";
export { createBriefVerifier, plainText } from "./verify.ts";

export interface IntelligenceOptions {
  db: Db;
  mailstore: Mailstore;
  /** The seam under the runtime; defaults to LangChain. Tests pass a fake. */
  chat?: ChatModel;
  /** The agent loop's seam; defaults to LangChain with tools bound. Tests pass a script. */
  converse?: ConverseModel;
  /** The judge's seam (ADR 0012); the entry wires TypeSafe, tests pass a fake. Absent: judge() throws NoJudgeError. */
  judge?: JudgeModel;
  /** Validates a pasted key live; defaults to TypeSafe's models endpoint for typesafe, null for the rest. Tests pass a fake. */
  validateKey?: KeyValidator;
  /** Where the runtime's keys come from; defaults to the shared-key store. */
  keys?: KeysResolver;
  /** The brief policy seam; defaults to the rule over Settings with the model behind it. */
  policy?: BriefPolicyRule;
  /** The Drafts module the Agent's draft and send tools go through; defaults to one over `db`. */
  drafts?: Drafts;
  /** LangGraph's checkpointer; the entry passes PostgresSaver, the default keeps checkpoints in memory. */
  checkpointer?: BaseCheckpointSaver;
  /** The integrations the Workflow steps post through; HTTP by default, the fake in tests. */
  integrations?: Integrations;
  /** The MCP servers as steps; the SDK client by default, the fake in tests. */
  mcp?: McpClients;
  now?: () => Date;
  log?: (message: string) => void;
  /** The AI level; defaults to the Setting ai.level. Tests may pin it. */
  level?: () => Promise<AiLevel>;
}

export interface Intelligence {
  runtime: HostedRuntime;
  keys: ProviderKeyStore;
  meter: Meter;
  briefs: Briefs;
  policy: BriefPolicyRule;
  routing: Routing;
  agent: AgentHost;
  activity: ActivityLog;
  workflows: Workflows;
  /** The extension tools' seams; a module made after this one (external MCP, slice 19) fills its slot here. */
  extensions: ToolExtensions;
  /** What the onboarding tools act through (slice 20). */
  onboarding: OnboardingSeam;
  /** The sealed integration secrets the Workflow steps post with; the routes set and clear them. */
  integrationSecrets: IntegrationSecretStore;
  /** The Voice profile builder the build_voice_profile tool acts through. */
  voice: VoiceSeam;
  /** The guardrail on Thread text entering a turn (slice 27). */
  guard: GuardSeam;
  /** The Brief verifier (slice 27). */
  verify: BriefVerifier;
  /** The palette's typed sentence as one Judgment (slice 27). Throws NoJudgeError without a judge. */
  intent(request: IntentRequest): Promise<IntentReading>;
  /**
   * Seals what earlier versions wrote in the clear (transcripts, Voice
   * profiles, integration secrets in the Setting). Needs the root key; the
   * app runs it at boot and after every unlock until nothing is left.
   */
  sealLegacy(): Promise<{ transcripts: number; voices: number; integrations: number }>;
  /** The AI level in effect (CONTEXT.md), read from the Setting. */
  level(): Promise<AiLevel>;
  /** The runtime as /capabilities reports it. Works locked. */
  hostedState(): Promise<HostedState>;
  /** Who answers judgments on this Server now (ADR 0012). Works locked. */
  judgeState(): Promise<JudgeState>;
  /** The live check for a pasted key, run here so a client never talks to the provider; null when the provider has none. */
  validateKey(provider: KeyProvider, key: string): Promise<KeyValidation | null>;
  registerSteps(jobs: Jobs): void;
  /** Hands the calendar tools their seam (slice 18); the app calls it once the calendar module exists. */
  attachCalendar(seam: CalendarSeam): void;
}

const AGENT_SETTING_KEYS = [
  "agent.system_prompt",
  "agent.onboarding_prompt",
  "onboarding.questions_max",
  "onboarding.read_days",
  "onboarding.workflow_proposals_max",
  "onboarding.focus_view_threads",
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

const VERIFY_SETTING_KEYS = [
  "briefs.verify",
  "briefs.verify.question",
  "briefs.verify.criteria",
  "briefs.verify.confidence",
] as const;

const GUARD_SETTING_KEYS = [
  "guard.enabled",
  "guard.threshold",
  "guard.question",
  "guard.input_chars_max",
  "guard.notice",
  "guard.prompt",
] as const;

const INTENT_SETTING_KEYS = [
  "intent.contacts_max",
  "intent.question.intent",
  "intent.criteria.intent",
  "intent.question.person",
  "intent.question.group",
  "intent.question.section",
  "intent.question.weekday",
  "intent.question.hour",
  "intent.question.scope",
  "intent.question.age",
  "intent.question.kind",
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

const WORKFLOW_SETTING_KEYS = [
  "workflows.placement",
  "workflows.ask_before_enable",
  "workflows.notify_on_failure",
  "workflows.run_retention_days",
  "workflows.budget.tool_calls",
  "workflows.budget.tokens",
  "workflows.budget.minutes",
  "workflows.agentic.system_prompt",
  "workflows.step_retries",
  "workflows.trigger.routing_wait_seconds",
  "workflows.dry_run.recent",
  "workflows.silence.check_cron",
  "strings.workflows.failed_notice",
  "workflows.judged.threshold",
  "workflows.judged.question",
  "workflows.judged.input_chars_max",
] as const;

const VOICE_SETTING_KEYS = [
  "voice.sample_messages",
  "voice.excerpt_chars",
  "voice.excerpts_max",
  "voice.prompt",
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

/**
 * Who answers judgments under these Settings with these shared keys: TypeSafe
 * when a judge model is wired, Settings allow it and its key is shared; the
 * language model's prompt path (the classify Task's model) when Settings say
 * so or auto finds no key; none when Settings pin TypeSafe and no key is shared.
 */
export function judgeStateFor(
  settings: HostedSettings,
  sharedKeys: readonly string[],
  hasJudge: boolean,
): JudgeState {
  const choice = settings["ai.judge.provider"];
  const llm = (): JudgeState => ({
    provider: "llm",
    model: resolveTaskModel(settings, "classify").model,
  });
  if (choice === "llm") return llm();
  if (hasJudge && sharedKeys.includes("typesafe")) {
    return { provider: "typesafe", model: settings["ai.judge.model"] };
  }
  return choice === "auto" ? llm() : { provider: "none", model: "" };
}

export function createIntelligence(options: IntelligenceOptions): Intelligence {
  const { db, mailstore } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const keys = createProviderKeyStore(db, mailstore);
  const meter = createMeter(db, { now });
  const level = options.level ?? (() => readGlobalSetting(db, "ai.level"));
  const hostedSettings = () => readGlobalSettings(db, HOSTED_SETTING_KEYS);
  const resolveKey: KeysResolver = options.keys ?? ((provider) => keys.load(provider));
  const validateKey: KeyValidator =
    options.validateKey ??
    (async (provider, key) => {
      if (provider !== "typesafe") return null;
      const s = await hostedSettings();
      return validateTypeSafeKey(key, { baseUrl: s["ai.endpoint.typesafe"] });
    });
  const runtime = createHostedRuntime({
    chat: options.chat ?? createLangChainChat(),
    converse: options.converse ?? createLangChainConverse(),
    ...(options.judge ? { judge: options.judge } : {}),
    keys: resolveKey,
    settings: hostedSettings,
    meter,
    now: () => now().getTime(),
    level,
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
  const verify = createBriefVerifier({
    runtime,
    log,
    settings: async (): Promise<VerifySettings> => {
      const s = await readGlobalSettings(db, VERIFY_SETTING_KEYS);
      return {
        enabled: s["briefs.verify"],
        question: s["briefs.verify.question"],
        criteria: s["briefs.verify.criteria"],
        confidence: s["briefs.verify.confidence"],
      };
    },
  });
  const guardSettings = async (): Promise<GuardSettings & { prompt: string }> => {
    const s = await readGlobalSettings(db, GUARD_SETTING_KEYS);
    return {
      enabled: s["guard.enabled"],
      threshold: s["guard.threshold"],
      question: s["guard.question"],
      inputCharsMax: s["guard.input_chars_max"],
      notice: s["guard.notice"],
      prompt: s["guard.prompt"],
    };
  };
  const guard = createBodyGuard({ runtime, log, settings: guardSettings });
  const intentSettings = async (): Promise<IntentSettings> => {
    const s = await readGlobalSettings(db, INTENT_SETTING_KEYS);
    return {
      contactsMax: s["intent.contacts_max"],
      questions: {
        intent: s["intent.question.intent"],
        person: s["intent.question.person"],
        group: s["intent.question.group"],
        section: s["intent.question.section"],
        weekday: s["intent.question.weekday"],
        hour: s["intent.question.hour"],
        scope: s["intent.question.scope"],
        age: s["intent.question.age"],
        kind: s["intent.question.kind"],
      },
      intentCriteria: s["intent.criteria.intent"],
    };
  };
  const briefs = createBriefs({
    db,
    mailstore,
    runtime,
    policy,
    now,
    log,
    level,
    verify,
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
    level,
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
  const activity = createActivityLog(db, { now });
  const sessions = createSessionStore(db, { now, content: mailstore });
  // The tokens and webhook URLs live as sealed rows; the Setting only says which exist.
  const integrationSecrets = createIntegrationSecretStore(db, mailstore, { now });
  const integrations =
    options.integrations ??
    createHttpIntegrations({
      config: () => integrationSecrets.loadAll(),
      configured: () => integrationSecrets.list(),
    });
  const mcp =
    options.mcp ??
    createSdkMcpClients({
      servers: async () =>
        (await readGlobalSettings(db, ["workflows.mcp_servers"]))["workflows.mcp_servers"],
    });
  const voice = createVoiceBuilder({
    db,
    mailstore,
    drafts,
    runtime,
    now,
    settings: async (): Promise<VoiceSettings> => {
      const s = await readGlobalSettings(db, VOICE_SETTING_KEYS);
      return {
        sampleMessages: s["voice.sample_messages"],
        excerptChars: s["voice.excerpt_chars"],
        excerptsMax: s["voice.excerpts_max"],
        prompt: s["voice.prompt"],
      };
    },
  });
  // Filled once the Workflows module exists; the tool server reads it per call.
  const extensions: ToolExtensions = { integrations, mcp, voice, guard };
  const agent = createAgentHost({
    runtime,
    activity,
    sessions,
    hostFor: (workspaceId) => createServerToolHost({ db, mailstore, drafts, workspaceId, now }),
    ...(options.checkpointer ? { checkpointer: options.checkpointer } : {}),
    extensions,
    now,
    settings: async () => {
      const s = await readGlobalSettings(db, AGENT_SETTING_KEYS);
      const current = await level();
      // While screening is on, the Agent is told what the notice line means (slice 27).
      const g = await guardSettings();
      const guardLine = g.enabled && g.prompt.trim() !== "" ? `\n${g.prompt}` : "";
      return {
        systemPrompt: `${s["agent.system_prompt"]}${guardLine}`,
        level: current,
        onboardingPrompt: s["agent.onboarding_prompt"]
          .replaceAll("{level}", current)
          .replaceAll("{questions}", String(s["onboarding.questions_max"]))
          .replaceAll("{days}", String(s["onboarding.read_days"]))
          .replaceAll("{workflows}", String(s["onboarding.workflow_proposals_max"]))
          .replaceAll("{focus}", String(s["onboarding.focus_view_threads"])),
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

  const workflows = createWorkflows({
    db,
    mailstore,
    runtime,
    agent,
    activity,
    integrations,
    mcp,
    now,
    log,
    level,
    settings: async (): Promise<WorkflowSettings> => {
      const s = await readGlobalSettings(db, WORKFLOW_SETTING_KEYS);
      return {
        placement: s["workflows.placement"],
        askBeforeEnable: s["workflows.ask_before_enable"],
        notifyOnFailure: s["workflows.notify_on_failure"],
        retentionDays: s["workflows.run_retention_days"],
        budget: {
          calls: s["workflows.budget.tool_calls"],
          tokens: s["workflows.budget.tokens"],
          minutes: s["workflows.budget.minutes"],
        },
        agenticSystemPrompt: s["workflows.agentic.system_prompt"],
        stepRetries: s["workflows.step_retries"],
        routingWaitSeconds: s["workflows.trigger.routing_wait_seconds"],
        dryRunRecent: s["workflows.dry_run.recent"],
        silenceCheckCron: s["workflows.silence.check_cron"],
        failedNotice: s["strings.workflows.failed_notice"],
        judged: {
          threshold: s["workflows.judged.threshold"],
          question: s["workflows.judged.question"],
          inputCharsMax: s["workflows.judged.input_chars_max"],
        },
      };
    },
  });
  extensions.workflows = workflows;
  const onboarding = createOnboarding({ db, routing, workflows, level });
  extensions.onboarding = onboarding;

  return {
    attachCalendar(seam) {
      extensions.calendar = seam;
    },
    runtime,
    keys,
    meter,
    briefs,
    policy,
    routing,
    agent,
    activity,
    workflows,
    extensions,
    onboarding,
    integrationSecrets,
    voice,
    guard,
    verify,
    intent: async (request) => judgeIntent(runtime, request, await intentSettings()),
    level,
    async sealLegacy() {
      let transcripts = 0;
      // Bounded: one pass moves at most 500 rows per call, and the loop stops when a call moves none.
      for (let round = 0; round < 200; round++) {
        const moved = await sessions.sealLegacy(500);
        transcripts += moved;
        if (moved === 0) break;
      }
      const voices = await drafts.sealLegacyVoices();
      const first = await db.query.workspaces.findFirst({ orderBy: asc(workspaces.createdAt) });
      const integrations = first ? await integrationSecrets.adopt(first.id) : 0;
      return { transcripts, voices, integrations };
    },
    async hostedState() {
      const settings = await hostedSettings();
      const roles = Object.fromEntries(
        HOSTED_PROVIDERS.map((p) => [p, rolesFor(settings, p)]),
      ) as HostedState["roles"];
      const shared = await keys.list();
      return {
        provider: settings["ai.hosted.provider"],
        roles,
        sharedKeys: shared,
        judge: judgeStateFor(settings, shared, options.judge !== undefined),
      };
    },
    async judgeState() {
      return judgeStateFor(await hostedSettings(), await keys.list(), options.judge !== undefined);
    },
    validateKey,
    registerSteps(jobs) {
      briefs.registerSteps(jobs);
      routing.registerSteps(jobs);
      workflows.registerSteps(jobs);
    },
  };
}
