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

import type {
  AiLevel,
  HostedProvider,
  HostedState,
  IntentReading,
  IntentRequest,
  JudgeState,
  KeyProvider,
  LocalCli,
  Task,
} from "@monday/shared";
import {
  HOSTED_PROVIDERS,
  HOSTED_SETTING_KEYS,
  type HostedSettings,
  priceFor,
  pricingFor,
  resolveTaskModel,
  rolesFor,
  scopeWordsFrom,
} from "@monday/shared";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { accounts, workspaces } from "../db/schema.ts";
import { createDrafts, type Drafts } from "../drafts/index.ts";
import type { Jobs } from "../jobs/index.ts";
import type { Mailstore } from "../mailstore/index.ts";
import { readGlobalSetting, readGlobalSettings } from "../settings/read.ts";
import { createViewStore } from "../views/index.ts";
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
import { createRecommendations, type Recommendations } from "./actions/recommend.ts";
import { type Fetch, oneClick } from "./actions/unsubscribe.ts";
import {
  type ActivityLog,
  type AgentHost,
  type CalendarSeam,
  type CheckpointerSource,
  createActivityLog,
  createAgentHost,
  createServerToolHost,
  createSessionStore,
  type ToolExtensions,
} from "./agent/index.ts";
import { type BriefSettings, type Briefs, createBriefs } from "./brief.ts";
import { type ComposeAssist, createComposeAssist } from "./compose-assist.ts";
import { createBodyGuard, type GuardSeam, type GuardSettings } from "./guard.ts";
import { type IntentSettings, judgeIntent } from "./intent.ts";
import { createJudgments, type JudgmentSettings, type Judgments } from "./judgments.ts";
import { createProviderKeyStore, type ProviderKeyStore } from "./keys.ts";
import { type BatchingEval, createBatchingEval } from "./measure/index.ts";
import { createDbMeetingSource, createDbMeetingStore, recordMeeting } from "./meetings/db.ts";
import { createMeetings, type Meetings } from "./meetings/index.ts";
import { MEETING_SETTING_KEYS, meetingSettingsFrom } from "./meetings/settings.ts";
import { createMeter, type Meter } from "./meter.ts";
import { createOnboarding, type OnboardingSeam } from "./onboarding.ts";
import { createOrganize, type OrganizeSeam } from "./organize.ts";
import { type BriefPolicyRule, type BriefPolicySettings, createBriefPolicyRule } from "./policy.ts";
import { type Backlog, type BacklogStepSettings, createBacklog } from "./routing/backlog.ts";
import { createRouting, type Routing, type RoutingSettings } from "./routing/index.ts";
import { createDemoChat, createDemoConverse, withDemoKey } from "./runtime/demo.ts";
import {
  type ChatModel,
  type ConverseModel,
  createHostedRuntime,
  type HostedRuntime,
  type JudgeModel,
  type KeysResolver,
} from "./runtime/index.ts";
import { lazyLangChainChat, lazyLangChainConverse } from "./runtime/langchain-lazy.ts";
import {
  LOCAL_CLI_LABEL,
  type LocalBridge,
  type LocalLanguageModel,
  localLanguageModel,
} from "./runtime/local.ts";
import { type KeyValidation, validateTypeSafeKey } from "./runtime/typesafe.ts";
import { createSignalBackfills, type SignalBackfills } from "./signals/backfill.ts";
import { backgroundBudget } from "./signals/budget.ts";
import { createSignals, type Signals } from "./signals/index.ts";
import { createJudgeLimiter, type JudgeLimiter, type LimiterSettings } from "./signals/limiter.ts";
import { createTemplateIntelligence, type TemplateIntelligence } from "./templates/index.ts";
import { createTune } from "./tune.ts";
import { type BriefVerifier, createBriefVerifier, type VerifySettings } from "./verify.ts";
import { createViewIntelligence, type ViewIntelligence } from "./views/index.ts";
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
export type {
  JudgeJobPayload,
  JudgmentFacts,
  JudgmentQuestionSettings,
  JudgmentSettings,
  Judgments,
} from "./judgments.ts";
export {
  createJudgments,
  JUDGE_STEP,
  judgeJobId,
  judgmentQuestions,
  judgmentState,
  readJudgments,
} from "./judgments.ts";
export type { ProviderKeyStore } from "./keys.ts";
export { createProviderKeyStore } from "./keys.ts";
export type {
  MeetingJobPayload,
  MeetingSettings,
  MeetingStore,
  Meetings,
  MeetingThread,
  MeetingThreadSource,
} from "./meetings/index.ts";
export {
  createMeetings,
  MEETING_STEP,
  MeetingThreadNotFoundError,
  meetingJobId,
} from "./meetings/index.ts";
export { MEETING_SETTING_KEYS, meetingSettingsFrom } from "./meetings/settings.ts";
export type { Meter } from "./meter.ts";
export { createMeter, isMonth, monthOf } from "./meter.ts";
export type { OnboardingSeam, TopSender } from "./onboarding.ts";
export { createOnboarding } from "./onboarding.ts";
export type { OrganizeSeam, SectionCount, SectionJudgmentView } from "./organize.ts";
export { createOrganize } from "./organize.ts";
export type {
  BriefPolicyRule,
  BriefPolicySettings,
  BriefThreadFacts,
  JudgePolicySettings,
} from "./policy.ts";
export { createBriefPolicyRule, judgedPolicy, rulePolicy, shouldCompute } from "./policy.ts";
export type { Backlog, BacklogJobPayload, BacklogStart } from "./routing/backlog.ts";
export { BACKLOG_STEP, backlogJobId, createBacklog } from "./routing/backlog.ts";
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
export type { LocalBridge, LocalCompletion, LocalLanguageModel } from "./runtime/local.ts";
export {
  createLocalBridge,
  LocalRuntimeError,
  LocalRuntimeTimeoutError,
  localLanguageModel,
} from "./runtime/local.ts";
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
  /** LangGraph's checkpointer; the entry passes a loader for PostgresSaver, the default keeps checkpoints in memory. */
  checkpointer?: CheckpointerSource;
  /** The integrations the Workflow steps post through; HTTP by default, the fake in tests. */
  integrations?: Integrations;
  /** The MCP servers as steps; the SDK client by default, the fake in tests. */
  mcp?: McpClients;
  now?: () => Date;
  log?: (message: string) => void;
  /** The AI level; defaults to the Setting ai.level. Tests may pin it. */
  level?: () => Promise<AiLevel>;
  /** The judge's limiter; defaults to one over the signals.rate Settings. Tests pass one with a fake clock. */
  limiter?: JudgeLimiter;
  /**
   * Where a Device's Local runtime takes background work (runtime/local.ts):
   * the Sidecar makes one; a Server no client drives has none.
   */
  localBridge?: LocalBridge | undefined;
  /**
   * The browser demo's scripted assistant (runtime/demo.ts), for MONDAY_DEMO=1
   * only: a placeholder key for this provider behind every shared-key read,
   * and calls carrying it answered by the script instead of a model.
   */
  demo?: { provider: HostedProvider } | undefined;
  /** The network for an unsubscribe's RFC 8058 POST; tests pass a fake list server. */
  fetch?: Fetch | undefined;
}

