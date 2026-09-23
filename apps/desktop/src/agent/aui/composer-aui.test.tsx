/// <reference types="bun-types" />
// The composer on Assistant UI, mounted as a column over the fake AgentClient
// with happy-dom: answers render as Markdown (a table, a code block with Copy,
// a link that opens outside, no raw HTML), read-only steps group under their
// turn and fold once the answer starts, Apply resumes the paused turn and
// Undo reaches the Activity route, Up recalls what was sent, and Stop ends a
// turn in flight. Plus the pure message conversion and its cache.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { type AgentEvent, defaultSettings, type ToolCall } from "@monday/shared";
import { dom } from "@monday/ui/test-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { Composer } from "../Composer.tsx";
import { type AgentClient, type FakeAgentClient, fakeAgentClient, toolEvent } from "../client.ts";
import { composerStrings } from "../composerStrings.ts";
import { applyEvents } from "../transcript.ts";
import { useAgentSession } from "../useAgentSession.ts";
import { createMessageCache, messagesOf } from "./messages.ts";

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
const strings = composerStrings(defaultSettings());
const opened: string[] = [];

function Harness({ client }: { client: AgentClient }) {
  const agent = useAgentSession({
    client,
    workspaceId: "ws",
    context: () => ({}),
    newAfterHours: 24,
    now: () => NOW,
  });
  return <ColumnComposer agent={agent} />;
}

function ColumnComposer({ agent }: { agent: ReturnType<typeof useAgentSession> }) {
  return (
    <Composer
      agent={agent}
      mode="right"
      runtime="Anthropic claude-sonnet-5 · me@example.test"
      strings={strings}
      suggestions={[]}
      now={NOW}
      placeholder="Ask or tell monday"
      text={textState.value}
      onTextChange={(t) => {
        textState.value = t;
      }}
      onOpenLink={(href) => opened.push(href)}
    />
  );
}

/** The screen's copy of the bar's text; the tests read it back. */
const textState = { value: "" };

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

