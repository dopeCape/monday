/// <reference types="bun-types" />
// The Routing page through its seams: Groups and Needs a decision from the
// RoutingSource, counts from the InboxSource, Confidence, Examples, routes
// and the actions through a fake of the routing API; the tabs, why each
// Thread went where it did, and the locked state below automate. Mounted
// under a StaticShell with happy-dom.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type {
  GroupView,
  JudgeState,
  ProposedMove,
  RerunProgress,
  RoutingBacklog,
  RoutingPreview,
} from "@monday/shared";
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
    rerun: async (_w, _recent, scope) => {
      calls.push("rerun", `rerun:${scope ?? ""}`);
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
  sorting: { state(): Promise<JudgeState> } | null = null,
  level: "off" | "assist" | "automate" = "automate",
) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <StaticShell settings={{ "ai.level": level }}>
        <Routing routing={routing} inbox={fixtureInbox(threads)} api={api} sorting={sorting} />
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

const typeInto = async (input: Element | null | undefined, value: string) => {
  if (!input) throw new Error("no input");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
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
    await click(byText(el, "Show what would move"));
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

  test("a re-run that streams shows how far it is and what it just scored, then the result above the tabs", async () => {
    const base = fakeApi();
    let tell!: (p: RerunProgress) => void;
    let finish!: () => void;
    const api = {
      ...base,
      rerunWithProgress: (workspaceId: string, onProgress: (p: RerunProgress) => void) => {
        tell = onProgress;
        return new Promise<RoutingPreview>((resolve) => {
          finish = () => void base.rerun(workspaceId).then(resolve);
        });
      },
    };
    const el = await mount(api);
    await click(byText(el, "Re-run on inbox"));
    await click(byText(el, "Show what would move"));
    expect(el.querySelector(".rt-rerun")?.textContent).toContain("Getting your newest threads");
    await act(async () => tell({ done: 3, total: 11, moves: 1, subject: "Term sheet" }));
    const panel = el.querySelector(".rt-rerun") as HTMLElement;
    expect(panel.textContent).toContain("Sorting 3 of 11");
    expect(panel.textContent).toContain("1 would move so far");
    expect(panel.textContent).toContain("Just scored: Term sheet");
    await act(async () => {
      finish();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(el.querySelector(".rt-rerun")).toBeNull();
    const result = el.querySelector(".side-card.preview") as HTMLElement;
    expect(result.textContent).toContain("1 of 11 threads would move");
    // The result sits above the tabs, not in the side column.
    expect(result.closest("aside")).toBeNull();
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
            sorting={null}
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

  test("at automate with nothing to sort with the page names the three ways; with TypeSafe or a coding agent it says nothing", async () => {
    const el = await mount(fakeApi(), fixtureRouting(), {
      state: async (): Promise<JudgeState> => ({ provider: "none", model: "" }),
    });
    expect(el.querySelector(".routing-note")?.textContent).toBe(
      "Sorting needs TypeSafe, an AI provider key, or a coding agent. Add one under AI and agent and sorting picks up again on its own.",
    );
    await act(async () => root?.unmount());
    host?.remove();
    const el2 = await mount(fakeApi(), fixtureRouting(), {
      state: async (): Promise<JudgeState> => ({ provider: "typesafe", model: "jev-1.13.0" }),
    });
    expect(el2.querySelector(".routing-note")).toBeNull();
    await act(async () => root?.unmount());
    host?.remove();
    const el3 = await mount(fakeApi(), fixtureRouting(), {
      state: async (): Promise<JudgeState> => ({
        provider: "llm",
        model: "Claude Code",
        runtime: "local",
      }),
    });
    expect(el3.querySelector(".routing-note")).toBeNull();
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

  test("Re-run asks which mail first: the Setting's scope, or the newest N, the last N units, or a date", async () => {
    const api = fakeApi();
    const el = await mount(api);
    await click(byText(el, "Re-run on inbox"));
    const pop = el.querySelector(".rt-scope-pop") as HTMLElement;
    expect(pop.querySelector(".pop-h")?.textContent).toBe("Which mail to sort");
    // The default comes from routing.rerun.scope: the newest 50.
    expect((pop.querySelector(".scope-n") as HTMLInputElement).value).toBe("50");
    expect(pop.querySelector(".scope-says")?.textContent).toBe("The newest 50 threads");
    // The last 6 months.
    await click(byText(pop, "The last"));
    await typeInto(pop.querySelector(".scope-n"), "6");
    await click(byText(pop, "months"));
    expect(pop.querySelector(".scope-says")?.textContent).toBe("The last 6 months");
    await click(byText(pop, "Show what would move"));
    expect(api.calls).toContain("rerun:last 6 months");
    expect(el.querySelector(".rt-scope-pop")).toBeNull();
    // Since a date, then everything; a scope that is not one keeps the button off.
    await click(byText(el, "Re-run on inbox"));
    const again = el.querySelector(".rt-scope-pop") as HTMLElement;
    expect(again.querySelector(".scope-says")?.textContent).toBe("The last 6 months");
    await click(byText(again, "Since"));
    expect(byText(again, "Show what would move")?.disabled).toBe(true);
    expect(again.querySelector(".scope-says")?.textContent).toBe(
      "Pick a number from 1 up, or a date.",
    );
    await typeInto(again.querySelector(".scope-date"), "2026-01-01");
    await click(byText(again, "Show what would move"));
    expect(api.calls).toContain("rerun:since 2026-01-01");
    await click(byText(el, "Re-run on inbox"));
    await click(byText(el.querySelector(".rt-scope-pop") as HTMLElement, "Everything"));
    await click(byText(el, "Show what would move"));
    expect(api.calls).toContain("rerun:all");
  });

  test("a large scope shows a sample with counts per Group; Apply starts the background sort, which pauses, resumes and stops", async () => {
    const base = fakeApi();
    const move = (id: string, groupId: string): ProposedMove => ({
      threadId: id,
      from: { name: "Stripe", email: "billing@stripe.com" },
      subject: `Invoice ${id}`,
      current: { groupId: null, subgroupId: null },
      proposed: { kind: "route", groupId, subgroupId: null, confidence: 0.95 },
    });
    let state: RoutingBacklog = {
      workspaceId: "ws",
      scope: "all",
      status: "running",
      reason: null,
      sorter: "typesafe",
      local: false,
      done: 100,
      total: 56000,
      moved: 2,
      asked: 0,
      skipped: 0,
      batches: 0,
      batchSize: 0,
      calls: 0,
      startedAt: "2026-09-16T12:00:00.000Z",
      updatedAt: "2026-09-16T12:00:00.000Z",
      finishedAt: null,
      lastError: null,
    };
    const started: unknown[] = [];
    const api: RoutingApi = {
      ...base,
      rerun: async (_w, _recent, scope) => ({
        workspaceId: "ws",
        considered: 100,
        calls: 100,
        moves: [move("i1", "hiring"), move("i2", "hiring")],
        scope: scope ?? "",
        inScope: 56000,
        complete: false,
        after: { at: "2025-01-01T00:00:00.000Z", id: "t100" },
        byTarget: { hiring: 2 },
      }),
      // Nothing runs until Apply starts it; after that the Server answers with where it is.
      backlog: async () => (started.length ? state : null),
      startBacklog: async (_w, input) => {
        started.push(input);
        return { backlog: state, applied: { moved: 2, asked: 0 } };
      },
      backlogAction: async (_w, action) => {
        state = {
          ...state,
          status: action === "pause" ? "paused" : action === "resume" ? "running" : "cancelled",
          ...(action === "cancel" ? { finishedAt: "2026-09-16T12:01:00.000Z" } : {}),
        };
        base.calls.push(`backlog:${action}`);
        return state;
      },
    };
    const el = await mount(api);
    await click(byText(el, "Re-run on inbox"));
    await click(byText(el, "Everything"));
    await click(byText(el, "Show what would move"));
    const preview = el.querySelector(".side-card.preview") as HTMLElement;
    const summary = preview.querySelector("p")?.textContent ?? "";
    expect(summary).toContain("2 of the newest 100 would move");
    expect(summary).toContain("All your mail holds 56,000 threads");
    expect(summary).toContain("Hiring: 2");
    await click(byText(preview, "Apply and sort the rest"));
    expect(started).toEqual([
      {
        scope: "all",
        moves: [move("i1", "hiring"), move("i2", "hiring")],
        after: { at: "2025-01-01T00:00:00.000Z", id: "t100" },
        done: 100,
      },
    ]);
    // The background sort's card: how far, what it did, and its buttons.
    const card = () => el.querySelector(".rt-backlog") as HTMLElement;
    expect(card().textContent).toContain("Sorting all your mail");
    expect(card().textContent).toContain("100 of 56,000 threads");
    expect(card().textContent).toContain("2 moved, 0 to decide");
    await click(byText(card(), "Pause"));
    expect(base.calls).toContain("backlog:pause");
    expect(card().dataset.status).toBe("paused");
    await click(byText(card(), "Resume"));
    expect(base.calls).toContain("backlog:resume");
    expect(card().dataset.status).toBe("running");
    await click(byText(card(), "Stop"));
    expect(base.calls).toContain("backlog:cancel");
    expect(card().textContent).toContain("Stopped after 100 threads: 2 moved.");
    await click(byText(card(), "Dismiss"));
    expect(el.querySelector(".rt-backlog")).toBeNull();
  });

  test("a background sort that waits says why; on a coding agent it says it is slow", async () => {
    const base = fakeApi();
    const backlog: RoutingBacklog = {
      workspaceId: "ws",
      scope: "last 3 months",
      status: "waiting",
      reason: "no_judge",
      sorter: "llm",
      local: true,
      done: 40,
      total: 5400,
      moved: 12,
      asked: 3,
      skipped: 1,
      batches: 8,
      batchSize: 5,
      calls: 8,
      startedAt: "2026-09-16T12:00:00.000Z",
      updatedAt: "2026-09-16T12:00:00.000Z",
      finishedAt: null,
      lastError: null,
    };
    const el = await mount({ ...base, backlog: async () => backlog });
    const card = el.querySelector(".rt-backlog") as HTMLElement;
    expect(card.textContent).toContain("Sorting the last 3 months");
    expect(card.textContent).toContain("12 moved, 3 to decide, 1 you placed");
    expect(card.textContent).toContain("Batch 8, 5 threads each");
    expect(card.textContent).toContain(
      "Sorting needs TypeSafe, an AI provider key, or a coding agent.",
    );
    expect(card.textContent).toContain("Sorting with your coding agent, a few threads at a time.");
  });
});
