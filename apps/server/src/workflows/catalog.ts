// The catalog of Workflows onboarding proposes (docs/spec/onboarding.md, "What
// it seeds"): ready-made documents in the same JSON shape the Agent writes
// (ADR 0003), each tagged with the tools it needs, so a proposal is matched to
// the tools the user named. The names follow the design mock's Workflows page
// where it has them. Nothing here is enabled by itself: a proposal shows its
// Dry run and is created and enabled only on approval.

import type { WorkflowInput, WorkflowInputRaw } from "@monday/shared";
import { INTEGRATIONS, parseWorkflowInput } from "@monday/shared";

export type CatalogTool = (typeof INTEGRATIONS)[number];

export interface CatalogEntry {
  /** Stable id the adopt tool names. */
  id: string;
  /** The integrations the document posts through; empty means built-in steps only. */
  tools: readonly CatalogTool[];
  document: WorkflowInput;
}

function entry(id: string, tools: readonly CatalogTool[], raw: WorkflowInputRaw): CatalogEntry {
  const parsed = parseWorkflowInput(raw);
  if (!parsed.ok) throw new Error(`catalog ${id} does not validate: ${parsed.error}`);
  return { id, tools, document: parsed.value };
}

export const WORKFLOW_CATALOG: readonly CatalogEntry[] = [
  entry("invoices-to-drive", ["drive"], {
    name: "Invoices to Drive",
    sentence:
      "Save every invoice or receipt PDF into Drive under Finance, tag the thread as invoice.",
    kind: "hybrid",
    trigger: {
      kind: "arrival",
      predicate: { subjectPatterns: ["invoice", "receipt"], hasAttachment: true },
    },
    steps: [
      { id: "drive", kind: "drive", name: "Drive", folder: "Finance" },
      { id: "tag", kind: "tag", name: "Tag", add: ["invoice"] },
    ],
    placement: null,
    failurePolicy: "stop",
  }),
  entry("candidates-to-notion", ["notion"], {
    name: "Candidate intake",
    sentence:
      "When a candidate emails about a role, add a row to the Hiring database in Notion and tag the thread as candidate.",
    kind: "hybrid",
    trigger: {
      kind: "arrival",
      predicate: { subjectPatterns: ["application", "candidate", "applying", "role"] },
    },
    steps: [
      {
        id: "notion",
        kind: "notion",
        name: "Notion",
        database: "Hiring",
        properties: { Name: "{{thread.from}}", Thread: "{{thread.subject}}" },
      },
      { id: "tag", kind: "tag", name: "Tag", add: ["candidate"] },
    ],
    placement: null,
    failurePolicy: "stop",
  }),
  entry("newsletter-digest", [], {
    name: "Newsletter digest",
    sentence:
      "Every Friday at 16:00 summarize the week's newsletters into one draft to myself and archive the originals.",
    kind: "hybrid",
    trigger: { kind: "schedule", cron: "0 16 * * 5" },
    steps: [
      {
        id: "digest",
        kind: "agentic",
        name: "Summarize",
        prompt:
          "Find the newsletters from the last seven days, write one short digest as a draft addressed to me, then archive the originals.",
        tools: ["search_threads", "read_thread", "draft_message", "archive_threads"],
        budget: { calls: 12 },
      },
    ],
    placement: null,
    failurePolicy: "notify",
  }),
  entry("receipts-tag", [], {
    name: "Receipts tag",
    sentence: "Tag every receipt or payment notice as receipt so it is easy to find at tax time.",
    kind: "hybrid",
    trigger: { kind: "arrival", predicate: { subjectPatterns: ["receipt", "payment received"] } },
    steps: [{ id: "tag", kind: "tag", name: "Tag", add: ["receipt"] }],
    placement: null,
    failurePolicy: "skip",
  }),
  entry("hiring-to-slack", ["slack"], {
    name: "Hiring pings",
    sentence: "When a candidate emails about a role, post a line to #hiring on Slack.",
    kind: "hybrid",
    trigger: {
      kind: "arrival",
      predicate: { subjectPatterns: ["application", "candidate", "applying"] },
    },
    steps: [
      {
        id: "slack",
        kind: "slack",
        name: "Slack",
        channel: "#hiring",
        text: "New candidate: {{thread.from}}, {{thread.subject}}",
      },
    ],
    placement: null,
    failurePolicy: "stop",
  }),
  entry("shipping-to-discord", ["discord"], {
    name: "Shipping updates",
    sentence: "Post every order and shipping notice to #orders on Discord.",
    kind: "hybrid",
    trigger: { kind: "arrival", predicate: { subjectPatterns: ["shipped", "order", "delivery"] } },
    steps: [
      {
        id: "discord",
        kind: "discord",
        name: "Discord",
        channel: "#orders",
        text: "{{thread.subject}} from {{thread.from}}",
      },
    ],
    placement: null,
    failurePolicy: "skip",
  }),
];

/**
 * The catalog entries for the tools the user named, best match first: entries
 * whose every tool was named, then the built-in ones. An unknown tool name is
 * ignored. With no tools, only the built-in entries match.
 */
export function matchCatalog(tools: readonly string[], max: number): CatalogEntry[] {
  const named = new Set(
    tools.map((t) => t.trim().toLowerCase()).filter((t): t is CatalogTool => isTool(t)),
  );
  const withTools = WORKFLOW_CATALOG.filter(
    (e) => e.tools.length > 0 && e.tools.every((t) => named.has(t)),
  );
  const builtIn = WORKFLOW_CATALOG.filter((e) => e.tools.length === 0);
  return [...withTools, ...builtIn].slice(0, Math.max(0, max));
}

export function catalogEntry(id: string): CatalogEntry | undefined {
  return WORKFLOW_CATALOG.find((e) => e.id === id);
}

function isTool(name: string): name is CatalogTool {
  return (INTEGRATIONS as readonly string[]).includes(name);
}
