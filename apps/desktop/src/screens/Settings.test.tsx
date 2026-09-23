/// <reference types="bun-types" />
// The Settings screens through the DOM with happy-dom (docs/spec/settings.md,
// slice 17): every control on every page comes from the schema and every
// schema key lands on exactly one page (and at most once in search results);
// a Pinned key is locked with the file line and refuses a write; a change
// writes through with Undo from the toast for every kind of value; the card
// footers show the scope, the default and Reset; the search finds settings
// and panels by label, help, key, option and section with keyboard walking
// and "Show in section"; "Ask monday" inputs hand their text to the composer;
// the Accounts, Devices, Storage, Meter, Activity log and About panels over a
// scripted Api with every button doing something; and the Agent's
// change_setting tool (the Server's own tool server over a fake ToolHost)
// changing one key per section with the rendered control following after
// shell.refresh().

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  type ActivityRecord,
  type Device,
  defaultSettings,
  type ExternalConsent,
  type ExternalCredential,
  isSettingKey,
  isStringKey,
  type KeyProvider,
  keyConditions,
  type MeterMonth,
  type PartialSettings,
  SETTING_SECTIONS,
  type SettingEntry,
  type SettingKey,
  type SettingSection,
  satisfyingValue,
  settingKeys,
  settingsSchema,
  unmetConditions,
  type VoiceProfile,
} from "@monday/shared";
import { dom } from "@monday/ui/test-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createMemoryActivityLog } from "../../../server/src/intelligence/agent/activity.ts";
import { createFakeToolHost } from "../../../server/src/intelligence/agent/tools/fake-host.ts";
import { createToolServer } from "../../../server/src/intelligence/agent/tools/index.ts";
import { type Api, ApiError, createApi, type PendingPairings } from "../platform/api.ts";
import type { DeviceProviderKeys } from "../platform/providerKeys.ts";
import { fakePlatform } from "../platform/tauri.ts";
import { Shell, type ShellState, StaticShell, useShell } from "../shell/Shell.tsx";
import { Settings, type SettingsProps, writeAll } from "./Settings.tsx";
import { resetDisclosures } from "./settings/disclosure.tsx";
import { controlKinds } from "./settings/render.tsx";
import { buildSearchIndex, searchSettings } from "./settings/search.ts";

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
  // Disclosures are remembered for the session; each case starts folded.
  resetDisclosures();
});

const NOW = new Date("2026-09-17T10:00:00Z");
const settle = () => act(async () => Bun.sleep(15));
const q = <T extends Element = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector);
const qa = <T extends Element = HTMLElement>(selector: string) => [
  ...document.querySelectorAll<T>(selector),
];
const text = () => document.body.textContent ?? "";

async function click(el: Element | null | undefined) {
  if (!el) throw new Error("nothing to click");
  await act(async () => (el as HTMLElement).click());
  await settle();
}

async function clickText(label: string, within: ParentNode = document) {
  const el = [...within.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => (b.textContent ?? "").trim() === label,
  );
  if (!el) throw new Error(`no button ${label}`);
  await click(el);
}

