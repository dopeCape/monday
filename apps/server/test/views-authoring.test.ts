// Views IV, authoring (docs/spec/views.md, "Making a View"; acceptance 16
// and 17): the drafting prompt carries the Block catalog, the Fields, the
// Extractions, the actions and the Workspace's Workflows; a draft that
// names an unknown Block or Workflow fails validation with the reason and
// the retry corrects it; "Wrong value" on a tried row becomes an Example of
// the right span, the revision reads it, and the question as asked carries it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Account, ViewDoc } from "@monday/shared";
import { AMAZON_ORDERS_VIEW, TOOL_ALIASES, viewExtractionId } from "@monday/shared";
import { randomKey } from "../src/crypto/aead.ts";
import { createKeys } from "../src/crypto/keys.ts";
import { settings as settingsTable, workflows } from "../src/db/schema.ts";
import { findTool } from "../src/intelligence/agent/tools/catalog.ts";
import { createIntelligence, type Intelligence } from "../src/intelligence/index.ts";
import { createFakeChat, createFakeJudge } from "../src/intelligence/runtime/fake/index.ts";
import type { ChatCall } from "../src/intelligence/runtime/index.ts";
import { createMailstore, type Mailstore } from "../src/mailstore/index.ts";
import { type TestDatabase, testDatabase } from "./harness.ts";

const NOW = new Date("2026-10-15T12:00:00Z");
const owner = { name: "Sam Okafor", email: "sam@monday.test" };
const amazon = { name: "Amazon.com", email: "auto-confirm@amazon.com" };
const VIEW = "v_amazon_orders_with_refunds";
const { id: _id, version: _v, examples: _e, ...WRITTEN } = AMAZON_ORDERS_VIEW;

const REFUND = {
  id: "refund",
  label: "Refund",
  icon: "arrow-u-up-left",
  on: "row",
  when: { lane: "delivered" },
  do: {
    kind: "run_workflow",
    workflow: "wf_refund",
    inputs: { order: "x:order_number", amount: "x:order_total" },
  },
};

