// The Voice profile builder (CONTEXT.md "Voice profile": a per-Workspace
// description of how the user writes, with excerpts, built from sent mail
// when the user opts in). The Agent's build_voice_profile tool and the
// onboarding conversation's "yes, learn my voice" land here: the newest
// Messages the user sent are read (their own text, quoted history cut off),
// the model describes the voice and picks verbatim excerpts, and the result
// is stored sealed through the Drafts module's Voice profile. Every number
// and the prompt are Settings (ADR 0004); the model call meters as the
// summarize Task.

import type { VoiceProfile } from "@monday/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { accounts, messages, workspaces } from "../db/schema.ts";
import type { Drafts } from "../drafts/index.ts";
import { quoteStart } from "../mail/text.ts";
import type { Mailstore } from "../mailstore/index.ts";
import type { HostedRuntime } from "./runtime/index.ts";

export interface VoiceSettings {
  /** How many sent Messages the build reads, newest first. */
  sampleMessages: number;
  /** How much of each Message's own text the model sees. */
  excerptChars: number;
  /** The most excerpts kept on the profile. */
  excerptsMax: number;
  /** The system prompt for the build. */
  prompt: string;
}

export interface VoiceBuilderOptions {
  db: Db;
  mailstore: Mailstore;
  drafts: Drafts;
  runtime: HostedRuntime;
  settings: () => Promise<VoiceSettings>;
  now?: () => Date;
}

/** What the tools act through. */
export interface VoiceSeam {
  get(workspaceId: string): Promise<VoiceProfile>;
  /** Reads the user's sent mail and rewrites the profile; throws when nothing was sent yet. */
  build(workspaceId: string, options?: { jobId?: string | null }): Promise<VoiceProfile>;
  put(
    workspaceId: string,
    patch: { description?: string; excerpts?: string[]; enabled?: boolean },
  ): Promise<VoiceProfile>;
}

/** No sent mail to learn from. */
export class NoSentMailError extends Error {
  constructor(readonly workspaceId: string) {
    super("nothing has been sent from this account yet, so there is no voice to learn");
    this.name = "NoSentMailError";
  }
}

/** The model's answer was not the JSON asked for. */
export class VoiceOutputError extends Error {
  constructor(readonly output: string) {
    super("the model did not answer with a description and excerpts");
    this.name = "VoiceOutputError";
  }
}

/** A sent Message's own words: the text above the quoted history, trimmed. */
export function ownText(text: string): string {
  const lines = text.split(/\r?\n/);
  const start = quoteStart(lines);
  const own = (start >= 0 ? lines.slice(0, start) : lines)
    .filter((line) => !/^\s*>/.test(line))
    .join("\n");
  return own.replace(/\n{3,}/g, "\n\n").trim();
}

export interface VoiceOutput {
  description: string;
  excerpts: string[];
}

/** The last JSON object in the model's answer, checked for the two fields. */
export function parseVoiceOutput(output: string, excerptsMax: number): VoiceOutput {
  const start = output.lastIndexOf("{");
  const end = output.lastIndexOf("}");
  if (start < 0 || end <= start) throw new VoiceOutputError(output);
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.slice(start, end + 1));
  } catch {
    throw new VoiceOutputError(output);
  }
  if (!parsed || typeof parsed !== "object") throw new VoiceOutputError(output);
  const o = parsed as { description?: unknown; excerpts?: unknown };
  if (typeof o.description !== "string" || !o.description.trim()) {
    throw new VoiceOutputError(output);
  }
  const excerpts = Array.isArray(o.excerpts)
    ? o.excerpts.filter((e): e is string => typeof e === "string" && e.trim() !== "")
    : [];
  return {
    description: o.description.trim(),
    excerpts: excerpts.map((e) => e.trim()).slice(0, Math.max(0, excerptsMax)),
  };
}

export function createVoiceBuilder(options: VoiceBuilderOptions): VoiceSeam {
  const { db, mailstore, drafts, runtime } = options;

  /** The newest Messages the user sent, as their own text. */
  const samples = async (workspaceId: string, settings: VoiceSettings): Promise<string[]> => {
    const [owner] = await db
      .select({ address: accounts.address })
      .from(workspaces)
      .innerJoin(accounts, eq(accounts.id, workspaces.accountId))
      .where(eq(workspaces.id, workspaceId));
    if (!owner) return [];
    const rows = await db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.workspaceId, workspaceId),
          sql`lower(${messages.from} ->> 'email') = ${owner.address.toLowerCase()}`,
        ),
      )
      .orderBy(desc(messages.date), desc(messages.id))
      .limit(Math.max(1, settings.sampleMessages));
    const out: string[] = [];
    for (const row of rows) {
      const body = await mailstore.readMessageBody(row.id);
      const own = ownText(body.text);
      if (own.length < 20) continue;
      out.push(own.slice(0, Math.max(80, settings.excerptChars)));
    }
    return out;
  };

  return {
    get: (workspaceId) => drafts.getVoice(workspaceId),

    async build(workspaceId, opts = {}) {
      const settings = await options.settings();
      const texts = await samples(workspaceId, settings);
      if (texts.length === 0) throw new NoSentMailError(workspaceId);
      const prompt = [
        `${texts.length} messages the user sent, newest first, each between <message> tags:`,
        ...texts.map((t) => `<message>\n${t}\n</message>`),
        `Answer with one JSON object on the last line: {"description": "...", "excerpts": ["...", ...]} with at most ${settings.excerptsMax} excerpts, each a verbatim sentence or two from the messages above.`,
      ].join("\n\n");
      const result = await runtime.run(
        "summarize",
        { system: settings.prompt, prompt },
        { workspaceId, jobId: opts.jobId ?? null },
      );
      const parsed = parseVoiceOutput(result.output, settings.excerptsMax);
      return drafts.putVoice(workspaceId, {
        description: parsed.description,
        excerpts: parsed.excerpts,
        builtAt: (options.now ?? (() => new Date()))().toISOString(),
      });
    },

    put: (workspaceId, patch) => drafts.putVoice(workspaceId, patch),
  };
}