async function type(input: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
  if (!input) throw new Error("no input");
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function blur(input: Element | null) {
  if (!input) throw new Error("no input");
  await act(async () => input.dispatchEvent(new FocusEvent("blur", { bubbles: false })));
  // React listens to focusout for onBlur.
  await act(async () => input.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
  await settle();
}

/* ------------------------------ A scripted Server ------------------------------ */

interface Scripted {
  api: Api;
  calls: Array<{ name: string; args: unknown[] }>;
  stored: Record<string, unknown>;
}

function scriptedApi(
  over: {
    devices?: Device[];
    me?: string;
    pending?: PendingPairings;
    meter?: MeterMonth;
    activity?: ActivityRecord[];
    voice?: VoiceProfile;
    stored?: Record<string, unknown>;
    shared?: KeyProvider[];
    credentials?: ExternalCredential[];
    consents?: ExternalConsent[];
  } = {},
): Scripted {
  const calls: Scripted["calls"] = [];
  const sharedNow = new Set<KeyProvider>();
  const stored = over.stored ?? {};
  const base = createApi(() => ({ baseUrl: "http://127.0.0.1:4242", token: "t" }));
  const api: Api = {
    ...base,
    health: async () => ({ ok: true, mode: "sidecar", uptimeMs: 1 }),
    capabilities: async () => {
      throw new Error("no capabilities scripted");
    },
    upgrade: {
      ...base.upgrade,
      status: async () => {
        throw new Error("no upgrade scripted");
      },
    },
    // No sign-in app saved yet.
    oauth: { ...base.oauth, app: async () => ({ app: null }) },
    // Each Account's card asks whether its calendar is a CalDAV link.
    calendar: {
      ...base.calendar,
      info: async () => {
        throw new Error("no calendar scripted");
      },
    },
    accounts: {
      ...base.accounts,
      list: async () => ({
        accounts: [
          {
            id: "a1",
            workspaceId: "ws-1",
            provider: "jmap",
            address: "tejas@genai-labs.io",
            displayName: "Tejas",
            capabilities: {
              push: true,
              labels: true,
              snooze: false,
              mute: false,
              calendar: false,
              meetingLink: null,
            },
            connected: true,
            lastSync: "2026-09-17T09:59:00Z",
            lastError: null,
          },
        ],
      }),
    },
    settings: {
      all: async () => ({ global: { ...stored }, device: {} }),
      set: async (key, value, scope) => {
        calls.push({ name: "settings.set", args: [key, value, scope] });
        stored[key] = value;
        return { key, value, scope };
      },
    },
    devices: {
      list: async () => over.devices ?? [],
      me: async () => ({ id: over.me ?? "d1", kind: "device" as const }),
      pending: async () => over.pending ?? { pending: [], setupAvailable: false },
      revoke: async (id) => {
        calls.push({ name: "revoke", args: [id] });
        return new Response(null, { status: 204 });
      },
      confirm: async (code) => {
        calls.push({ name: "confirm", args: [code] });
        return { ok: true };
      },
    },
    storage: async () => ({ messages: 12418, bytes: 1.9 * 1024 * 1024 * 1024 }),
    meter: {
      month: async () =>
        over.meter ?? { workspaceId: "ws-1", month: "2026-09", lines: [], costMicros: 0 },
    },
    voice: {
      get: async () =>
        over.voice ?? {
          workspaceId: "ws-1",
          description: "Short and warm.",
          excerpts: ["a", "b"],
          builtAt: "2026-09-10T10:00:00Z",
          enabled: true,
        },
      put: async (_ws, patch) => {
        calls.push({ name: "voice.put", args: [patch] });
        return { ...(over.voice ?? (await api.voice.get("ws-1"))), ...patch } as VoiceProfile;
      },
    },
    keys: {
      // Shares made through the api are listed back, as the Server would.
      shared: async () => ({ shared: [...new Set([...(over.shared ?? []), ...sharedNow])] }),
      share: async (_ws, provider, key) => {
        calls.push({ name: "keys.share", args: [provider, key] });
        sharedNow.add(provider);
        return { provider, shared: true };
      },
      unshare: async (provider) => {
        calls.push({ name: "keys.unshare", args: [provider] });
        sharedNow.delete(provider);
      },
      // The Server's live check, scripted: one TypeSafe key is known, every other refused.
      validate: async (provider, key) => {
        calls.push({ name: "keys.validate", args: [provider, key] });
        if (provider !== "typesafe") throw new ApiError(404, "no_validator");
        return key === "ts-good"
          ? { ok: true, models: ["jev-latest"] }
          : { ok: false, code: "unauthorized", reason: "TypeSafe does not know this key." };
      },
    },
    routing: {
      ...base.routing,
      groups: async () => [
        {
          id: "g-hiring",
          workspaceId: "ws-1",
          parentId: null,
          name: "Hiring",
          rule: { sentence: "Anything about candidates", predicate: {}, prompt: "" },
          threshold: null,
          briefPolicy: null,
          examples: [],
          threads: 7,
          unread: 2,
          confidence: 0.9,
        },
      ],
    },
    agent: {
      ...base.agent,
      activity: async () => ({ activity: [...(over.activity ?? [])] }),
      undo: async (id, session) => {
        calls.push({ name: "agent.undo", args: [id, session] });
        const row = over.activity?.find((r) => r.id === id);
        if (!row) throw new Error("no row");
        row.undoneAt = NOW.toISOString();
        return row;
      },
    },
    external: {
      ...base.external,
      credentials: async () => over.credentials ?? [],
      createKey: async (input) => {
        calls.push({ name: "external.createKey", args: [input] });
        return {
          credential: {
            id: "c-new",
            kind: "key",
            name: input.name,
            scope: input.scope,
            workspaceIds: input.workspaceIds,
            createdAt: NOW.toISOString(),
            expiresAt: "2026-12-16T10:00:00Z",
            lastUsedAt: null,
            revokedAt: null,
            clientId: null,
            prefix: "mk_live_abcdef",
          },
          secret: "mk_live_abcdef0123456789",
        };
      },
      revoke: async (id) => {
        calls.push({ name: "external.revoke", args: [id] });
      },
      consents: async () => over.consents ?? [],
      approveConsent: async (ref, workspaceIds) => {
        calls.push({ name: "external.approve", args: [ref, workspaceIds] });
        const found = over.consents?.[0];
        if (!found) throw Object.assign(new Error("not found"), { status: 404 });
        return found;
      },
      denyConsent: async (id) => {
        calls.push({ name: "external.deny", args: [id] });
      },
      pending: async () => [],
      live: () => () => {},
      decide: async () => {
        throw new Error("not scripted");
      },
    },
  };
  return { api, calls, stored };
}

/** A keychain of provider keys for the tests: set, get, remove, share through the api. */
function fakeKeys(initial: Partial<Record<KeyProvider, string>> = {}) {
  const store = new Map<KeyProvider, string>(
    Object.entries(initial) as Array<[KeyProvider, string]>,
  );
  const keys: DeviceProviderKeys & { writes: string[] } = {
    writes: [],
    get: async (p) => store.get(p) ?? null,
    set: async (p, k) => {
      store.set(p, k);
      keys.writes.push(`${p}:${k}`);
    },
    remove: async (p) => {
      store.delete(p);
    },
    resolver: async (p) => store.get(p) ?? null,
    share: async (api, ws, p) => {
      const k = store.get(p);
      if (!k) return false;
      await api.keys.share(ws, p, k);
      return true;
    },
    unshare: (api, p) => api.keys.unshare(p),
  };
  return keys;
}

let captured: ShellState | null = null;
function Capture() {
  captured = useShell();
  return null;
}

async function mount(
  props: Partial<SettingsProps> = {},
  shell: Partial<Pick<ShellState, "api" | "pinned" | "config" | "sidecar" | "server">> = {},
  // These pages were specified under the full AI level; the level tests set their own (slice 20).
  settings: PartialSettings = { "ai.level": "automate" },
) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const r = root;
  const asked: string[] = [];
  await act(async () =>
    r.render(
      <StaticShell shell={shell} settings={settings}>
        <Capture />
        <Settings
          workspaceId="ws-1"
          now={() => NOW}
          onAsk={(t) => asked.push(t)}
          keys={props.keys ?? fakeKeys()}
          {...props}
        />
      </StaticShell>,
    ),
  );
  await settle();
  return { asked };
}

/** Opens every disclosure on the page, in rounds, since an opened one may hold more. */
async function openAll() {
  for (let round = 0; round < 12; round++) {
    const closed = qa('[data-disclosure][aria-expanded="false"]');
    if (closed.length === 0) return;
    for (const b of closed) await act(async () => b.click());
    await settle();
  }
  throw new Error("disclosures kept appearing");
}

/** The Hosted runtime at the full level: the provider cards and the Task map are on the page. */
const HOSTED: PartialSettings = { "ai.level": "automate", "ai.mode": "hosted" };

/** mount, then every disclosure open: for tests about a card, not about what folds. */
async function mountOpen(...args: Parameters<typeof mount>) {
  const out = await mount(...args);
  await openAll();
  return out;
}

async function unmount() {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  resetDisclosures();
}

/** A value for a free dependency (a URL, a palette file) no single option satisfies. */
const FREE_VALUES: Record<string, unknown> = {
  "server.url": "https://cloud.example.test",
  "appearance.palette": "~/.config/monday/palette.toml",
};

/**
 * The Settings that bring a key onto its page: its unmet conditions met, the
 * chain followed. Throws when a dependency cannot be satisfied.
 */
function satisfying(key: SettingKey): Record<string, unknown> {
  const values: Record<string, unknown> = { ...defaultSettings(), "ai.level": "automate" };
  const out: Record<string, unknown> = {};
  for (let i = 0; i < 6; i++) {
    const unmet = unmetConditions(keyConditions(key), values);
    if (unmet.length === 0) return out;
    for (const c of unmet) {
      const v = satisfyingValue(c)?.value ?? FREE_VALUES[c.key];
      if (v === undefined) throw new Error(`${key}: cannot satisfy ${JSON.stringify(c)}`);
      values[c.key] = v;
      out[c.key] = v;
    }
  }
  throw new Error(`${key}: dependencies never settle`);
}

/* ------------------------------ Coverage ------------------------------ */

describe("Settings pages come from the schema", () => {
  test("every control's data-setting is a schema key, and every non-string key is reachable on exactly one page: shown, behind a disclosure, or behind a choice that can be made", async () => {
    const seen = new Map<string, Set<string>>();
    // Each section on a fresh install at the full level, then each distinct set
    // of choices a dependency needs, on the section that holds the key.
    const runs = new Map<string, { section: SettingSection; settings: Record<string, unknown> }>();
    for (const section of SETTING_SECTIONS) runs.set(section, { section, settings: {} });
    for (const key of settingKeys) {
      const entry = settingsSchema[key] as SettingEntry;
      if (isStringKey(key) || entry.hidden || entry.renderedBy) continue;
      if (keyConditions(key).length === 0) continue;
      const settings = satisfying(key);
      const at = settingsSchema[key].section;
      if (Object.keys(settings).length === 0) continue;
      runs.set(`${at}:${JSON.stringify(settings)}`, { section: at, settings });
    }
    for (const { section, settings } of runs.values()) {
      await mountOpen(
        { initialSection: section },
        { api: scriptedApi().api },
        { "ai.level": "automate", ...(settings as PartialSettings) },
      );
      const page = q(".settings-in");
      expect(page?.dataset.section).toBe(section);
      const keys = qa("[data-setting]").map((el) => el.getAttribute("data-setting") ?? "");
      // About holds only strings, so its page is one panel and no control.
      expect(keys.length > 0 || qa("[data-panel]").length > 0, section).toBe(true);
      for (const key of keys) {
        expect(isSettingKey(key), `${section}: ${key}`).toBe(true);
        const pages = seen.get(key) ?? new Set<string>();
        pages.add(section);
        seen.set(key, pages);
      }
      // Nothing on the page is a control outside the schema: every input, switch,
      // select, segmented control and swatch sits inside a data-setting row or a
      // panel, apart from the page's own search field.
      for (const el of qa("input, textarea, select, .switch, .seg, .sw")) {
        const inside = el.closest("[data-setting], [data-panel], .settings-nav, .settings-search");
        expect(inside, `${section}: ${el.outerHTML.slice(0, 80)}`).not.toBeNull();
      }
      await unmount();
    }
    // The search results are the same cards: every data-setting there is a
    // schema key and no key appears twice, for a query that matches nearly everything.
    await mount({ initialSection: "appearance" }, { api: scriptedApi().api });
    await type(q<HTMLInputElement>(".settings-search input"), "e");
    const results = qa(".settings-results [data-setting]").map(
      (el) => el.getAttribute("data-setting") ?? "",
    );
    expect(results.length).toBeGreaterThan(10);
    expect(new Set(results).size).toBe(results.length);
    for (const key of results) expect(isSettingKey(key), key).toBe(true);
    for (const el of qa(".settings-results input, .settings-results .switch")) {
      expect(el.closest("[data-setting], [data-panel-result]")).not.toBeNull();
    }
    await unmount();
    for (const key of settingKeys) {
      const entry = settingsSchema[key] as SettingEntry;
      if (isStringKey(key) || entry.hidden) {
        expect(seen.has(key), key).toBe(false);
        continue;
      }
      const pages = seen.get(key);
      expect(pages?.size, `${key} on ${[...(pages ?? [])].join(", ")}`).toBe(1);
      expect([...(pages ?? [])][0], key).toBe(entry.section);
    }
    // Every special control the schema names has a registered renderer.
    for (const key of settingKeys) {
      const control = (settingsSchema[key] as SettingEntry).control;
      if (control) expect(controlKinds[control], `${key}: ${control}`).toBeDefined();
    }
  });

  test("a fresh page shows only what the current choices make relevant, folded behind disclosures that remember their state", async () => {
    await mount({ initialSection: "ai" }, { api: scriptedApi().api });
    // Local CLI: the CLIs and the chosen one's settings; no provider cards, no fold.
    expect(q('[data-setting="ai.local.cli"]')).not.toBeNull();
    expect(q('[data-setting="ai.hosted.provider"]')).toBeNull();
    expect(q('[data-group="Anthropic"]')).toBeNull();
    expect(q('[data-group="Other providers"]')).toBeNull();
    expect(q('[data-setting="ai.local.model.claude-code"]')).toBeNull();
    await click(q('[data-disclosure="ai/more/Runtime"]'));
    expect(q('[data-setting="ai.local.model.claude-code"]')).not.toBeNull();
    expect(q('[data-setting="ai.local.model.codex"]')).toBeNull();
    // The overview says it in plain words.
    expect(q('[data-overview="ai"]')?.textContent).toContain(
      "Claude Code on this computer answers the agent.",
    );
    // Hosted: the chosen provider's card is open, the rest fold into one row that says which have keys.
    await click(q('[data-setting="ai.mode"] .mode button:nth-child(2)'));
    expect(q('[data-group="Anthropic"] [data-setting="ai.share_key.anthropic"]')).not.toBeNull();
    expect(q('[data-setting="ai.local.cli"]')).toBeNull();
    const fold = q('[data-group="Other providers"]');
    expect(fold?.textContent).toContain("Gemini, OpenAI, Kimi, OpenRouter. None has a key.");
    expect(q('[data-setting="ai.share_key.gemini"]')).toBeNull();
    await click(q('[data-disclosure="ai/fold/Other providers"]'));
    expect(qa(".disclosure.folded").map((el) => el.dataset.folded)).toEqual([
      "Gemini",
      "OpenAI",
      "Kimi",
      "OpenRouter",
    ]);
    await click(q('[data-disclosure="ai/fold/Other providers/Gemini"]'));
    expect(q('[data-setting="ai.share_key.gemini"]')).not.toBeNull();
    // Prices and endpoints stay under the provider's own Advanced.
    expect(q('[data-setting="ai.pricing.anthropic"]')).toBeNull();
    await click(q('[data-disclosure="ai/own-advanced/Anthropic"]'));
    expect(q('[data-setting="ai.pricing.anthropic"]')).not.toBeNull();
    // The index lists what is on the page and marks what is folded.
    const index = qa(".settings-index a").map((a) => [a.textContent, a.dataset.folded ?? ""]);
    expect(index).toContainEqual(["Other providers", "true"]);
    expect(index).toContainEqual(["Anthropic", ""]);
    expect(index.at(-1)).toEqual(["Advanced", "true"]);
    // Leaving and coming back keeps what was open for the session.
    await act(async () => root?.unmount());
    root = null;
    host?.remove();
    host = null;
    await mount(
      { initialSection: "ai" },
      { api: scriptedApi().api },
      { "ai.mode": "hosted", "ai.level": "automate" },
    );
    expect(q('[data-setting="ai.share_key.gemini"]')).not.toBeNull();
    expect(q('[data-setting="ai.pricing.anthropic"]')).not.toBeNull();
  });

  test("routing: thresholds only when sorting is on, brief thresholds only in judge mode, the prompt only in model mode", async () => {
    await mountOpen({ initialSection: "routing" }, { api: scriptedApi().api });
    expect(q('[data-setting="routing.threshold.route"]')).not.toBeNull();
    expect(q('[data-setting="briefs.judge.always_at_least"]')).not.toBeNull();
    expect(q('[data-setting="briefs.prompt"]')).toBeNull();
    await clickText("Model", q('[data-setting="briefs.policy_mode"]') ?? document);
    expect(q('[data-setting="briefs.prompt"]')).not.toBeNull();
    expect(q('[data-setting="briefs.judge.always_at_least"]')).toBeNull();
    await click(q('[data-setting="routing.on_arrival"] .switch'));
    expect(q('[data-setting="routing.threshold.route"]')).toBeNull();
    expect(q('[data-group="Confidence"]')).toBeNull();
  });

  test("search finds a card a choice keeps off the page, says which choice, and one click makes it", async () => {
    await mount({ initialSection: "accounts" }, { api: scriptedApi().api });
    await type(q<HTMLInputElement>(".settings-search input"), "meeting url");
    const hit = q('[data-result-key="calendar.custom_link"]');
    expect(hit?.querySelector(".hidden-line")?.textContent).toContain(
      "Not on the page right now. It shows when Meeting link is Custom.",
    );
    await clickText("Set Meeting link to Custom", hit ?? document);
    expect(captured?.settings["calendar.meeting_link"]).toBe("custom");
    expect(q('[data-result-key="calendar.custom_link"] .hidden-line')).toBeNull();
    // Show in section on a folded card opens what it sits in.
    await type(q<HTMLInputElement>(".settings-search input"), "full check");
    await clickText("Show in sectionAccounts / Sync", q('[data-result="0"]') ?? document);
    expect(q(".settings-in")?.dataset.section).toBe("accounts");
    expect(q('[data-setting="sync.reconcile_minutes"]')).not.toBeNull();
    expect(q('[data-disclosure="accounts/group/Sync"]')?.getAttribute("aria-expanded")).toBe(
      "true",
    );
  });

  test("a Pinned key is locked with the file value and the line it is set on", async () => {
    const file = {
      path: "~/.config/monday/monday.toml",
      exists: true,
      text: '# my rice\n[appearance]\nmode = "dark"\n',
    };
    await mount(
      { initialSection: "appearance" },
      {
        pinned: new Set<SettingKey>(["appearance.mode"]),
        config: { file, values: { "appearance.mode": "dark" }, warnings: [], error: null },
      },
    );
    const row = q('[data-setting="appearance.mode"]');
    expect(row?.dataset.pinned).toBe("true");
    expect(row?.textContent).toContain("set in monday.toml");
    const lock = row?.querySelector<HTMLElement>(".pinned");
    expect(lock?.title).toBe('Set in ~/.config/monday/monday.toml, line 3: mode = "dark"');
    expect(row?.querySelector(".scard-foot")?.textContent).toContain(
      "Set in ~/.config/monday/monday.toml, line 3",
    );
    // No Reset on a pinned key: the file owns it.
    expect(row?.querySelector(".scard-foot .link")).toBeNull();
    // The control is inert: clicking Light changes nothing.
    await clickText("Light", row ?? document);
    expect(captured?.settings["appearance.mode"]).toBe("system");
    // And the Shell itself refuses the write, so no toast and no change.
    const result = await captured?.set("appearance.mode", "light");
    expect(result?.ok).toBe(false);
    expect(captured?.settings["appearance.mode"]).toBe("system");
    expect(q(".toast")).toBeNull();
    // A preset that touches a pinned knob is refused whole, before anything is written.
    if (root) await act(async () => root?.unmount());
    root = null;
    host?.remove();
    const scripted = scriptedApi();
    await mount(
      { initialSection: "appearance" },
      {
        api: scripted.api,
        pinned: new Set<SettingKey>(["layout.nav"]),
        config: { file, values: { "layout.nav": "rail" }, warnings: [], error: null },
      },
    );
    await clickText("Agent left", q('[data-setting="layout.preset"]') ?? document);
    expect(scripted.calls.filter((c) => c.name === "settings.set")).toHaveLength(0);
    expect(q('[data-setting="layout.preset"] .err')?.textContent).toContain("Set in");
  });

  test("a change applies at once and the toast undoes it", async () => {
    const { api } = scriptedApi();
    await mount({ initialSection: "appearance" }, { api });
    const row = q('[data-setting="appearance.mode"]');
    await clickText("Dark", row ?? document);
    expect(captured?.settings["appearance.mode"]).toBe("dark");
    expect(q(".toast")?.textContent).toContain("Light or dark changed");
    await clickText("Undo Z", q(".toast") ?? document);
    expect(captured?.settings["appearance.mode"]).toBe("system");
    expect(q(".toast")?.textContent).toContain("Undone");

    // A number commits on blur through the schema's range.
    const size = q<HTMLInputElement>('[data-setting="appearance.font_size"] input');
    await type(size, "16");
    await blur(size);
    expect(captured?.settings["appearance.font_size"]).toBe(16);
    await type(size, "99");
    await blur(size);
    expect(captured?.settings["appearance.font_size"]).toBe(16);
    expect(q('[data-setting="appearance.font_size"] .err')?.textContent).toContain("Not saved");

    // A refused number snaps the box back to the value in effect.
    expect(size?.value).toBe("16");

    // A preset writes the three knobs as one change, and its Undo restores them.
    await clickText("Agent left", q('[data-setting="layout.preset"]') ?? document);
    expect(captured?.layout).toEqual({ nav: "rail", agent: "left", list: "split" });
    await clickText("Undo Z", q(".toast") ?? document);
    expect(captured?.layout).toEqual({ nav: "full", agent: "bottom", list: "stream" });

    // The footer: the scope, the default, and Reset once the value differs.
    const density = q('[data-setting="appearance.density"]');
    expect(density?.querySelector(".scard-foot")?.textContent).toContain("Per device");
    expect(density?.querySelector(".scard-foot")?.textContent).toContain("Default: Comfortable");
    expect(density?.querySelector(".scard-foot .link")).toBeNull();
    await clickText("Compact", density ?? document);
    expect(captured?.settings["appearance.density"]).toBe("compact");
    await click(density?.querySelector(".scard-foot .link"));
    expect(captured?.settings["appearance.density"]).toBe("comfortable");
    expect(q('[data-setting="appearance.font_size"] .scard-foot')?.textContent).toContain(
      "Default: 14",
    );
  });

  test("Undo restores a boolean, an array and a record, in one toast each", async () => {
    await mountOpen({ initialSection: "routing" }, { api: scriptedApi().api });
    // A boolean.
    await click(q('[data-setting="reader.load_remote_images"] .switch'));
    expect(captured?.settings["reader.load_remote_images"]).toBe(true);
    await clickText("Undo Z", q(".toast") ?? document);
    expect(captured?.settings["reader.load_remote_images"]).toBe(false);
    // An array: a list item added, then undone.
    const senders = q('[data-setting="briefs.automated_senders"]');
    const before = captured?.settings["briefs.automated_senders"] ?? [];
    await type(senders?.querySelector<HTMLInputElement>(".set-list-add input") ?? null, "bot");
    await clickText("Add", senders ?? document);
    expect(captured?.settings["briefs.automated_senders"]).toEqual([...before, "bot"]);
    await clickText("Undo Z", q(".toast") ?? document);
    expect(captured?.settings["briefs.automated_senders"]).toEqual(before);
    // A record: a per-Group policy added, then undone.
    const policies = q('[data-setting="briefs.policy_groups"]');
    await clickText("Add", policies ?? document);
    expect(captured?.settings["briefs.policy_groups"]).toEqual({ "g-hiring": "always" });
    await clickText("Undo Z", q(".toast") ?? document);
    expect(captured?.settings["briefs.policy_groups"]).toEqual({});
  });

  test("Ask monday inputs hand their text to the composer, and Fix with monday carries the warnings", async () => {
    const { asked } = await mountOpen(
      { initialSection: "appearance" },
      {
        config: {
          file: { path: "monday.toml", exists: true, text: "[appearance]\nmod = 1\n" },
          values: {},
          warnings: [{ line: 2, key: "appearance.mod", message: "unknown key" }],
          error: null,
        },
      },
    );
    expect(text()).toContain("Line 2: unknown key");
    await clickText("Fix with monday", q('[data-panel="config"]') ?? document);
    expect(asked[0]).toContain("line 2: unknown key");

    const ask = q<HTMLInputElement>('[data-setting="views.list"] .set-ask input');
    await type(ask, "no nav, agent on the right");
    await clickText("Ask", q('[data-setting="views.list"]') ?? document);
    expect(asked[1]).toBe("Make me a view: no nav, agent on the right");
  });

  test("Section rules rename, hide and reorder through their Settings", async () => {
    await mount({ initialSection: "routing" }, { api: scriptedApi().api });
    const rules = q('[data-setting="sections.rules"]');
    expect(rules?.querySelector('[data-setting="sections.order"]')).not.toBeNull();
    await click(q('[data-rule="fyi"] button[aria-label="Up"]'));
    expect(captured?.settings["sections.order"]).toEqual([
      "needs-reply",
      "fyi",
      "waiting",
      "newsletters",
    ]);
    await click(q('[data-rule="newsletters"] .switch'));
    expect(captured?.settings["sections.rules"].find((r) => r.id === "newsletters")?.hidden).toBe(
      true,
    );
    await clickText("Rename", q('[data-rule="needs-reply"]') ?? document);
    const input = q<HTMLInputElement>('[data-rule="needs-reply"] input');
    await type(input, "Reply today");
    await blur(input);
    expect(captured?.settings["strings.section.needs-reply"]).toBe("Reply today");
    // The Groups tree is read-only and shows counts.
    expect(q('[data-group-id="g-hiring"]')?.textContent).toContain("7 threads, 0 examples");
  });
});

/* ------------------------------ AI and agent ------------------------------ */

describe("Settings › AI and agent", () => {
  test("keys are added and shared without ever being displayed", async () => {
    const scripted = scriptedApi();
    const keys = fakeKeys();
    await mountOpen({ initialSection: "ai", keys }, { api: scripted.api }, HOSTED);
    const row = q('[data-setting="ai.share_key.anthropic"]');
    expect(row?.textContent).toContain("No key on this device");
    await clickText("Add key", row ?? document);
    const input = row?.querySelector<HTMLInputElement>("input");
    expect(input?.type).toBe("password");
    await type(input ?? null, "sk-ant-secret");
    await clickText("Save", row ?? document);
    expect(keys.writes).toEqual(["anthropic:sk-ant-secret"]);
    expect(text()).not.toContain("sk-ant-secret");
    expect(row?.textContent).toContain("Key set");
    // The share switch sends the Device key and flips the Setting.
    await click(row?.querySelector(".switch"));
    expect(scripted.calls).toContainEqual({
      name: "keys.share",
      args: ["anthropic", "sk-ant-secret"],
    });
    expect(captured?.settings["ai.share_key.anthropic"]).toBe(true);
    // Sharing with no key on the Device is refused with the reason.
    const gemini = q('[data-setting="ai.share_key.gemini"]');
    await click(gemini?.querySelector(".switch"));
    expect(captured?.settings["ai.share_key.gemini"]).toBe(false);
    expect(gemini?.textContent).toContain("No key on this device");
  });

  test("the TypeSafe group sits above the providers: a key is checked live through the Server before it is saved, a wrong key is refused with the reason, the status line says who answers judgments, and Judgments is a segmented choice", async () => {
    const scripted = scriptedApi();
    const keys = fakeKeys();
    await mountOpen({ initialSection: "ai", keys }, { api: scripted.api }, HOSTED);
    // The group order: TypeSafe right after Runtime, before Anthropic.
    const groups = qa("[data-group]").map((el) => el.getAttribute("data-group"));
    expect(groups.indexOf("TypeSafe")).toBe(groups.indexOf("Runtime") + 1);
    expect(groups.indexOf("TypeSafe")).toBeLessThan(groups.indexOf("Anthropic"));
    // Auto with no key: the language model answers.
    const status = () => q('[data-panel="judge-status"]');
    expect(status()?.dataset.judge).toBe("llm");
    expect(status()?.textContent).toContain("The language model answers judgments.");
    expect(q('[data-setting="ai.judge.provider"] .seg')).not.toBeNull();

    const row = q('[data-setting="ai.share_key.typesafe"]');
    expect(row?.textContent).toContain("No key on this device");
    await clickText("Add key", row ?? document);
    const input = row?.querySelector<HTMLInputElement>("input");
    expect(input?.type).toBe("password");
    // A wrong key never reaches the keychain; the Server's reason is shown.
    await type(input ?? null, "ts-wrong");
    await clickText("Save", row ?? document);
    expect(scripted.calls).toContainEqual({
      name: "keys.validate",
      args: ["typesafe", "ts-wrong"],
    });
    expect(keys.writes).toEqual([]);
    expect(row?.textContent).toContain("TypeSafe does not know this key.");
    expect(text()).not.toContain("ts-wrong");
    // The right key is saved once TypeSafe accepted it, and never displayed.
    await type(row?.querySelector<HTMLInputElement>("input") ?? null, "ts-good");
    await clickText("Save", row ?? document);
    expect(keys.writes).toEqual(["typesafe:ts-good"]);
    expect(text()).not.toContain("ts-good");
    expect(row?.textContent).toContain("Key accepted");
    // In Settings the share switch keeps its default, off: the key stays on this device.
    expect(scripted.calls.some((c) => c.name === "keys.share")).toBe(false);
    expect(captured?.settings["ai.share_key.typesafe"]).toBe(false);
    expect(status()?.dataset.judge).toBe("typesafe");
    expect(status()?.textContent).toContain("TypeSafe answers judgments on jev-1.13.0.");
    expect(status()?.textContent).toContain("The key is on this device only.");
    // The share switch sends it under the envelope like any provider's.
    await click(row?.querySelector(".switch"));
    expect(scripted.calls).toContainEqual({ name: "keys.share", args: ["typesafe", "ts-good"] });
    expect(captured?.settings["ai.share_key.typesafe"]).toBe(true);
    expect(row?.textContent).toContain("Shared with the server");
    // Judgments pinned to the language model: the status follows the Setting.
    await click(
      [...(q('[data-setting="ai.judge.provider"]')?.querySelectorAll("button") ?? [])].find(
        (b) => b.textContent?.trim() === "Language model",
      ),
    );
    expect(captured?.settings["ai.judge.provider"]).toBe("llm");
    expect(status()?.dataset.judge).toBe("llm");
    // Removing the key with the Setting pinned to TypeSafe: no key answers.
    await click(
      [...(q('[data-setting="ai.judge.provider"]')?.querySelectorAll("button") ?? [])].find(
        (b) => b.textContent?.trim() === "TypeSafe",
      ),
    );
    await clickText("Remove", row ?? document);
    await clickText("Confirm", row ?? document);
    expect(status()?.dataset.judge).toBe("none");
    expect(status()?.textContent).toContain("No TypeSafe key.");
  });

  test("the task map, the tier list, the Meter and the Activity log", async () => {
    const activity: ActivityRecord[] = [
      {
        id: "act-1",
        workspaceId: "ws-1",
        sessionId: "s1",
        runId: null,
        tool: "archive_threads",
        tier: "reversible",
        inputSummary: "2 threads",
        status: "done",
        approvedBy: null,
        result: "Archived 2 threads",
        undoable: true,
        actor: "agent",
        callId: "c1",
        input: null,
        preview: null,
        decision: "auto",
        undoneAt: null,
        at: "2026-09-17T09:00:00Z",
      },
      {
        id: "act-2",
        workspaceId: "ws-1",
        sessionId: "s1",
        runId: null,
        tool: "send_draft",
        tier: "always-ask",
        inputSummary: "To Aoife",
        status: "done",
        approvedBy: "user",
        undoable: false,
        actor: "agent",
        callId: "c2",
        input: null,
        preview: null,
        decision: "approved",
        undoneAt: null,
        at: "2026-09-17T09:30:00Z",
      },
    ];
    const scripted = scriptedApi({
      activity,
      meter: {
        workspaceId: "ws-1",
        month: "2026-09",
        lines: [
          {
            task: "brief",
            provider: "anthropic",
            calls: 12,
            inputTokens: 30_000,
            outputTokens: 4_000,
            cachedTokens: 0,
            costMicros: 120_000,
          },
        ],
        costMicros: 120_000,
      },
    });
    await mountOpen({ initialSection: "ai" }, { api: scripted.api }, HOSTED);

    // Every Task has a row; promoting draft_message to always-ask writes the Setting.
    expect(qa('[data-setting^="ai.task."]')).toHaveLength(9);
    await clickText("Fast", q('[data-setting="ai.task.composer"]') ?? document);
    expect(captured?.settings["ai.task.composer"].role).toBe("fast");
    await click(q('[data-tool="draft_message"] .switch'));
    expect(captured?.settings["agent.always_ask"]).toEqual(["draft_message"]);
    expect(q('[data-tool="send_draft"]')?.textContent).toContain("Always ask");
    expect(q('[data-tool="send_draft"] .switch')).toBeNull();

    // The Meter by Task and provider with the estimate.
    const meter = q('[data-panel="meter"]');
    expect(meter?.textContent).toContain("brief");
    expect(meter?.textContent).toContain("$0.12");

    // The Activity log: searchable, with who approved and Undo where still possible.
    const log = q('[data-panel="activity"]');
    expect(log?.querySelectorAll(".activity-row")).toHaveLength(2);
    expect(q('[data-activity="act-2"]')?.textContent).toContain("Approved by you");
    expect(q('[data-activity="act-2"] button')).toBeNull();
    await type(log?.querySelector<HTMLInputElement>("input") ?? null, "archive");
    expect(log?.querySelectorAll(".activity-row")).toHaveLength(1);
    await clickText("Undo", q('[data-activity="act-1"]') ?? document);
    expect(scripted.calls).toContainEqual({ name: "agent.undo", args: ["act-1", "s1"] });
    expect(q('[data-activity="act-1"]')?.textContent).toContain("Undone");
  });
});

/* ------------------------------ The AI level (slice 20) ------------------------------ */

describe("Settings › AI and agent: the AI level", () => {
  const cardsOf = () => qa('[data-setting="ai.level"] .choice-card b').map((b) => b.textContent);

  test("at off only the three cards show; the rest of the section and the Ask monday inputs hide, the automation parts hide at assist", async () => {
    await mount({ initialSection: "ai" }, { api: scriptedApi().api }, { "ai.level": "off" });
    expect(cardsOf()).toEqual([
      "Just mail",
      "Mail with an assistant",
      "Mail that sorts and acts for me",
    ]);
    expect(q('[data-setting="ai.level"] .choice-card.on b')?.textContent).toBe("Just mail");
    expect(qa("[data-setting]").map((el) => el.getAttribute("data-setting"))).toEqual(["ai.level"]);
    expect(qa("[data-panel]")).toHaveLength(0);
    if (root) await act(async () => root?.unmount());
    root = null;
    host?.remove();
    // Routing at off: the Groups tree stays, the on-arrival and Brief policy knobs hide, no Ask monday.
    await mount({ initialSection: "routing" }, { api: scriptedApi().api }, { "ai.level": "off" });
    expect(q('[data-setting="routing.on_arrival"]')).toBeNull();
    expect(q('[data-setting="briefs.policy"]')).toBeNull();
    expect(q('[data-setting="sections.rules"]')).not.toBeNull();
    expect(qa(".set-ask")).toHaveLength(0);
    if (root) await act(async () => root?.unmount());
    root = null;
    host?.remove();
    // Assist: the Runtime and Permissions show; Workflows keeps only what the level allows.
    await mount({ initialSection: "ai" }, { api: scriptedApi().api }, { "ai.level": "assist" });
    expect(q('[data-setting="ai.mode"]')).not.toBeNull();
    expect(q('[data-setting="agent.always_ask"]')).not.toBeNull();
    if (root) await act(async () => root?.unmount());
    root = null;
    host?.remove();
    await mount(
      { initialSection: "workflows" },
      { api: scriptedApi().api },
      { "ai.level": "assist" },
    );
    expect(q('[data-setting="workflows.placement"]')).toBeNull();
    expect(qa("[data-setting]")).toHaveLength(0);
  });

  test("raising from off with no runtime configured shows the runtime step first; Continue saves the level", async () => {
    const scripted = scriptedApi();
    const captured = await mount(
      { initialSection: "ai", runtimes: { detect: async () => [] } },
      { api: scripted.api },
      { "ai.level": "off" },
    );
    void captured;
    await click(q('[data-setting="ai.level"] .choice-card[data-value="automate"]'));
    // Not saved yet: the runtime step sits under the cards.
    expect(scripted.calls.some((c) => c.name === "settings.set")).toBe(false);
    const step = q('[data-panel="runtime-step"]');
    expect(step).not.toBeNull();
    expect(step?.textContent).toContain("One thing first");
    expect(step?.querySelector('[data-setting="ai.mode"]')).not.toBeNull();
    expect(step?.querySelector('[data-setting="ai.local.cli"]')).not.toBeNull();
    const cont = [...(step?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent?.trim() === "Continue",
    );
    expect(cont?.disabled).toBe(true);
    // Back returns to the cards with off still in effect.
    await clickText("Back", step ?? document);
    expect(q('[data-panel="runtime-step"]')).toBeNull();
    expect(q('[data-setting="ai.level"] .choice-card.on b')?.textContent).toBe("Just mail");
  });

  test("with a CLI detected the cards save the level at once, and lowering keeps every other Setting", async () => {
    const scripted = scriptedApi();
    await mount(
      {
        initialSection: "ai",
        runtimes: {
          detect: async () => [
            { cli: "claude-code", version: "2.1.4", path: "/usr/bin/claude", status: "connected" },
          ],
        },
      },
      { api: scripted.api },
      { "ai.level": "off" },
    );
    await click(q('[data-setting="ai.level"] .choice-card[data-value="automate"]'));
    expect(q('[data-panel="runtime-step"]')).toBeNull();
    expect(scripted.calls.find((c) => c.name === "settings.set")?.args.slice(0, 2)).toEqual([
      "ai.level",
      "automate",
    ]);
    expect(q('[data-setting="ai.level"] .choice-card.on b')?.textContent).toBe(
      "Mail that sorts and acts for me",
    );
    // The rest of the section came back.
    expect(q('[data-setting="ai.mode"]')).not.toBeNull();
    await click(q('[data-setting="ai.level"] .choice-card[data-value="off"]'));
    expect(
      scripted.calls
        .filter((c) => c.name === "settings.set")
        .at(-1)
        ?.args.slice(0, 2),
    ).toEqual(["ai.level", "off"]);
    expect(scripted.calls.filter((c) => c.name === "settings.set")).toHaveLength(2);
  });
});

/* ------------------------------ Sync server ------------------------------ */

describe("Settings › AI › External access", () => {
  test("keys and signed-in clients with scope, Workspaces, expiry and last use; revoke; a new key shown once with Copy; a consent approved by code", async () => {
    const scripted = scriptedApi({
      credentials: [
        {
          id: "c1",
          kind: "key",
          name: "assistant",
          scope: "read",
          workspaceIds: ["ws-1"],
          createdAt: "2026-09-01T10:00:00Z",
          expiresAt: "2026-11-30T10:00:00Z",
          lastUsedAt: "2026-09-17T09:00:00Z",
          revokedAt: null,
          clientId: null,
          prefix: "mk_live_zzzzzz",
        },
        {
          id: "c2",
          kind: "oauth",
          name: "Claude Desktop",
          scope: "act",
          workspaceIds: null,
          createdAt: "2026-09-01T10:00:00Z",
          expiresAt: "2026-09-10T10:00:00Z",
          lastUsedAt: null,
          revokedAt: null,
          clientId: "client-1",
          prefix: null,
        },
      ],
      consents: [
        {
          id: "consent-1",
          clientId: "client-1",
          clientName: "Cursor",
          scope: "read",
          workspaceIds: null,
          code: "424242",
          expiresAt: "2026-09-17T10:10:00Z",
        },
      ],
    });
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (t: string) => void copied.push(t) },
    });
    await mountOpen({ initialSection: "ai" }, { api: scripted.api });
    const panel = q('[data-panel="external"]');
    expect(panel).not.toBeNull();
    // The Setting controls of the group render beside the panel, under Advanced.
    expect(q('[data-setting="external.rate_per_minute"]')).not.toBeNull();
    expect(q('[data-setting="external.key_expiry_days"]')).not.toBeNull();

    const key = q('[data-credential="c1"]');
    expect(key?.textContent).toContain("assistant (mk_live_zzzzzz...)");
    expect(key?.textContent).toContain("Key · Read only · 1 workspaces · Last used Today 09:00");
    expect(key?.textContent).toContain("Expires");
    const client = q('[data-credential="c2"]');
    expect(client?.textContent).toContain("Signed in · Read and act, asks first · All workspaces");
    expect(client?.textContent).toContain("Never used");
    expect(client?.textContent).toContain("Expired");

    // Revoke asks first, inline: Cancel keeps it, Confirm revokes.
    await clickText("Revoke", key ?? document);
    expect(key?.textContent).toContain("Revoke assistant?");
    expect(scripted.calls.find((c) => c.name === "external.revoke")).toBeUndefined();
    await clickText("Cancel", key ?? document);
    expect(key?.querySelector(".danger-ask .q")).toBeNull();
    await clickText("Revoke", key ?? document);
    await clickText("Confirm", key ?? document);
    expect(scripted.calls).toContainEqual({ name: "external.revoke", args: ["c1"] });

    // A new key: name, scope, expiry; then the secret once, with Copy.
    await clickText("New key");
    await type(q<HTMLInputElement>("#external-name"), "my assistant");
    await click(
      [...(q('[data-panel="external-new"]')?.querySelectorAll("button") ?? [])].find(
        (b) => b.textContent === "Read and act, asks first",
      ),
    );
    await type(q<HTMLInputElement>("#external-days"), "30");
    await clickText("Create key", q('[data-panel="external-new"]') ?? document);
    expect(scripted.calls).toContainEqual({
      name: "external.createKey",
      args: [{ name: "my assistant", scope: "act", workspaceIds: null, expiresInDays: 30 }],
    });
    const shown = q('[data-panel="external-key"]');
    expect(shown?.querySelector<HTMLInputElement>("input[data-secret]")?.value).toBe(
      "mk_live_abcdef0123456789",
    );
    expect(shown?.textContent).toContain("shown once");
    await clickText("Copy", shown ?? document);
    expect(copied).toEqual(["mk_live_abcdef0123456789"]);
    expect(shown?.textContent).toContain("Copied");
    await clickText("Done", shown ?? document);
    expect(q('[data-panel="external-key"]')).toBeNull();

    // An OAuth consent waiting: approved from the list, or by the code the page shows.
    const consent = q('[data-consent="consent-1"]');
    expect(consent?.textContent).toContain("Cursor wants Read only access, code 424242");
    await clickText("Approve", consent ?? document);
    expect(scripted.calls).toContainEqual({
      name: "external.approve",
      args: [{ id: "consent-1" }, null],
    });
    await type(q<HTMLInputElement>("#external-code"), "424242");
    await clickText("Approve", q('[data-panel="external-consents"] .wizard-action') ?? document);
    expect(scripted.calls).toContainEqual({
      name: "external.approve",
      args: [{ code: "424242" }, null],
    });
    expect(q('[data-panel="external-consents"]')?.textContent).toContain("Approved");
  });
});

