/// <reference types="bun-types" />
// The Workflows page through its seam: the list with each Workflow's
// trigger, status and last run; the selected Workflow drawn as a flow of
// cards; a Run's Step results laid over the flow; the approval card a paused
// Run waits on; the Dry run preview, rename, the Source view and the "Change
// with monday" handoff; and the locked state below automate. Mounted under a
// StaticShell with happy-dom over the fixture API.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { RunView } from "@monday/shared";
import { dom } from "@monday/ui/test-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { StaticShell } from "../shell/Shell.tsx";
import { WorkspaceProvider } from "../workspace.tsx";
import { Workflows } from "./Workflows.tsx";
import { fixtureWorkflowsApi, type WorkflowsApi } from "./workflows/workflow-data.ts";

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
const NOW = new Date("2026-09-16T10:00:00");

/** The fixture API with one Run of Candidate intake paused at Slack. */
function pausedApi(): WorkflowsApi & { calls: string[] } {
  const api = fixtureWorkflowsApi();
  const listRuns = api.runs;
  const paused: RunView = {
    id: "r9",
    workflowId: "w1",
    workspaceId: "ws",
    version: 1,
    status: "paused",
    trigger: { kind: "arrival", threadId: "t-r9" },
    threadId: "t-r9",
    subject: "Priya Raman, Rust engineer",
    currentStep: 3,
    failedStep: null,
    waitingActivityId: "a-r9",
    waitingStep: 3,
    error: null,
    steps: [
      {
        index: 0,
        stepId: "extract",
        name: "Extract",
        kind: "agentic",
        status: "done",
        detail: "name: Priya Raman, role: Rust engineer",
        activityId: null,
        at: NOW.toISOString(),
      },
      {
        index: 1,
        stepId: "notion",
        name: "Notion",
        kind: "notion",
        status: "done",
        detail: "Row added to Hiring",
        activityId: null,
        at: NOW.toISOString(),
      },
      {
        index: 2,
        stepId: "rust",
        name: "If role is Rust",
        kind: "condition",
        status: "done",
        detail: "Yes: Rust engineer",
        activityId: null,
        at: NOW.toISOString(),
      },
      {
        index: 3,
        stepId: "slack",
        name: "Slack",
        kind: "slack",
        status: "waiting",
        detail: "Waiting for your approval",
        activityId: "a-r9",
        at: NOW.toISOString(),
      },
    ],
    startedAt: new Date(NOW.getTime() - 2 * 60_000).toISOString(),
    finishedAt: null,
  };
  let decided: RunView | null = null;
  return {
    ...api,
    runs: async (w, options) => {
      const rest = await listRuns(w, options);
      const mine = decided ?? paused;
      return !options?.workflowId || options.workflowId === "w1" ? [mine, ...rest] : rest;
    },
    runActivity: async (runId) =>
      runId === "r9"
        ? [
            {
              id: "a-r9",
              workspaceId: "ws",
              sessionId: null,
              runId,
              tool: "post_to_slack",
              tier: "always-ask",
              inputSummary: "#hiring",
              status: "waiting",
              approvedBy: null,
              undoable: false,
              undoneAt: null,
              actor: "automation",
              callId: "step-3",
              input: {},
              preview: {
                kind: "text",
                text: "Slack #hiring:\nNew candidate: Priya Raman for Rust engineer",
              },
              decision: null,
              at: NOW.toISOString(),
            },
          ]
        : api.runActivity(runId),
    decide: async (runId, decision, standing = false) => {
      api.calls.push(`decide:${runId}:${decision}:${standing}`);
      decided = {
        ...paused,
        status: decision === "approved" ? "done" : "failed",
        waitingActivityId: null,
        waitingStep: null,
        steps: paused.steps.map((s) =>
          s.status === "waiting" ? { ...s, status: "done", detail: "Posted to #hiring" } : s,
        ),
      };
      return decided;
    },
  };
}

