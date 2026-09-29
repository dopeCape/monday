// The batching measurement's report (docs/spec/signals.md, "What the report
// says"): every table the spec lists, the bars per batch size with their
// numbers, and one verdict line. Markdown, committed under
// docs/research/judge-batching.md once the lead has run it live. Numbers and
// Thread ids only: no subject, no sender, no text.

import type { BatchingReport, Comparison } from "./batching.ts";

const armName = (size: number) => (size === 1 ? "Single" : `Batch ${size}`);
const usd = (n: number) => `$${n.toFixed(6)}`;

/** The one line the script prints and the report opens with. */
export function verdictLine(report: BatchingReport): string {
  const inconclusive = report.verdicts.every((v) => v.inconclusive);
  if (report.recommendation !== null) {
    return `VERDICT: batching passes every bar at ${report.recommendation} Threads per request. Keep routing.backfill.batch_size = ${report.recommendation} for the Backlog sort's Group Choice alone.`;
  }
  return inconclusive
    ? "VERDICT: inconclusive (fewer than 30 labelled threads), so batching is not kept. The Backlog sort asks one Thread per request (routing.backfill.batch_size = 1)."
    : "VERDICT: batching fails at least one bar at every size measured. The Backlog sort asks one Thread per request (routing.backfill.batch_size = 1).";
}

function comparisonRow(name: string, c: Comparison): string {
  return `| ${name} | ${c.threads} | ${c.agreement}% | ${c.differing.length} |`;
}

export function renderBatchingReport(report: BatchingReport): string {
  const lines: string[] = [];
  const push = (...l: string[]) => lines.push(...l);
  push(
    "# Judge batching: batched against one-Thread requests",
    "",
    `Measured ${report.generatedAt} on ${report.model || "an unknown model"} (docs/spec/signals.md, "Measure first").`,
    "",
    `**${verdictLine(report)}**`,
    "",
    "## Sample",
    "",
    "| Newest | Recent (3 months) | Older (in scope) | Labelled | Total |",
    "|---|---|---|---|---|",
    `| ${report.sample.newest} | ${report.sample.recent} | ${report.sample.older} | ${report.sample.labelled} | ${report.sample.total} |`,
    "",
    "Labelled Threads are counted once however they were drawn; the labelled column counts every Thread with the owner's own answer.",
    "",
    "## Placement agreement with Single (repeat 1)",
    "",
    "| Arm | Threads | Agreement | Differing |",
    "|---|---|---|---|",
    comparisonRow("Noise floor (Single repeat 1 against repeat 2)", report.noiseFloor),
    ...report.arms.slice(1).map((a) => comparisonRow(armName(a.size), a.vsSingle)),
    "",
    "Each arm's own repeat agreement: " +
      report.arms.map((a) => `${armName(a.size)} ${a.selfAgreement}%`).join(", ") +
      ".",
    "",
    "## Accuracy on the labelled Threads",
    "",
    "| Arm | Correct | Labelled | Accuracy |",
    "|---|---|---|---|",
    ...report.arms.map(
      (a) =>
        `| ${armName(a.size)} | ${a.accuracy.correct} | ${a.accuracy.count} | ${a.accuracy.share === null ? "n/a" : `${a.accuracy.share}%`} |`,
    ),
    "",
    "## Group confidence and Needs a decision",
    "",
    "| Arm | Mean Group confidence | Sent to Needs a decision |",
    "|---|---|---|",
    ...report.arms.map((a) => `| ${armName(a.size)} | ${a.meanConfidence} | ${a.askShare}% |`),
    "",
    "## Nouls at 0.7 and urgency",
    "",
    "| Arm | Noul decisions agree | Noul mean abs. difference | Urgency mean abs. difference |",
    "|---|---|---|---|",
    `| Noise floor | ${report.noiseFloor.noulAgreement}% | ${report.noiseFloor.noulMad} | ${report.noiseFloor.urgencyMad} |`,
    ...report.arms
      .slice(1)
      .map(
        (a) =>
          `| ${armName(a.size)} | ${a.vsSingle.noulAgreement}% | ${a.vsSingle.noulMad} | ${a.vsSingle.urgencyMad} |`,
      ),
    "",
    "## Tokens, cost and time",
    "",
    "| Arm | Requests per repeat | Tokens per Thread | Cost per Thread | Seconds per 100 Threads |",
    "|---|---|---|---|---|",
    ...report.arms.map(
      (a) =>
        `| ${armName(a.size)} | ${a.requests} | ${a.tokensPerThread} | ${usd(a.costPerThread)} | ${a.wallPer100} |`,
    ),
    "",
    "## The bar, per batch size",
    "",
  );
  for (const v of report.verdicts) {
    push(
      `### ${armName(v.size)}: ${v.keep ? "passes" : v.inconclusive ? "inconclusive, not kept" : "fails"}`,
      "",
      ...v.checks.map((c) => `- ${c.holds ? "[x]" : "[ ]"} ${c.id}. ${c.detail}`),
      "",
    );
  }
  push("## Threads that placed differently", "");
  push(
    `- Noise floor: ${report.noiseFloor.differing.length ? report.noiseFloor.differing.join(", ") : "none"}`,
  );
  for (const a of report.arms.slice(1)) {
    push(
      `- ${armName(a.size)}: ${a.vsSingle.differing.length ? a.vsSingle.differing.join(", ") : "none"}`,
    );
  }
  push(
    "",
    "## The switch",
    "",
    "`routing.backfill.batch_size` = 1 (the default) asks one Thread per request with the Group Choice and every Signal the Thread lacks. A larger value packs that many Threads' Group Choices into one request, the batched path this report measured; keep it only at a size that passes every bar above.",
    "",
  );
  return lines.join("\n");
}