async function mount(client: AgentClient) {
  textState.value = "";
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const r = root;
  await act(async () => r.render(<Harness client={client} />));
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
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
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

async function key(el: Element | null, k: string) {
  if (!el) throw new Error("no target");
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
  await settle();
}

const MARKDOWN = [
  "Here is **what I found**:",
  "",
  "| Sender | Threads |",
  "|---|---|",
  "| Aoife | 3 |",
  "| Kenji | 1 |",
  "",
  "```ts",
  "const total = 4;",
  "```",
  "",
  "- first",
  "- second with `inline code`",
  "",
  "See [the docs](https://example.test/docs) or [this](javascript:alert(1)).",
  "",
  '<script>window.pwned = true</script><img src="x" onerror="window.pwned = true">',
].join("\n");

describe("the composer on Assistant UI", () => {
  test("an answer renders as Markdown: a table, a code block with Copy, a list, a link that opens outside, no raw HTML", async () => {
    const client = fakeAgentClient({
      turns: [() => [{ kind: "text", id: "t1", text: MARKDOWN }]],
    });
    await mount(client);
    await send("who wrote this week?");
    const answer = q(".agent-thread .a .agent-md");
    expect(answer).not.toBeNull();
    // The table, header and rows.
    const cells = qa(".agent-md table td").map((td) => td.textContent);
    expect(qa(".agent-md table th").map((th) => th.textContent)).toEqual(["Sender", "Threads"]);
    expect(cells).toEqual(["Aoife", "3", "Kenji", "1"]);
    // The code block, its language and a Copy button worded by the Setting; no download.
    const code = q('.agent-md [data-streamdown="code-block"]');
    expect(code?.textContent).toContain("const total = 4;");
    expect(q('.agent-md [data-streamdown="code-block-header"]')?.textContent).toBe("ts");
    expect(q('.agent-md [data-streamdown="code-block-copy-button"]')?.getAttribute("title")).toBe(
      "Copy code",
    );
    expect(q('.agent-md [data-streamdown="code-block-download-button"]')).toBeNull();
    // A list with inline code.
    expect(qa(".agent-md li").map((li) => li.textContent)).toEqual([
      "first",
      "second with inline code",
    ]);
    expect(q(".agent-md li code")?.textContent).toBe("inline code");
    // The safe link opens through the platform; the javascript: one is only text.
    const links = qa<HTMLAnchorElement>(".agent-md a");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["https://example.test/docs"]);
    opened.length = 0;
    await click(links[0]);
    expect(opened).toEqual(["https://example.test/docs"]);
    // Raw HTML never becomes elements.
    expect(q(".agent-md script")).toBeNull();
    expect(q(".agent-md img")).toBeNull();
    expect((window as { pwned?: boolean }).pwned).toBeUndefined();
  });

  test("read-only steps group under their turn, fold once the answer starts, and reopen on a click", async () => {
    const client = fakeAgentClient({
      turns: [
        () => [
          toolEvent({
            id: "s1",
            tool: "search_threads",
            status: "done",
            inputSummary: "from:aoife",
            result: "3 threads",
          }),
          toolEvent({ id: "s2", tool: "read_thread", status: "done", inputSummary: "t-1" }),
          toolEvent({ id: "s3", tool: "read_thread", status: "done", inputSummary: "t-2" }),
          { kind: "text", id: "t1", text: "Aoife asked twice about Thursday." },
        ],
      ],
    });
    await mount(client);
    await send("what did aoife want?");
    const turn = q(".agent-thread .a");
    const steps = turn?.querySelector<HTMLElement>(".agent-steps");
    expect(steps).not.toBeNull();
    // All three steps are rows in the one group, in order.
    const rows = [...(steps?.querySelectorAll<HTMLElement>(".tool.step") ?? [])];
    expect(rows.map((r) => r.querySelector(".t")?.textContent)).toEqual([
      "Searched mail",
      "Read thread",
      "Read thread",
    ]);
    expect(rows[0]?.querySelector(".st")?.textContent?.trim()).toBe("3 threads");
    // The answer followed, so the group is folded to its summary and count.
    expect(steps?.dataset.state).toBe("closed");
    const head = steps?.querySelector<HTMLButtonElement>(".head");
    expect(head?.getAttribute("aria-expanded")).toBe("false");
    expect(head?.querySelector(".label")?.textContent).toBe("Searched mail, Read thread (2)");
    expect(head?.querySelector(".n")?.textContent).toBe("3 steps");
    // The answer sits after the group in the same turn.
    expect(turn?.querySelector(".agent-md")?.textContent).toContain("Aoife asked twice");
    await click(head);
    expect(steps?.dataset.state).toBe("open");
    expect(head?.getAttribute("aria-expanded")).toBe("true");
  });

  test("a waiting card stays out of the group; Apply resumes the turn and Undo reaches the Activity route", async () => {
    const client = fakeAgentClient({
      turns: [
        () => [
          toolEvent({
            id: "s1",
            tool: "search_threads",
            status: "done",
            inputSummary: "newsletters",
            result: "2 threads",
          }),
          toolEvent({
            id: "c1",
            tool: "archive_threads",
            tier: "reversible",
            status: "waiting",
            inputSummary: "2 threads",
          }),
        ],
      ],
      onApprove: (call: ToolCall) => [
        toolEvent({ ...call, status: "done", approvedBy: "user", undoable: true }),
        { kind: "text", id: "t2", text: "Archived **2** newsletters." },
      ],
    });
    await mount(client);
    await send("archive the newsletters");
    const card = () => q(".agent-thread .a > .tool:not(.step)");
    expect(card()?.closest(".agent-steps")).toBeNull();
    // Nothing answered yet: the steps stay open beside the waiting card.
    expect(q(".agent-steps")?.dataset.state).toBe("open");
    const apply = [...(card()?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === "Apply",
    );
    await click(apply);
    expect(client.approvals).toMatchObject([{ activityId: "c1", decision: "approved" }]);
    expect(card()?.querySelector(".st")?.textContent?.trim()).toBe("Applied");
    expect(q('.agent-md [data-streamdown="strong"]')?.textContent).toBe("2");
    expect(q(".agent-steps")?.dataset.state).toBe("closed");
    const undo = [...(card()?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent === "Undo",
    );
    await click(undo);
    expect(client.undos).toEqual(["c1"]);
    expect(card()?.querySelector(".st")?.textContent?.trim()).toBe("Undone");
  });

  test("Up in the empty bar recalls what was sent, newest first; Down steps back to the draft", async () => {
    const client = fakeAgentClient();
    await mount(client);
    await send("first question");
    await send("second question");
    expect(bar()?.value).toBe("");
    await key(bar(), "ArrowUp");
    expect(bar()?.value).toBe("second question");
    await key(bar(), "ArrowUp");
    expect(bar()?.value).toBe("first question");
    await key(bar(), "ArrowDown");
    expect(bar()?.value).toBe("second question");
    await key(bar(), "ArrowDown");
    expect(bar()?.value).toBe("");
  });

  test("Stop ends a turn in flight: the stream is dropped, the running card says Stopped, and the bar sends again", async () => {
    const inner = fakeAgentClient();
    let signal: AbortSignal | undefined;
    const client: FakeAgentClient = {
      ...inner,
      turn: (_sessionId, text, _context, onEvent, s) => {
        signal = s;
        onEvent({ kind: "user", id: "u1", text });
        onEvent({ kind: "delta", id: "t1", text: "Looking through " });
        onEvent(
          toolEvent({ id: "s1", tool: "search_threads", status: "running", inputSummary: "all" }),
        );
        return new Promise<void>((_, reject) => {
          s?.addEventListener("abort", () => {
            // A late token after the abort never lands.
            onEvent({ kind: "delta", id: "t1", text: "too late" });
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      },
    };
    await mount(client);
    await send("summarize everything");
    expect(q(".agent-bar .stop")).not.toBeNull();
    expect(q(".agent-bar .send")).toBeNull();
    expect(q(".agent-steps")?.classList.contains("active")).toBe(true);
    await click(q(".agent-bar .stop"));
    expect(signal?.aborted).toBe(true);
    expect(q(".agent-bar .stop")).toBeNull();
    expect(q(".agent-bar .send")).not.toBeNull();
    expect(q(".agent-thread .a .line.stopped")?.textContent).toBe("Stopped");
    expect(q(".tool.step .st")?.textContent?.trim()).toBe("Stopped");
    expect(q(".agent-md")?.textContent).not.toContain("too late");
    expect(q(".agent-error")).toBeNull();
    await send("again");
    expect(inner.sent.map((s) => s.text)).toEqual([]);
    expect(q(".agent-bar .stop")).not.toBeNull();
  });
});

describe("the transcript as Assistant UI messages", () => {
  const events = (): AgentEvent[] => [
    { kind: "user", id: "u1", text: "hi" },
    { kind: "text", id: "t1", text: "Hello." },
    toolEvent({ id: "c1", tool: "search_threads", status: "done", result: "1 thread" }),
    { kind: "error", id: "e1", message: "model timed out" },
    { kind: "runtime", id: "r1", runtime: { kind: "local", cli: "codex" } },
    { kind: "user", id: "u2", text: "again" },
  ];

  test("a user event is a user message; the agent's parts follow in one message; a switch starts the next", () => {
    const messages = messagesOf(applyEvents([], events()));
    expect(messages.map((m) => [m.id, m.role])).toEqual([
      ["u-u1", "user"],
      ["a-t1", "assistant"],
      ["a-r1", "assistant"],
      ["u-u2", "user"],
    ]);
    const parts = messages[1]?.content;
    expect(Array.isArray(parts) ? parts.map((p) => p.type) : []).toEqual([
      "text",
      "tool-call",
      "tool-call",
    ]);
    const tool = Array.isArray(parts) ? parts[1] : null;
    expect(tool).toMatchObject({
      toolName: "search_threads",
      toolCallId: "c1",
      result: "1 thread",
    });
    expect(Array.isArray(parts) ? parts[2] : null).toMatchObject({
      toolName: "error",
      isError: true,
    });
    expect(messages[2]?.content).toEqual([
      {
        type: "data",
        name: "line",
        data: { kind: "runtime", runtime: { kind: "local", cli: "codex" } },
      },
    ]);
  });

  test("the cache keeps a message's object while its events are unchanged", () => {
    const convert = createMessageCache();
    const first = applyEvents([], events().slice(0, 3));
    const a = convert(first);
    const grown = applyEvents(first, [{ kind: "user", id: "u2", text: "more" }]);
    const b = convert(grown);
    expect(b[0]).toBe(a[0] as (typeof b)[number]);
    expect(b[1]).toBe(a[1] as (typeof b)[number]);
    const streamed = applyEvents(grown, [{ kind: "delta", id: "t9", text: "x" }]);
    const c = convert(streamed);
    expect(c[0]).toBe(b[0] as (typeof c)[number]);
    expect(c[1]).toBe(b[1] as (typeof c)[number]);
    expect(c[3]).not.toBe(b[3] as (typeof c)[number]);
  });
});
