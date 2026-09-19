/// <reference types="bun-types" />
// The onboarding screen through the DOM with happy-dom (docs/spec/onboarding.md,
// slice 20): the three cards; `off` ends with the keymap question and seeds
// density; moving up from `off` with no runtime configured shows the runtime
// step first; with a CLI detected the conversation runs on the fake Agent
// client with the onboarding context, sender and tool chips per question,
// Skip, the Groups proposal card with its move counts and Approve, and Done
// once the keymap landed; every step writes onboarding.state for the Account.
// The App offers it once per Account, renders no agent bar at `off`, and
// runs it again from "Set me up".

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { defaultSettings, type PartialSettings } from "@monday/shared";
import { dom } from "@monday/ui/test-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { App } from "../App.tsx";
import { type FakeAgentClient, fakeAgentClient, toolEvent } from "../agent/client.ts";
import { StaticShell, useShell } from "../shell/Shell.tsx";
import { chipsForQuestion, densityFor, Onboarding, type OnboardingProps } from "./Onboarding.tsx";

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

const NOW = new Date("2026-09-19T10:00:00Z");
const settle = () => act(async () => Bun.sleep(20));
const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const qa = <T extends Element = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)];
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
const card = (value: string) => q(`.choice-card[data-value="${value}"]`);

/** What the Shell holds now, for assertions on Settings written by the screen. */
let captured: ReturnType<typeof useShell> | null = null;
function Capture() {
  captured = useShell();
  return null;
}

const detected = {
  detect: async () => [
    {
      cli: "claude-code" as const,
      version: "2.1",
      path: "/usr/bin/claude",
      status: "connected" as const,
    },
  ],
};
const nothing = { detect: async () => [] };

async function mount(
  props: Partial<OnboardingProps> & { client?: FakeAgentClient },
  settings: PartialSettings = {},
) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const r = root;
  const done: string[] = [];
  const { client, ...rest } = props;
  await act(async () =>
    r.render(
      <StaticShell settings={settings}>
        <Capture />
        <Onboarding
          accountId="acct-1"
          workspaceId="ws-1"
          address="sam@monday.test"
          agentClient={client ?? null}
          runtimes={nothing}
          keys={null}
          senders={["Aoife Byrne", "Mateo Silva", "Priya Raman"]}
          threadCount={24}
          screenWidth={1440}
          now={NOW}
          onDone={() => done.push("done")}
          {...rest}
        />
      </StaticShell>,
    ),
  );
  await settle();
  return { done };
}