async function mount(
  api: WorkflowsApi,
  onAsk?: (text: string) => void,
  options: { level?: "off" | "assist" | "automate"; onNavigate?: (t: string) => void } = {},
) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <StaticShell
        settings={{ "workflows.page.refresh_seconds": 0, "ai.level": options.level ?? "automate" }}
      >
        <Workflows
          api={api}
          onAsk={onAsk}
          onNavigate={options.onNavigate}
          now={NOW}
          groupName={(id) =>
            ({ candidates: "Hiring › Candidates", finance: "Finance", investors: "Investors" })[
              id
            ] ?? id
          }
        />
      </StaticShell>,
    );
  });
  await act(async () => {
    await tick();
    await tick();
  });
  return host;
}

const click = async (el: Element | null | undefined) => {
  if (!(el instanceof HTMLElement)) throw new Error("nothing to click");
  await act(async () => {
    el.click();
    await tick();
    await tick();
  });
};

const texts = (el: ParentNode, selector: string) =>
  [...el.querySelectorAll(selector)].map((n) => n.textContent?.trim() ?? "");

const button = (el: ParentNode, text: string) =>
  [...el.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);

/** The flow's cards as "eyebrow | title | tier or outcome". */
const cards = (el: ParentNode) =>
  [...el.querySelectorAll(".wfx-detail .wflow-node")].map((n) =>
    [
      n.querySelector(".wflow-eyebrow")?.textContent,
      n.querySelector(".wflow-title b")?.textContent,
      n.querySelector(".wflow-run, .wflow-tier")?.textContent ?? "",
    ].join(" | "),
  );

