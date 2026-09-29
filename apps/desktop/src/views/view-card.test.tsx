/// <reference types="bun-types" />
// The View card in the Agent (slice 40) through the DOM with happy-dom: the
// tried Threads with their Lane and reasons, the counts, the quiet-scope
// line; Pin view waits until the tried Threads are shown; Move to and Wrong
// are corrections sent to the draft; Revise sends the Agent a turn; Pin
// view saves; an edit shows its moves and Apply, with Undo; without a
// TypeSafe key only the Fact Lanes can be kept. The Server is a scripted api.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { ViewDraft, ViewTest } from "@monday/shared";
import { SUPPORT_TODAY_VIEW } from "@monday/shared";
import { dom } from "@monday/ui/test-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { ComposerEnvContext } from "../agent/aui/context.tsx";
import { type Api, createApi } from "../platform/api.ts";
import { StaticShell } from "../shell/Shell.tsx";
import { canPin, ViewCard } from "./ViewCard.tsx";

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

const tried = (i: number, lane: string, reasons: string[]) => ({
  threadId: `t${i}`,
  from: `c${i}@customer.test`,
  subject: `Export broken ${i}`,
  lastActivity: "2026-09-29T09:00:00.000Z",
  lane,
  notRead: false,
  certainty: 0.8,
  reasons,
  nouls: [{ signal: "is_support_request", label: "support request", noul: 0.9 }],
  values: [],
  actions: [],
});

const TEST: ViewTest = {
  tried: 12,
  shown: [
    tried(1, "red", ["support request 95%", "blocked 2.0 of 2"]),
    ...Array.from({ length: 9 }, (_, i) => tried(i + 2, "green", ["support request 90%"])),
  ],
  counts: { red: 1, yellow: 0, green: 11, unsure: 0, others: 0 },
  widened: { when: "today", count: 4 },
  empty: false,
  inScope: 4,
  agreement: null,
  changes: [],
  needsJudge: false,
  moves: null,
  blocks: [],
};

const DRAFT: ViewDraft = {
  id: "bd_1",
  workspaceId: "ws",
  viewId: null,
  status: "open",
  doc: SUPPORT_TODAY_VIEW,
  previous: null,
  test: TEST,
  threadIds: [],
  createdAt: "2026-09-29T10:00:00.000Z",
  updatedAt: "2026-09-29T10:00:00.000Z",
};

function scripted(initial: ViewDraft) {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  let draft = initial;
  const base = createApi(() => ({ baseUrl: "http://127.0.0.1:4242", token: "t" }));
  const api: Api = {
    ...base,
    views: {
      ...base.views,
      draft: async () => draft,
      correct: async (id, c) => {
        calls.push({ name: "correct", args: [id, c] });
        const key = c.lane ? "_lanes" : (c.signal ?? "");
        draft = {
          ...draft,
          doc: {
            ...draft.doc,
            examples: {
              ...draft.doc.examples,
              [key]: [
                { threadId: c.threadId, ...(c.lane ? { lane: c.lane } : { holds: c.holds }) },
              ],
            },
          },
        };
        return draft;
      },
      pinDraft: async (id, options) => {
        calls.push({ name: "pin", args: [id, options] });
        draft = { ...draft, status: "pinned" };
        return { view: {} as never, draft };
      },
      applyDraft: async (id) => {
        calls.push({ name: "apply", args: [id] });
        draft = { ...draft, status: "applied" };
        return { view: { id: "b1", version: 2 } as never, draft, previous: 1 };
      },
      revert: async (id, version) => {
        calls.push({ name: "revert", args: [id, version] });
        return {} as never;
      },
      discardDraft: async (id) => {
        calls.push({ name: "discard", args: [id] });
        draft = { ...draft, status: "discarded" };
        return draft;
      },
    },
  };
  return { api, calls };
}