export interface Intelligence {
  runtime: HostedRuntime;
  /** The Local runtime's line to the client, on a Server that has one (the Sidecar). */
  localBridge: LocalBridge | null;
  keys: ProviderKeyStore;
  meter: Meter;
  briefs: Briefs;
  policy: BriefPolicyRule;
  /** The arrival request and its stored answers (slice 25), read from the Signal store since slice 30. */
  judgments: Judgments;
  /** The Signal store and the Signal request (ADR 0014, slice 30). */
  signals: Signals;
  /** The Recommended actions (docs/spec/actions.md, slices 34 and 35). */
  recommendations: Recommendations;
  /** The background read of new and reworded Signals (slice 31). */
  signalBackfills: SignalBackfills;
  /** The one limiter every judge request passes (slice 31). */
  limiter: JudgeLimiter;
  routing: Routing;
  /** The Backlog sort: the mail already there, sorted in the background within a Sort scope. */
  backlog: Backlog;
  agent: AgentHost;
  activity: ActivityLog;
  workflows: Workflows;
  /** The extension tools' seams; a module made after this one (external MCP, slice 19) fills its slot here. */
  extensions: ToolExtensions;
  /** What the onboarding tools act through (slice 20). */
  onboarding: OnboardingSeam;
  /** Sections, Groups and custom actions from a sentence, and the judged Sections (slice 26). */
  organize: OrganizeSeam;
  /** The sealed integration secrets the Workflow steps post with; the routes set and clear them. */
  integrationSecrets: IntegrationSecretStore;
  /** The Voice profile builder the build_voice_profile tool acts through. */
  voice: VoiceSeam;
  /** The composer's writing assist (rewrite, grammar, translate, continue, a free instruction). */
  composeAssist: ComposeAssist;
  /** The guardrail on Thread text entering a turn (slice 27). */
  guard: GuardSeam;
  /** Templates, their Placeholders filled from a Thread, and what the judge adds (slices 36 to 38). */
  templates: TemplateIntelligence;
  /** Views (docs/spec/views.md, slices 39 and 40): the store, the Agent's drafts and their tests. */
  views: ViewIntelligence;
  /** The Brief verifier (slice 27). */
  verify: BriefVerifier;
  /** The batching measurement (slice 28), Sidecar only; its route checks where it runs. */
  batchingEval: BatchingEval;
  /** The palette's typed sentence as one Judgment (slice 27). Throws NoJudgeError without a judge. */
  intent(request: IntentRequest): Promise<IntentReading>;
  /** Meetings from mail (docs/spec/meetings.md): the meeting request, the chips' options and their replies. */
  meetings: Meetings;
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

const BRIEF_SETTING_KEYS = ["briefs.bullets_max", "briefs.input_chars_max"] as const;

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

const JUDGMENT_SETTING_KEYS = [
  "judgments.on_arrival",
  "judgments.questions.needs_reply",
  "judgments.questions.waiting_on_others",
  "judgments.questions.newsletter",
  "judgments.questions.automated",
  "judgments.questions.brief_worth",
  "judgments.questions.brief_worth_levels",
  "judgments.questions.urgency",
  "judgments.questions.urgency_levels",
  "routing.classify.snippet_chars",
] as const;

const POLICY_SETTING_KEYS = [
  "briefs.policy_mode",
  "briefs.judge.always_at_least",
  "briefs.judge.never_below",
  "briefs.judge.newsletter_at_least",
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
  "workflows.local_wait_seconds",
  "strings.workflows.waiting_local",
  "workflows.trigger.routing_wait_seconds",
  "workflows.dry_run.recent",
  "workflows.silence.check_cron",
  "strings.workflows.failed_notice",
  "workflows.judged.threshold",
  "workflows.judged.question",
  "workflows.judged.input_chars_max",
  "signals.backfill.concurrency",
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
  "routing.rerun.concurrency",
  "routing.lookback_days",
  "routing.brief_policy.default",
  "routing.judge.instructions",
  "routing.judge.none_option",
  "routing.wait_seconds",
  "routing.rerun.scope",
  "routing.rerun.preview_max",
  "routing.rerun.sample",
  "routing.backfill.batch_size",
  "routing.backfill.request_tokens",
  "routing.backfill.state_tokens",
  "routing.backfill.llm_batch_size",
  "routing.backfill.concurrency",
  "routing.backfill.sync_wait_seconds",
] as const;

const BACKLOG_TOOL_SETTING_KEYS = [
  "routing.backfill.scope",
  "routing.backfill.sample",
  "strings.routing.scope.latest",
  "strings.routing.scope.latest_one",
  "strings.routing.scope.last",
  "strings.routing.scope.last_one",
  "strings.routing.scope.since",
  "strings.routing.scope.all",
  "strings.routing.scope.unit.day",
  "strings.routing.scope.unit.days",
  "strings.routing.scope.unit.week",
  "strings.routing.scope.unit.weeks",
  "strings.routing.scope.unit.month",
  "strings.routing.scope.unit.months",
  "strings.routing.scope.unit.year",
  "strings.routing.scope.unit.years",
] as const;

/**
 * Who answers judgments under these Settings with these shared keys and this
 * Local runtime (ADR 0012): TypeSafe when a judge model is wired, Settings
 * allow it and its key is shared; otherwise, when Settings say auto or llm,
 * the language model the user actually has: a connected Device's Local
 * runtime that takes the classify Task, else the classify Task's Hosted
 * provider when its key is shared. Never a Hosted provider with no key: with
 * nothing to answer, `none`, and routing waits instead of failing.
 */
export function judgeStateFor(
  settings: HostedSettings,
  sharedKeys: readonly string[],
  hasJudge: boolean,
  local: LocalCli | null = null,
): JudgeState {
  const choice = settings["ai.judge.provider"];
  const none: JudgeState = { provider: "none", model: "" };
  const llm = (): JudgeState => {
    if (local) return { provider: "llm", model: LOCAL_CLI_LABEL[local], runtime: "local" };
    const hosted = resolveTaskModel(settings, "classify");
    return sharedKeys.includes(hosted.provider)
      ? { provider: "llm", model: hosted.model, runtime: "hosted" }
      : none;
  };
  if (choice === "llm") return llm();
  if (hasJudge && sharedKeys.includes("typesafe")) {
    return { provider: "typesafe", model: settings["ai.judge.model"] };
  }
  return choice === "auto" ? llm() : none;
}

export function createIntelligence(options: IntelligenceOptions): Intelligence {
  const { db, mailstore } = options;
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const stored = createProviderKeyStore(db, mailstore);
  const keys = options.demo ? withDemoKey(stored, options.demo.provider) : stored;
  const meter = createMeter(db, { now });
  const level = options.level ?? (() => readGlobalSetting(db, "ai.level"));
  const hostedSettings = () => readGlobalSettings(db, HOSTED_SETTING_KEYS);
  const demoChat = (real: ChatModel) => (options.demo ? createDemoChat(real) : real);
  const demoConverse = (real: ConverseModel) => (options.demo ? createDemoConverse(real) : real);
  const resolveKey: KeysResolver = options.keys ?? ((provider) => keys.load(provider));
  const validateKey: KeyValidator =
    options.validateKey ??
    (async (provider, key) => {
      if (provider !== "typesafe") return null;
      const s = await hostedSettings();
      return validateTypeSafeKey(key, { baseUrl: s["ai.endpoint.typesafe"] });
    });
  const local: LocalLanguageModel | undefined = options.localBridge
    ? localLanguageModel(
        options.localBridge,
        async (): Promise<readonly Task[]> => readGlobalSetting(db, "ai.local.background.tasks"),
      )
    : undefined;
  // Every judge request passes one limiter: its Settings are read at most every few seconds.
  let limiterCache: { at: number; value: LimiterSettings } | null = null;
  const limiter =
    options.limiter ??
    createJudgeLimiter({
      settings: async () => {
        const at = Date.now();
        if (limiterCache && at - limiterCache.at < 5000) return limiterCache.value;
        const s = await readGlobalSettings(db, [
          "signals.rate.requests_per_minute",
          "signals.rate.cooldown_seconds",
          "signals.rate.arrival_reserve_per_minute",
          "signals.backfill.concurrency",
        ] as const);
        limiterCache = {
          at,
          value: {
            requestsPerMinute: s["signals.rate.requests_per_minute"],
            cooldownSeconds: s["signals.rate.cooldown_seconds"],
            arrivalReservePerMinute: s["signals.rate.arrival_reserve_per_minute"],
            concurrency: s["signals.backfill.concurrency"],
          },
        };
        return limiterCache.value;
      },
    });
  const runtime = createHostedRuntime({
    limiter,
    ...(local ? { local } : {}),
    chat: demoChat(options.chat ?? lazyLangChainChat()),
    converse: demoConverse(options.converse ?? lazyLangChainConverse()),
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
      judge: {
        alwaysAtLeast: s["briefs.judge.always_at_least"],
        neverBelow: s["briefs.judge.never_below"],
        newsletterAtLeast: s["briefs.judge.newsletter_at_least"],
      },
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
  const viewStore = createViewStore({ db, mailstore, now });
  const signals = createSignals({
    db,
    mailstore,
    runtime,
    now,
    log,
    level,
    viewSignals: (workspaceId) => viewStore.signalsWanted(workspaceId),
  });
  const views = createViewIntelligence({
    db,
    mailstore,
    runtime,
    signals,
    store: viewStore,
    now,
    log,
    level,
  });
  // Recommended actions follow every Signal request (docs/spec/actions.md).
  const recommendations = createRecommendations({
    db,
    mailstore,
    signals,
    now,
    log,
    level,
    // The calendar, the Workflows and the Activity log are made below; read them when asked.
    calendar: () => extensions.calendar ?? null,
    workflows: () => extensions.workflows ?? null,
    activity: () => activity,
    writeSetting: (workspaceId, key, value) =>
      createServerToolHost({ db, mailstore, drafts, workspaceId, now }).writeSetting(key, value),
  });
  signals.setCandidateSource(recommendations.candidates);
  signals.setAnsweredListener((workspaceId, threadId) =>
    recommendations.refresh(workspaceId, threadId),
  );
  /**
   * One request for an arriving Thread (slice 33): the Signals it lacks and,
   * when routing places it now, the Group Choice and the speculative
   * Sub-group Choices, placed from the same answers.
   */
  const arrivalAsk = async (workspaceId: string, threadId: string, jobId: string | null) => {
    const plan = await routing.arrivalPlan(threadId);
    const questions = plan?.questions ?? {};
    const asked = await signals.ask(workspaceId, threadId, {
      reason: "arrival",
      jobId,
      ...(Object.keys(questions).length > 0 ? { extra: questions } : {}),
    });
    if (plan) await plan.apply(asked.extra);
  };
  const judgments = createJudgments({
    db,
    mailstore,
    runtime,
    signals,
    arrivalAsk,
    llmAvailable: async () => (await judgeStateNow()).provider === "llm",
    now,
    log,
    level,
    settings: async (): Promise<JudgmentSettings> => {
      const s = await readGlobalSettings(db, JUDGMENT_SETTING_KEYS);
      return {
        onArrival: s["judgments.on_arrival"],
        snippetChars: s["routing.classify.snippet_chars"],
        questions: {
          needsReply: s["judgments.questions.needs_reply"],
          waitingOnOthers: s["judgments.questions.waiting_on_others"],
          newsletter: s["judgments.questions.newsletter"],
          automated: s["judgments.questions.automated"],
          briefWorth: s["judgments.questions.brief_worth"],
          briefWorthLevels: s["judgments.questions.brief_worth_levels"],
          urgency: s["judgments.questions.urgency"],
          urgencyLevels: s["judgments.questions.urgency_levels"],
        },
      };
    },
  });
  const policy =
    options.policy ?? createBriefPolicyRule({ settings: policySettings, runtime, judgments, log });
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
        rerunConcurrency: s["routing.rerun.concurrency"],
        lookbackDays: s["routing.lookback_days"],
        briefPolicyDefault: s["routing.brief_policy.default"],
        judge: {
          instructions: s["routing.judge.instructions"],
          noneOption: s["routing.judge.none_option"],
        },
        waitSeconds: s["routing.wait_seconds"],
        rerunScope: s["routing.rerun.scope"],
        rerunPreviewMax: s["routing.rerun.preview_max"],
        rerunSample: s["routing.rerun.sample"],
        backfill: {
          batchSize: s["routing.backfill.batch_size"],
          requestTokens: s["routing.backfill.request_tokens"],
          stateTokens: s["routing.backfill.state_tokens"],
          llmBatchSize: s["routing.backfill.llm_batch_size"],
          concurrency: s["routing.backfill.concurrency"],
        },
      };
    },
  });
  const judgeStateNow = async (): Promise<JudgeState> =>
    judgeStateFor(
      await hostedSettings(),
      await keys.list(),
      options.judge !== undefined,
      (await local?.takes("classify")) ?? null,
    );
  const backgroundBudgetNow = async (workspaceId: string) => {
    const s = await readGlobalSettings(db, ["signals.budget.background_monthly_usd"] as const);
    return backgroundBudget(db, workspaceId, s["signals.budget.background_monthly_usd"], now());
  };
  const backlog = createBacklog({
    db,
    routing,
    now,
    level,
    budget: backgroundBudgetNow,
    ...(options.log ? { log: options.log } : {}),
    judgeAvailable: () => runtime.judgeAvailable(),
    sorterIsLocal: async () => (await judgeStateNow()).runtime === "local",
    settings: async (): Promise<BacklogStepSettings> => {
      const s = await readGlobalSettings(db, ROUTING_SETTING_KEYS);
      return {
        batchSize: s["routing.backfill.batch_size"],
        llmBatchSize: s["routing.backfill.llm_batch_size"],
        concurrency: s["routing.backfill.concurrency"],
        waitSeconds: s["routing.wait_seconds"],
        syncWaitSeconds: s["routing.backfill.sync_wait_seconds"],
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
  const composeAssist = createComposeAssist({
    runtime,
    drafts,
    level,
    hasKey: async (provider) => (await resolveKey(provider as KeyProvider)) !== null,
    settings: async () => {
      const s = await readGlobalSettings(db, [
        "compose.assist",
        "compose.assist_prompt",
        "compose.assist_max_chars",
        "compose.assist_voice",
      ]);
      return {
        enabled: s["compose.assist"],
        prompt: s["compose.assist_prompt"],
        maxChars: s["compose.assist_max_chars"],
        useVoice: s["compose.assist_voice"],
      };
    },
  });
  const templates = createTemplateIntelligence({
    db,
    mailstore,
    runtime,
    now,
    log,
    voice: async (workspaceId) => {
      const v = await voice.get(workspaceId);
      return v.enabled && v.description ? v.description : null;
    },
    needsReply: async (threadId) => (await judgments.get(threadId))?.needsReply ?? null,
    readDraft: async (draftId) => drafts.get(draftId).catch(() => null),
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
    templates: templates.step,
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
        localWaitSeconds: s["workflows.local_wait_seconds"],
        waitingLocal: s["strings.workflows.waiting_local"],
        routingWaitSeconds: s["workflows.trigger.routing_wait_seconds"],
        dryRunRecent: s["workflows.dry_run.recent"],
        silenceCheckCron: s["workflows.silence.check_cron"],
        failedNotice: s["strings.workflows.failed_notice"],
        judged: {
          threshold: s["workflows.judged.threshold"],
          question: s["workflows.judged.question"],
          inputCharsMax: s["workflows.judged.input_chars_max"],
          concurrency: s["signals.backfill.concurrency"],
        },
      };
    },
  });
  extensions.workflows = workflows;
  const onboarding = createOnboarding({ db, routing, workflows, level });
  extensions.onboarding = onboarding;
  const organize = createOrganize({ db, mailstore, runtime, routing, signals, now, log });
  extensions.organize = organize;
  extensions.tune = createTune({
    db,
    mailstore,
    runtime,
    routing,
    judgments,
    organize,
    signals,
    now,
  });
  const meetings = createMeetings({
    runtime,
    thread: createDbMeetingSource(db, mailstore),
    store: createDbMeetingStore(db, mailstore),
    calendar: () => extensions.calendar ?? null,
    voice: async (workspaceId) => {
      const voice = await drafts.getVoice(workspaceId);
      return voice.enabled && voice.description.trim() !== "" ? voice : null;
    },
    settings: async () => meetingSettingsFrom(await readGlobalSettings(db, MEETING_SETTING_KEYS)),
    level,
    record: recordMeeting(db, mailstore),
    now,
    log,
  });
  extensions.meetings = meetings;
  extensions.recommendations = {
    view: (workspaceId, threadId) => recommendations.view(workspaceId, threadId),
    listExit: (workspaceId, threadId) => recommendations.listExit(workspaceId, threadId),
    oneClick: (url) => oneClick(url, options.fetch ?? ((u, init) => fetch(u, init))),
  };
  extensions.templates = templates;
  extensions.views = views;
  extensions.backlog = {
    async settings() {
      const s = await readGlobalSettings(db, BACKLOG_TOOL_SETTING_KEYS);
      return {
        scope: s["routing.backfill.scope"],
        sample: s["routing.backfill.sample"],
        words: scopeWordsFrom(s),
      };
    },
    preview: (workspaceId, scope, sample, candidates) =>
      routing.preview(workspaceId, { scope, sample, ...(candidates ? { candidates } : {}) }),
    start: (workspaceId, scope, from) => backlog.start(workspaceId, scope, from),
    cancel: (workspaceId) => backlog.cancel(workspaceId),
  };

  const batchingEval = createBatchingEval({ db, routing, runtime, now, log });

  // The background read (slice 31): new and reworded Signals over the mail already there.
  const signalBackfills = createSignalBackfills({
    db,
    signals,
    now,
    log,
    level,
    canAnswer: async () =>
      (await runtime.judgeAvailable()) ||
      ((await signals.settings()).llmFallback !== "none" &&
        (await judgeStateNow()).provider === "llm"),
    settings: async () => {
      const s = await readGlobalSettings(db, [
        "signals.backfill.scope",
        "signals.backfill.concurrency",
        "signals.backfill.confirm_above",
        "signals.backfill.tokens_per_thread",
        "signals.budget.background_monthly_usd",
        "routing.wait_seconds",
      ] as const);
      const hosted = await hostedSettings();
      return {
        scope: s["signals.backfill.scope"],
        concurrency: s["signals.backfill.concurrency"],
        confirmAbove: s["signals.backfill.confirm_above"],
        budgetUsd: s["signals.budget.background_monthly_usd"],
        waitSeconds: s["routing.wait_seconds"],
        tokensPerThread: s["signals.backfill.tokens_per_thread"],
        usdPerMillion:
          priceFor(pricingFor(hosted, "typesafe"), hosted["ai.judge.model"])?.input ?? 0,
      };
    },
  });
  // A pinned View reads its own scope; everything else goes to the Workspace's backfill.
  signals.setDefsListener(async (workspaceId, ids) => {
    const rest = await views.readNew(workspaceId, ids);
    return rest.length ? signalBackfills.request(workspaceId, rest) : null;
  });
  // The arrival request (slice 33): routing's Group and Sub-group Choices ride with every Signal.
  routing.setArrivalAsk(arrivalAsk);
  // A running Backlog sort carries the Signals a Thread lacks in its one request per Thread.
  routing.setOneThreadAsk(async (req) => {
    const r = await signals.ask(req.workspaceId, req.threadId, {
      reason: "backlog",
      extra: req.questions,
      jobId: req.jobId,
    });
    return { answers: r.extra, calls: r.calls };
  });

  return {
    batchingEval,
    signalBackfills,
    limiter,
    attachCalendar(seam) {
      extensions.calendar = seam;
    },
    runtime,
    localBridge: options.localBridge ?? null,
    keys,
    meter,
    briefs,
    policy,
    judgments,
    signals,
    recommendations,
    routing,
    backlog,
    agent,
    activity,
    workflows,
    extensions,
    onboarding,
    organize,
    integrationSecrets,
    voice,
    composeAssist,
    guard,
    templates,
    views,
    verify,
    intent: async (request) => judgeIntent(runtime, request, await intentSettings()),
    meetings,
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
        judge: judgeStateFor(
          settings,
          shared,
          options.judge !== undefined,
          (await local?.takes("classify")) ?? null,
        ),
      };
    },
    async judgeState() {
      return judgeStateFor(
        await hostedSettings(),
        await keys.list(),
        options.judge !== undefined,
        (await local?.takes("classify")) ?? null,
      );
    },
    validateKey,
    registerSteps(jobs) {
      judgments.registerSteps(jobs);
      meetings.registerSteps(jobs);
      briefs.registerSteps(jobs);
      routing.registerSteps(jobs);
      backlog.registerSteps(jobs);
      signalBackfills.registerSteps(jobs);
      views.registerSteps(jobs);
      workflows.registerSteps(jobs);
    },
  };
}
