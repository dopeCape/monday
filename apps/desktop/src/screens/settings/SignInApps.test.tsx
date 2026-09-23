/// <reference types="bun-types" />
// The Sign-in apps block through the DOM: one card per provider saying whether
// it is set up; Set up checks the pasted registration live and saves it the
// moment it passes; a wrong secret says why and saves nothing; the secret is
// never shown again; Remove asks first and forgets the app. The Server is a
// scripted Api that keeps the saved app as the real one does.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { dom } from "@monday/ui/test-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { type Api, createApi, type OAuthAppView, type OAuthProvider } from "../../platform/api.ts";
import { StaticShell } from "../../shell/Shell.tsx";
import { SignInAppsPanel } from "./SignInApps.tsx";
import { OAUTH_APP_CHANGED } from "./wizard.ts";

let createRoot: Awaited<ReturnType<typeof dom>>["createRoot"];
beforeAll(async () => {
  ({ createRoot } = await dom());
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

const SECRET = "GOCSPX-right";

function fakeApi(initial: Partial<Record<OAuthProvider, OAuthAppView>> = {}) {
  const saved = new Map(Object.entries(initial) as Array<[OAuthProvider, OAuthAppView]>);
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const base = createApi(() => null);
  const api: Api = {
    ...base,
    oauth: {
      ...base.oauth,
      app: async (p) => ({ app: saved.get(p) ?? null }),
      saveApp: async (p, body) => {
        calls.push({ name: "saveApp", args: [p, body] });
        if (p === "google" && body.clientSecret !== SECRET) {
          return {
            result: {
              ok: false,
              field: "clientSecret",
              reason: "Google rejected the client secret.",
            },
            app: null,
          };
        }
        const view: OAuthAppView = {
          provider: p,
          clientId: body.clientId,
          hasSecret: Boolean(body.clientSecret),
          tenant: body.tenant ?? null,
          accountType: body.accountType ?? null,
          projectId: body.projectId ?? null,
          pubsubTopic: body.pubsubTopic ?? null,
          updatedAt: "2026-09-23T10:00:00Z",
        };
        saved.set(p, view);
        return { result: { ok: true, detail: "recognized" }, app: view };
      },
      updateApp: async (p, patch) => {
        calls.push({ name: "updateApp", args: [p, patch] });
        const current = saved.get(p);
        if (!current) throw new Error("none");
        const next = { ...current, pubsubTopic: patch.pubsubTopic ?? null };
        saved.set(p, next);
        return { app: next };
      },
      removeApp: async (p) => {
        calls.push({ name: "removeApp", args: [p] });
        saved.delete(p);
        return {};
      },
    },
  };
  return { api, calls, saved };
}

async function mount(api: Api) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const r = root;
  await act(async () =>
    r.render(
      <StaticShell>
        <SignInAppsPanel api={api} debounceMs={0} />
      </StaticShell>,
    ),
  );
  await settle();
}

const settle = () => act(async () => Bun.sleep(15));
const card = (p: OAuthProvider) => document.querySelector<HTMLElement>(`[data-oauth-app="${p}"]`);
const text = () => document.body.textContent ?? "";

async function clickIn(el: HTMLElement | null, label: string) {
  const b = [...(el?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (x) => (x.textContent ?? "").trim() === label,
  );
  if (!b) throw new Error(`no button ${label}`);
  await act(async () => b.click());
  await settle();
}

async function type(input: HTMLInputElement | undefined, value: string) {
  if (!input) throw new Error("no input");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

describe("Sign-in apps", () => {
  test("Set up checks live, saves the moment it passes, never shows the secret again", async () => {
    const { api, calls, saved } = fakeApi();
    let heard = 0;
    const onChange = () => heard++;
    window.addEventListener(OAUTH_APP_CHANGED, onChange);
    await mount(api);
    expect(card("google")?.dataset.state).toBe("missing");
    expect(text()).toContain(
      "Not set up yet. monday asks for it the first time you add a Google account.",
    );
    await clickIn(card("google"), "Set up");
    const inputs = () => [...(card("google")?.querySelectorAll<HTMLInputElement>("input") ?? [])];
    await type(inputs()[0], "1234-abc.apps.googleusercontent.com");
    await type(inputs()[1], "GOCSPX-wrong");
    expect(card("google")?.querySelector('[role="alert"]')?.textContent).toContain(
      "Google rejected the client secret.",
    );
    expect(saved.has("google")).toBe(false);

    await type(inputs()[1], SECRET);
    expect(saved.get("google")?.clientId).toBe("1234-abc.apps.googleusercontent.com");
    expect(card("google")?.dataset.state).toBe("ready");
    expect(text()).toContain("Google sign-in is set up. Add as many Google accounts as you like.");
    expect(heard).toBeGreaterThan(0);
    // The topic follows on leaving its box, without the secret again.
    await type(inputs()[2], "projects/p/topics/monday-gmail");
    await act(async () =>
      inputs()[2]?.dispatchEvent(new FocusEvent("focusout", { bubbles: true })),
    );
    await settle();
    expect(calls.at(-1)).toEqual({
      name: "updateApp",
      args: ["google", { pubsubTopic: "projects/p/topics/monday-gmail" }],
    });
    await clickIn(card("google"), "Done");
    expect(card("google")?.querySelectorAll("input")).toHaveLength(0);
    expect(text()).toContain("Secret saved on your server, never shown");
    expect(document.body.innerHTML).not.toContain(SECRET);
    window.removeEventListener(OAUTH_APP_CHANGED, onChange);
  });

  test("Microsoft: account type and tenant, saved on the check", async () => {
    const { api, calls } = fakeApi();
    await mount(api);
    await clickIn(card("microsoft"), "Set up");
    await clickIn(card("microsoft"), "Work or school account, this organization only");
    const inputs = () => [
      ...(card("microsoft")?.querySelectorAll<HTMLInputElement>("input") ?? []),
    ];
    await type(inputs()[0], "12345678-1234-1234-1234-123456789abc");
    expect(calls).toHaveLength(0);
    await type(inputs()[1], "contoso");
    expect(calls.at(-1)?.args).toEqual([
      "microsoft",
      { clientId: "12345678-1234-1234-1234-123456789abc", tenant: "contoso", accountType: "work" },
    ]);
    expect(card("microsoft")?.dataset.state).toBe("ready");
  });

  test("Remove asks first and forgets the app", async () => {
    const { api, saved } = fakeApi({
      google: {
        provider: "google",
        clientId: "1234-abc.apps.googleusercontent.com",
        hasSecret: true,
        tenant: null,
        accountType: null,
        projectId: null,
        pubsubTopic: null,
        updatedAt: "2026-09-23T10:00:00Z",
      },
    });
    await mount(api);
    expect(card("google")?.dataset.state).toBe("ready");
    expect(text()).toContain("Client id 1234-abc.apps.googleusercontent.com");
    await clickIn(card("google"), "Remove");
    expect(text()).toContain("Forget the Google sign-in app?");
    expect(saved.has("google")).toBe(true);
    await clickIn(card("google"), "Confirm");
    expect(saved.has("google")).toBe(false);
    expect(card("google")?.dataset.state).toBe("missing");
  });
});
