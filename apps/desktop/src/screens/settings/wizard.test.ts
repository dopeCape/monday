// The wizard step machine through its reducer: every transition, the live
// validation states the route can answer with, the IMAP escape hatch, the
// deep links and the elapsed time.

import { describe, expect, test } from "bun:test";
import {
  canAdvance,
  canSkip,
  canValidate,
  deepLink,
  effectiveTenant,
  elapsedMs,
  fill,
  formatElapsed,
  GMAIL_PUBLISHER,
  GOOGLE_STEPS,
  initialWizard,
  MICROSOFT_STEPS,
  reduceWizard,
  stepIndex,
  suggestedTopic,
  targetMinutes,
  validationKey,
  type WizardAction,
  type WizardState,
} from "./wizard.ts";

function run(state: WizardState, ...actions: WizardAction[]): WizardState {
  return actions.reduce(reduceWizard, state);
}

const googleClient = (state: WizardState) =>
  run(
    state,
    { type: "field", name: "clientId", value: "1234-abc.apps.googleusercontent.com" },
    { type: "field", name: "clientSecret", value: "GOCSPX-secret" },
  );

describe("wizard reducer: Google", () => {
  test("walks the eight steps in order and counts seven", () => {
    let state = initialWizard("google", 1000);
    expect(state.step).toBe("project");
    expect(stepIndex(state)).toEqual({ n: 1, total: 7 });
    expect(GOOGLE_STEPS).toEqual([
      "project",
      "api",
      "consent",
      "client",
      "paste",
      "pubsub",
      "signin",
      "done",
    ]);
    for (const expected of ["api", "consent", "client", "paste"] as const) {
      state = reduceWizard(state, { type: "next" });
      expect(state.step).toBe(expected);
    }
    // Back and forth, never past the first step.
    expect(run(state, { type: "back" }).step).toBe("client");
    expect(run(initialWizard("google", 0), { type: "back" }).step).toBe("project");
  });

  test("the paste step advances only after a green validation, and typing resets it", () => {
    let state = run(
      initialWizard("google", 0),
      { type: "next" },
      { type: "next" },
      { type: "next" },
      { type: "next" },
    );
    expect(state.step).toBe("paste");
    expect(canValidate(state)).toBe(false);
    expect(canAdvance(state)).toBe(false);
    expect(run(state, { type: "next" }).step).toBe("paste");

    state = googleClient(state);
    expect(canValidate(state)).toBe(true);
    const key = validationKey(state);
    state = reduceWizard(state, { type: "validate.start", key });
    expect(state.validation).toEqual({ status: "checking", for: key });
    expect(canAdvance(state)).toBe(false);

    // A stale answer for an older key is ignored.
    const stale = reduceWizard(state, {
      type: "validate.result",
      key: "older",
      result: { ok: true, detail: "x" },
    });
    expect(stale.validation.status).toBe("checking");

    const bad = reduceWizard(state, {
      type: "validate.result",
      key,
      result: { ok: false, field: "clientSecret", reason: "Google rejected the client secret." },
    });
    expect(bad.validation).toEqual({
      status: "error",
      field: "clientSecret",
      reason: "Google rejected the client secret.",
    });
    expect(canAdvance(bad)).toBe(false);

    const good = reduceWizard(state, {
      type: "validate.result",
      key,
      result: { ok: true, detail: "Google recognizes this client id and secret." },
    });
    expect(good.validation.status).toBe("ok");
    expect(canAdvance(good)).toBe(true);
    // Editing the secret drops the green state; editing the project id does not.
    expect(
      reduceWizard(good, { type: "field", name: "clientSecret", value: "changed" }).validation,
    ).toEqual({ status: "idle" });
    expect(
      reduceWizard(good, { type: "field", name: "projectId", value: "monday-1" }).validation.status,
    ).toBe("ok");
    const next = reduceWizard(good, { type: "next" });
    expect(next.step).toBe("pubsub");
    expect(canSkip(next)).toBe(true);
    expect(canSkip(good)).toBe(false);
    expect(reduceWizard(next, { type: "skip" }).step).toBe("signin");
    expect(reduceWizard(next, { type: "next" }).step).toBe("signin");
  });

  test("sign-in: start, opened, done moves to done and records the time; failed allows a retry", () => {
    const base = run(
      googleClient(initialWizard("google", 10_000)),
      { type: "next" },
      { type: "next" },
      { type: "next" },
      { type: "next" },
      { type: "validate.start", key: "k" },
    );
    let state = reduceWizard(base, {
      type: "validate.result",
      key: validationKey(base),
      result: { ok: true, detail: "ok" },
    });
    state = run(state, { type: "next" }, { type: "skip" });
    expect(state.step).toBe("signin");
    expect(canAdvance(state)).toBe(false);
    // signin.start only counts on the sign-in step.
    expect(reduceWizard(base, { type: "signin.start" }).signIn.status).toBe("idle");
    state = reduceWizard(state, { type: "signin.start" });
    expect(state.signIn.status).toBe("starting");
    state = reduceWizard(state, { type: "signin.opened", state: "st", url: "https://accounts" });
    expect(state.signIn).toEqual({ status: "waiting", state: "st", url: "https://accounts" });
    // No going back while the browser is open.
    expect(reduceWizard(state, { type: "back" }).step).toBe("signin");

    const failed = reduceWizard(state, { type: "signin.failed", message: "access_denied" });
    expect(failed.signIn).toEqual({ status: "error", message: "access_denied" });
    expect(failed.step).toBe("signin");
    expect(reduceWizard(failed, { type: "signin.retry" }).signIn.status).toBe("idle");

    const done = reduceWizard(state, { type: "signin.done", address: "me@gmail.com", at: 730_000 });
    expect(done.step).toBe("done");
    expect(done.signIn).toEqual({ status: "done", address: "me@gmail.com" });
    expect(done.finishedAt).toBe(730_000);
    expect(elapsedMs(done, 999_999)).toBe(720_000);
    expect(formatElapsed(elapsedMs(done, 0))).toBe("12m 00s");
    expect(canAdvance(done)).toBe(false);
    expect(reduceWizard(done, { type: "next" }).step).toBe("done");
    expect(reduceWizard(done, { type: "back" }).step).toBe("done");
    expect(targetMinutes("google")).toBe(15);
    expect(targetMinutes("microsoft")).toBe(10);
  });

  test("deep links open the consoles, scoped to the project once it is known", () => {
    let state = initialWizard("google", 0);
    expect(deepLink(state)).toBe("https://console.cloud.google.com/projectcreate");
    state = reduceWizard(state, { type: "field", name: "projectId", value: "monday-1" });
    state = reduceWizard(state, { type: "next" });
    expect(deepLink(state)).toBe(
      "https://console.cloud.google.com/apis/library/gmail.googleapis.com?project=monday-1",
    );
    state = reduceWizard(state, { type: "next" });
    expect(deepLink(state)).toBe("https://console.cloud.google.com/auth/audience?project=monday-1");
    state = reduceWizard(state, { type: "next" });
    expect(deepLink(state)).toBe(
      "https://console.cloud.google.com/auth/clients/create?project=monday-1",
    );
    state = reduceWizard(state, { type: "next" });
    expect(deepLink(state)).toBeNull();
    expect(suggestedTopic(state)).toBe("projects/monday-1/topics/monday-gmail");
    expect(suggestedTopic(initialWizard("google", 0))).toBe("");
    expect(GMAIL_PUBLISHER).toBe("gmail-api-push@system.gserviceaccount.com");
  });

  test("the IMAP escape hatch is recorded from any step", () => {
    const state = run(initialWizard("google", 0), { type: "next" }, { type: "escape" });
    expect(state.escaped).toBe(true);
    expect(state.step).toBe("api");
    expect(run(initialWizard("microsoft", 0), { type: "escape" }).escaped).toBe(true);
  });
});

