/// <reference types="bun-types" />
// The composer's Assistant UI patterns beyond the thread itself, mounted as a
// column over the fake AgentClient with happy-dom: the action bar on each
// turn (Copy, Edit and resend, Ask again on the last answer), turn times,
// Continue after a Stop, the / command menu from ai.composer.commands, the @
// mention menu from the screen's list with chips in the sent turn, and the
// approval card's note and tool glyph. Plus the pure pieces: the command
// list, the mention list, the Working label and the transcript's times.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  type AgentEvent,
  defaultSettings,
  type Group,
  type Settings,
  type Thread,
} from "@monday/shared";
import { dom } from "@monday/ui/test-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { Composer } from "../Composer.tsx";
import { type AgentClient, type FakeAgentClient, fakeAgentClient, toolEvent } from "../client.ts";
import { composerStrings } from "../composerStrings.ts";
import { applyEvents, stampLive } from "../transcript.ts";
import { useAgentSession } from "../useAgentSession.ts";
import { workingLabel } from "./context.tsx";
import {
  ComposerMentionsContext,
  cleanLabel,
  type MentionItem,
  mentionItems,
  THREAD_DRAG_TYPE,
} from "./mentions.tsx";
import { messagesOf, messageTime } from "./messages.ts";
import { turnText } from "./runtime.ts";
import { commandList, commandText } from "./triggers.tsx";

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

const NOW = new Date(2026, 8, 17, 10, 0);
const textState = { value: "" };

function Harness({
  client,
  settings,
  mentions,
}: {
  client: AgentClient;
  settings: Settings;
  mentions: readonly MentionItem[];
}) {
  const agent = useAgentSession({
    client,
    workspaceId: "ws",
    context: () => ({}),
    newAfterHours: 24,
    now: () => NOW,
  });
  return (
    <ComposerMentionsContext.Provider value={mentions}>
      <Composer
        agent={agent}
        mode="right"
        runtime="Anthropic claude-sonnet-5 · me@example.test"
        strings={composerStrings(settings)}
        suggestions={[]}
        now={NOW}
        placeholder="Ask or tell monday"
        text={textState.value}
        onTextChange={(t) => {
          textState.value = t;
        }}
      />
    </ComposerMentionsContext.Provider>
  );
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

async function mount(
  client: AgentClient,
  options: { settings?: Settings; mentions?: readonly MentionItem[] } = {},
) {
  textState.value = "";
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const r = root;
  await act(async () =>
    r.render(
      <Harness
        client={client}
        settings={options.settings ?? defaultSettings()}
        mentions={options.mentions ?? []}
      />,
    ),
  );
  await settle();
}

const q = <T extends Element = HTMLElement>(sel: string) => document.querySelector<T>(sel);
const qa = <T extends Element = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)];
const bar = () => q<HTMLTextAreaElement>(".agent-bar textarea");

async function type(text: string) {
  const el = bar();
  if (!el) throw new Error("no agent bar");
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    el.focus();
    setter?.call(el, text);
    el.setSelectionRange(text.length, text.length);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("select", { bubbles: true }));
  });
  await settle();
}