describe("Settings › Sync server", () => {
  test("devices with this Device marked, revoke with confirm, pending codes to approve, and storage", async () => {
    const scripted = scriptedApi({
      devices: [
        { id: "d1", name: "Laptop", lastSeen: "2026-09-17T09:59:00Z" },
        { id: "d2", name: "Phone", lastSeen: "2026-09-16T09:00:00Z" },
      ],
      me: "d1",
      pending: {
        pending: [{ code: "123456", name: "Tablet", expiresAt: "2026-09-17T10:10:00Z" }],
        setupAvailable: false,
      },
    });
    await mountOpen(
      { initialSection: "server" },
      {
        api: scripted.api,
        sidecar: { port: 4242, token: "t", running: true },
        server: { kind: "sidecar", target: { baseUrl: "http://127.0.0.1:4242", token: "t" } },
      },
    );
    expect(q('[data-device="d1"]')?.textContent).toContain("This device");
    expect(q('[data-device="d1"] .danger-ask')).toBeNull();
    expect(q('[data-device="d2"]')?.textContent).not.toContain("This device");
    await clickText("Revoke", q('[data-device="d2"]') ?? document);
    expect(q('[data-device="d2"]')?.textContent).toContain("Phone");
    expect(scripted.calls.find((c) => c.name === "revoke")).toBeUndefined();
    await clickText("Confirm", q('[data-device="d2"]') ?? document);
    expect(scripted.calls).toContainEqual({ name: "revoke", args: ["d2"] });

    // A code another Device is showing, approved from here.
    expect(q('[data-pending="123456"]')?.textContent).toContain(
      "Tablet asked to pair, code 123456",
    );
    await clickText("Approve a code", q('[data-pending="123456"]') ?? document);
    expect(scripted.calls).toContainEqual({ name: "confirm", args: ["123456"] });

    // The schema-backed Connection controls render beside the panel.
    // Talk-to, the public URL and the root key only mean something with a Cloud; plain HTTP always does.
    expect(q('[data-setting="server.prefer"]')).toBeNull();
    expect(q('[data-setting="server.insecure_allowed"] .switch')).not.toBeNull();

    // Storage: the count and size, the recovery file from the keychain, export and import.
    expect(q('[data-panel="storage"]')?.textContent).toContain("12,418 messages, 1.9 GB");
    const recovery = q('[data-panel="recovery"]');
    expect(recovery?.textContent).toContain("In the keychain");
    // Export always shows the text with Copy, since a webview may not save files.
    await clickText("Export", recovery ?? document);
    const shown = q<HTMLTextAreaElement>('[data-panel="recovery-export"] textarea');
    expect(shown?.value).toContain("monday recovery");
    await clickText("Copy", q('[data-panel="recovery-export"]') ?? document);
    expect(q('[data-panel="recovery-export"]')?.textContent).toContain("Copied");
    await clickText("Import", recovery ?? document);
    await type(q<HTMLTextAreaElement>('[data-panel="recovery-import"] textarea'), "not a key");
    await clickText("Import", q('[data-panel="recovery-import"]') ?? document);
    expect(recovery?.querySelector(".scard-foot .err")?.textContent).toContain(
      "not a recovery key",
    );
  });
});

