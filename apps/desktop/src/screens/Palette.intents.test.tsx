/// <reference types="bun-types" />
// Typed sentences in the palette (slice 27, ADR 0012): a sentence that
// matches no entry goes to the judge seam and its reading becomes the first
// row, gated by confidence and Tier. Mounted under a StaticShell over the
// fixtures with happy-dom and a fake judge that answers from a script, the
// way the Server would over /judge/intent.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { ChoiceReading, IntentReading, IntentRequest } from "@monday/shared";
import { dom } from "@monday/ui/test-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { StaticShell } from "../shell/Shell.tsx";
import { fixtureCalendar } from "./calendar/calendar-data.ts";
import { Inbox, type InboxProps } from "./Inbox.tsx";
import { fixtureInbox } from "./inbox/actions.ts";
import type { IntentJudge } from "./inbox/intents.ts";

let createRoot: typeof import("react-dom/client")["createRoot"];
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

/** Wednesday 16 September 2026, 10:00 local. */
const NOW = new Date(2026, 8, 16, 10, 0);

const choice = <K extends string>(key: K, confidence = 1): ChoiceReading<K> => ({
  choice: key,
  confidence,
  probabilities: { [key]: confidence },
});

/** A full reading with every question answered "none", overridden per test. */
function reading(text: string, overrides: Partial<IntentReading>): IntentReading {
  return {
    text,
    intent: choice("other"),
    person: choice("none"),
    group: choice("none"),
    section: choice("none"),
    weekday: choice("none"),
    hour: choice("none"),
    scope: 0.1,
    age: choice("none"),
    kind: choice("any"),
    model: "jev-1.13.0",
    ...overrides,
  };
}

/** The judge seam as the Server's /judge/intent answers it: the scripted reading for the text sent. */
function fakeJudge(
  script: (request: IntentRequest) => IntentReading | null,
): IntentJudge & { requests: IntentRequest[] } {
  const requests: IntentRequest[] = [];
  return {
    requests,
    async intent(request) {
      requests.push(request);
      return script(request);
    },
  };
}

async function mount(props: Partial<InboxProps> = {}, settings: Record<string, unknown> = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const r = root;
  const navigated: string[] = [];
  const searched: string[] = [];
  await act(async () =>
    r.render(
      <StaticShell settings={{ "ai.level": "automate", "intent.debounce_ms": 0, ...settings }}>
        <Inbox
          inbox={fixtureInbox()}
          now={NOW}
          initialOpen={null}
          timing={{ collapse: 0, toast: 60_000 }}
          onNavigate={(t) => navigated.push(t)}
          onSearch={(q) => searched.push(q)}
          {...props}
        />
      </StaticShell>,
    ),
  );
  return { navigated, searched };
}

async function press(key: string, mods: Partial<KeyboardEventInit> = {}, target?: EventTarget) {
  await act(async () => {
    (target ?? window).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...mods }),
    );
  });
}

const input = () => document.querySelector<HTMLInputElement>(".cmdk input");

/** Types through the native value setter plus an input event, then lets the judge and the Cache answer. */
async function type(text: string) {
  const el = input();
  if (!el) throw new Error("no palette input");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
}

const sections = () => [...document.querySelectorAll(".cmdk-sec")].map((s) => s.textContent);
const items = () =>
  [...document.querySelectorAll<HTMLElement>(".cmdk-item span:not(.kbd):not(.mk)")].map(
    (s) => s.textContent,
  );
const activeText = () =>
  document.querySelector(".cmdk-item.on span:not(.mk):not(.kbd)")?.textContent ?? null;