async function mount(draft: ViewDraft, sent: string[] = []) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const r = root;
  const { api, calls } = scripted(draft);
  const env = {
    strings: {} as never,
    now: new Date(),
    runStartedAt: null,
    actions: {
      approve() {},
      decline() {},
      undo() {},
      retry() {},
      openThread() {},
      openLink() {},
      recall() {},
      send: (text: string) => sent.push(text),
      newSession() {},
      attach() {},
    },
  };
  await act(async () =>
    r.render(
      <StaticShell
        shell={{
          api,
          server: { kind: "sidecar", target: { baseUrl: "http://127.0.0.1:4242", token: "t" } },
        }}
      >
        <ComposerEnvContext.Provider value={env}>
          <ViewCard
            preview={{
              kind: "view",
              action: "create",
              draftId: draft.id,
              viewId: draft.viewId,
              name: draft.doc.name,
              draft,
            }}
          />
        </ComposerEnvContext.Provider>
      </StaticShell>,
    ),
  );
  return { calls, el: host };
}

const click = async (el: Element | null | undefined) => {
  if (!el) throw new Error("nothing to click");
  await act(async () => (el as HTMLElement).click());
};
const button = (el: ParentNode, label: string) =>
  [...el.querySelectorAll("button")].find((b) => b.textContent === label);

describe("the View card", () => {
  test("the tried Threads, their Lanes and reasons, the counts and the quiet-scope line", async () => {
    const { el } = await mount(DRAFT);
    const rows = el.querySelectorAll(".bc-row");
    expect(rows).toHaveLength(10);
    expect(rows[0]?.querySelector(".why")?.textContent).toBe(
      "Red: support request 95%, blocked 2.0 of 2",
    );
    expect(el.textContent).toContain("Tried on 12 threads");
    expect(el.textContent).toContain("Tried on earlier days: today has 4 threads so far");
    expect(el.querySelector('.bc-lane[data-lane="green"] b')?.textContent).toBe("11");
    expect(button(el, "Pin view")?.hasAttribute("disabled")).toBe(false);
    // Fewer shown than tried and than the Setting: Pin waits.
    expect(canPin({ ...DRAFT, test: { ...TEST, shown: TEST.shown.slice(0, 3) } }, 10)).toBe(false);
    expect(canPin({ ...DRAFT, test: { ...TEST, shown: [], tried: 0, empty: true } }, 10)).toBe(
      true,
    );
  });

  test("Wrong and Move to are corrections; Revise asks the Agent; Pin view saves", async () => {
    const sent: string[] = [];
    const { el, calls } = await mount(DRAFT, sent);
    const first = el.querySelector(".bc-row");
    await click(first && button(first, "Wrong"));
    expect(calls[0]).toEqual({
      name: "correct",
      args: ["bd_1", { threadId: "t1", signal: "is_support_request", holds: false }],
    });
    await click(first && button(first, "Move to"));
    await click(
      [...el.querySelectorAll(".pop-item")].find((b) => b.textContent === "Unsure") ?? null,
    );
    expect(calls[1]).toEqual({
      name: "correct",
      args: ["bd_1", { threadId: "t1", lane: "unsure" }],
    });
    await click(button(el, "Revise with my corrections"));
    expect(sent).toEqual(["Revise the view draft bd_1 with my corrections"]);
    await click(button(el, "Pin view"));
    expect(calls.at(-1)).toEqual({ name: "pin", args: ["bd_1", undefined] });
    expect(el.textContent).toContain("Pinned in the nav.");
  });

  test("an edit shows its moves and Apply, then Undo; no key keeps only the Fact Lanes", async () => {
    const edit: ViewDraft = {
      ...DRAFT,
      viewId: "b1",
      test: { ...TEST, moves: [{ from: "yellow", to: "green", threadIds: ["a", "b"] }] },
    };
    const { el, calls } = await mount(edit);
    expect(el.textContent).toContain("2 threads move: 2 Yellow to Green");
    await click(button(el, "Apply"));
    expect(el.textContent).toContain("Saved as version 2.");
    await click(button(el, "Undo"));
    expect(calls.at(-1)).toEqual({ name: "revert", args: ["b1", 1] });
    await act(async () => root?.unmount());
    root = null;
    const noKey = await mount({ ...DRAFT, test: { ...TEST, needsJudge: true } });
    expect(noKey.el.textContent).toContain("Views that read your mail need a TypeSafe key.");
    await click(button(noKey.el, "Keep only the lanes that need no reading"));
    expect(noKey.calls.at(-1)).toEqual({ name: "pin", args: ["bd_1", { factsOnly: true }] });
  });
});