/* ------------------------------ Shortcuts ------------------------------ */

describe("Settings › Shortcuts", () => {
  test("the binding table is grouped, remappable and highlights conflicts", async () => {
    await mountOpen({ initialSection: "shortcuts" }, { api: scriptedApi().api });
    expect(qa(".bindings-area .g-name").map((h) => h.textContent)).toEqual([
      "Navigate",
      "Act",
      "Compose",
      "Select",
      "Views",
    ]);
    await click(q('[data-action="thread.star"] .chord-btn'));
    const input = q<HTMLInputElement>('[data-action="thread.star"] input');
    // The key pressed becomes the chord; no need to spell it.
    await act(async () =>
      input?.dispatchEvent(new KeyboardEvent("keydown", { key: "e", bubbles: true })),
    );
    expect(input?.value).toBe("e");
    await blur(input);
    expect(captured?.settings["keyboard.bindings"]).toEqual({ "thread.star": "e" });
    expect(q('[data-action="thread.star"]')?.classList.contains("clash")).toBe(true);
    expect(q('[data-action="thread.archive"]')?.textContent).toContain("Also bound to Star");
    // Reset drops the override.
    await click(q('[data-action="thread.star"] button[aria-label="Reset"]'));
    expect(captured?.settings["keyboard.bindings"]).toEqual({});
    // The keymap picker is the Setting.
    await clickText("Gmail", q('[data-setting="keyboard.keymap"]') ?? document);
    expect(captured?.settings["keyboard.keymap"]).toBe("gmail");
    expect(q('[data-action="thread.open"] .kbd')?.textContent).toBe("O");
  });
});

