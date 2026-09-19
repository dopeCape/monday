/// <reference types="bun-types" />
// The Workflows page through its seam: the list with its switches and
// Placement, the chain rendered from the document, the Run log with Step
// results, the approval card a paused Run waits on, the Dry run preview, the
// Source view and the "Change with monday" handoff. Mounted under a
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

async function mount(api: WorkflowsApi, onAsk?: (text: string) => void) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <StaticShell settings={{ "workflows.page.refresh_seconds": 0, "ai.level": "automate" }}>
        <Workflows
          api={api}
          onAsk={onAsk}
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

describe("the Workflows page", () => {
  test("lists the active Workflows with their chain, Placement and switch, and the paused one under its tab", async () => {
    const api = fixtureWorkflowsApi();
    const el = await mount(api);
    expect(el.querySelector("h1")?.textContent).toBe("Workflows");
    expect(texts(el, ".wf-card .wf-top b")).toEqual([
      "Candidate intake",
      "Invoices to Drive",
      "Investor follow-up nudge",
    ]);
    const first = el.querySelector(".wf-card") as HTMLElement;
    expect(first.dataset.selected).toBe("true");
    expect(texts(first, ".flow .node")).toEqual([
      "Email arrivesmatches Hiring › Candidates",
      "Extractname, role, links",
      "Notionadd row to Hiring",
      "If role is Rust",
      "Slack#hiring",
    ]);
    expect(first.querySelector(".where")?.textContent).toContain("Runs on your server");
    expect(first.querySelector(".wf-foot")?.textContent).toContain("Last run 9 min ago");
    expect(first.querySelector(".tag")?.textContent).toBe("1 today");
    expect(texts(el, ".wf-card .where")[2]).toContain("Runs here via Claude Code");
    // The switch is the only control on a card; off pauses the Workflow through the API.
    const switches = el.querySelectorAll<HTMLButtonElement>(".wf-card .switch");
    expect([...switches].map((s) => s.getAttribute("aria-checked"))).toEqual([
      "true",
      "true",
      "true",
    ]);
    await click(switches[1]);
    expect(api.calls).toEqual(["enable:w2:false"]);
    // Paused tab holds the Newsletter digest, and now Invoices to Drive.
    await click([...el.querySelectorAll('[role="tab"]')][1]);
    expect(texts(el, ".wf-card .wf-top b")).toEqual(["Invoices to Drive", "Newsletter digest"]);
    expect(texts(el, ".wf-card .flow .node")[3]).toBe("Fridays 16:00");
  });

  test("the side shows the Run log with Step results, the Source, and hands a change to the composer", async () => {
    const asked: string[] = [];
    const el = await mount(fixtureWorkflowsApi(), (t) => asked.push(t));
    const aside = el.querySelector("aside") as HTMLElement;
    expect(aside.querySelector(".side-card h3")?.textContent).toContain("Candidate intake");
    expect(texts(aside, ".runlog .r")).toEqual([
      expect.stringContaining("Aoife Brennan, Senior Rust engineerPosted to #hiring9 min ago"),
      expect.stringContaining("Ngozi Adeyemi, Design EngineerNo: Design Engineer"),
      expect.stringContaining("Unknown sender, no role detected"),
    ]);
    // Opening a Run shows its Steps in order with their outcomes.
    await click(aside.querySelectorAll(".runlog button.r")[1]);
    expect(texts(aside, ".run-steps .r")).toEqual([
      "Extractname: Ngozi Adeyemi, role: Design Engineer",
      "NotionRow added to Hiring",
      "If role is RustNo: Design Engineer",
      "SlackSkipped: If role is Rust said no",
    ]);
    // Source is the JSON document, read-only.
    await click([...aside.querySelectorAll("button")].find((b) => b.textContent === "Source"));
    const source = aside.querySelector("pre.source")?.textContent ?? "";
    expect(JSON.parse(source)).toMatchObject({
      name: "Candidate intake",
      trigger: { kind: "arrival" },
    });
    // Standing approvals are listed and revocable.
    expect(aside.querySelector(".wf-standing")?.textContent).toContain("Standing approval Notion");
    // The ask box hands the sentence to the composer with the Workflow named; no editor exists.
    const input = aside.querySelector<HTMLInputElement>(".ask input") as HTMLInputElement;
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
    expect(el.querySelector("textarea, input[type=text].editor")).toBeNull();
  });

  test("a paused Run shows the approval card with the Step's payload; approving resumes it through the API", async () => {
    const api = pausedApi();
    const el = await mount(api);
    const first = el.querySelector(".wf-card") as HTMLElement;
    expect(first.querySelector(".tag.warn")?.textContent).toBe("1 waiting");
    const aside = el.querySelector("aside") as HTMLElement;
    const card = aside.querySelector(".run-approval") as HTMLElement;
    expect(card).not.toBeNull();
    expect(card.dataset.tier).toBe("always-ask");
    expect(card.querySelector(".preview")?.textContent).toBe(
      "Slack #hiring:\nNew candidate: Priya Raman for Rust engineer",
    );
    expect(texts(card, ".acts button")).toEqual(["Approve", "Always allow this step", "Decline"]);
    await click(card.querySelectorAll(".acts button")[1]);
    expect(api.calls).toEqual(["decide:r9:approved:true"]);
    expect(aside.querySelector(".run-approval")).toBeNull();
    expect(texts(aside, ".runlog .r")[0]).toContain("Priya Raman, Rust engineerPosted to #hiring");
  });

  test("Dry run asks the Server and shows what would happen, applying nothing", async () => {
    const api = fixtureWorkflowsApi();
    const el = await mount(api);
    const aside = el.querySelector("aside") as HTMLElement;
    await click(
      [...aside.querySelectorAll("button")].find((b) => b.textContent?.includes("Dry run")),
    );
    expect(api.calls).toEqual(["dry:w1:"]);
    const card = aside.querySelector(".dry-run") as HTMLElement;
    expect(card.querySelector("h3")?.textContent).toContain("Dry run over 1 threads");
    expect(card.textContent).toContain("Nothing was applied");
    expect(texts(card, '[data-status="would_ask"]')).toEqual(["Slack: Slack would run"]);
    expect(texts(card, '[data-status="would_apply"]')).toHaveLength(3);
  });

  test("Where it runs names the current Workspace's address, never the fixture's; the Local line names the CLI Setting", async () => {
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
    const where = [...el.querySelectorAll(".side-card")].find((c) =>
      c.querySelector("h3")?.textContent?.includes("Where it runs"),
    );
    expect(where?.textContent).toContain("Runs on me@example.test");
    expect(where?.textContent).not.toContain("genai-labs");
    expect(texts(el, ".wf-card .where")[2]).toContain("Runs here via Codex");
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
    expect(el.querySelector(".wf")?.getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      release();
      await tick();
      await tick();
    });
    expect(el.querySelector(".wf-loading")).toBeNull();
    expect(texts(el, ".wf-card .wf-top b")).toHaveLength(3);

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
});
