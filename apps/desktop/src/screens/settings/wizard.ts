// The credential wizard's step machine (ADR 0008): a pure reducer over the
// Google and Microsoft flows, one sentence and one action per step. The
// component renders the state and dispatches; every network answer (the live
// validation, the sign-in outcome) arrives as an action, so every transition
// is testable without a DOM or a server. Elapsed time is kept here so the 15
// and 10 minute targets can be measured by hand from the debug log.
//
// The OAuth app is app level (one per provider, saved on the Server the
// moment the live check passes): with one saved, the wizard is only the
// sign-in; a failed sign-in, Back or a closed window never loses it.

import type { ValidationField, ValidationResult } from "../../platform/api.ts";

export type WizardProvider = "google" | "microsoft";

export type GoogleStep =
  | "project"
  | "api"
  | "consent"
  | "client"
  | "paste"
  | "pubsub"
  | "signin"
  | "done";

export type MicrosoftStep = "register" | "accountType" | "platform" | "paste" | "signin" | "done";

export type WizardStep = GoogleStep | MicrosoftStep;

export const GOOGLE_STEPS: readonly GoogleStep[] = [
  "project",
  "api",
  "consent",
  "client",
  "paste",
  "pubsub",
  "signin",
  "done",
];

export const MICROSOFT_STEPS: readonly MicrosoftStep[] = [
  "register",
  "accountType",
  "platform",
  "paste",
  "signin",
  "done",
];

/** The principal Gmail publishes from; the self-hoster grants it Publisher on the topic. */
export const GMAIL_PUBLISHER = "gmail-api-push@system.gserviceaccount.com";

export interface WizardFields {
  projectId: string;
  clientId: string;
  clientSecret: string;
  tenant: string;
  accountType: "personal" | "work";
  pubsubTopic: string;
}

export type Validation =
  | { status: "idle" }
  | { status: "checking"; for: string }
  | { status: "ok"; detail: string }
  | { status: "error"; field: ValidationField; reason: string };

export type SignIn =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "waiting"; state: string; url: string }
  | { status: "done"; address: string }
  | { status: "error"; message: string }
  | { status: "cancelled" };

/** The non-secret part of a saved sign-in app, as the Server answers it. */
export interface SavedApp {
  clientId: string;
  tenant: string | null;
  accountType: "personal" | "work" | null;
  projectId: string | null;
  pubsubTopic: string | null;
}

/** The window event a change to a saved sign-in app raises, so an open wizard reads it again. */
export const OAUTH_APP_CHANGED = "monday:oauth-app-changed";

export interface WizardState {
  provider: WizardProvider;
  step: WizardStep;
  /** The Server holds a sign-in app for the provider (read, or saved by the paste step). */
  appSaved: boolean;
  /** Opened with the app already saved: the wizard is the sign-in alone. */
  fromSaved: boolean;
  fields: WizardFields;
  validation: Validation;
  signIn: SignIn;
  /** Epoch milliseconds when the wizard opened. */
  startedAt: number;
  finishedAt: number | null;
  /** The user took the IMAP escape hatch. */
  escaped: boolean;
}

export type WizardAction =
  | { type: "next" }
  | { type: "back" }
  | { type: "skip" }
  | { type: "field"; name: keyof WizardFields; value: string }
  | { type: "validate.start"; key: string }
  | { type: "validate.result"; key: string; result: ValidationResult }
  | { type: "signin.start" }
  | { type: "signin.opened"; state: string; url: string }
  | { type: "signin.done"; address: string; at: number }
  | { type: "signin.failed"; message: string }
  | { type: "signin.retry" }
  | { type: "signin.cancel" }
  | { type: "escape" }
  | { type: "app.loaded"; app: SavedApp | null };

export function stepsOf(provider: WizardProvider): readonly WizardStep[] {
  return provider === "google" ? GOOGLE_STEPS : MICROSOFT_STEPS;
}

