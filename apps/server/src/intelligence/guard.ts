// The guardrail on Thread text entering a turn (ADR 0012, slice 27, the
// RAG-passage screening pattern): before read_thread hands a body to the
// Agent (a composer turn, an agentic Step, an external caller through the
// same tool server), one Noul per Message asks whether the text carries an
// instruction aimed at an assistant. A hit puts a notice line above the
// Message and a flag on the result, and the system prompt tells the Agent
// what the line means. Bodies stay untrusted either way: this is one layer
// under the tool tiers and approvals (ADR 0002), never a replacement. The
// judge is not adversarially robust by itself, and its docs say so.

import type { NoulQuestion } from "@monday/shared";
import type { HostedRuntime } from "./runtime/index.ts";

export interface GuardSettings {
  enabled: boolean;
  threshold: number;
  question: string;
  inputCharsMax: number;
  notice: string;
}

export interface GuardVerdict {
  messageId: string;
  probability: number;
  hit: boolean;
}

/** What the tool server screens with (ToolExtensions.guard). */
export interface GuardSeam {
  /**
   * Screens Messages about to enter a turn. Null when screening is off or
   * no judge answers (the text goes through unmarked, as before); otherwise
   * one verdict per Message with text.
   */
  screen(
    workspaceId: string,
    messages: ReadonlyArray<{ id: string; text: string | null }>,
  ): Promise<GuardVerdict[] | null>;
  /** The notice line placed above a marked Message. */
  notice(): Promise<string>;
}

export interface GuardOptions {
  runtime: HostedRuntime;
  settings: () => Promise<GuardSettings>;
  log?: (message: string) => void;
}

export function createBodyGuard(options: GuardOptions): GuardSeam {
  const log = options.log ?? (() => {});
  return {
    async notice() {
      return (await options.settings()).notice;
    },

    async screen(workspaceId, messages) {
      const settings = await options.settings();
      if (!settings.enabled) return null;
      const withText = messages.filter((m) => m.text !== null && m.text.trim() !== "");
      if (withText.length === 0) return [];
      if (!(await options.runtime.judgeAvailable())) return null;
      // One request, one Noul per Message: the answers are independent, so
      // a long Thread costs one round trip and each Message gets its own mark.
      const questions: Record<string, NoulQuestion> = {};
      const state: Record<string, { id: string; text: string }> = {};
      withText.forEach((m, i) => {
        const key = `m${i}`;
        state[key] = { id: m.id, text: (m.text ?? "").slice(0, settings.inputCharsMax) };
        questions[key] = {
          type: "noul",
          instructions: `${settings.question} The message is the one under \`${key}\`.`,
        };
      });
      try {
        const result = await options.runtime.judge("judge.guard", state, questions, {
          workspaceId,
        });
        return withText.map((m, i) => {
          const probability = result.answers[`m${i}`]?.noul ?? 0;
          const hit = probability >= settings.threshold;
          if (hit) log(`guard: message ${m.id} reads as instructions (${probability.toFixed(2)})`);
          return { messageId: m.id, probability, hit };
        });
      } catch (error) {
        // The judge failing never blocks a turn: the text goes through unmarked, and the log says so.
        log(`guard: no verdict (${error instanceof Error ? error.message : String(error)})`);
        return null;
      }
    },
  };
}