describe("the Workflows page", () => {
  test("lists every Workflow with its trigger in plain words, its status and last run; switched-off ones last", async () => {
    const el = await mount(fixtureWorkflowsApi());
    expect(el.querySelector("h1")?.textContent).toBe("Workflows");
    expect(texts(el, ".wfx-row:not(.wfx-new) b")).toEqual([
      "Candidate intake",
      "Investor follow-up nudge",
      "Invoices to Drive",
      "Newsletter digest",
    ]);
    expect(texts(el, ".wfx-row .wfx-row-trig").slice(0, 4)).toEqual([
      "Mail arrives in Hiring › Candidates",
      "No reply from you for 2 days in Investors",
      "Mail arrives in Finance",
      "On a schedule: Fridays 16:00",
    ]);
    const rows = [...el.querySelectorAll<HTMLElement>(".wfx-row:not(.wfx-new)")];
    expect(rows.map((r) => r.dataset.status)).toEqual(["on", "on", "on", "off"]);
    expect(texts(el, ".wfx-row .wf-status")).toEqual(["On", "On", "On", "Paused"]);
    expect(rows[0]?.querySelector(".wfx-row-foot")?.textContent).toContain("Last run 9 min ago");
    expect(rows[0]?.querySelector(".wfx-row-foot")?.textContent).toContain("1 today");
    // Recent outcomes as dots, oldest first: the failed Run shows.
    expect(
      [...(rows[0]?.querySelectorAll(".wf-dot") ?? [])].map((d) => d.getAttribute("data-status")),
    ).toEqual(["failed", "done", "done"]);
    expect(rows[0]?.getAttribute("aria-current")).toBe("true");
  });

  test("the selected Workflow is drawn as a flow of cards: trigger, Steps with their approval, the condition's branches", async () => {
    const el = await mount(fixtureWorkflowsApi());
    expect(el.querySelector(".wfx-detail h2")?.textContent).toBe("Candidate intake");
    expect(cards(el)).toEqual([
      "When | Mail arrives in Hiring › Candidates | ",
      "Step 1 · Agent step | Extract | Changes nothing",
      "Step 2 · Add to Notion | Notion | Runs on your standing approval",
      "Step 3 · Check | If role is Rust | ",
      "Step 4 · Post to Slack | Slack | Asks first",
    ]);
    const nodes = [...el.querySelectorAll<HTMLElement>(".wfx-detail .wflow-node")];
    // The condition says what happens either way, and Slack hangs under its "if yes".
    expect(nodes[3]?.querySelector(".wflow-summary")?.textContent).toBe(
      'Goes on only if role from Extract contains "rust"',
    );
    expect(texts(nodes[3] as HTMLElement, ".wflow-branches span")).toEqual([
      "If yes",
      "If not, the run ends here",
    ]);
    expect(nodes.map((n) => n.dataset.depth)).toEqual(["0", "0", "0", "0", "1"]);
    // Template holes read as names, not {{steps.extract.name}}.
    expect(texts(nodes[4] as HTMLElement, ".wflow-hole")).toEqual([
      "name from Extract",
      "role from Extract",
    ]);
    expect(nodes[1]?.querySelector(".wflow-fields")?.textContent).toContain("read_thread");
    // The sentence it was written from sits above the flow.
    expect(el.querySelector(".wfx-sentence blockquote")?.textContent).toContain(
      "When a candidate emails about any open role",
    );
    // Picking another Workflow draws its flow.
    await click(el.querySelectorAll(".wfx-row")[3]);
    expect(cards(el)).toEqual([
      "When | On a schedule: Fridays 16:00 | ",
      "Step 1 · Agent step | Summarize | Asks first",
    ]);
    // Switched off, the flow reads faded.
    expect(el.querySelector(".wfx-detail .wflow")?.classList.contains("dim")).toBe(true);
  });

  test("the switch, rename and Source act on the selected Workflow through the API", async () => {
    const api = fixtureWorkflowsApi();
    const el = await mount(api);
    await click(el.querySelector(".wfx-switch .switch"));
    expect(api.calls).toEqual(["enable:w1:false"]);
    // Rename writes a new version with the new name.
    await click(el.querySelector('.wfx-title button[aria-label="Rename"]'));
    const input = el.querySelector<HTMLInputElement>(".wfx-rename input") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "Candidates to Notion");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await tick();
      await tick();
    });
    expect(api.calls).toEqual(["enable:w1:false", "update:w1"]);
    expect(texts(el, ".wfx-row b")).toContain("Candidates to Notion");
    // Source is the JSON document, read-only.
    await click(button(el, "Source"));
    const source = el.querySelector("pre.source")?.textContent ?? "";
    expect(JSON.parse(source)).toMatchObject({ trigger: { kind: "arrival" } });
  });

  test("a Run lays its Step results over the flow; the Run log lists the Workflow's Runs", async () => {
    const el = await mount(fixtureWorkflowsApi());
    const runs = el.querySelector(".wfx-runs") as HTMLElement;
    expect(texts(runs, ".runlog .r")).toEqual([
      expect.stringContaining("Aoife Brennan, Senior Rust engineerPosted to #hiring9 min ago"),
      expect.stringContaining("Ngozi Adeyemi, Design EngineerNo: Design Engineer"),
      expect.stringContaining("Unknown sender, no role detected"),
    ]);
    await click(runs.querySelectorAll(".runlog button.r")[1]);
    expect(el.querySelector(".wfx-showing")?.textContent).toContain(
      "Showing what happened on Ngozi Adeyemi, Design Engineer",
    );
    expect(cards(el).slice(1)).toEqual([
      "Step 1 · Agent step | Extract | Done",
      "Step 2 · Add to Notion | Notion | Done",
      "Step 3 · Check | If role is Rust | Done",
      "Step 4 · Post to Slack | Slack | Skipped",
    ]);
    const slack = [...el.querySelectorAll<HTMLElement>(".wfx-detail .wflow-node")][4];
    expect(slack?.dataset.run).toBe("skipped");
    expect(slack?.querySelector(".wflow-run-detail")?.textContent).toBe(
      "Skipped: If role is Rust said no",
    );
    // A failed Run: the Steps it never reached say so.
    await click(runs.querySelectorAll(".runlog button.r")[2]);
    expect(
      cards(el)
        .slice(1)
        .map((c) => c.split(" | ")[2]),
    ).toEqual(["Failed", "Not reached", "Not reached", "Not reached"]);
    await click(button(el, "Show the workflow"));
    expect(el.querySelector(".wfx-showing")).toBeNull();
    expect(cards(el)[4]).toBe("Step 4 · Post to Slack | Slack | Asks first");
  });

  test("the ask box hands a change to the composer with the Workflow named; no editor exists", async () => {
    const asked: string[] = [];
    const el = await mount(fixtureWorkflowsApi(), (t) => asked.push(t));
    // Standing approvals are listed and revocable.
    expect(el.querySelector(".wf-standing")?.textContent).toContain("Standing approval Notion");
    const input = el.querySelector<HTMLInputElement>(".wfx-ask input") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, "Also post to Discord");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await tick();
    });
    await act(async () => {
      input.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await tick();
    });
    expect(asked).toEqual(['Change the workflow "Candidate intake": Also post to Discord']);
    expect(el.querySelector("textarea")).toBeNull();
  });

  test("a paused Run shows the approval card with the Step's payload; approving resumes it through the API", async () => {
    const api = pausedApi();
    const el = await mount(api);
    const first = el.querySelector(".wfx-row") as HTMLElement;
    expect(first.dataset.status).toBe("waiting");
    expect(first.querySelector(".wf-status")?.textContent).toBe("1 waiting");
    const card = el.querySelector(".wfx-detail .run-approval") as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.dataset.tier).toBe("always-ask");
    expect(card.querySelector(".preview")?.textContent).toBe(
      "Slack #hiring:\nNew candidate: Priya Raman for Rust engineer",
    );
    expect(texts(card, ".acts button")).toEqual(["Approve", "Always allow this step", "Decline"]);
    await click(card.querySelectorAll(".acts button")[1]);
    expect(api.calls).toEqual(["decide:r9:approved:true"]);
    expect(el.querySelector(".run-approval")).toBeNull();
    expect(texts(el, ".wfx-runs .runlog .r")[0]).toContain(
      "Priya Raman, Rust engineerPosted to #hiring",
    );
  });

  test("Dry run asks the Server and shows what would happen, applying nothing", async () => {
    const api = fixtureWorkflowsApi();
    const el = await mount(api);
    await click(
      [...el.querySelectorAll(".wfx-acts button")].find((b) => b.textContent?.includes("Dry run")),
    );
    expect(api.calls).toEqual(["dry:w1:"]);
    const card = el.querySelector(".dry-run") as HTMLElement;
    expect(card.querySelector("h3")?.textContent).toContain("Dry run over 1 threads");
    expect(card.textContent).toContain("Nothing was applied");
    expect(texts(card, '[data-status="would_ask"]')).toEqual(["Slack: Slack would run"]);
    expect(texts(card, '[data-status="would_apply"]')).toHaveLength(3);
  });

  test("where it runs names the current Workspace's address; the Local line names the CLI Setting", async () => {
    const api = fixtureWorkflowsApi();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <StaticShell
          settings={{
            "workflows.page.refresh_seconds": 0,
            "ai.level": "automate",
            "ai.local.cli": "codex",
          }}
        >
          <WorkspaceProvider value={{ id: "ws-9", accountId: "a-9", address: "me@example.test" }}>
            <Workflows api={api} now={NOW} />
          </WorkspaceProvider>
        </StaticShell>,
      );
    });
    await act(async () => {
      await tick();
      await tick();
    });
    const el = host;
    expect(api.calls).toEqual([]);
    expect(el.querySelector(".wfx-where")?.textContent).toContain("Runs on me@example.test");
    expect(el.querySelector(".wfx-where")?.textContent).not.toContain("genai-labs");
    await click(el.querySelectorAll(".wfx-row")[1]);
    expect(el.querySelector(".wfx-meta .where")?.textContent).toContain("Runs here via Codex");
  });

  test("while the list loads it says so; a list that cannot load says why, in plain words", async () => {
    const api = fixtureWorkflowsApi();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow: WorkflowsApi = {
      ...api,
      list: async (ws) => {
        await gate;
        return api.list(ws);
      },
    };
    const el = await mount(slow);
    expect(el.querySelector(".wf-loading")?.textContent).toBe("Loading your workflows");
    await act(async () => {
      release();
      await tick();
      await tick();
    });
    expect(el.querySelector(".wf-loading")).toBeNull();
    expect(texts(el, ".wfx-row:not(.wfx-new) b")).toHaveLength(4);

    const broken: WorkflowsApi = {
      ...api,
      list: async () => {
        throw new Error("the Server is unreachable");
      },
    };
    await act(async () => root?.unmount());
    host?.remove();
    const el2 = await mount(broken);
    expect(el2.querySelector(".routing-error")?.textContent).toBe(
      "Could not load your workflows: the Server is unreachable",
    );
    expect(el2.querySelector(".wf-loading")).toBeNull();
  });

  test("with no Workflows the page offers examples to ask the agent for", async () => {
    const asked: string[] = [];
    const empty: WorkflowsApi = { ...fixtureWorkflowsApi(), list: async () => [] };
    const el = await mount(empty, (t) => asked.push(t));
    expect(el.querySelector(".wfx")).toBeNull();
    const examples = [...el.querySelectorAll<HTMLButtonElement>(".examples button")];
    expect(examples).toHaveLength(3);
    await click(examples[0]);
    expect(asked[0]).toStartWith("Write a new workflow: When a customer replies angry");
  });
});