export function initialWizard(provider: WizardProvider, now: number): WizardState {
  return {
    provider,
    step: stepsOf(provider)[0] as WizardStep,
    fields: {
      projectId: "",
      clientId: "",
      clientSecret: "",
      tenant: "",
      accountType: "personal",
      pubsubTopic: "",
    },
    appSaved: false,
    fromSaved: false,
    validation: { status: "idle" },
    signIn: { status: "idle" },
    startedAt: now,
    finishedAt: null,
    escaped: false,
  };
}

/** The key the live validation runs under: the exact fields it checked. */
export function validationKey(state: WizardState): string {
  const f = state.fields;
  return state.provider === "google"
    ? `${f.clientId.trim()}|${f.clientSecret.trim()}`
    : `${f.clientId.trim()}|${effectiveTenant(state)}`;
}

/** What the wizard sends as the tenant: consumers for a personal account, the pasted id otherwise. */
export function effectiveTenant(state: WizardState): string {
  if (state.provider !== "microsoft") return "";
  return state.fields.accountType === "personal" ? "consumers" : state.fields.tenant.trim();
}

/** Whether the paste step has enough to validate. */
export function canValidate(state: WizardState): boolean {
  const f = state.fields;
  if (state.provider === "google") return f.clientId.trim() !== "" && f.clientSecret.trim() !== "";
  return f.clientId.trim() !== "" && (f.accountType === "personal" || f.tenant.trim() !== "");
}

export function canAdvance(state: WizardState): boolean {
  switch (state.step) {
    case "paste":
      return state.validation.status === "ok";
    case "signin":
      return state.signIn.status === "done";
    case "done":
      return false;
    default:
      return true;
  }
}

/** Steps the user may skip: the optional Pub/Sub topic. */
export function canSkip(state: WizardState): boolean {
  return state.step === "pubsub";
}

export function stepIndex(state: WizardState): { n: number; total: number } {
  if (state.fromSaved) return { n: 1, total: 1 };
  const steps = stepsOf(state.provider);
  // "done" is the outcome, not a step to count.
  return { n: steps.indexOf(state.step) + 1, total: steps.length - 1 };
}

function move(state: WizardState, delta: 1 | -1): WizardState {
  const steps = stepsOf(state.provider);
  const index = steps.indexOf(state.step) + delta;
  const step = steps[index];
  if (!step || step === "done") return state;
  return { ...state, step };
}