describe("typed sentences in the palette", () => {
  test("set up a call with Aoife Thursday 15:00 typed in the palette opens the scheduling card without a Session", async () => {
    const judge = fakeJudge((request) =>
      request.text === "set up a call with Aoife Thursday 15:00"
        ? reading(request.text, {
            intent: choice("schedule_event"),
            person: choice("aoife_brennan"),
            weekday: choice("thu"),
            hour: choice("h15"),
          })
        : null,
    );
    const calendar = fixtureCalendar({});
    await mount({ judge, calendar });
    await press("k", { metaKey: true });
    await type("set up a call with Aoife Thursday 15:00");
    // The request carried the Device's day with its offset and the contacts by recency.
    expect(judge.requests).toHaveLength(1);
    expect(judge.requests[0]?.now.startsWith("2026-09-16T10:00:00")).toBe(true);
    expect(judge.requests[0]?.contacts.some((c) => c.email === "aoife@northlight.dev")).toBe(true);
    expect(judge.requests[0]?.sections.map((s) => s.id)).toContain("needs-reply");
    // The reading is the first row, under Do: the intent leaves the mailbox, so its card comes first, not a run.
    expect(sections()[0]).toBe("Do");
    // Thursday is tomorrow of the fixture's Wednesday; the row words the moment the way a snooze does.
    expect(activeText()).toBe("Schedule Call with Aoife Brennan, Tomorrow 15:00");
    await press("Enter", {}, input() ?? window);
    expect(document.querySelector(".cmdk")).toBeNull();
    // The composer's scheduling card, with Thursday 15:00 and Aoife resolved, and no Session: no turn was sent.
    const card = document.querySelector<HTMLElement>(".tool.intent-card");
    expect(card).not.toBeNull();
    expect(card?.dataset.tier).toBe("always-ask");
    expect(card?.querySelector(".ev-title")?.textContent).toBe("Call with Aoife Brennan");
    expect(card?.querySelector(".ev-when")?.textContent).toBe("Thu 17 Sep, 15:00 to 15:30");
    expect(card?.querySelector(".ev-who")?.textContent).toBe("Aoife Brennan");
    expect(card?.querySelector(".st")?.textContent).toContain("Needs approval");
    expect(document.querySelectorAll(".agent-thread .u")).toHaveLength(0);
    expect(document.querySelector<HTMLTextAreaElement>("[name=ask]")?.value).toBe("");
    expect(calendar.events()).toHaveLength(0);
    // Approve: the Event goes on the calendar through the seam, with Aoife as an attendee; the card says Applied.
    const approve = [...(card?.querySelectorAll<HTMLButtonElement>(".acts button") ?? [])].find(
      (b) => b.textContent === "Approve",
    );
    await act(async () => approve?.click());
    expect(calendar.events()).toHaveLength(1);
    expect(calendar.events()[0]).toMatchObject({
      title: "Call with Aoife Brennan",
      start: new Date(2026, 8, 17, 15, 0).toISOString(),
      end: new Date(2026, 8, 17, 15, 30).toISOString(),
      attendees: [{ name: "Aoife Brennan", email: "aoife@northlight.dev" }],
    });
    expect(document.querySelector(".tool.intent-card .st")?.textContent).toContain("Applied");
    expect(document.querySelector(".toast")?.textContent).toContain("Call with Aoife Brennan");
  });

  test("archive every newsletter older than a week at high confidence previews above the threshold and applies through InboxActions", async () => {
    const judge = fakeJudge((request) =>
      reading(request.text, {
        intent: choice("archive"),
        // The literal reading that missed "every newsletter" in the research: the age and the kind decide the set.
        scope: 0.32,
        age: choice("week"),
        kind: choice("newsletter"),
      }),
    );
    const inbox = fixtureInbox();
    // Ten days on, the fixture's two newsletters are older than a week; two is above a preview threshold of one.
    const later = new Date(2026, 8, 26, 10, 0);
    await mount({ judge, inbox, now: later }, { "inbox.batch_preview_above": 1 });
    await press("k", { metaKey: true });
    await type("archive every newsletter older than a week");
    expect(sections()[0]).toBe("Do");
    expect(activeText()).toBe("Archive 2 threads");
    await press("Enter", {}, input() ?? window);
    // The batch preview first, as any archive of more Threads than the Setting.
    const preview = document.querySelector<HTMLElement>(".batch");
    expect(preview?.textContent).toContain("Archive 2 threads?");
    expect(inbox.thread("e10")?.archived).toBe(false);
    const apply = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "Apply",
    );
    await act(async () => apply?.click());
    expect(inbox.thread("e10")?.archived).toBe(true);
    expect(inbox.thread("e11")?.archived).toBe(true);
    expect(inbox.thread("e1")?.archived).toBe(false);
    // The undo toast, as for a manual archive.
    expect(document.querySelector(".toast")?.textContent).toContain("Archived, 2 threads");
  });

  test("in the middle band a Did you mean row shows the reading and Enter confirms it; below the floor the sentence goes to the Agent as before; without a judge nothing is asked", async () => {
    const judge = fakeJudge((request) =>
      reading(request.text, {
        intent: choice("archive", request.text.includes("please") ? 0.75 : 0.4),
      }),
    );
    const inbox = fixtureInbox();
    await mount({ judge, inbox });
    await press("k", { metaKey: true });
    await type("please get rid of this one");
    expect(sections()[0]).toBe("Did you mean");
    expect(activeText()).toBe("Archive this thread");
    expect(document.querySelector(".cmdk-item.on .kbd")?.textContent).toBe("Enter");
    await press("Enter", {}, input() ?? window);
    expect(document.querySelector(".toast")?.textContent).toContain("Archived");
    expect(inbox.thread("e1")?.archived).toBe(true);

    // Below the floor: the rows are what they always were, and Enter offers the search.
    await press("k", { metaKey: true });
    await type("get rid of this one");
    expect(sections()).not.toContain("Do");
    expect(sections()).not.toContain("Did you mean");
    expect(items()).toContain("Search for get rid of this one");
    expect(items()).toContain("Ask monday: get rid of this one");
    await press("Escape", {}, input() ?? window);

    // A command name matches an entry: nothing is asked.
    const before = judge.requests.length;
    await press("k", { metaKey: true });
    await type("arch");
    expect(judge.requests).toHaveLength(before);
  });

  test("without a judge, and at AI level off, the palette behaves as before", async () => {
    await mount({ judge: null });
    await press("k", { metaKey: true });
    await type("set up a call with Aoife Thursday 15:00");
    expect(sections()).toEqual(["Results", "Ask the agent"]);
    await press("Escape", {}, input() ?? window);
  });
});
