/// <reference types="bun-types" />
// The Routing page through its seams: Groups and Needs a decision from the
// RoutingSource, counts from the InboxSource, Confidence and the actions
// through a fake of the routing API. Mounted under a StaticShell with happy-dom.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { GroupView, ProposedMove, RoutingPreview } from "@monday/shared";
import { groups, threads } from "@monday/ui/fixtures";
import { dom } from "@monday/ui/test-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { StaticShell } from "../shell/Shell.tsx";
import { fixtureInbox } from "./inbox/actions.ts";
import { Routing, type RoutingApi } from "./Routing.tsx";
import { fixtureRouting } from "./routing/routing-data.ts";

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

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** A routing API whose Server has scored the fixture Groups and would move one Thread on a re-run. */
function fakeApi(): RoutingApi & { calls: string[] } {
  const calls: string[] = [];
  const views = new Map<string, GroupView>(
    groups.map((g) => [
      g.id,
      {
        ...g,
        examples:
          g.id === "hiring"
            ? [
                {
                  threadId: "e1",
                  positive: true,
                  from: { name: "Aoife Brennan", email: "aoife@northlight.dev" },
                  subject: "re: senior rust engineer role",
                  at: "2026-09-16T09:00:00.000Z",
                },
              ]
            : [],
        threads: g.id === "hiring" ? 2 : 0,
        unread: g.id === "hiring" ? 6 : 0,
        confidence: g.id === "hiring" ? 0.94 : null,
      },
    ]),
  );
  const move: ProposedMove = {
    threadId: "e6",
    from: { name: "Tomasz Kowalczyk", email: "t.kowalczyk@proton.me" },
    subject: "NixOS module for monday",
    current: { groupId: "community", subgroupId: null },
    proposed: { kind: "route", groupId: "hiring", subgroupId: "candidates", confidence: 0.9 },
  };
  const preview: RoutingPreview = { workspaceId: "ws", considered: 11, moves: [move], calls: 11 };
  return {
    calls,
    groups: async () => {
      calls.push("groups");
      return [...views.values()];
    },
    createGroup: async (_w, input) => {
      calls.push(`create:${input.name}`);
      const view: GroupView = {
        id: "new",
        workspaceId: "ws",
        parentId: null,
        name: input.name,
        rule: { sentence: input.sentence ?? "", predicate: input.predicate ?? {}, prompt: "" },
        threshold: null,
        briefPolicy: null,
        examples: [],
        threads: 0,
        unread: 0,
        confidence: null,
      };
      views.set(view.id, view);
      return view;
    },
    updateGroup: async (id, patch) => {
      calls.push(`update:${id}:${JSON.stringify(patch)}`);
      const view = views.get(id) as GroupView;
      return view;
    },
    deleteGroup: async (id) => {
      calls.push(`delete:${id}`);
    },
    decisions: async () => [],
    decide: async (threadId, groupId) => {
      calls.push(`decide:${threadId}:${groupId}`);
      return { examples: [], revised: groupId };
    },
    rerun: async () => {
      calls.push("rerun");
      return preview;
    },
    apply: async (_w, moves) => {
      calls.push(`apply:${moves.map((m) => m.threadId).join(",")}`);
      return { moved: moves.length, asked: 0 };
    },
    route: async () => ({ jobId: "j" }),
    routeOf: async () => null,
  };
}

async function mount(api: RoutingApi, routing = fixtureRouting()) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <StaticShell settings={{ "ai.level": "automate" }}>
        <Routing routing={routing} inbox={fixtureInbox(threads)} api={api} />
      </StaticShell>,
    );
  });
  await act(async () => {
    await tick();
  });
  return host;
}

const click = async (el: Element | null | undefined) => {
  if (!(el instanceof HTMLElement)) throw new Error("nothing to click");
  await act(async () => {
    el.click();
    await tick();
  });
};

const buttons = (el: HTMLElement) => [...el.querySelectorAll("button")];
const byText = (el: HTMLElement, text: string) =>
  buttons(el).find((b) => b.textContent?.trim() === text);