describe("wizard reducer: Microsoft", () => {
  test("walks the six steps and validates the application id against the chosen tenant", () => {
    let state = initialWizard("microsoft", 0);
    expect(MICROSOFT_STEPS).toEqual([
      "register",
      "accountType",
      "platform",
      "paste",
      "signin",
      "done",
    ]);
    expect(stepIndex(state)).toEqual({ n: 1, total: 5 });
    expect(deepLink(state)).toBe(
      "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/CreateApplicationBlade",
    );
    state = run(state, { type: "next" }, { type: "next" });
    expect(state.step).toBe("platform");
    expect(deepLink(state)).toContain("ApplicationsListBlade");
    state = reduceWizard(state, {
      type: "field",
      name: "clientId",
      value: "12345678-1234-1234-1234-123456789abc",
    });
    expect(deepLink(state)).toBe(
      "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/Authentication/appId/12345678-1234-1234-1234-123456789abc",
    );
    state = reduceWizard(state, { type: "next" });
    expect(state.step).toBe("paste");
    // A personal account needs no tenant: it is "consumers".
    expect(effectiveTenant(state)).toBe("consumers");
    expect(canValidate(state)).toBe(true);
    const work = reduceWizard(state, { type: "field", name: "accountType", value: "work" });
    expect(canValidate(work)).toBe(false);
    const withTenant = reduceWizard(work, { type: "field", name: "tenant", value: " contoso " });
    expect(effectiveTenant(withTenant)).toBe("contoso");
    expect(canValidate(withTenant)).toBe(true);
    expect(validationKey(withTenant)).toBe("12345678-1234-1234-1234-123456789abc|contoso");
    const key = validationKey(withTenant);
    const checked = run(
      withTenant,
      { type: "validate.start", key },
      {
        type: "validate.result",
        key,
        result: { ok: false, field: "tenant", reason: 'Microsoft has no tenant "contoso".' },
      },
    );
    expect(checked.validation).toMatchObject({ status: "error", field: "tenant" });
    const ok = run(
      withTenant,
      { type: "validate.start", key },
      {
        type: "validate.result",
        key,
        result: { ok: true, detail: "Microsoft recognizes this app in contoso." },
      },
    );
    expect(reduceWizard(ok, { type: "next" }).step).toBe("signin");
    expect(canSkip(ok)).toBe(false);
  });
});