describe("onboarding: the first screen and the AI level", () => {
  test("density comes from the screen size and the chips follow the question", () => {
    expect(densityFor(1024)).toBe("compact");
    expect(densityFor(1440)).toBe("comfortable");
    expect(densityFor(2560)).toBe("spacious");
    const s = defaultSettings();
    expect(chipsForQuestion(1, s, ["A"])).toEqual([]);
    expect(chipsForQuestion(2, s, ["A", "B"])).toEqual(["A", "B", "I get a lot of mail"]);
    expect(chipsForQuestion(3, s, [])).toEqual(["Slack", "Notion", "Drive", "Discord"]);
    expect(chipsForQuestion(4, s, [])).toEqual(["Yes", "No"]);
    expect(chipsForQuestion(6, s, [])).toEqual([]);
  });

  test("Just mail: the three cards, then the keymap question, then done; density seeded, the state completed", async () => {
    const { done } = await mount({ screenWidth: 1024 });
    expect(q('[data-screen="onboarding"]')?.dataset.step).toBe("level");
    expect(qa(".choice-card b").map((b) => b.textContent)).toEqual([
      "Just mail",
      "Mail with an assistant",
      "Mail that sorts and acts for me",
    ]);
    expect(text()).not.toContain("sparkle");
    // Nothing chosen yet: Continue waits.
    const cont = qa<HTMLButtonElement>("button").find((b) => b.textContent?.trim() === "Continue");
    expect(cont?.disabled).toBe(true);
    await click(card("off"));
    await clickText("Continue");
    expect(q('[data-screen="onboarding"]')?.dataset.step).toBe("keymap");
    expect(text()).toContain("How do you like your keys?");
    expect(q(".choice-card.on")?.dataset.value).toBe("vim");
    await click(card("gmail"));
    expect(captured?.settings["keyboard.keymap"]).toBe("gmail");
    await clickText("Done");
    expect(done).toEqual(["done"]);
    expect(captured?.settings["ai.level"]).toBe("off");
    expect(captured?.settings["appearance.density"]).toBe("compact");
    expect(captured?.settings["onboarding.state"]).toEqual({
      "acct-1": { status: "completed", at: NOW.toISOString() },
    });
  });

  test("Skip on the first screen records skipped and leaves the level alone", async () => {
    const { done } = await mount({});
    await clickText("Skip");
    expect(done).toEqual(["done"]);
    expect(captured?.settings["onboarding.state"]?.["acct-1"]?.status).toBe("skipped");
    expect(captured?.settings["ai.level"]).toBe("off");
  });

  test("moving up from off with no runtime configured shows the runtime step first; the level is saved after it", async () => {
    await mount({ runtimes: nothing });
    await click(card("automate"));
    await clickText("Continue");
    expect(q('[data-screen="onboarding"]')?.dataset.step).toBe("runtime");
    expect(text()).toContain("One thing first");
    expect(q('[data-setting="ai.mode"]')).not.toBeNull();
    expect(q('[data-setting="ai.local.cli"]')).not.toBeNull();
    // Not saved: nothing was configured, so Continue waits and the level is still off.
    expect(captured?.settings["ai.level"]).toBe("off");
    const cont = qa('[data-panel="runtime-step"] button').find(
      (b) => b.textContent?.trim() === "Continue",
    );
    expect((cont as HTMLButtonElement | undefined)?.disabled).toBe(true);
    await clickText("Back");
    expect(q('[data-screen="onboarding"]')?.dataset.step).toBe("level");
  });

  test("Set me up again starts from the three choices with the current level marked, and seeds no density", async () => {
    await mount({ rerun: true, screenWidth: 1024 }, { "ai.level": "assist" });
    expect(q(".choice-card.on")?.dataset.value).toBe("assist");
    expect(captured?.settings["appearance.density"]).toBe("comfortable");
  });
});

describe("onboarding: the welcome before any Account", () => {
  test("the level cards come first, then the keymap, then connecting the first Account; the welcome is recorded", async () => {
    const { done } = await mount({
      mode: "welcome",
      accountId: "welcome",
      workspaceId: "",
      address: "",
    });
    expect(q('[data-screen="onboarding"]')?.dataset.step).toBe("level");
    await click(card("off"));
    await clickText("Continue");
    expect(q('[data-screen="onboarding"]')?.dataset.step).toBe("keymap");
    // The welcome continues to the Account instead of finishing.
    await clickText("Continue");
    expect(q('[data-screen="onboarding"]')?.dataset.step).toBe("connect");
    expect(text()).toContain("Connect an account");
    expect(text()).toContain("Gmail");
    expect(done).toEqual([]);
    // Connecting later skips the rest and records the welcome, so it never re-asks.
    await clickText("Connect later");
    expect(done).toEqual(["done"]);
    expect(captured?.settings["onboarding.state"]).toEqual({
      welcome: { status: "skipped", at: NOW.toISOString() },
    });
  });

  test("with an assistant chosen the welcome still goes to the keymap and the Account, never the conversation", async () => {
    await mount(
      { mode: "welcome", accountId: "welcome", workspaceId: "", address: "", runtimes: detected },
      { "ai.mode": "local", "ai.local.cli": "claude-code" },
    );
    await click(card("assist"));
    await clickText("Continue");
    expect(q('[data-screen="onboarding"]')?.dataset.step).toBe("keymap");
    expect(captured?.settings["ai.level"]).toBe("assist");
  });
});