/* ------------------------------ Search and the page index ------------------------------ */

describe("Settings › search", () => {
  const names = Object.fromEntries(
    SETTING_SECTIONS.map((n) => [
      n,
      String(settingsSchema[`strings.settings.section.${n}`].default),
    ]),
  ) as Record<(typeof SETTING_SECTIONS)[number], string>;
  const index = () =>
    buildSearchIndex(names, [
      {
        section: "server",
        group: "Devices",
        label: "Devices",
        help: "Every device that holds a token.",
        terms: ["pairing", "revoke"],
        level: "off",
      },
    ]);
  const keysOf = (query: string, current: (typeof SETTING_SECTIONS)[number] = "appearance") =>
    searchSettings(index(), query, { level: "automate", current, limit: 40 }).map((h) =>
      h.entry.kind === "setting" ? h.entry.key : `panel:${h.entry.group}`,
    );

  test("the index holds every rendered key once and the panels, and ranks label prefix over word over help over key", () => {
    const idx = index();
    const keys = idx.filter((e) => e.kind === "setting").map((e) => (e as { key: string }).key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of settingKeys) {
      const entry = settingsSchema[key] as SettingEntry;
      const shown = !isStringKey(key) && !entry.hidden && !entry.renderedBy;
      expect(keys.includes(key), key).toBe(shown);
    }
    expect(idx.find((e) => e.kind === "panel")?.terms).toContain("pairing");
    // "density" is a label prefix on appearance.density; the help mentions of it come after.
    expect(keysOf("density")[0]).toBe("appearance.density");
    // "font" as a label prefix beats "Code font", a label word.
    expect(keysOf("font").slice(0, 2)).toEqual(["appearance.font", "appearance.monospace"]);
    expect(keysOf("font")).toContain("appearance.monospace");
    // An option label finds its setting: vim is a keymap, dark is a mode, meet is a link kind.
    expect(keysOf("vim")).toContain("keyboard.keymap");
    expect(keysOf("dark")).toContain("appearance.mode");
    expect(keysOf("meet").slice(0, 2)).toContain("calendar.meeting_link");
    // A raw key matches last, but matches.
    expect(keysOf("undo_toast")).toEqual(["inbox.undo_toast_ms"]);
    // A panel by its own terms and by its section name.
    expect(keysOf("pairing")).toEqual(["panel:Devices"]);
    expect(keysOf("sync server")).toContain("panel:Devices");
    // Every word must match; blank finds nothing.
    expect(keysOf("font monospace")).toEqual(["appearance.monospace"]);
    expect(keysOf("   ")).toEqual([]);
    // Ties go to the current section first: "seconds" appears in many helps.
    const fromServer = keysOf("seconds", "server");
    expect(settingsSchema[fromServer[0] as SettingKey].section).toBe("server");
    // The AI level hides what it hides.
    const atOff = searchSettings(index(), "brief", { level: "off", current: "routing", limit: 40 });
    expect(atOff.some((h) => h.entry.kind === "setting" && h.entry.key.startsWith("briefs."))).toBe(
      false,
    );
  });

  test("results are the same cards grouped by section with highlights, Show in section jumps to the card, arrows and Enter walk them, Escape clears", async () => {
    await mount({ initialSection: "appearance" }, { api: scriptedApi().api });
    const search = q<HTMLInputElement>(".settings-search input");
    await type(search, "keymap");
    expect(q(".settings-in")?.dataset.searching).toBe("true");
    const sections = qa("[data-result-section]").map((el) => el.dataset.resultSection);
    expect(sections[0]).toBe("shortcuts");
    const first = q('[data-result="0"]');
    expect(first?.dataset.resultKey).toBe("keyboard.keymap");
    expect(first?.querySelector("mark")?.textContent).toBe("Keymap");
    expect(first?.classList.contains("active")).toBe(true);
    // The card is the real control: changing it writes the Setting from the results.
    await clickText("Gmail", first ?? document);
    expect(captured?.settings["keyboard.keymap"]).toBe("gmail");
    // Arrows move the active card; Enter focuses its control.
    const down = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true });
    await act(async () => search?.dispatchEvent(down));
    expect(q('[data-result="1"]')?.classList.contains("active")).toBe(true);
    await act(async () =>
      search?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
    );
    expect(document.activeElement?.closest('[data-result="1"]')).not.toBeNull();
    // Show in section leaves the results for the section, at the card.
    await clickText("Show in sectionShortcuts / Keymap", first ?? document);
    expect(q(".settings-in")?.dataset.section).toBe("shortcuts");
    expect(q(".settings-in")?.dataset.searching).toBe("false");
    expect(q('[data-setting="keyboard.keymap"]')?.classList.contains("flash")).toBe(true);
    expect(q(".settings-nav .nav-item.on")?.textContent).toBe("Shortcuts");
    // A panel is findable by its terms, and a miss offers a suggestion.
    await type(q<HTMLInputElement>(".settings-search input"), "pairing");
    expect(q('[data-panel-result="Devices"]')).not.toBeNull();
    await type(q<HTMLInputElement>(".settings-search input"), "zzzz");
    expect(q('[data-panel="search-empty"]')?.textContent).toContain("Nothing matches zzzz.");
    expect(q('[data-panel="search-empty"]')?.textContent).toContain("Try a word");
    // Escape clears the field.
    await act(async () =>
      q(".settings-search input")?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      ),
    );
    expect(q<HTMLInputElement>(".settings-search input")?.value).toBe("");
    expect(q(".settings-in")?.dataset.searching).toBe("false");
    // The search key focuses the field from anywhere on the page.
    await act(async () =>
      q(".settings-content")?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "/", bubbles: true }),
      ),
    );
    expect(document.activeElement).toBe(q(".settings-search input"));
  });

  test("the page index lists the section's groups, a click jumps to the group, and the palette can open the search", async () => {
    await mount({ initialSection: "appearance" }, { api: scriptedApi().api });
    const items = qa(".settings-index a").map((a) => a.textContent);
    expect(items).toEqual([
      "Theme",
      "Palette",
      "Layout",
      "Text",
      "Views",
      "Inbox",
      "Calendar",
      "Search",
      "Config file",
      "Advanced",
    ]);
    // Groups with nothing primary start folded, and the index marks them.
    const folded = qa(".settings-index a[data-folded]").map((a) => a.textContent);
    expect(folded).toEqual(["Views", "Inbox", "Calendar", "Search", "Advanced"]);
    expect(q(".settings-index a.on")?.textContent).toBe("Theme");
    await click(q('.settings-index a[data-index-group="Text"]'));
    expect(q(".settings-index a.on")?.textContent).toBe("Text");
    expect(q("#group-text")).not.toBeNull();
    // A click on a folded group opens it.
    expect(q('[data-setting="calendar.day_start_hour"]')).toBeNull();
    await click(q('.settings-index a[data-index-group="Calendar"]'));
    expect(q('[data-setting="calendar.day_start_hour"]')).not.toBeNull();
    // About has one group: no index.
    if (root) await act(async () => root?.unmount());
    root = null;
    host?.remove();
    await mount({ initialSection: "about", initialSearch: true }, { api: scriptedApi().api });
    expect(qa(".settings-index a")).toHaveLength(0);
    expect(document.activeElement).toBe(q(".settings-search input"));
  });
});

