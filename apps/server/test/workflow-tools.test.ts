// The Workflow tools' cards through the tool server, over a fake Workflows
// seam: create, update and enable plan a structured Workflow preview (the
// composer draws the flow, and for an edit what changed) instead of a line
// of text, and applying still goes through the seam with its Undo record.

import { describe, expect, test } from "bun:test";
import type { WorkflowInput, WorkflowView } from "@monday/shared";
import { parseWorkflowInput } from "@monday/shared";
import { createMemoryActivityLog, createToolServer } from "../src/intelligence/agent/index.ts";
import type { WorkflowsSeam } from "../src/intelligence/agent/tools/extensions.ts";
import { createFakeToolHost } from "../src/intelligence/agent/tools/fake-host.ts";

const NOW = new Date("2026-09-17T10:00:00Z");

const DOC = {
  name: "Invoices to Drive",
  sentence: "Save invoices to Drive.",
  trigger: { kind: "arrival", group: "finance", predicate: { hasAttachment: true } },
  steps: [
    { id: "read", kind: "agentic", name: "Read", prompt: "Read the invoice.", outputs: ["vendor"] },
    { id: "drive", kind: "drive", name: "Drive", folder: "Finance/2026" },
  ],
};

function parsed(doc: unknown): WorkflowInput {
  const p = parseWorkflowInput(doc);
  if (!p.ok) throw new Error(p.error);
  return p.value;
}

function fakeWorkflows(): WorkflowsSeam & { calls: string[] } {
  const calls: string[] = [];
  const view: WorkflowView = {
    ...parsed(DOC),
    id: "w1",
    workspaceId: "ws",
    version: 3,
    enabled: false,
    placementInEffect: "server",
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    lastRunAt: null,
    runsToday: 0,
    recent: [],
    paused: 0,
  };
  const unused = async (): Promise<never> => {
    throw new Error("not used");
  };
  return {
    calls,
    list: async () => [view],
    get: async (id) => (id === "w1" ? view : null),
    create: async (_ws, input) => {
      calls.push(`create:${input.name}`);
      return { ...view, ...input, id: "w2", version: 1 };
    },
    update: async (id, input) => {
      calls.push(`update:${id}`);
      return { ...view, ...input, version: view.version + 1 };
    },
    revert: unused,
    remove: unused,
    enable: async (id, enabled) => {
      calls.push(`enable:${id}:${enabled}`);
      return { ...view, enabled };
    },
    dryRun: async () => ({ workflowId: "w1", version: 3, considered: 0, threads: [] }),
    runs: async () => [],
    run: async () => null,
    decide: unused,
    start: unused,
    askBeforeEnable: async () => true,
  };
}

function server(workflows: WorkflowsSeam) {
  return createToolServer({
    host: createFakeToolHost([], { now: () => NOW }),
    activity: createMemoryActivityLog({ now: () => NOW }),
    now: () => NOW,
    settings: async () => ({ previewAbove: 10, alwaysAsk: [], searchLimit: 100 }),
    extensions: { workflows },
  });
}

describe("the Workflow tools' cards", () => {
  test("create_workflow previews the document as a Workflow card, never a chain of text", async () => {
    const tools = server(fakeWorkflows());
    const out = await tools.preview({ name: "create_workflow", args: { document: DOC } });
    if (out.kind !== "action") throw new Error(out.kind);
    expect(out.preview).toMatchObject({
      kind: "workflow",
      action: "create",
      previous: null,
      version: 1,
      workflow: {
        name: "Invoices to Drive",
        trigger: { kind: "arrival", group: "finance" },
        steps: [{ id: "read" }, { id: "drive", folder: "Finance/2026" }],
        // Standing approvals are the user's to grant, never the Agent's.
        standingApprovals: [],
      },
    });
  });

  test("update_workflow carries the version it replaces, so the card can say what changed", async () => {
    const tools = server(fakeWorkflows());
    const next = {
      ...DOC,
      steps: [
        ...DOC.steps,
        { id: "tell", kind: "slack", name: "Tell", channel: "#finance", text: "Saved" },
      ],
    };
    const out = await tools.preview({
      name: "update_workflow",
      args: { workflow_id: "w1", document: next },
    });
    if (out.kind !== "action" || out.preview.kind !== "workflow") throw new Error("no card");
    expect(out.preview.action).toBe("update");
    expect(out.preview.version).toBe(4);
    expect(out.preview.previous?.steps.map((s) => s.id)).toEqual(["read", "drive"]);
    expect(out.preview.workflow.steps.map((s) => s.id)).toEqual(["read", "drive", "tell"]);
  });

  test("enable_workflow asks with the flow and the Dry run as its note", async () => {
    const tools = server(fakeWorkflows());
    const out = await tools.preview({
      name: "enable_workflow",
      args: { workflow_id: "w1", enabled: true },
    });
    if (out.kind !== "action" || out.preview.kind !== "workflow") throw new Error("no card");
    expect(out.preview.action).toBe("enable");
    expect(out.preview.workflow.name).toBe("Invoices to Drive");
    expect(out.preview.note).toContain("No recent Thread matches");
    // workflows.ask_before_enable is on: the card asks.
    expect(out.asks).toBe(true);
  });
});