describe("onboarding: the conversation", () => {
  test("automate with a CLI detected: the conversation runs with the onboarding context, chips per question, Skip, the Groups card with move counts, Approve, and Done after the keymap", async () => {
    const client = fakeAgentClient({
      workspaceId: "ws-1",
      now: () => NOW,
      turns: [
        () => [
          toolEvent({ id: "c-ctx", tool: "onboarding_context", status: "done" }),
          { kind: "text", id: "t1", text: "Who are you and what do you do?" },
        ],
        () => [{ kind: "text", id: "t2", text: "What mail matters most?" }],
        () => [{ kind: "text", id: "t3", text: "Which tools do you use?" }],
        () => [{ kind: "text", id: "t4", text: "May monday learn your voice?" }],
        () => [{ kind: "text", id: "t5", text: "May monday read the last 30 days?" }],
        () => [
          toolEvent(
            {
              id: "c-groups",
              tool: "propose_groups",
              tier: "reversible",
              inputSummary: "Northwind, Lumen",
              status: "waiting",
            },
            {
              kind: "text",
              text: "Northwind: Everything from Aoife. (4 threads would move)\nLumen: Mail from Lumen. (2 threads would move)\nOver the newest 24 threads. Nothing moves until you approve; one Undo puts it all back.",
            },
          ),
        ],
      ],
      onApprove: (call) => [
        toolEvent({
          ...call,
          status: "done",
          approvedBy: "user",
          undoable: true,
          result: "Created 2 Groups; 6 threads moved.",
        }),
        toolEvent({
          id: "c-keys",
          tool: "set_keymap",
          tier: "reversible",
          inputSummary: "vim",
          status: "done",
        }),
        { kind: "text", id: "t6", text: "Done. Set me up in the composer runs this again." },
      ],
    });
    const { done } = await mount({ client, runtimes: detected });
    await click(card("automate"));
    await clickText("Continue");
    // A CLI is detected: no runtime step, the level is saved and the conversation opens on its own Session.
    expect(captured?.settings["ai.level"]).toBe("automate");
    expect(q('[data-screen="onboarding"]')?.dataset.step).toBe("chat");
    await settle();
    expect(client.sessions).toHaveLength(1);
    expect(client.sent[0]).toMatchObject({
      text: "Set me up.",
      context: { onboarding: true },
    });
    expect(text()).toContain("Who are you and what do you do?");
    // Question 1: no chips but Skip; the user types.
    expect(qa(".onboarding-chips .chip").map((c) => c.textContent)).toEqual(["Skip"]);
    const input = q<HTMLInputElement>(".agent-bar input");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(input, "I run a small studio");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      q<HTMLFormElement>("form.agent-bar")?.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await settle();
    expect(client.sent[1]?.text).toBe("I run a small studio");
    // Question 2: the top senders already synced, plus lots of mail, plus Skip.
    expect(qa(".onboarding-chips .chip").map((c) => c.textContent)).toEqual([
      "Aoife Byrne",
      "Mateo Silva",
      "Priya Raman",
      "I get a lot of mail",
      "Skip",
    ]);
    await clickText("Aoife Byrne", q(".onboarding-chips") ?? document);
    expect(client.sent[2]?.text).toBe("Aoife Byrne");
    // Question 3: the tools.
    expect(qa(".onboarding-chips .chip").map((c) => c.textContent)).toEqual([
      "Slack",
      "Notion",
      "Drive",
      "Discord",
      "Skip",
    ]);
    await clickText("Drive", q(".onboarding-chips") ?? document);
    // Question 4: Skip sends Skip.
    expect(qa(".onboarding-chips .chip").map((c) => c.textContent)).toEqual(["Yes", "No", "Skip"]);
    await clickText("Skip", q(".onboarding-chips") ?? document);
    expect(client.sent[4]?.text).toBe("Skip");
    await clickText("Yes", q(".onboarding-chips") ?? document);
    // The proposal card: sentences with counts, waiting for Approve; nothing done yet.
    expect(text()).toContain("4 threads would move");
    expect(text()).toContain("2 threads would move");
    expect(qa("button").some((b) => b.textContent?.trim() === "Done")).toBe(false);
    expect(qa("button").some((b) => b.textContent?.trim() === "Skip the rest")).toBe(true);
    await clickText("Apply");
    expect(client.approvals).toEqual([
      { sessionId: client.sessions[0]?.id ?? "", activityId: "c-groups", decision: "approved" },
    ]);
    // The keymap landed: Done shows and finishes with the state completed.
    expect(text()).toContain("propose groups Applied");
    await clickText("Done");
    expect(done).toEqual(["done"]);
    expect(captured?.settings["onboarding.state"]?.["acct-1"]?.status).toBe("completed");
  });

  test("closing the panel skips the rest", async () => {
    const client = fakeAgentClient({
      workspaceId: "ws-1",
      now: () => NOW,
      turns: [() => [{ kind: "text", id: "t1", text: "Who are you?" }]],
    });
    const { done } = await mount({ client, runtimes: detected });
    await click(card("assist"));
    await clickText("Continue");
    await settle();
    expect(text()).toContain("Who are you?");
    await clickText("Skip the rest");
    expect(done).toEqual(["done"]);
    expect(captured?.settings["onboarding.state"]?.["acct-1"]?.status).toBe("skipped");
    expect(captured?.settings["ai.level"]).toBe("assist");
  });
});