/* ------------------------------ Accounts ------------------------------ */

describe("Settings › Accounts", () => {
  test("a fresh install welcomes with Connect an account; a provider card opens the wizard inline; Back keeps what was typed; a connected Account lists and removes with a confirm", async () => {
    const scripted = scriptedApi();
    let accounts: Awaited<ReturnType<typeof scripted.api.accounts.list>>["accounts"] = [];
    scripted.api.accounts.list = async () => ({ accounts });
    scripted.api.accounts.add = async (body) => {
      scripted.calls.push({ name: "accounts.add", args: [body] });
      const account = {
        id: "a-new",
        workspaceId: "ws-2",
        provider: body.provider,
        address: body.address,
        displayName: "",
        capabilities: {
          push: false,
          labels: true,
          snooze: false,
          mute: false,
          calendar: false,
          meetingLink: null,
        },
        connected: true,
        lastSync: null,
        lastError: null,
      };
      accounts = [account];
      return { account };
    };
    scripted.api.accounts.remove = async (id) => {
      scripted.calls.push({ name: "accounts.remove", args: [id] });
      accounts = [];
      return {};
    };
    await mount({ initialSection: "accounts" }, { api: scripted.api });
    const connect = q('[data-panel="connect"]');
    expect(connect?.textContent).toContain("Connect an account");
    expect(qa('[data-panel="connect"] .prov b').map((b) => b.textContent)).toEqual([
      "Fastmail or JMAP",
      "IMAP",
      "Google",
      "Microsoft",
    ]);
    expect(connect?.textContent).toContain("Needs an API token from Fastmail settings");
    expect(connect?.textContent).toContain("Needs an app registration in Azure");
    // The JMAP card opens its form inline; Back returns to the cards and keeps the draft.
    await click(q('[data-provider="jmap"]'));
    const sheet = q('[data-panel="add-account"]');
    expect(sheet?.textContent).toContain("Fastmail or JMAP");
    const inputs = () => [...(sheet?.querySelectorAll<HTMLInputElement>("input") ?? [])];
    await type(inputs()[0] ?? null, "me@fastmail.com");
    await clickText("Back", sheet ?? document);
    expect(q('[data-panel="add-account"]')).toBeNull();
    expect(q('[data-panel="connect"]')).not.toBeNull();
    // The Google wizard keeps its step and fields across Back too.
    await click(q('[data-provider="google"]'));
    await type(q<HTMLInputElement>(".wizard-field input"), "monday-1");
    await clickText("Next");
    expect(q(".wizard")?.dataset.step).toBe("api");
    await clickText("Back");
    await clickText("Back");
    expect(q('[data-panel="add-account"]')).toBeNull();
    await click(q('[data-provider="google"]'));
    expect(q(".wizard")?.dataset.step).toBe("project");
    expect(q<HTMLInputElement>(".wizard-field input")?.value).toBe("monday-1");
    await clickText("Back");
    // Connect through JMAP: the form remembers the address; Done closes the sheet and lists the Account.
    await click(q('[data-provider="jmap"]'));
    const again = q('[data-panel="add-account"]');
    const fields = [...(again?.querySelectorAll<HTMLInputElement>("input") ?? [])];
    expect(fields[0]?.value).toBe("me@fastmail.com");
    await type(fields[2] ?? null, "fmu1-token");
    await clickText("Connect", again ?? document);
    expect(scripted.calls.find((c) => c.name === "accounts.add")).toBeDefined();
    expect(q('[data-panel="add-account"]')?.textContent).toContain(
      "me@fastmail.com is connected. Mail starts syncing now.",
    );
    await clickText("Done", q('[data-panel="add-account"]') ?? document);
    expect(q('[data-panel="add-account"]')).toBeNull();
    const card = q('[data-account="a-new"]');
    expect(card?.textContent).toContain("me@fastmail.com");
    expect(card?.textContent).toContain("Polling");
    expect(card?.textContent).toContain("Not synced yet");
    expect(card?.querySelector(".tag")?.textContent).toBe("Connected");
    expect(q('[data-panel="connect"]')?.textContent).toContain("Connect another account");
    // Remove asks, says what is deleted, then removes.
    await clickText("Remove", card ?? document);
    expect(card?.textContent).toContain("Remove me@fastmail.com?");
    expect(card?.textContent).toContain("mailbox itself is untouched");
    expect(scripted.calls.find((c) => c.name === "accounts.remove")).toBeUndefined();
    await clickText("Confirm", card ?? document);
    expect(scripted.calls).toContainEqual({ name: "accounts.remove", args: ["a-new"] });
    expect(q('[data-account="a-new"]')).toBeNull();
  });

  test("a failed remove and a last error show in plain words", async () => {
    const scripted = scriptedApi();
    const base = scripted.api.accounts.list;
    scripted.api.accounts.list = async () => {
      const r = await base();
      return { accounts: r.accounts.map((a) => ({ ...a, lastError: "IMAP login refused" })) };
    };
    scripted.api.accounts.remove = async () => {
      throw new Error("server says no");
    };
    await mount({ initialSection: "accounts" }, { api: scripted.api });
    const card = q('[data-account="a1"]');
    expect(card?.textContent).toContain("Last error: IMAP login refused");
    await clickText("Remove", card ?? document);
    await clickText("Confirm", card ?? document);
    expect(card?.textContent).toContain("Could not remove the account: server says no");
  });
});

