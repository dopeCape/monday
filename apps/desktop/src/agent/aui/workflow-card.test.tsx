/// <reference types="bun-types" />
// The composer's Workflow card through PreviewView: a create draws the
// compact flow with each Step's tool and approval; an update says what
// changes and marks new, changed and removed Steps; an enable carries its
// Dry run. Rendered to static markup.

import { beforeAll, describe, expect, test } from "bun:test";
import type { WorkflowPreview, WorkflowSketch } from "@monday/shared";
import { defaultSettings, parseWorkflowInput, sketchOf } from "@monday/shared";
import { dom } from "@monday/ui/test-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { composerStrings } from "../composerStrings.ts";
import { PreviewView } from "./tools.tsx";

const strings = composerStrings(defaultSettings());

beforeAll(async () => {
  await dom();
});

function doc(raw: Record<string, unknown>): WorkflowSketch {
  const p = parseWorkflowInput(raw);
  if (!p.ok) throw new Error(p.error);
  return sketchOf(p.value);
}

const before = doc({
  name: "Invoices to Drive",
  trigger: { kind: "arrival", group: "g-fin" },
  steps: [
    { id: "drive", kind: "drive", name: "Save", folder: "Finance/2026" },
    { id: "tag", kind: "tag", name: "Label", add: ["invoice"] },
  ],
});
const after = doc({
  name: "Invoices to Drive",
  trigger: { kind: "arrival", group: "g-fin" },
  steps: [
    { id: "drive", kind: "drive", name: "Save", folder: "Finance/2027" },
    { id: "tell", kind: "slack", name: "Tell accounting", channel: "#acc", text: "Saved" },
  ],
});

const render = (preview: WorkflowPreview) => {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    <PreviewView preview={preview} strings={strings} now={new Date("2026-09-16T10:00:00Z")} />,
  );
  return host;
};

const texts = (el: ParentNode, selector: string) =>
  [...el.querySelectorAll(selector)].map((n) => n.textContent ?? "");

describe("the Workflow card", () => {
  test("a new Workflow draws as its compact flow, the Group named, each Step with its approval", () => {
    const el = render({
      kind: "workflow",
      action: "create",
      workflow: after,
      previous: null,
      version: 1,
      groupNames: { "g-fin": "Finance" },
    });
    expect(el.querySelector(".count")?.textContent).toBe(
      "New workflow Invoices to Drive. It starts switched off.",
    );
    expect(el.querySelector(".wflow.compact")).not.toBeNull();
    expect(texts(el, ".wflow-title b")).toEqual([
      "Mail arrives in Finance",
      "Save",
      "Tell accounting",
    ]);
    expect(texts(el, ".wflow-sum")).toEqual([
      "Saves the attachment to Finance/2027",
      "Posts to #acc on Slack",
    ]);
    expect(texts(el, ".wflow-tier")).toEqual(["Asks first", "Asks first"]);
    expect(el.querySelector(".wf-diff")).toBeNull();
  });

  test("an edit says what changes and marks the Steps, with the removed ones after", () => {
    const el = render({
      kind: "workflow",
      action: "update",
      workflow: after,
      previous: before,
      version: 4,
    });
    expect(el.querySelector(".count")?.textContent).toBe(
      "Changes Invoices to Drive to version 4. Earlier runs keep theirs.",
    );
    expect(el.querySelector(".wf-diff")?.textContent).toBe("1 new, 1 changed, 1 removed");
    expect(texts(el, ".wflow-change")).toEqual(["Changed", "New", "Removed"]);
    expect(el.querySelector('.wflow-removed [data-change="removed"] b')?.textContent).toBe("Label");
  });

  test("an enable carries its Dry run under the flow", () => {
    const el = render({
      kind: "workflow",
      action: "enable",
      workflow: after,
      previous: null,
      version: 2,
      note: "Dry run: nothing matched over recent mail.",
    });
    expect(el.querySelector(".count")?.textContent).toBe("Turns on Invoices to Drive");
    expect(el.querySelector(".wf-note")?.textContent).toBe(
      "Dry run: nothing matched over recent mail.",
    );
  });
});