async function send(text: string) {
  await type(text);
  const form = q<HTMLFormElement>("form.agent-bar");
  await act(async () => {
    form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await settle();
}

async function click(el: Element | null | undefined) {
  if (!el) throw new Error("nothing to click");
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await settle();
}

const answer = (text: string) => () => [{ kind: "text" as const, id: `t-${text}`, text }];

describe("the action bar on each turn", () => {
  test("a user turn shows its time, Copy, and Edit and resend, which puts it back in the bar", async () => {
    const client = fakeAgentClient({ turns: [answer("Two invoices.")] });
    await mount(client);
    await send("what came in today?");
    const turn = q(".agent-thread .u-turn");
    expect(turn?.querySelector(".u")?.textContent).toBe("what came in today?");
    expect(turn?.querySelector("time.agent-time")?.getAttribute("datetime")).toBe(
      NOW.toISOString(),
    );
    expect(turn?.querySelector('.agent-msg-acts button[title="Copy"]')).not.toBeNull();
    expect(textState.value).toBe("");
    await click(turn?.querySelector('.agent-msg-acts button[title="Edit and resend"]'));
    expect(textState.value).toBe("what came in today?");
    expect(bar()?.value).toBe("what came in today?");
  });

  test("Ask again sits on the last answer only and sends the turn it answered again", async () => {
    const client = fakeAgentClient({
      turns: [answer("First answer."), answer("Second answer."), answer("Again.")],
    });
    await mount(client);
    await send("first question");
    await send("second question");
    const reloads = qa('.agent-answer-acts button[title="Ask again"]');
    expect(reloads).toHaveLength(1);
    expect(reloads[0]?.closest(".a")?.textContent).toContain("Second answer.");
    await click(reloads[0]);
    expect(client.sent.map((s) => s.text)).toEqual([
      "first question",
      "second question",
      "second question",
    ]);
    expect(q(".agent-thread .a:last-of-type")?.textContent).toContain("Again.");
  });

  test("the time is left out when ai.composer.timestamps is off", async () => {
    const client = fakeAgentClient({ turns: [answer("Hi.")] });
    await mount(client, {
      settings: { ...defaultSettings(), "ai.composer.timestamps": false },
    });
    await send("hello");
    expect(q(".agent-time")).toBeNull();
  });

  test("Continue on a stopped turn sends the Setting's words and leaves the bar's draft", async () => {
    const inner = fakeAgentClient();
    let turns = 0;
    const client: FakeAgentClient = {
      ...inner,
      turn: (sessionId, text, context, onEvent, signal) => {
        turns += 1;
        if (turns > 1) return inner.turn(sessionId, text, context, onEvent, signal);
        onEvent({ kind: "user", id: "u1", text });
        onEvent({ kind: "delta", id: "t1", text: "Looking" });
        return new Promise<void>((_, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      },
    };
    await mount(client);
    await send("summarize everything");
    await click(q(".agent-bar .stop"));
    await type("a draft I keep");
    await click(q(".line.stopped .chip"));
    expect(inner.sent.map((s) => s.text)).toEqual(["Continue where you stopped."]);
    expect(bar()?.value).toBe("a draft I keep");
    // The stopped turn is no longer the last: its Continue is gone.
    expect(q(".line.stopped .chip")).toBeNull();
  });
});

describe("the / command menu", () => {
  test("/ lists the Setting's commands and /new, filters as you type, and a pick starts the message", async () => {
    const client = fakeAgentClient();
    await mount(client);
    await type("/");
    const names = () =>
      qa('.agent-menu[data-kind="commands"] .agent-menu-item .name').map((n) => n.textContent);
    expect(names()).toEqual(["/draft", "/summarize", "/find", "/organize", "/new"]);
    await type("/sum");
    expect(names()).toEqual(["/summarize"]);
    await click(q('.agent-menu[data-kind="commands"] .agent-menu-item'));
    expect(bar()?.value).toBe("Summarize ");
    expect(q('.agent-menu[data-kind="commands"] .agent-menu-item')).toBeNull();
  });

  test("/new starts a new Session", async () => {
    const client = fakeAgentClient();
    await mount(client);
    await send("hello");
    expect(client.sessions).toHaveLength(1);
    await type("/ne");
    await click(q('.agent-menu[data-kind="commands"] .agent-menu-item'));
    expect(client.sessions).toHaveLength(2);
    expect(q(".agent-thread .u")).toBeNull();
    expect(bar()?.value).toBe("");
  });
});

describe("the @ mention menu", () => {
  const mentions: MentionItem[] = [
    { id: "t1", type: "thread", label: "Quarterly report", description: "Aoife" },
    { id: "g1", type: "group", label: "Hiring" },
    { id: "g2", type: "group", label: "Finance" },
  ];

  test("@ lists the kinds, a kind drills in, and a pick inserts a mention the sent turn shows as a chip", async () => {
    const client = fakeAgentClient({ turns: [answer("Done.")] });
    await mount(client, { mentions });
    await type("move these to @");
    const menu = () => q('.agent-menu[data-kind="mentions"]');
    expect(
      qa('.agent-menu[data-kind="mentions"] .agent-menu-item .name').map((n) => n.textContent),
    ).toEqual(["Threads", "Groups"]);
    await click(menu()?.querySelectorAll(".agent-menu-item")[1]);
    expect(
      qa('.agent-menu[data-kind="mentions"] .agent-menu-item .name').map((n) => n.textContent),
    ).toEqual(["Hiring", "Finance"]);
    await click(menu()?.querySelector(".agent-menu-item"));
    // The pick waits above the input as a chip; the typed words stay plain, the @ is gone.
    expect(bar()?.value.trim()).toBe("move these to");
    expect(qa(".agent-attached-chip").map((c) => [c.dataset.type, c.textContent])).toEqual([
      ["group", "Hiring"],
    ]);
    await send("move these to");
    expect(client.sent.at(-1)?.text).toBe("move these to :group[Hiring]{name=g1}");
    expect(qa(".agent-attached-chip")).toHaveLength(0);
    const chip = q(".agent-thread .u .agent-mention");
    expect(chip?.dataset.type).toBe("group");
    expect(chip?.textContent).toBe("Hiring");
    expect(q(".agent-thread .u")?.textContent).toBe("move these to Hiring");
  });

  test("typing after @ searches every kind", async () => {
    const client = fakeAgentClient();
    await mount(client, { mentions });
    await type("@quar");
    expect(
      qa('.agent-menu[data-kind="mentions"] .agent-menu-item .name').map((n) => n.textContent),
    ).toEqual(["Quarterly report"]);
  });

  test("no menu when ai.composer.mentions is off", async () => {
    const client = fakeAgentClient();
    await mount(client, {
      mentions,
      settings: { ...defaultSettings(), "ai.composer.mentions": false },
    });
    await type("@");
    expect(q('.agent-menu[data-kind="mentions"]')).toBeNull();
  });
});

describe("Threads dropped into the Agent", () => {
  /** A drag's data as the browser hands it over: the types during dragover, the data on drop. */
  function dataTransfer(payload: Record<string, string>) {
    return {
      types: Object.keys(payload),
      getData: (type: string) => payload[type] ?? "",
      dropEffect: "none",
    };
  }
  function fire(target: Element | null, type: string, data: ReturnType<typeof dataTransfer>) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: data });
    act(() => {
      target?.dispatchEvent(event);
    });
    return event;
  }

  test("a drop of rows puts them in the bar as Thread mentions the Agent can act on", async () => {
    const client = fakeAgentClient({ turns: [answer("Done.")] });
    await mount(client);
    const threads = JSON.stringify([
      { id: "t1", subject: "Quarterly report [draft]" },
      { id: "t2", subject: "" },
    ]);
    const data = dataTransfer({ [THREAD_DRAG_TYPE]: threads, "text/plain": "Quarterly report" });
    const column = q(".agent-col");
    const over = fire(column, "dragover", data);
    // Accepting the drag: the browser only drops where dragover was cancelled.
    expect(over.defaultPrevented).toBe(true);
    expect(document.documentElement.getAttribute("data-drop-over")).toBe("agent");
    fire(column, "drop", data);
    await settle();
    expect(document.documentElement.getAttribute("data-drop-over")).toBeNull();
    // They wait above the input as chips; the typed words stay plain.
    expect(textState.value).toBe("");
    expect(qa(".agent-attached-chip .label").map((c) => c.textContent)).toEqual([
      "Quarterly report draft",
      "(no subject)",
    ]);
    // A chip can be taken off before sending.
    await click(q('.agent-attached-chip [aria-label="Remove (no subject)"]'));
    expect(qa(".agent-attached-chip")).toHaveLength(1);
    // Sending carries the words and the Thread as a mention the Agent acts on, then clears the chips.
    await send("summarize this");
    expect(client.sent.at(-1)?.text).toBe(
      "summarize this :thread[Quarterly report draft]{name=t1}",
    );
    expect(qa(".agent-attached-chip")).toHaveLength(0);
    expect(q(".agent-thread .u .agent-mention")?.textContent).toBe("Quarterly report draft");
  });

  test("a drag without Threads (a file, some text) is left alone", async () => {
    const client = fakeAgentClient({ turns: [] });
    await mount(client);
    const data = dataTransfer({ "text/plain": "hello" });
    const over = fire(q(".agent-col"), "dragover", data);
    expect(over.defaultPrevented).toBe(false);
    fire(q(".agent-col"), "drop", data);
    expect(textState.value).toBe("");
  });
});

describe("the approval card", () => {
  test("a card that asks names what approving means and carries its tool's glyph; a read step does not", async () => {
    const client = fakeAgentClient({
      turns: [
        () => [
          toolEvent({ id: "s1", tool: "search_threads", status: "done", inputSummary: "invoices" }),
          toolEvent({
            id: "c1",
            tool: "send_draft",
            tier: "always-ask",
            status: "waiting",
            inputSummary: "to accounting",
          }),
        ],
      ],
    });
    await mount(client);
    await send("send it to accounting");
    const card = q(".agent-thread .a > .tool:not(.step)");
    expect(card?.querySelector(".note")?.textContent).toBe(
      "Nothing leaves your mailbox until you approve.",
    );
    expect(card?.querySelector(".t .ti")).not.toBeNull();
    expect([...(card?.querySelectorAll("button") ?? [])].map((b) => b.textContent)).toEqual([
      "Approve",
      "Cancel",
    ]);
    expect(q(".tool.step .note")).toBeNull();
  });
});

describe("the pure pieces", () => {
  test("the command list keeps the Setting's order, drops a clash with /new, and ends with /new", () => {
    expect(commandList({ draft: "Draft ", new: "x", find: "Find" }, "Start over")).toEqual([
      { id: "draft", description: "Draft", prompt: "Draft " },
      { id: "find", description: "Find", prompt: "Find" },
      { id: "new", description: "Start over", prompt: null },
    ]);
    expect(commandText("Find", "")).toBe("Find ");
    expect(commandText("Draft a reply to ", " Aoife ")).toBe("Draft a reply to Aoife");
  });

  test("the mention list: newest Threads first, Groups with their parent, Sections, and people once, never yourself", () => {
    const thread = (id: string, at: string, subject: string, email: string): Thread =>
      ({
        id,
        subject,
        lastActivity: at,
        archived: false,
        participants: [
          { name: "", email: "me@example.test" },
          { name: email.split("@")[0] ?? "", email },
        ],
      }) as Thread;
    const group = (id: string, name: string, parentId: string | null = null): Group =>
      ({ id, name, parentId }) as Group;
    const items = mentionItems({
      threads: [
        thread("t1", "2026-09-10T00:00:00Z", "Old [draft] news", "kenji@x.test"),
        thread("t2", "2026-09-16T00:00:00Z", "Offer letter", "aoife@x.test"),
        thread("t3", "2026-09-01T00:00:00Z", "Too old", "zed@x.test"),
      ],
      groups: [group("g1", "Hiring"), group("g2", "Candidates", "g1")],
      sections: [{ id: "needs-reply", name: "Needs your reply" }],
      limit: 2,
      self: "me@example.test",
    });
    expect(items.map((i) => [i.type, i.label])).toEqual([
      ["thread", "Offer letter"],
      ["thread", "Old draft news"],
      ["group", "Hiring"],
      ["group", "Hiring › Candidates"],
      ["section", "Needs your reply"],
      ["person", "aoife"],
      ["person", "kenji"],
    ]);
    expect(cleanLabel("a {b}\n[c]")).toBe("a b c");
  });

  test("Working counts its time only past ai.composer.elapsed_after_seconds, and never at 0", () => {
    const strings = composerStrings(defaultSettings());
    expect(workingLabel(strings, 2)).toBe("Working");
    expect(workingLabel(strings, 12)).toBe("Working for 12s");
    const never = composerStrings({ ...defaultSettings(), "ai.composer.elapsed_after_seconds": 0 });
    expect(workingLabel(never, 120)).toBe("Working");
  });

  test("a live turn is stamped as it arrives; the answer keeps the time of its first token", () => {
    const t0 = new Date("2026-09-17T10:00:00Z");
    const t1 = new Date("2026-09-17T10:00:09Z");
    const events = applyEvents([], [
      stampLive({ kind: "user", id: "u1", text: "hi" }, t0),
      stampLive({ kind: "delta", id: "a1", text: "Hel" }, t0),
      stampLive({ kind: "text", id: "a1", text: "Hello." }, t1),
    ] as AgentEvent[]);
    expect(events).toEqual([
      { kind: "user", id: "u1", text: "hi", at: t0.toISOString() },
      { kind: "text", id: "a1", text: "Hello.", at: t0.toISOString() },
    ]);
    const error: AgentEvent = { kind: "error", id: "e", message: "x" };
    expect(stampLive(error, t0)).toBe(error);
    // Each message carries its time; Ask again finds the turn an answer followed.
    const messages = messagesOf(events);
    expect(messages.map((m) => messageTime(m.metadata as never))).toEqual([
      t0.toISOString(),
      t0.toISOString(),
    ]);
    expect(turnText(messages, "u-u1")).toBe("hi");
    expect(turnText(messages, "a-a1")).toBeNull();
    // A transcript without times (an older Server) carries none.
    expect(messagesOf(applyEvents([], [{ kind: "user", id: "u", text: "x" }]))[0]?.metadata).toBe(
      undefined,
    );
  });
});