describe("the Workflows page below automate", () => {
  test("says Workflows are paused and how to unlock them, and keeps every Workflow visible read-only", async () => {
    const api = fixtureWorkflowsApi();
    const went: string[] = [];
    const el = await mount(api, undefined, { level: "assist", onNavigate: (t) => went.push(t) });
    const lock = el.querySelector(".locked") as HTMLElement;
    expect(lock.querySelector("h2")?.textContent).toBe("Workflows are paused");
    expect(lock.querySelector(".locked-lede")?.textContent).toBe(
      "Increase the AI level to unlock Workflows.",
    );
    expect(lock.querySelector(".locked-body")?.textContent).toContain(
      "At Mail with an assistant nothing runs on its own. Your 4 workflows are kept",
    );
    expect(texts(lock, ".locked-side > ul > li")).toHaveLength(3);
    expect(texts(lock, ".wflow-example .wflow-title b")).toHaveLength(3);
    // Kept, read-only, marked locked: no switch, no Dry run, no ask box, no New workflow.
    expect(el.querySelector(".wf-kept")?.textContent).toBe("Kept while paused");
    expect(texts(el, ".wfx-row .wf-status")).toEqual(["Locked", "Locked", "Locked", "Locked"]);
    expect(el.querySelector(".wfx-switch")).toBeNull();
    expect(el.querySelector(".wfx-ask")).toBeNull();
    expect(el.querySelector(".wfx-new")).toBeNull();
    expect(button(el, "New workflow")).toBeUndefined();
    expect([...el.querySelectorAll("button")].some((b) => b.textContent?.includes("Dry run"))).toBe(
      false,
    );
    expect(cards(el)).toHaveLength(5);
    expect(el.querySelector(".wfx-detail .wflow")?.classList.contains("dim")).toBe(true);
    await click(button(lock, "See the AI levels"));
    expect(went).toEqual(["settings:ai"]);
    expect(api.calls).toEqual([]);
  });

  test("raising the level asks once, saying what starts, then unlocks the page", async () => {
    const el = await mount(fixtureWorkflowsApi(), undefined, { level: "off" });
    const lock = el.querySelector(".locked") as HTMLElement;
    expect(lock.querySelector(".locked-body")?.textContent).toContain("At Just mail");
    await click(button(lock, "Raise to Mail that sorts and acts for me"));
    expect(lock.querySelector(".locked-confirm p")?.textContent).toContain(
      "Anything that leaves your mailbox still asks first",
    );
    // Not now forgets the question.
    await click(button(lock, "Not now"));
    expect(lock.querySelector(".locked-confirm")).toBeNull();
    await click(button(lock, "Raise to Mail that sorts and acts for me"));
    await click(button(lock, "Turn on Mail that sorts and acts for me"));
    expect(el.querySelector(".locked")).toBeNull();
    expect(el.querySelector(".wfx-switch")).not.toBeNull();
    expect(texts(el, ".wfx-row .wf-status")[0]).toBe("On");
  });

  test("a level set in the Config file is the user's: the page says where to change it instead", async () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <StaticShell
          settings={{ "workflows.page.refresh_seconds": 0, "ai.level": "off" }}
          shell={{ pinned: new Set(["ai.level"]) }}
        >
          <Workflows api={fixtureWorkflowsApi()} now={NOW} />
        </StaticShell>,
      );
    });
    await act(async () => {
      await tick();
    });
    const lock = host.querySelector(".locked") as HTMLElement;
    expect(lock.querySelector(".locked-pinned")?.textContent).toBe(
      "The AI level is set in monday.toml, so change it there.",
    );
    expect(button(lock, "Raise to Mail that sorts and acts for me")).toBeUndefined();
  });
});