describe("helpers", () => {
  test("fill replaces the holes a Setting string carries", () => {
    expect(fill("Step {n} of {total}", { n: 2, total: 7 })).toBe("Step 2 of 7");
    expect(fill("{address} is connected", { address: "a@b.c" })).toBe("a@b.c is connected");
    expect(fill("{missing}", {})).toBe("{missing}");
    expect(formatElapsed(65_400)).toBe("1m 05s");
    expect(formatElapsed(0)).toBe("0m 00s");
  });
});

describe("the saved sign-in app", () => {
  const saved = {
    clientId: "1234-abc.apps.googleusercontent.com",
    tenant: null,
    accountType: null,
    projectId: "p",
    pubsubTopic: "projects/p/topics/t",
  };

  test("a saved app makes the wizard the sign-in alone, and Back stays put", () => {
    const s = run(initialWizard("google", 0), { type: "app.loaded", app: saved });
    expect(s.step).toBe("signin");
    expect(s.fromSaved).toBe(true);
    expect(stepIndex(s)).toEqual({ n: 1, total: 1 });
    expect(s.fields.pubsubTopic).toBe("projects/p/topics/t");
    expect(run(s, { type: "back" }).step).toBe("signin");
  });

  test("a passing check marks the app saved; the wizard's own save does not skip its steps", () => {
    let s = run(
      initialWizard("google", 0),
      { type: "next" },
      { type: "next" },
      { type: "next" },
      { type: "next" },
      { type: "field", name: "clientId", value: "1234-abc.apps.googleusercontent.com" },
      { type: "field", name: "clientSecret", value: "x" },
    );
    const key = validationKey(s);
    s = run(
      s,
      { type: "validate.start", key },
      { type: "validate.result", key, result: { ok: true, detail: "ok" } },
    );
    expect(s.appSaved).toBe(true);
    const after = run(s, { type: "app.loaded", app: saved });
    expect(after.step).toBe("paste");
    expect(after.fromSaved).toBe(false);
  });

  test("a forgotten app starts the setup again; a sign-in under way is left alone", () => {
    const s = run(initialWizard("microsoft", 0), {
      type: "app.loaded",
      app: { ...saved, tenant: "consumers" },
    });
    expect(run(s, { type: "app.loaded", app: null }).step).toBe("register");
    const waiting = run(
      s,
      { type: "signin.start" },
      { type: "signin.opened", state: "st", url: "u" },
    );
    expect(run(waiting, { type: "app.loaded", app: null }).step).toBe("signin");
    // Never having had one, a null answer changes nothing.
    const fresh = initialWizard("google", 0);
    expect(run(fresh, { type: "app.loaded", app: null })).toEqual(fresh);
  });
});