describe("Routing page", () => {
  test("renders the Groups tree with rules, Sub-groups, Confidence and the side cards from the mock", async () => {
    const api = fakeApi();
    const el = await mount(api);
    const cards = [...el.querySelectorAll(".grp")];
    expect(cards.map((c) => c.querySelector("b")?.textContent)).toEqual([
      "Hiring",
      "Finance",
      "Investors",
      "Community",
      "Press",
    ]);
    const hiring = cards[0] as HTMLElement;
    expect(hiring.querySelector(".grp-h .tag")?.textContent).toBe("94% confident");
    expect(hiring.querySelector(".grp-h .n")?.textContent).toBe("6 unread");
    expect(hiring.querySelector(".rule code")?.textContent).toBe("careers.genai-labs.io");
    expect([...hiring.querySelectorAll(".subg")].map((s) => s.textContent)).toEqual([
      expect.stringContaining("Candidates"),
      expect.stringContaining("Interviews"),
      expect.stringContaining("Rejected"),
    ]);
    // Only Hiring was scored; the others show no Confidence.
    expect(cards[1]?.querySelector(".grp-h .tag")).toBeNull();
    expect(el.querySelector(".page-head h1")?.textContent).toBe("Routing");
    const sideTitles = [...el.querySelectorAll(".side-card h3")].map((h) => h.textContent);
    expect(sideTitles).toEqual(["Ask for a group", "Needs a decision2", "Recently routed"]);
    expect(el.querySelector(".ask input")?.getAttribute("placeholder")).toBe(
      "A Support inbox for anything from customers",
    );
    // Needs a decision: two rows from the fixture, candidates as buttons.
    const decisions = el.querySelectorAll(".side-card")[1] as HTMLElement;
    expect(decisions.querySelectorAll(".sample")).toHaveLength(2);
    expect(buttons(decisions).map((b) => b.textContent?.trim())).toEqual([
      "Hiring",
      "Community",
      "Finance",
      "",
    ]);
    expect(api.calls).toEqual(["groups"]);
  });

  test("accepting a decision calls the API and drops the row; leaving passes null", async () => {
    const api = fakeApi();
    const routing = fixtureRouting();
    const el = await mount(api, routing);
    const decisions = () => el.querySelectorAll(".side-card")[1] as HTMLElement;
    await click(byText(decisions(), "Hiring"));
    expect(api.calls).toContain("decide:d1:hiring");
    expect(decisions().querySelectorAll(".sample")).toHaveLength(1);
    await click(decisions().querySelector('button[aria-label="Leave"]'));
    expect(api.calls).toContain("decide:d2:null");
    expect(decisions().querySelectorAll(".sample")).toHaveLength(0);
    expect(decisions().textContent).toContain("Nothing waiting on you");
  });

  test("Re-run shows the preview first and applies only on the second click", async () => {
    const api = fakeApi();
    const el = await mount(api);
    await click(byText(el, "Re-run on inbox"));
    expect(api.calls).toContain("rerun");
    const preview = el.querySelector(".side-card.preview") as HTMLElement;
    expect(preview.querySelector("h3")?.textContent).toContain("What would move");
    expect(preview.textContent).toContain("1 of 11 threads would move");
    expect(preview.querySelector(".sample .tag")?.textContent).toBe("Candidates");
    expect(api.calls.filter((c) => c.startsWith("apply"))).toEqual([]);
    await click(byText(preview, "Apply"));
    expect(api.calls).toContain("apply:e6");
    expect(el.querySelector(".side-card.preview")).toBeNull();
  });

  test("Change rule opens the editor with the Predicate and Examples; Save sends the patch", async () => {
    const api = fakeApi();
    const el = await mount(api);
    await click(byText(el, "Change rule"));
    const editor = el.querySelector(".rule-edit") as HTMLElement;
    expect(editor).not.toBeNull();
    const inputs = [...editor.querySelectorAll("input, textarea")] as HTMLInputElement[];
    expect(inputs[0]?.value).toBe("Hiring");
    expect(inputs[2]?.value).toBe("careers.genai-labs.io");
    expect(editor.textContent).toContain("1 examples");
    expect(editor.querySelector(".rule-examples .sample")?.textContent).toContain(
      "re: senior rust engineer role",
    );
    await click(byText(editor, "Save"));
    const update = api.calls.find((c) => c.startsWith("update:hiring:"));
    expect(update).toBeDefined();
    expect(JSON.parse((update as string).slice("update:hiring:".length))).toMatchObject({
      name: "Hiring",
      predicate: { domains: ["careers.genai-labs.io"] },
      threshold: null,
      briefPolicy: null,
    });
    expect(el.querySelector(".rule-edit")).toBeNull();
  });
});