/* ------------------------------ Panels: every button does something ------------------------------ */

describe("Settings › panels", () => {
  test("a saved key updates the provider list at once, and the runtime step continues once a key is added", async () => {
    const scripted = scriptedApi();
    const keys = fakeKeys();
    await mount(
      { initialSection: "ai", keys, runtimes: { detect: async () => [] } },
      { api: scripted.api },
      { "ai.level": "off" },
    );
    await click(q('[data-setting="ai.level"] .choice-card[data-value="assist"]'));
    const step = q('[data-panel="runtime-step"]');
    await click(step?.querySelector('[data-setting="ai.mode"] .mode button:nth-child(2)'));
    await settle();
    expect(q('[data-setting="ai.hosted.provider"] .prov.on')?.textContent).toContain("Add key");
    const cont = () =>
      [...(q('[data-panel="runtime-step"]')?.querySelectorAll("button") ?? [])].find(
        (b) => b.textContent?.trim() === "Continue",
      );
    expect(cont()?.disabled).toBe(true);
    const row = q('[data-setting="ai.share_key.anthropic"]');
    await clickText("Add key", row ?? document);
    await type(row?.querySelector<HTMLInputElement>("input") ?? null, "sk-ant-1");
    await clickText("Save", row ?? document);
    // The provider card and the Continue button follow the keychain without a reload.
    expect(q('[data-setting="ai.hosted.provider"] .prov.on')?.textContent).toContain("Key set");
    expect(cont()?.disabled).toBe(false);
    await click(cont());
    expect(captured?.settings["ai.level"]).toBe("assist");
    // Remove asks first, then forgets the key and the card follows.
    await clickText("Remove", q('[data-setting="ai.share_key.anthropic"]') ?? document);
    await clickText("Confirm", q('[data-setting="ai.share_key.anthropic"]') ?? document);
    expect(q('[data-setting="ai.hosted.provider"] .prov.on')?.textContent).toContain("Add key");
  });

  test("the Meter has a month picker, the Activity log shows a failed Undo, and Check for updates reports", async () => {
    const months: string[] = [];
    const scripted = scriptedApi({
      activity: [
        {
          id: "act-1",
          workspaceId: "ws-1",
          sessionId: "s1",
          runId: null,
          tool: "archive_threads",
          tier: "reversible",
          inputSummary: "2 threads",
          status: "done",
          approvedBy: null,
          result: "Archived 2 threads",
          undoable: true,
          actor: "agent",
          callId: "c1",
          input: null,
          preview: null,
          decision: "auto",
          undoneAt: null,
          at: "2026-09-17T09:00:00Z",
        },
      ],
    });
    scripted.api.meter.month = async (_ws, month) => {
      months.push(month ?? "");
      return { workspaceId: "ws-1", month: month ?? "", lines: [], costMicros: 0 };
    };
    scripted.api.agent.undo = async () => {
      throw new Error("already gone");
    };
    const releases: string[] = [];
    await mountOpen(
      {
        initialSection: "ai",
        latestRelease: async (source) => {
          releases.push(source);
          return { version: "v0.2.0", url: "https://example.test/releases/v0.2.0" };
        },
      },
      { api: scripted.api },
    );
    const meter = q('[data-panel="meter"]');
    expect(meter?.dataset.month).toBe("2026-09");
    expect(meter?.textContent).toContain("September 2026");
    await click(meter?.querySelector('button[aria-label="Previous month"]'));
    expect(q('[data-panel="meter"]')?.dataset.month).toBe("2026-08");
    expect(months.at(-1)).toBe("2026-08");
    expect(q('[data-panel="meter"]')?.textContent).toContain("August 2026");
    await clickText("This month", q('[data-panel="meter"]') ?? document);
    expect(q('[data-panel="meter"]')?.dataset.month).toBe("2026-09");
    expect(
      q<HTMLButtonElement>('[data-panel="meter"] button[aria-label="Next month"]')?.disabled,
    ).toBe(true);
    // A failed Undo says so instead of doing nothing.
    await clickText("Undo", q('[data-activity="act-1"]') ?? document);
    expect(q('[data-panel="activity"]')?.textContent).toContain("Undo failed: already gone");

    if (root) await act(async () => root?.unmount());
    root = null;
    host?.remove();
    await mount(
      {
        initialSection: "about",
        version: "0.1.0",
        latestRelease: async (source) => {
          releases.push(source);
          return { version: "v0.2.0", url: "https://example.test/releases/v0.2.0" };
        },
      },
      { api: scripted.api },
    );
    await clickText("Check for updates");
    expect(releases).toEqual(["https://github.com/dopeCape/monday"]);
    expect(q('[data-panel="about"]')?.textContent).toContain("v0.2.0 is available.");
    expect(q('[data-panel="about"]')?.textContent).toContain("Release notes");
  });

  test("Check for updates reports up to date and a failure", async () => {
    await mount(
      {
        initialSection: "about",
        version: "0.2.0",
        latestRelease: async () => ({ version: "v0.2.0", url: "" }),
      },
      { api: scriptedApi().api },
    );
    await clickText("Check for updates");
    expect(q('[data-panel="about"]')?.textContent).toContain("You have the latest version.");
    if (root) await act(async () => root?.unmount());
    root = null;
    host?.remove();
    await mount(
      {
        initialSection: "about",
        latestRelease: async () => {
          throw new Error("offline");
        },
      },
      { api: scriptedApi().api },
    );
    await clickText("Check for updates");
    expect(q('[data-panel="about"]')?.textContent).toContain("Could not check: offline");
  });

  test("Views delete and MCP server remove ask first; the Voice profile switch writes and reports a failure", async () => {
    const scripted = scriptedApi();
    scripted.api.voice.put = async () => {
      throw new Error("no server");
    };
    await mountOpen(
      { initialSection: "appearance" },
      { api: scripted.api },
      {
        "ai.level": "automate",
        "views.list": [
          {
            id: "v1",
            name: "Triage",
            layout: { nav: "hidden", agent: "bottom", list: "stream" },
            shortcut: "mod+2",
          },
        ],
      },
    );
    const view = q('[data-view="v1"]');
    await clickText("Delete", view ?? document);
    expect(view?.textContent).toContain("Delete the view Triage?");
    expect(captured?.settings["views.list"]).toHaveLength(1);
    await clickText("Confirm", view ?? document);
    expect(captured?.settings["views.list"]).toHaveLength(0);
    if (root) await act(async () => root?.unmount());
    root = null;
    host?.remove();
    await mount(
      { initialSection: "workflows" },
      { api: scripted.api },
      {
        "ai.level": "automate",
        "workflows.mcp_servers": [{ name: "notes", command: "notes-mcp", tools: [] }],
      },
    );
    const mcp = q('[data-mcp="notes"]');
    await clickText("Remove", mcp ?? document);
    expect(mcp?.textContent).toContain("Remove notes?");
    await clickText("Confirm", mcp ?? document);
    expect(captured?.settings["workflows.mcp_servers"]).toEqual([]);
    if (root) await act(async () => root?.unmount());
    root = null;
    host?.remove();
    await mountOpen({ initialSection: "accounts" }, { api: scripted.api });
    const voice = q('[data-panel="voice"]');
    expect(voice?.textContent).toContain("Built");
    await click(voice?.querySelector(".switch"));
    expect(voice?.textContent).toContain("That did not work: no server");
  });
});

