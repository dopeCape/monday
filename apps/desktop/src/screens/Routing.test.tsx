/// <reference types="bun-types" />
// The Routing page through its seams: Groups and Needs a decision from the
// RoutingSource, counts from the InboxSource, Confidence, Examples, routes
// and the actions through a fake of the routing API; the tabs, why each
// Thread went where it did, and the locked state below automate. Mounted
// under a StaticShell with happy-dom.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { GroupView, HostedProvider, ProposedMove, RoutingPreview } from "@monday/shared";
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
    sectionJudgments: async () => [],
    routeOf: async () => null,
  };
}

async function mount(
  api: RoutingApi,
  routing = fixtureRouting(),
  keys: { shared(): Promise<{ shared: HostedProvider[] }> } | null = null,
  level: "off" | "assist" | "automate" = "automate",
) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <StaticShell settings={{ "ai.level": level }}>
        <Routing routing={routing} inbox={fixtureInbox(threads)} api={api} keys={keys} />
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
  test("renders each Group as a card: its rule, what always goes there, Sub-groups, Confidence and corrections", async () => {
    const api = fakeApi();
    const el = await mount(api);
    const cards = [...el.querySelectorAll(".rgrp")];
    expect(cards.map((c) => c.querySelector(".rgrp-name b")?.textContent)).toEqual([
      "Hiring",
      "Finance",
      "Investors",
      "Community",
      "Press",
    ]);
    const hiring = cards[0] as HTMLElement;
    expect(hiring.querySelector(".rgrp-conf-label")?.textContent).toBe("94% confident");
    expect([...hiring.querySelectorAll(".rgrp-stats span")].map((s) => s.textContent)).toEqual([
      "6 unread",
      "2 threads",
    ]);
    expect(hiring.querySelector(".rgrp-rule .rule code")?.textContent).toBe(
      "careers.genai-labs.io",
    );
    expect([...hiring.querySelectorAll(".rgrp-chip")].map((c) => c.textContent)).toEqual([
      "Anyone at careers.genai-labs.io",
    ]);
    expect([...hiring.querySelectorAll(".rgrp-sub")].map((s) => s.textContent)).toEqual([
      expect.stringContaining("Candidates"),
      expect.stringContaining("Interviews"),
      expect.stringContaining("Rejected"),
    ]);
    // What it learned from the user's moves, behind a toggle.
    const learned = hiring.querySelector(".rgrp-learned") as HTMLElement;
    expect(learned.textContent).toContain("Learned from 1 of your corrections");
    expect(learned.querySelector(".sample")).toBeNull();
    await click(byText(learned, "Show"));
    expect(learned.querySelector(".sample")?.textContent).toContain(
      "re: senior rust engineer role",
    );
    // Only Hiring was scored; the others show no Confidence.
    expect(cards[1]?.querySelector(".rgrp-conf")).toBeNull();
    expect([...(cards[1]?.querySelectorAll(".rgrp-chip") ?? [])].map((c) => c.textContent)).toEqual(
      ["From billing@hetzner.com", "From receipts@stripe.com"],
    );
    // The overview line: how many, and that new mail is sorted as it arrives.
    expect(el.querySelector(".rt-stats")?.textContent).toContain("5 Groups");
    expect(el.querySelector(".rt-sorting")?.textContent).toBe("Sorting new mail as it arrives");
    expect(el.querySelector(".page-head h1")?.textContent).toBe("Routing");
    const sideTitles = [...el.querySelectorAll(".side-card h3")].map((h) => h.textContent);
    expect(sideTitles).toEqual(["Ask for a group", "Needs a decision2", "Recently routed"]);
    expect(el.querySelector(".ask input")?.getAttribute("placeholder")).toBe(
      "A Support inbox for anything from customers",
    );
    // Needs a decision: two rows from the fixture, candidates as buttons.
    const decisions = el.querySelectorAll(".side-card")[1] as HTMLElement;
    expect(decisions.querySelectorAll(".sample")).toHaveLength(2);
    // Every row can be left out of every Group, tied candidates or not.
    // Each candidate says how sure routing was.
    expect(buttons(decisions).map((b) => b.textContent?.trim())).toEqual([
      "Hiring 61%",
      "Community 54%",
      "",
      "Finance 66%",
      "",
    ]);
    expect(decisions.querySelectorAll('button[aria-label="Leave"]')).toHaveLength(2);
    expect(api.calls.filter((c) => c === "groups")).toEqual(["groups"]);
  });

  test("accepting a decision calls the API and drops the row; leaving passes null", async () => {
    const api = fakeApi();
    const routing = fixtureRouting();
    const el = await mount(api, routing);
    const decisions = () => el.querySelectorAll(".side-card")[1] as HTMLElement;
    await click(byText(decisions(), "Hiring 61%"));
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

  test("Ask for a group hands the typed sentence to the composer, with the Setting's prefix", async () => {
    const asked: string[] = [];
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <StaticShell settings={{ "ai.level": "automate" }}>
          <Routing
            routing={fixtureRouting()}
            inbox={fixtureInbox(threads)}
            api={fakeApi()}
            keys={null}
            onAsk={(t) => asked.push(t)}
          />
        </StaticShell>,
      );
    });
    await act(async () => {
      await tick();
    });
    const input = host.querySelector<HTMLInputElement>(".ask input");
    if (!input) throw new Error("no ask box");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "A Support inbox for anything from customers");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await tick();
    });
    expect(asked).toEqual(["Make a group: A Support inbox for anything from customers"]);
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

  test("Delete group asks once, naming the Group, and deletes on the second click", async () => {
    const api = fakeApi();
    const el = await mount(api);
    await click(byText(el, "Change rule"));
    const editor = el.querySelector(".rule-edit") as HTMLElement;
    await click(byText(editor, "Delete group"));
    expect(api.calls.filter((c) => c.startsWith("delete"))).toEqual([]);
    const confirm = byText(editor, "Delete Hiring for good");
    expect(confirm?.className).toContain("danger");
    // Cancel forgets the question; the next Delete asks again.
    await click(byText(editor, "Cancel"));
    await click(byText(el, "Change rule"));
    const again = el.querySelector(".rule-edit") as HTMLElement;
    expect(byText(again, "Delete group")).toBeDefined();
    await click(byText(again, "Delete group"));
    await click(byText(again, "Delete Hiring for good"));
    expect(api.calls).toContain("delete:hiring");
    expect(el.querySelector(".rule-edit")).toBeNull();
  });

  test("with the Server unreachable no Confidence is shown: nothing comes from the fixtures", async () => {
    const api = fakeApi();
    api.groups = async () => {
      throw new Error("offline");
    };
    const el = await mount(api);
    expect([...el.querySelectorAll(".rgrp-conf")]).toHaveLength(0);
    // The unread counts still come from the stream.
    expect(el.querySelector(".rgrp-stats span")?.textContent).toBe("1 unread");
  });

  test("at automate with no shared key the page says routing needs one; with a key it says nothing", async () => {
    const el = await mount(fakeApi(), fixtureRouting(), { shared: async () => ({ shared: [] }) });
    expect(el.querySelector(".routing-note")?.textContent).toBe(
      "Routing runs on the Server with a shared key. Share one under AI and agent.",
    );
    await act(async () => root?.unmount());
    host?.remove();
    const el2 = await mount(fakeApi(), fixtureRouting(), {
      shared: async () => ({ shared: ["anthropic"] }),
    });
    expect(el2.querySelector(".routing-note")).toBeNull();
  });

  test("Recently routed says why each Thread went where it did", async () => {
    const api = fakeApi();
    api.routeOf = async (threadId) =>
      threadId === "e5"
        ? {
            threadId,
            groupId: "press",
            subgroupId: null,
            confidence: null,
            subgroupConfidence: null,
            by: "user",
            routedAt: "2026-09-16T09:00:00.000Z",
          }
        : threadId === "e1"
          ? {
              threadId,
              groupId: "hiring",
              subgroupId: "candidates",
              confidence: 0.9,
              subgroupConfidence: 0.82,
              by: "model",
              routedAt: "2026-09-16T09:00:00.000Z",
            }
          : null;
    const el = await mount(api);
    await act(async () => {
      await tick();
    });
    const rows = [...el.querySelectorAll(".rt-recent .routed")];
    const why = (subject: string) =>
      rows
        .find((r) => r.querySelector(".routed-subject")?.textContent === subject)
        ?.querySelector(".routed-why")?.textContent;
    // A Predicate fact the headers met.
    expect(why("Term sheet redline, v3")).toBe("Matched meridianfund.co");
    // The user's own move, and the rule sentence with the model's Confidence.
    expect(why("Podcast invite: building email clients in 2026")).toBe("You put it here");
    expect(why("Re: Senior Rust engineer role, take-home submitted")).toBe(
      "Read the rule, 82% sure",
    );
  });

  test("the Sections and Custom actions tabs hold their blocks", async () => {
    const el = await mount(fakeApi());
    expect(el.querySelector('[data-block="sections"]')).toBeNull();
    await click(el.querySelectorAll(".rt-tabs button")[1]);
    expect(el.querySelector('[data-block="sections"]')).not.toBeNull();
    expect(el.querySelector(".rgrp")).toBeNull();
    await click(el.querySelectorAll(".rt-tabs button")[2]);
    expect(el.querySelector('[data-block="actions"]')).not.toBeNull();
  });

  test("below automate sorting is paused: the page says so, and the Groups stay, editable by hand", async () => {
    const api = fakeApi();
    const el = await mount(api, fixtureRouting(), null, "off");
    const lock = el.querySelector(".locked") as HTMLElement;
    expect(lock.querySelector("h2")?.textContent).toBe("Sorting is paused");
    expect(lock.querySelector(".locked-lede")?.textContent).toBe(
      "Increase the AI level to unlock Routing.",
    );
    expect(lock.querySelector(".locked-body")?.textContent).toContain(
      "At Just mail new mail is not sorted into your 5 Groups",
    );
    expect(el.querySelector(".rt-sorting")?.textContent).toBe("Sorting paused");
    // Every rule is kept and says it is paused.
    const cards = [...el.querySelectorAll<HTMLElement>(".rgrp")];
    expect(cards).toHaveLength(5);
    expect(cards.every((c) => c.dataset.paused === "true")).toBe(true);
    expect(cards[0]?.querySelector(".rgrp-label .tag")?.textContent).toBe("Paused");
    // Nothing that asks a model: no re-run, no Ask for a group.
    expect(byText(el, "Re-run on inbox")).toBeUndefined();
    expect(el.querySelector(".ask input")).toBeNull();
    // Groups still work by hand.
    await click(byText(el, "Change rule"));
    expect(el.querySelector(".rule-edit")).not.toBeNull();
    // Raising the level asks once, then the page unlocks.
    await click(byText(lock, "Raise to Mail that sorts and acts for me"));
    await click(byText(lock, "Turn on Mail that sorts and acts for me"));
    expect(el.querySelector(".locked")).toBeNull();
    expect(byText(el, "Re-run on inbox")).toBeDefined();
  });
});
