// The writing assist behind the composer's menu (docs/spec/inbox.md): a
// rewrite (shorter, clearer, friendlier, more formal), a grammar pass, a
// translation, a continuation or a free instruction over the selection or
// the body. One model call through the Hosted runtime, metered as the
// draft-in-voice Task like any other; the Voice profile shapes it when the
// user has one switched on and the Setting allows. The answer is only text:
// the composer shows it as a suggestion and writes nothing until the user
// accepts. Every word of the prompt is a Setting (ADR 0004) except the
// per-action line, which names what the menu item says.

import type {
  AiLevel,
  DraftAssistAction,
  DraftAssistRequest,
  DraftAssistResult,
} from "@monday/shared";
import type { Drafts } from "../drafts/index.ts";
import { AiOffError, type HostedRuntime, NoProviderKeyError } from "./runtime/index.ts";

export interface ComposeAssistSettings {
  prompt: string;
  maxChars: number;
  /** Write in the Voice profile when it is on (compose.assist_voice). */
  useVoice: boolean;
  /** The composer assist is on (compose.assist). */
  enabled: boolean;
}

export interface ComposeAssistOptions {
  runtime: HostedRuntime;
  drafts: Pick<Drafts, "getVoice">;
  settings: () => Promise<ComposeAssistSettings>;
  level: () => Promise<AiLevel>;
  /** Whether a key exists for a provider, without loading it into a call. */
  hasKey: (provider: string) => Promise<boolean>;
}

export type AssistAvailability =
  | { available: true }
  | { available: false; reason: "ai_off" | "disabled" | "no_shared_key"; provider?: string };

export interface ComposeAssist {
  /** Whether a run would reach a model now; the composer shows its menu only then. */
  available(workspaceId: string): Promise<AssistAvailability>;
  /** Throws AiOffError, NoProviderKeyError, or AssistDisabledError. */
  run(request: DraftAssistRequest): Promise<DraftAssistResult>;
}

export class AssistDisabledError extends Error {
  readonly status = 409;
  readonly code = "assist_off";
  constructor() {
    super("the writing assist is off in Settings");
    this.name = "AssistDisabledError";
  }
}

/** What each menu item asks for, in one line. */
export function actionLine(request: DraftAssistRequest): string {
  const action: DraftAssistAction = request.action;
  switch (action) {
    case "shorter":
      return "Make it shorter. Keep every fact, date, name and request; cut the rest.";
    case "clearer":
      return "Make it clearer and easier to read. Keep the meaning and the length about the same.";
    case "friendlier":
      return "Make it warmer and friendlier, without filler or exclamation marks it did not have.";
    case "formal":
      return "Make it more formal and polished.";
    case "grammar":
      return "Fix spelling, grammar and punctuation only. Change nothing else.";
    case "translate":
      return `Translate it into ${request.language?.trim() || "English"}.`;
    case "continue":
      return "Continue writing from where the text ends, in the same voice. Answer with only the new text that follows it.";
    case "instruction":
      return request.instruction?.trim() || "Improve it.";
  }
}

/** The model's answer as plain text: no fences, no quotes around the whole of it. */
export function cleanAnswer(output: string): string {
  let text = output.trim();
  const fence = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(text);
  if (fence?.[1] !== undefined) text = fence[1].trim();
  if (text.length > 1 && /^["“]/.test(text) && /["”]$/.test(text)) text = text.slice(1, -1).trim();
  return text;
}

export function createComposeAssist(options: ComposeAssistOptions): ComposeAssist {
  const { runtime, drafts } = options;

  const voiceFor = async (workspaceId: string, useVoice: boolean) => {
    if (!useVoice) return null;
    try {
      const voice = await drafts.getVoice(workspaceId);
      if (!voice.enabled || voice.description.trim() === "") return null;
      return voice;
    } catch {
      // A locked Server has no Voice profile to read; the assist still answers.
      return null;
    }
  };

  return {
    async available() {
      if ((await options.level()) === "off") return { available: false, reason: "ai_off" };
      const s = await options.settings();
      if (!s.enabled) return { available: false, reason: "disabled" };
      const choice = await runtime.resolve("draft-in-voice");
      if (!(await options.hasKey(choice.provider))) {
        return { available: false, reason: "no_shared_key", provider: choice.provider };
      }
      return { available: true };
    },

    async run(request) {
      const s = await options.settings();
      if (!s.enabled) throw new AssistDisabledError();
      const voice = await voiceFor(request.workspace, s.useVoice);
      const text = request.text.slice(0, s.maxChars);
      const system = [
        s.prompt,
        voice
          ? `Write the way this person writes:\n${voice.description}${
              voice.excerpts.length
                ? `\nExamples of their writing:\n${voice.excerpts.map((e) => `- ${e}`).join("\n")}`
                : ""
            }`
          : "",
      ]
        .filter((part) => part.trim() !== "")
        .join("\n\n");
      const about = [
        request.subject?.trim() ? `Subject: ${request.subject.trim()}` : "",
        request.to?.length ? `To: ${request.to.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      const prompt = [
        actionLine(request),
        request.selection
          ? "The text is a selection inside a longer email; answer with its replacement only."
          : "",
        about,
        `Text:\n<<<\n${text}\n>>>`,
      ]
        .filter((part) => part !== "")
        .join("\n\n");
      const result = await runtime.run(
        "draft-in-voice",
        { system, prompt },
        { workspaceId: request.workspace, jobId: null },
      );
      return { text: cleanAnswer(result.output), voice: voice !== null };
    },
  };
}

export { AiOffError, NoProviderKeyError };
