// Brief verification (ADR 0012, slice 27, the citation-check pattern): after
// the language model writes the bullets, one Judgment request asks, per
// bullet, how well the Thread's text supports it. An unsupported bullet is
// dropped before the Brief is stored, a partly supported one is marked so
// the reader dims it, and a verdict the judge is not confident about leaves
// the bullet as written. Without a judge the Brief is stored as written.

import type { BulletVerdict, ChoiceQuestion, RichText } from "@monday/shared";
import type { HostedRuntime } from "./runtime/index.ts";

export interface VerifySettings {
  enabled: boolean;
  question: string;
  criteria: { supported: string; partly: string; unsupported: string };
  /** Below this confidence a verdict is ignored. */
  confidence: number;
}

export interface Verified {
  bullets: RichText[];
  /** Per kept bullet, by index; absent when nothing was checked. */
  verified?: BulletVerdict[] | undefined;
}

/** The plain text of a bullet, for the claim the judge reads. */
export function plainText(bullet: RichText): string {
  return bullet.map((run) => (typeof run === "string" ? run : "b" in run ? run.b : run.i)).join("");
}

export interface BriefVerifier {
  /** Checks the bullets against the Thread text; never throws. */
  verify(workspaceId: string, bullets: RichText[], threadText: string): Promise<Verified>;
}

export interface VerifierOptions {
  runtime: HostedRuntime;
  settings: () => Promise<VerifySettings>;
  log?: (message: string) => void;
}

export function createBriefVerifier(options: VerifierOptions): BriefVerifier {
  const log = options.log ?? (() => {});
  return {
    async verify(workspaceId, bullets, threadText) {
      const settings = await options.settings();
      if (!settings.enabled || bullets.length === 0) return { bullets };
      if (!(await options.runtime.judgeAvailable())) return { bullets };
      const questions: Record<string, ChoiceQuestion> = {};
      const claims: Record<string, string> = {};
      bullets.forEach((b, i) => {
        const key = `b${i}`;
        claims[key] = plainText(b);
        questions[key] = {
          type: "choice",
          instructions: `${settings.question} The claim is the one under \`claims.${key}\`.`,
          criteria: {
            supported: settings.criteria.supported,
            partly: settings.criteria.partly,
            unsupported: settings.criteria.unsupported,
          },
        };
      });
      let answers: Record<string, { choice: string; confidence: number }>;
      try {
        const result = await options.runtime.judge(
          "judge.verify",
          { thread: threadText, claims },
          questions,
          { workspaceId },
        );
        answers = result.answers;
      } catch (error) {
        log(`verify: no verdict (${error instanceof Error ? error.message : String(error)})`);
        return { bullets };
      }
      const kept: RichText[] = [];
      const verified: BulletVerdict[] = [];
      bullets.forEach((b, i) => {
        const a = answers[`b${i}`];
        const verdict =
          a && a.confidence >= settings.confidence
            ? (a.choice as BulletVerdict | "unsupported")
            : "supported";
        if (verdict === "unsupported") {
          log(`verify: dropped an unsupported bullet: ${claims[`b${i}`]}`);
          return;
        }
        kept.push(b);
        verified.push(verdict);
      });
      // A Brief keeps at least its first bullet: dropping everything would leave a Brief with nothing to say.
      if (kept.length === 0) {
        const first = bullets[0];
        return first ? { bullets: [first], verified: ["partly"] } : { bullets };
      }
      return { bullets: kept, verified };
    },
  };
}