export function reduceWizard(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case "next":
      return canAdvance(state) ? move(state, 1) : state;
    case "back": {
      if (state.step === "done" || state.signIn.status === "waiting" || state.fromSaved) {
        return state;
      }
      return move(state, -1);
    }
    case "skip":
      return canSkip(state) ? move(state, 1) : state;
    case "field": {
      const fields = { ...state.fields, [action.name]: action.value };
      const affectsValidation = action.name !== "projectId" && action.name !== "pubsubTopic";
      return {
        ...state,
        fields,
        validation: affectsValidation ? { status: "idle" } : state.validation,
      };
    }
    case "validate.start":
      return { ...state, validation: { status: "checking", for: action.key } };
    case "validate.result": {
      // A stale answer (the user kept typing) is dropped.
      if (action.key !== validationKey(state)) return state;
      return {
        ...state,
        validation: action.result.ok
          ? { status: "ok", detail: action.result.detail }
          : { status: "error", field: action.result.field, reason: action.result.reason },
        // The paste step saves on the Server as it validates.
        appSaved: state.appSaved || action.result.ok,
      };
    }
    case "signin.start":
      return state.step === "signin" ? { ...state, signIn: { status: "starting" } } : state;
    case "signin.opened":
      return { ...state, signIn: { status: "waiting", state: action.state, url: action.url } };
    case "signin.done":
      return {
        ...state,
        step: "done",
        signIn: { status: "done", address: action.address },
        finishedAt: action.at,
      };
    case "signin.failed":
      return { ...state, signIn: { status: "error", message: action.message } };
    case "signin.retry":
      return { ...state, signIn: { status: "idle" } };
    case "signin.cancel":
      return state.signIn.status === "starting" || state.signIn.status === "waiting"
        ? { ...state, signIn: { status: "cancelled" } }
        : state;
    case "escape":
      return { ...state, escaped: true };
    case "app.loaded": {
      // A sign-in under way or finished is never pulled out from under the user.
      if (state.signIn.status === "waiting" || state.step === "done") return state;
      // Saved by this wizard's own paste step: the setup carries on to its next steps.
      if (action.app && state.appSaved && !state.fromSaved) return state;
      if (action.app) {
        const a = action.app;
        return {
          ...state,
          step: "signin",
          appSaved: true,
          fromSaved: true,
          signIn: state.signIn.status === "starting" ? state.signIn : { status: "idle" },
          fields: {
            ...state.fields,
            clientId: a.clientId,
            clientSecret: "",
            tenant: a.tenant && a.tenant !== "consumers" ? a.tenant : "",
            accountType: a.accountType ?? state.fields.accountType,
            projectId: a.projectId ?? state.fields.projectId,
            pubsubTopic: a.pubsubTopic ?? "",
          },
        };
      }
      // Forgotten (Remove): a wizard that relied on it starts the setup again.
      if (!state.appSaved) return state;
      return {
        ...state,
        step: stepsOf(state.provider)[0] as WizardStep,
        appSaved: false,
        fromSaved: false,
        validation: { status: "idle" },
        signIn: { status: "idle" },
      };
    }
  }
}

/* ------------------------------ Deep links ------------------------------ */

/** The console page each step opens. Project-scoped where the URL allows it. */
export function deepLink(state: WizardState): string | null {
  const project = state.fields.projectId.trim();
  const scoped = (url: string) => (project ? `${url}?project=${encodeURIComponent(project)}` : url);
  const clientId = state.fields.clientId.trim();
  if (state.provider === "google") {
    switch (state.step) {
      case "project":
        return "https://console.cloud.google.com/projectcreate";
      case "api":
        return scoped("https://console.cloud.google.com/apis/library/gmail.googleapis.com");
      case "consent":
        return scoped("https://console.cloud.google.com/auth/audience");
      case "client":
        return scoped("https://console.cloud.google.com/auth/clients/create");
      case "pubsub":
        return scoped("https://console.cloud.google.com/cloudpubsub/topic/create");
      default:
        return null;
    }
  }
  switch (state.step) {
    case "register":
      return "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/CreateApplicationBlade";
    case "platform":
      return clientId
        ? `https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/Authentication/appId/${encodeURIComponent(clientId)}`
        : "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade";
    default:
      return null;
  }
}

/** The Google Calendar API's page, the API step's second link; null elsewhere. */
export function calendarApiLink(state: WizardState): string | null {
  if (state.provider !== "google" || state.step !== "api") return null;
  const project = state.fields.projectId.trim();
  const url = "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com";
  return project ? `${url}?project=${encodeURIComponent(project)}` : url;
}

/** The topic the Pub/Sub step suggests once a project id is known. */
export function suggestedTopic(state: WizardState): string {
  const project = state.fields.projectId.trim();
  return project ? `projects/${project}/topics/monday-gmail` : "";
}

/* ------------------------------ Elapsed time ------------------------------ */

export function elapsedMs(state: WizardState, now: number): number {
  return Math.max(0, (state.finishedAt ?? now) - state.startedAt);
}

/** "12m 03s" for the debug log and the done step. */
export function formatElapsed(ms: number): string {
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** The per-provider target ADR 0008 sets for a fresh project. */
export function targetMinutes(provider: WizardProvider): number {
  return provider === "google" ? 15 : 10;
}

/** Fills {name} holes in a Setting string. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key] ?? `{${key}}`));
}
