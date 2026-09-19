/// <reference types="bun-types" />
// The composer in bottom-bar mode inside the Inbox (docs/spec/agent-composer.md)
// over the fake AgentClient with happy-dom: the bar opens the panel with the
// chips, Enter sends a turn, the tool cards render by tier with the preview
// rows and Apply or Cancel, Apply resumes and the card shows Applied with
// Undo, Undo marks it Undone, a send card asks with Approve, a Cancel changes
// nothing, Esc collapses the panel, and /new starts a fresh Session.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { AgentEvent, Runtime, ToolCall } from "@monday/shared";
import { dom } from "@monday/ui/test-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { Inbox } from "../screens/Inbox.tsx";
import { fixtureInbox } from "../screens/inbox/actions.ts";
import { StaticShell } from "../shell/Shell.tsx";
import { type FakeAgentClient, fakeAgentClient, toolEvent } from "./client.ts";
import { useAgentSession } from "./useAgentSession.ts";

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
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const preview = {
  kind: "threads" as const,
  action: "Archive",
  count: 12,
  threads: Array.from({ length: 12 }, (_, i) => ({
    id: `nl-${i + 1}`,
    subject: `Weekly digest ${i + 1}`,
    from: "digest@newsletter.test",
    lastActivity: daysAgo(8 + i),
  })),
};

/** The done-when turn as the Server would stream it, paused at the preview. */
const archiveTurn = (): AgentEvent[] => [
  { kind: "delta", id: "t1", text: "Looking for " },
  { kind: "delta", id: "t1", text: "old newsletters." },
  toolEvent({
    id: "c1",
    tool: "search_threads",
    tier: "read-only",
    status: "running",
    inputSummary: "section:newsletters · older than 7 days",
  }),
  { kind: "text", id: "t1", text: "Looking for old newsletters." },
  toolEvent({
    id: "c1",
    tool: "search_threads",
    tier: "read-only",
    status: "done",
    inputSummary: "section:newsletters · older than 7 days",
    result: "12 threads",
  }),
  toolEvent(
    {
      id: "c2",
      tool: "archive_threads",
      tier: "reversible",
      status: "waiting",
      inputSummary: "12 threads",
    },
    preview,
  ),
];

function Harness({ client, runtime }: { client: FakeAgentClient; runtime?: Runtime | undefined }) {
  const agent = useAgentSession({
    client,
    workspaceId: "ws-genai",
    context: () => ({ pinned: ["appearance.mode"] }),
    newAfterHours: 24,
    runtime,
    now: () => NOW,
  });
  return (
    <Inbox
      inbox={fixtureInbox()}
      now={NOW}
      initialOpen={null}
      timing={{ collapse: 0, toast: 60_000 }}
      agent={agent}
    />
  );
}

async function mount(client: FakeAgentClient, runtime?: Runtime) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const r = root;
  await act(async () =>
    r.render(
      <StaticShell>
        <Harness client={client} runtime={runtime} />
      </StaticShell>,
    ),
  );
  await settle();
}

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

const bar = () => document.querySelector<HTMLInputElement>(".agent-bar input");