describe("the Agent authors a View: the catalog, the retries, Wrong value", () => {
  let db: TestDatabase;
  let store: Mailstore;
  let workspaceId: string;
  const judge = createFakeJudge();
  const chat = createFakeChat();
  let intelligence: Intelligence;
  const calls: ChatCall[] = [];
  const script: Array<(call: ChatCall) => string | null> = [];

  beforeAll(async () => {
    db = await testDatabase();
    const keys = createKeys(db.handle.db);
    await keys.unlock(randomKey());
    store = createMailstore(db.handle.db, keys);
    const account: Account = {
      id: "acct-views-author",
      provider: "jmap",
      address: owner.email,
      displayName: owner.name,
      capabilities: {
        push: true,
        labels: false,
        snooze: false,
        mute: false,
        calendar: false,
        meetingLink: null,
      },
    };
    workspaceId = (await store.createWorkspace(account)).id;
    await db.handle.db
      .insert(settingsTable)
      .values({ scope: "global", deviceId: null, key: "calendar.time_zone", value: "UTC" });
    await db.handle.db.insert(workflows).values({ id: "wf_refund", workspaceId, name: "Refunds" });
    chat.answer((call) => {
      calls.push(call);
      for (const s of script) {
        const out = s(call);
        if (out !== null) return out;
      }
      return JSON.stringify(WRITTEN);
    });
    const threadId = await store.upsertThread({
      workspaceId,
      providerThreadId: "o1",
      subject: "Your Amazon.com order of two books",
      participants: [amazon, owner],
      lastActivity: "2026-10-02T09:00:00.000Z",
    });
    await store.upsertMessage({
      threadId,
      providerMessageId: "m-o1",
      from: amazon,
      to: [owner],
      cc: [],
      date: "2026-10-02T09:00:00.000Z",
      headers: {},
      bodyText:
        "Order #113-1111111-1111111\nItem subtotal: $38.00\nShipping: $3.97\nOrder total: $41.97",
      bodyHtml: null,
      snippet: "Order #113-1111111-1111111",
    });
    intelligence = createIntelligence({
      level: async () => "automate",
      db: db.handle.db,
      mailstore: store,
      chat: chat.chat,
      judge: judge.judge,
      keys: async (provider) =>
        provider === "typesafe" ? "ts-key" : provider === "anthropic" ? "sk-ant-fake" : null,
      now: () => NOW,
    });
  }, 120_000);

  afterAll(async () => {
    await db.drop();
  });

  let draftId = "";

  test("the prompt carries the catalog and the Workflows; an unknown Block and an unknown Workflow go back once with the reason", async () => {
    // First a Block the catalog does not have and a Workflow that does not exist; then the fix.
    let attempt = 0;
    script.push((call) => {
      if (!call.prompt.includes("The owner asks")) return null;
      attempt += 1;
      if (attempt === 1) {
        return JSON.stringify({
          ...WRITTEN,
          blocks: [...WRITTEN.blocks, { id: "spark", type: "sparkline" }],
        });
      }
      if (attempt === 2) {
        return JSON.stringify({
          ...WRITTEN,
          actions: [...WRITTEN.actions, { ...REFUND, do: { ...REFUND.do, workflow: "wf_gone" } }],
        });
      }
      return JSON.stringify({
        ...WRITTEN,
        blocks: WRITTEN.blocks.map((b) =>
          b.id === "orders" ? { ...b, actions: ["track", "refund"] } : b,
        ),
        actions: [...WRITTEN.actions, REFUND],
      });
    });
    const draft = await intelligence.views.drafting.propose(
      workspaceId,
      "amazon orders with refunds and total spend per month",
    );
    draftId = draft.id;
    expect(draft.doc.id).toBe(VIEW);
    expect(draft.doc.actions.map((a) => a.id)).toEqual(["track", "refund"]);
    const drafting = calls.filter((c) => c.prompt.includes("The owner asks"));
    expect(drafting).toHaveLength(3);
    const [first, second, third] = drafting;
    // The catalog, the Extraction kinds, the actions, and the limits filled in.
    for (const words of ["heatmap", "calendar", "find is one of", "run_workflow", "Bad:"]) {
      expect(first?.system).toContain(words);
    }
    expect(first?.system).not.toContain("{blocks}");
    expect(first?.prompt).toContain("Workflows (action run_workflow): wf_refund (Refunds)");
    expect(second?.prompt).toContain("did not validate");
    expect(second?.prompt).toContain("blocks.3");
    expect(third?.prompt).toContain("Workflow wf_gone");
    // The card shows the buttons on the rows they would carry: no delivered order here, so no Refund.
    expect(draft.test?.shown[0]?.actions).toEqual([]);
  });

  test("Wrong value becomes an Example of the right span; the revision reads it and the question carries it", async () => {
    const draft = await intelligence.views.drafting.drafts.get(draftId);
    const row = draft.test?.shown[0];
    if (!row) throw new Error("row");
    const total = row.values.find((v) => v.extraction === "order_total");
    // The neutral judge picked the first amount code found; the owner says the total is the last one.
    expect(total?.text).toBe("$38.00");
    expect(total?.candidates).toEqual(["$38.00", "$3.97", "$41.97"]);
    const corrected = await intelligence.views.drafting.correct(draftId, {
      threadId: row.threadId,
      extraction: "order_total",
      value: "$41.97",
    });
    expect(corrected.doc.examples["x:order_total"]?.[0]).toMatchObject({ value: "$41.97" });
    // A span code did not find is refused.
    await expect(
      intelligence.views.drafting.correct(draftId, {
        threadId: row.threadId,
        extraction: "order_total",
        value: "$99.99",
      }),
    ).rejects.toThrow();
    judge.when(
      (_s, questions) =>
        JSON.stringify(questions[viewExtractionId(VIEW, "order_total")] ?? "").includes(
          "right_value",
        ),
      { [viewExtractionId(VIEW, "order_total")]: "$41.97" },
    );
    const revised = await intelligence.views.drafting.revise(draftId);
    const revision = calls.find((c) => c.prompt.includes("corrected these threads"));
    expect(revision?.prompt).toContain('the Total is "$41.97"');
    expect(revision?.system).toContain("The rules and the catalog");
    expect(revised.test?.agreement).toEqual({ agree: 1, total: 1 });
    expect(revised.test?.changes.join(" ")).toContain("added 1 of your corrections to Total");
  });

  test("the Board tool names still reach the View tools", () => {
    expect(TOOL_ALIASES.create_board).toBe("create_view");
    expect(findTool("create_board")?.name).toBe("create_view");
    expect(findTool("update_board")?.name).toBe("update_view");
  });

  test("a revision that only adds a chart applies with Undo, no test", async () => {
    const pinned = await intelligence.views.drafting.pin(draftId);
    const chart = {
      id: "by_vendor",
      type: "chart",
      chart: "donut",
      title: "Orders by status",
      query: { group_by: { field: "lane" } },
    };
    script.unshift((call) =>
      call.prompt.includes("add a donut")
        ? JSON.stringify({ ...pinned.view.doc, blocks: [...pinned.view.doc.blocks, chart] })
        : null,
    );
    const proposal = await intelligence.views.drafting.proposeUpdate(pinned.view.id, {
      instruction: "add a donut of orders by status",
    });
    expect(proposal.kind).toBe("direct");
    if (proposal.kind !== "direct") throw new Error("direct");
    expect((proposal.next as ViewDoc).blocks.map((b) => b.id)).toContain("by_vendor");
  });
});
