// The batching measurement (docs/spec/signals.md, "Measure first"; slice 28).
//
//   bun apps/server/scripts/judge-batching-eval.ts --server <url> --token <device token> \
//     --workspace <id> [--sample 300] [--seed 7] [--out batching-report.md]
//   bun apps/server/scripts/judge-batching-eval.ts --fake [--out batching-report.md]
//
// Live, it asks the Sidecar's POST /intelligence/eval/batching (loopback, the
// Setting ai.judge.eval_enabled on), polls until the run is done and writes
// the report. --fake runs the same arms in-process against a fake judge on a
// synthetic sample, so the script and the report format are tested in CI.
// It prints the verdict line and where the report went; the exit code is 0
// whatever the verdict, 1 when the run could not finish.

import { writeFile } from "node:fs/promises";
import { defaultSettings } from "@monday/shared";
import {
  type BatchingReport,
  FAKE_GROUPS,
  fakeAsk,
  fakeSample,
  measureBatching,
  renderBatchingReport,
  verdictLine,
} from "../src/intelligence/measure/index.ts";

export interface EvalArgs {
  server: string | null;
  token: string | null;
  workspace: string | null;
  sample: number;
  seed: number;
  out: string;
  fake: boolean;
  /** Seconds between polls of a live run. */
  poll: number;
}

export function parseArgs(argv: readonly string[]): EvalArgs {
  const args: EvalArgs = {
    server: null,
    token: null,
    workspace: null,
    sample: 300,
    seed: 7,
    out: "batching-report.md",
    fake: false,
    poll: 5,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === "--fake") args.fake = true;
    else if (flag === "--server") args.server = value().replace(/\/+$/, "");
    else if (flag === "--token") args.token = value();
    else if (flag === "--workspace") args.workspace = value();
    else if (flag === "--sample") args.sample = Number(value());
    else if (flag === "--seed") args.seed = Number(value());
    else if (flag === "--out") args.out = value();
    else if (flag === "--poll") args.poll = Number(value());
    else throw new Error(`unknown flag ${flag}`);
  }
  if (!args.fake && (!args.server || !args.token || !args.workspace)) {
    throw new Error("live runs need --server, --token and --workspace (or pass --fake)");
  }
  if (!Number.isFinite(args.sample) || args.sample < 3)
    throw new Error("--sample must be at least 3");
  return args;
}

/** The measurement against the fake judge, in-process. */
export async function runFake(
  args: EvalArgs,
  drift?: (size: number) => number,
): Promise<BatchingReport> {
  const s = defaultSettings();
  const per = Math.max(1, Math.floor(args.sample / 3));
  return measureBatching({
    items: fakeSample(args.seed, per, Math.max(30, Math.round(per * 0.6))),
    candidates: FAKE_GROUPS,
    owner: "owner@example.test",
    settings: {
      route: {
        instructions: s["routing.judge.instructions"],
        noneOption: s["routing.judge.none_option"],
        snippetChars: s["routing.classify.snippet_chars"],
        examplesInPrompt: s["routing.examples_in_prompt"],
      },
      nouls: {
        needs_reply: s["judgments.questions.needs_reply"],
        waiting_on_others: s["judgments.questions.waiting_on_others"],
        newsletter: s["judgments.questions.newsletter"],
        automated: s["judgments.questions.automated"],
      },
      urgency: s["judgments.questions.urgency"],
      urgencyLevels: s["judgments.questions.urgency_levels"],
    },
    thresholds: {
      route: s["routing.threshold.route"],
      ask: s["routing.threshold.ask"],
      tieMargin: s["routing.threshold.tie_margin"],
    },
    limits: {
      requestTokens: s["routing.backfill.request_tokens"],
      stateTokens: s["routing.backfill.state_tokens"],
    },
    concurrency: 4,
    ask: fakeAsk(drift ? { drift } : {}),
  });
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The measurement on a live Sidecar: start, poll, return the report. */
export async function runLive(
  args: EvalArgs,
  options: {
    fetch?: FetchLike;
    sleep?: (ms: number) => Promise<void>;
    log?: (line: string) => void;
  } = {},
): Promise<BatchingReport> {
  const fetchImpl = options.fetch ?? ((u, i) => fetch(u, i));
  const sleep = options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = options.log ?? ((line) => console.error(line));
  const headers = { authorization: `Bearer ${args.token}`, "content-type": "application/json" };
  const started = await fetchImpl(`${args.server}/intelligence/eval/batching`, {
    method: "POST",
    headers,
    body: JSON.stringify({ workspace: args.workspace, sample: args.sample, seed: args.seed }),
  });
  const first = (await started.json().catch(() => ({}))) as {
    id?: string;
    error?: string;
    message?: string;
  };
  if (started.status !== 202 || !first.id) {
    throw new Error(
      `the Sidecar refused the measurement (${started.status} ${first.error ?? ""}): ${first.message ?? ""}`.trim(),
    );
  }
  for (;;) {
    await sleep(Math.max(1, args.poll) * 1000);
    const res = await fetchImpl(`${args.server}/intelligence/eval/batching/${first.id}`, {
      headers,
    });
    const status = (await res.json()) as {
      status: string;
      done: number;
      total: number;
      report: BatchingReport | null;
      error: string | null;
    };
    if (status.status === "done" && status.report) return status.report;
    if (status.status === "failed") throw new Error(`the measurement failed: ${status.error}`);
    log(`measuring: ${status.done} of ${status.total || "?"} requests`);
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  let args: EvalArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  try {
    const report = args.fake ? await runFake(args) : await runLive(args);
    await writeFile(args.out, renderBatchingReport(report));
    console.log(verdictLine(report));
    console.log(`Report written to ${args.out}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
