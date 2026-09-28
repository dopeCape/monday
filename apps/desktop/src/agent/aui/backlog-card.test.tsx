/// <reference types="bun-types" />
// The agent's Group card and the Backlog sort it starts: the proposal says
// the rest of the scope is sorted in the background, and once approved the
// card follows the Job through the screen's BacklogContext, from under way
// to finished, in the Settings' words.

import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { RoutingBacklog } from "@monday/shared";
import { defaultSettings } from "@monday/shared";
import { dom } from "@monday/ui/test-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { BacklogContext, backlogLine } from "../../screens/routing/backlog.tsx";
import { composerStrings } from "../composerStrings.ts";
import { BacklogToolLine, PreviewView } from "./tools.tsx";

let createRoot: Awaited<ReturnType<typeof dom>>["createRoot"];
beforeAll(async () => {
  ({ createRoot } = await dom());
});
let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
});

const settings = defaultSettings();
const running: RoutingBacklog = {
  workspaceId: "ws",
  scope: "last 3 months",
  status: "running",
  reason: null,
  sorter: "typesafe",
  local: false,
  done: 1200,
  total: 5400,
  moved: 310,
  asked: 12,
  skipped: 2,
  batches: 11,
  batchSize: 100,
  calls: 11,
  startedAt: "2026-09-16T12:00:00.000Z",
  updatedAt: "2026-09-16T12:01:00.000Z",
  finishedAt: null,
  lastError: null,
};

describe("the Groups card and the Backlog sort", () => {
  test("the proposal says the rest of the scope is sorted in the background", () => {
    const html = renderToStaticMarkup(
      <PreviewView
        preview={{
          kind: "groups",
          groups: [{ name: "Finance", sentence: "Invoices and receipts", moves: 25 }],
          considered: 100,
          backlog: { scope: "the last 3 months", threads: 5400 },
        }}
        strings={composerStrings(settings)}
        now={new Date("2026-09-16T12:00:00Z")}
      />,
    );
    expect(html).toContain("25 would move");
    expect(html).toContain(
      "On approval these move at once; then monday sorts the rest of the last 3 months (5,400 threads) in the background.",
    );
  });

  test("the line says how far it got, why it waits, and how it ended", () => {
    expect(backlogLine(running, settings)).toBe(
      "Sorting the last 3 months in the background: 1,200 of 5,400, 310 moved",
    );
    expect(backlogLine({ ...running, status: "waiting", reason: "no_judge" }, settings)).toContain(
      "Sorting needs TypeSafe, an AI provider key, or a coding agent.",
    );
    expect(backlogLine({ ...running, status: "done", done: 5400 }, settings)).toBe(
      "Sorted the last 3 months in the background: 310 moved, 12 to decide",
    );
  });

  test("an approved card follows the Job while it runs", async () => {
    let now = running;
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(
        <BacklogContext.Provider
          value={{
            workspaceId: "ws",
            source: { backlog: async () => now },
            pollSeconds: 1,
            settings,
          }}
        >
          <BacklogToolLine />
        </BacklogContext.Provider>,
      );
    });
    await act(async () => Bun.sleep(10));
    expect(host.querySelector(".agent-backlog")?.textContent).toBe(
      "Sorting the last 3 months in the background: 1,200 of 5,400, 310 moved",
    );
    now = { ...running, status: "done", done: 5400, moved: 1400 };
    await act(async () => Bun.sleep(1100));
    expect(host.querySelector(".agent-backlog")?.getAttribute("data-status")).toBe("done");
    expect(host.querySelector(".agent-backlog")?.textContent).toContain("1,400 moved");
    host.remove();
  });
});