/* ------------------------------ The App ------------------------------ */

const fresh = {
  id: "acct-new",
  workspaceId: "ws-1",
  provider: "jmap" as const,
  address: "sam@monday.test",
  displayName: "Sam",
  capabilities: {
    push: true,
    labels: false,
    snooze: false,
    mute: false,
    calendar: false,
    meetingLink: null,
  },
  connected: true,
  lastSync: null,
  lastError: null,
};

async function mountApp(settings: PartialSettings, accounts: (typeof fresh)[] | null) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const r = root;
  await act(async () =>
    r.render(
      <StaticShell settings={settings}>
        <Capture />
        <App
          agentClient={null}
          accounts={accounts ? { list: async () => ({ accounts }) } : null}
          keys={null}
          now={NOW}
        />
      </StaticShell>,
    ),
  );
  await settle();
}

describe("onboarding in the App", () => {
  test("a fresh Account is offered onboarding once: the offer is recorded, and an Account already offered is not asked again", async () => {
    await mountApp({}, [fresh]);
    expect(q('[data-screen="onboarding"]')).not.toBeNull();
    expect(captured?.settings["onboarding.state"]?.["acct-new"]?.status).toBe("offered");
    if (root) await act(async () => root?.unmount());
    root = null;
    host?.remove();
    await mountApp(
      { "onboarding.state": { "acct-new": { status: "skipped", at: NOW.toISOString() } } },
      [fresh],
    );
    expect(q('[data-screen="onboarding"]')).toBeNull();
    expect(q(".inbox")).not.toBeNull();
  });

  test("after the welcome, a fresh Account with AI off is completed without a screen; with an assistant it opens on the conversation", async () => {
    const welcomed = { welcome: { status: "completed" as const, at: NOW.toISOString() } };
    await mountApp({ "onboarding.state": welcomed, "ai.level": "off" }, [fresh]);
    expect(q('[data-screen="onboarding"]')).toBeNull();
    expect(captured?.settings["onboarding.state"]?.["acct-new"]?.status).toBe("completed");
    if (root) await act(async () => root?.unmount());
    root = null;
    host?.remove();
    await mountApp({ "onboarding.state": welcomed, "ai.level": "assist" }, [fresh]);
    expect(q('[data-screen="onboarding"]')?.dataset.step).toBe("chat");
  });

  test("at off the App renders no agent bar and no agent column; at assist the bar is back", async () => {
    await mountApp(
      {
        "ai.level": "off",
        "layout.agent": "right",
        "onboarding.state": { "acct-new": { status: "completed", at: NOW.toISOString() } },
      },
      [fresh],
    );
    expect(q(".agent-bar")).toBeNull();
    expect(q(".agent-col")).toBeNull();
    // The Setting keeps its value: the layout only falls back.
    expect(captured?.settings["layout.agent"]).toBe("right");
    if (root) await act(async () => root?.unmount());
    root = null;
    host?.remove();
    await mountApp(
      {
        "ai.level": "assist",
        "layout.agent": "bottom",
        "onboarding.state": { "acct-new": { status: "completed", at: NOW.toISOString() } },
      },
      [fresh],
    );
    expect(q(".agent-bar")).not.toBeNull();
  });
});