async function typeInBar(text: string) {
  const el = bar();
  if (!el) throw new Error("no agent bar");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    el.focus();
    el.dispatchEvent(new Event("focus", { bubbles: true }));
    setter?.call(el, text);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submitBar() {
  const form = document.querySelector<HTMLFormElement>("form.agent-bar");
  if (!form) throw new Error("no agent bar form");
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await settle();
}

async function press(key: string, target: EventTarget = window) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

async function click(el: Element | null | undefined) {
  if (!el) throw new Error("nothing to click");
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await settle();
}

const cards = () => [...document.querySelectorAll<HTMLElement>(".agent-panel .tool")];
const cardByTool = (tool: string) =>
  cards().find((c) => c.querySelector(".t")?.textContent?.toLowerCase().includes(tool));
const buttons = (card: HTMLElement) => [
  ...card.querySelectorAll<HTMLButtonElement>(".acts button"),
];
const button = (card: HTMLElement, label: string) =>
  buttons(card).find((b) => b.textContent === label);
const chips = () =>
  [...document.querySelectorAll<HTMLElement>(".agent-suggest .chip, .agent-suggest button")].map(
    (c) => c.textContent,
  );

describe("the composer in bottom-bar mode", () => {
  test("archive every newsletter older than a week: the preview card above 10, Apply, Applied with Undo, Undone", async () => {
    const client = fakeAgentClient({
      turns: [archiveTurn],
      onApprove: (call: ToolCall) => [
        toolEvent(
          {
            ...call,
            status: "done",
            approvedBy: "user",
            undoable: true,
            result: "Archive: 12 threads.",
          },
          preview,
        ),
        { kind: "text", id: "t2", text: "Archived 12 newsletters older than a week." },
      ],
    });
    await mount(client);
    expect(document.querySelector(".agent-panel")).toBeNull();

    // Focus raises the panel with the chips; the header names the Runtime and the address.
    await typeInBar("archive every newsletter older than a week");
    expect(document.querySelector(".agent-panel")).not.toBeNull();
    expect(chips()).toEqual([
      "Reply to the 3 threads waiting on me",
      "Summarize what I missed since yesterday",
      "Archive newsletters older than a week",
    ]);
    expect(document.querySelector(".agent-panel .col-head")?.textContent).toContain(
      "tejas@genai-labs.io",
    );

    // Enter sends: the user turn appears, the text streamed, and the cards render by tier.
    await submitBar();
    expect(bar()?.value).toBe("");
    const session = client.sessions[0]?.id ?? "";
    expect(client.sent).toEqual([
      {
        sessionId: session,
        text: "archive every newsletter older than a week",
        // Developer mode is off by default (CONTEXT.md); every turn says so.
        context: { pinned: ["appearance.mode"], developerMode: false },
      },
    ]);
    expect(document.querySelector(".agent-thread .u")?.textContent).toBe(
      "archive every newsletter older than a week",
    );
    expect(document.querySelector(".agent-thread .a p")?.textContent).toBe(
      "Looking for old newsletters.",
    );
    expect(document.querySelector(".agent-panel .col-head")?.textContent).toContain(
      "Anthropic claude-sonnet-5",
    );
    const search = cardByTool("searched");
    expect(search?.dataset.tier).toBe("read-only");
    expect(search?.querySelector(".st")?.textContent?.trim()).toBe("12 threads");
    expect(buttons(search as HTMLElement)).toHaveLength(0);

    const archive = cardByTool("archive");
    if (!archive) throw new Error("no archive card");
    expect(archive.dataset.tier).toBe("reversible");
    expect(archive.classList.contains("wait")).toBe(true);
    expect(archive.querySelector(".st")?.textContent?.trim()).toBe("Needs approval");
    expect(archive.querySelector(".agent-preview .count")?.textContent).toBe("12 threads");
    expect(archive.querySelectorAll(".agent-preview .r")).toHaveLength(12);
    expect(archive.querySelector(".agent-preview .r b")?.textContent).toBe("Weekly digest 1");
    expect(buttons(archive).map((b) => b.textContent)).toEqual(["Apply", "Cancel"]);
    expect(chips()).toEqual([]);

    // Apply resumes the paused turn; the card becomes Applied with Undo, and the answer follows.
    await click(button(archive, "Apply"));
    expect(client.approvals).toEqual([
      { sessionId: session, activityId: "c2", decision: "approved" },
    ]);
    const applied = cardByTool("archived");
    if (!applied) throw new Error("no applied card");
    expect(applied.classList.contains("ok")).toBe(true);
    expect(applied.querySelector(".st")?.textContent?.trim()).toBe("Applied");
    expect(buttons(applied).map((b) => b.textContent)).toEqual(["Undo"]);
    expect(cards()).toHaveLength(2);
    expect([...document.querySelectorAll(".agent-thread .a p")].at(-1)?.textContent).toBe(
      "Archived 12 newsletters older than a week.",
    );

    // Undo from the card; it shows Undone and offers nothing more.
    await click(button(applied, "Undo"));
    expect(client.undos).toEqual(["c2"]);
    const undone = cardByTool("archived");
    expect(undone?.querySelector(".st")?.textContent?.trim()).toBe("Undone");
    expect(buttons(undone as HTMLElement)).toHaveLength(0);

    // Esc collapses the panel; the bar stays.
    await press("Escape", bar() ?? window);
    expect(document.querySelector(".agent-panel")).toBeNull();
    expect(bar()).not.toBeNull();
  });

  test("a send asks even for one message; Cancel changes nothing and the card says so", async () => {
    const client = fakeAgentClient({
      turns: [
        () => [
          toolEvent(
            {
              id: "s1",
              tool: "send_draft",
              tier: "always-ask",
              status: "waiting",
              inputSummary: "draft-1",
            },
            {
              kind: "send",
              to: [{ name: "Aoife", email: "aoife@example.test" }],
              cc: [],
              subject: "Re: Take-home review",
              text: "Thursday 15:00 works.",
            },
          ),
        ],
      ],
      onApprove: (call, decision) => [
        toolEvent({
          ...call,
          status: "done",
          approvedBy: null,
          undoable: false,
          declined: decision === "declined",
        }),
        { kind: "text", id: "t9", text: "Not sent." },
      ],
    });
    await mount(client);
    await typeInBar("send my reply to aoife");
    await submitBar();
    const send = cardByTool("send");
    if (!send) throw new Error("no send card");
    expect(send.dataset.tier).toBe("always-ask");
    expect(buttons(send).map((b) => b.textContent)).toEqual(["Approve", "Cancel"]);
    expect(send.querySelector(".agent-preview .count")?.textContent).toBe(
      "To Aoife: Re: Take-home review",
    );
    expect(send.querySelector(".agent-preview .body")?.textContent).toBe("Thursday 15:00 works.");
    await click(button(send, "Cancel"));
    expect(client.approvals).toMatchObject([{ activityId: "s1", decision: "declined" }]);
    const declined = cardByTool("sent");
    expect(declined?.querySelector(".st")?.textContent?.trim()).toBe("Cancelled");
    expect(buttons(declined as HTMLElement)).toHaveLength(0);
    expect(client.undos).toEqual([]);
  });

  test("a chip sends its sentence as a turn; /new starts a fresh Session; History lists them", async () => {
    const client = fakeAgentClient();
    await mount(client);
    await typeInBar("");
    const chip = [...document.querySelectorAll<HTMLElement>(".agent-suggest button")].find((c) =>
      c.textContent?.startsWith("Archive newsletters"),
    );
    await click(chip);
    expect(client.sent.map((s) => s.text)).toEqual(["Archive newsletters older than a week"]);
    expect(document.querySelector(".agent-thread .a p")?.textContent).toBe(
      "You said: Archive newsletters older than a week",
    );
    await typeInBar("/new");
    await submitBar();
    expect(document.querySelector(".agent-thread .u")).toBeNull();
    expect(client.sessions).toHaveLength(2);
    await click(document.querySelector('.agent-panel button[title="History"]'));
    const rows = [...document.querySelectorAll(".agent-history .r b")].map((b) => b.textContent);
    expect(rows).toEqual(["New conversation", "Archive newsletters older than a week"]);
    await click(document.querySelectorAll(".agent-history .r")[1]);
    expect(document.querySelector(".agent-thread .u")?.textContent).toBe(
      "Archive newsletters older than a week",
    );
  });
  test("a Session on a Local runtime: the header names it, Developer mode is a switch with its warning, the CLI's own tool is a marked card, and a switch shows as a line", async () => {
    const client = fakeAgentClient({
      turns: [
        () => [
          toolEvent({
            id: "b1",
            tool: "Bash",
            tier: "always-ask",
            status: "done",
            inputSummary: "command: ls ~",
            approvedBy: "user",
            result: "Desktop",
            builtin: true,
          }),
          { kind: "text", id: "t9", text: "Two folders." },
        ],
      ],
    });
    // The Settings ask for Claude Code: the Session starts on it and the header says so.
    await mount(client, { kind: "local", cli: "claude-code" });
    await typeInBar("what is in my home folder?");
    await submitBar();
    expect(client.sessions[0]?.runtime).toEqual({ kind: "local", cli: "claude-code" });
    expect(document.querySelector(".agent-panel .col-head .count")?.textContent).toBe(
      "Claude Code · tejas@genai-labs.io",
    );
    // Developer mode is off by default; the chip turns it on and the warning appears.
    const chip = [...document.querySelectorAll<HTMLElement>(".agent-developer .chip")][0];
    expect(chip?.textContent).toBe("Developer mode");
    expect(chip?.classList.contains("on")).toBe(false);
    expect(document.querySelector(".agent-developer .warn")).toBeNull();
    await click(chip);
    expect(document.querySelector(".agent-developer .chip")?.classList.contains("on")).toBe(true);
    expect(document.querySelector(".agent-developer .warn")?.textContent).toContain(
      "Developer mode gives the runtime its own shell, file and web tools.",
    );
    await typeInBar("again");
    await submitBar();
    expect(client.sent.at(-1)?.context.developerMode).toBe(true);
    // The CLI's own tool renders as a card with the warning glyph and the Developer mode title.
    const bash = document.querySelector<HTMLElement>('.tool[data-builtin="true"]');
    expect(bash?.querySelector(".t")?.textContent).toBe("Developer mode: Bash");
    expect(bash?.querySelector(".t i, .t svg")).not.toBeNull();
  });

  test("switching the Runtime mid-Session puts a line in the thread before the next turn", async () => {
    const client = fakeAgentClient();
    await mount(client, { kind: "local", cli: "claude-code" });
    await typeInBar("hello");
    await submitBar();
    expect(client.sessions[0]?.runtime).toEqual({ kind: "local", cli: "claude-code" });
    // The Settings now ask for a Hosted provider: the same Session moves, with the line.
    await act(async () => {
      root?.render(
        <StaticShell>
          <Harness
            client={client}
            runtime={{ kind: "hosted", provider: "anthropic", model: "claude-sonnet-5" }}
          />
        </StaticShell>,
      );
    });
    await typeInBar("and again");
    await submitBar();
    expect(client.sessions).toHaveLength(1);
    expect(client.sessions[0]?.runtime).toEqual({
      kind: "hosted",
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    const lines = [...document.querySelectorAll(".agent-thread .a .line")].map(
      (l) => l.textContent,
    );
    expect(lines).toEqual(["Now answering: Anthropic claude-sonnet-5"]);
    expect(document.querySelector(".agent-panel .col-head .count")?.textContent).toBe(
      "Anthropic claude-sonnet-5 · tejas@genai-labs.io",
    );
    // The transcript keeps the line between the two runtimes' turns.
    const transcript = (await client.load(client.sessions[0]?.id ?? "")).events;
    expect(transcript.map((e) => e.kind)).toEqual([
      "user",
      "text",
      "done",
      "runtime",
      "user",
      "text",
      "done",
    ]);
  });
});