/* ------------------------------ Several keys as one change ------------------------------ */

describe("writeAll", () => {
  test("writes in order and, when one key is refused, puts the earlier ones back", async () => {
    const log: string[] = [];
    const set = async (key: SettingKey, value: unknown) => {
      log.push(`${key}=${JSON.stringify(value)}`);
      if (key === "layout.list") {
        return { ok: false as const, reason: "invalid" as const, message: "no such list" };
      }
      return { ok: true as const };
    };
    const result = await writeAll(
      set as never,
      [
        ["layout.nav", "hidden"],
        ["layout.agent", "right"],
        ["layout.list", "bogus"],
      ],
      [
        ["layout.nav", "full"],
        ["layout.agent", "bottom"],
        ["layout.list", "stream"],
      ],
    );
    expect(result).toEqual({ ok: false, reason: "invalid", message: "no such list" });
    expect(log).toEqual([
      'layout.nav="hidden"',
      'layout.agent="right"',
      'layout.list="bogus"',
      'layout.nav="full"',
      'layout.agent="bottom"',
    ]);
  });
});

/* ------------------------------ Appearance on the document ------------------------------ */

describe("Settings › Appearance on the document", () => {
  test("the Transitions switch flips the root attribute the motion tokens read", async () => {
    // The real Shell over a fake host, so the document root is written.
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const r = root;
    await act(async () =>
      r.render(
        <Shell host={fakePlatform("")}>
          <Settings initialSection="appearance" now={() => NOW} keys={fakeKeys()} />
        </Shell>,
      ),
    );
    await settle();
    await openAll();
    const doc = document.documentElement;
    expect(doc.dataset.transitions).toBe("auto");
    const card = q('[data-setting="appearance.transitions"]');
    const sw = card?.querySelector<HTMLButtonElement>(".switch");
    expect(sw?.getAttribute("aria-checked")).toBe("true");
    await click(sw);
    expect(doc.dataset.transitions).toBe("off");
    expect(sw?.getAttribute("aria-checked")).toBe("false");
    // The switch is per device, and the card says so.
    expect(card?.dataset.scope).toBe("device");
    await click(sw);
    expect(doc.dataset.transitions).toBe("auto");
  });

  test("a palette file that does not parse says so on the card; a good one names itself", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const r = root;
    const good = `name = "Moss"\n[light]\n${PALETTE_HALF}\n[dark]\n${PALETTE_HALF}\n`;
    await act(async () =>
      r.render(
        <Shell
          host={fakePlatform("", {
            files: { "/p/broken.toml": "[light]\nbg = 1\n", "/p/moss.toml": good },
          })}
        >
          <Settings initialSection="appearance" now={() => NOW} keys={fakeKeys()} />
        </Shell>,
      ),
    );
    await settle();
    const card = () => q('[data-setting="appearance.palette"]');
    await click(card()?.querySelector(".sw.custom"));
    const path = card()?.querySelector<HTMLInputElement>(".palette-path input") ?? null;
    await type(path, "/p/broken.toml");
    await blur(path);
    await settle();
    expect(card()?.textContent).toContain("bg must be a color string");
    expect(document.documentElement.dataset.palette).toBe("custom");
    await type(path, "/p/moss.toml");
    await blur(path);
    await settle();
    expect(card()?.querySelector("[data-palette-name]")?.textContent).toBe(
      "Moss, from the palette file",
    );
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("#f0f4ee");
  });
});

const PALETTE_HALF = [
  'bg = "#f0f4ee"',
  'panel = "#ffffff"',
  'sunken = "#e6ebe3"',
  'raised = "#ffffff"',
  'overlay = "#ffffff"',
  'fg = "#1f2a1c"',
  'fg-muted = "#5f6d5a"',
  'fg-faint = "#98a493"',
  'accent = "#3a7d44"',
  'accent-fg = "#ffffff"',
  'success = "#1f9d61"',
  'warning = "#d4880f"',
  'danger = "#d9403c"',
  'info = "#2f7fd6"',
  'tag-1 = "#3a7d44"',
  'tag-2 = "#1f9d61"',
  'tag-3 = "#d4880f"',
  'tag-4 = "#b8479a"',
  'tag-5 = "#2a9fa8"',
].join("\n");

/* ------------------------------ The Agent changes any of them ------------------------------ */

describe("the Agent's change_setting tool reaches every page", () => {
  /** One key per section, the value the Agent sets, and what the rendered control shows. */
  const cases: Array<{
    section: (typeof SETTING_SECTIONS)[number];
    key: SettingKey;
    value: unknown;
    shows: (row: HTMLElement) => boolean;
  }> = [
    {
      section: "accounts",
      key: "send.delay_seconds",
      value: 45,
      shows: (row) => row.querySelector<HTMLInputElement>("input")?.value === "45",
    },
    {
      section: "appearance",
      key: "appearance.density",
      value: "compact",
      shows: (row) => row.querySelector('[aria-pressed="true"]')?.textContent === "Compact",
    },
    {
      section: "routing",
      key: "routing.threshold.route",
      value: 0.9,
      shows: (row) => row.querySelector<HTMLInputElement>("input")?.value === "0.9",
    },
    {
      section: "ai",
      key: "ai.web_fetch",
      value: true,
      shows: (row) => row.querySelector(".switch")?.getAttribute("aria-checked") === "true",
    },
    {
      section: "workflows",
      key: "workflows.placement",
      value: "local",
      shows: (row) => row.querySelector('[aria-pressed="true"]')?.textContent === "Local",
    },
    {
      section: "server",
      key: "search.cache_cap_gb",
      value: 5,
      shows: (row) => row.querySelector<HTMLInputElement>("input")?.value === "5",
    },
    {
      section: "shortcuts",
      key: "keyboard.keymap",
      value: "natural",
      shows: (row) => row.querySelector('[aria-pressed="true"]')?.textContent === "Natural",
    },
  ];

  for (const c of cases) {
    test(`${c.section}: ${c.key}`, async () => {
      // The Server's tool server over a fake ToolHost whose settings the scripted api serves.
      const toolHost = createFakeToolHost([], { now: () => NOW });
      const scripted = scriptedApi();
      const serveHost = () => {
        for (const [k, v] of toolHost.settings) scripted.stored[k] = v;
      };
      const server = createToolServer({
        host: toolHost,
        activity: createMemoryActivityLog({ now: () => NOW }),
        now: () => NOW,
        settings: async () => ({ previewAbove: 10, alwaysAsk: [], searchLimit: 100 }),
      });
      await mountOpen({ initialSection: c.section }, { api: scripted.api });
      const before = q<HTMLElement>(`[data-setting="${c.key}"]`);
      expect(before, c.key).not.toBeNull();
      expect(c.shows(before as HTMLElement)).toBe(false);

      const outcome = await server.call(
        {
          name: "change_setting",
          args: { key: c.key, value: c.value },
          callId: "c1",
          sessionId: "s1",
        },
        { ask: async () => "approved" },
      );
      expect(outcome.isError, outcome.text).toBe(false);
      expect(toolHost.writes).toEqual([{ key: c.key, value: c.value }]);

      serveHost();
      await act(async () => captured?.refresh());
      await settle();
      expect(captured?.settings[c.key]).toEqual(c.value as never);
      const after = q<HTMLElement>(`[data-setting="${c.key}"]`);
      expect(c.shows(after as HTMLElement), c.key).toBe(true);
    });
  }

  test("about: a string Setting changes the rendered telemetry line", async () => {
    const toolHost = createFakeToolHost([], { now: () => NOW });
    const scripted = scriptedApi();
    const server = createToolServer({
      host: toolHost,
      activity: createMemoryActivityLog({ now: () => NOW }),
      now: () => NOW,
      settings: async () => ({ previewAbove: 10, alwaysAsk: [], searchLimit: 100 }),
    });
    await mount({ initialSection: "about" }, { api: scripted.api });
    expect(text()).toContain("monday sends no telemetry.");
    await server.call(
      {
        name: "change_setting",
        args: { key: "strings.about.telemetry", value: "No telemetry, ever." },
        callId: "c1",
        sessionId: "s1",
      },
      { ask: async () => "approved" },
    );
    for (const [k, v] of toolHost.settings) scripted.stored[k] = v;
    await act(async () => captured?.refresh());
    await settle();
    expect(text()).toContain("No telemetry, ever.");
  });
});
