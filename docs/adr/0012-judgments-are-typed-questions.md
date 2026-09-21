---
status: accepted
---

# Judgments are typed questions to a System One model; language models generate

monday makes two kinds of model calls. Some produce text a person reads: a Brief's bullets, a reply in the user's voice, a composer answer, an agentic Step. Others produce a decision code acts on: which Group a Thread belongs to, which Section, whether a Brief is worth writing, what a typed sentence asks for, whether a Workflow condition holds. Until now both went through the same prompt-and-parse path on Haiku or Sonnet (ADR 0007). We decided that decisions are **Judgments**: typed questions (Choice, Noul, Score) sent with a state to a System One model, TypeSafe's Jev, which answers with calibrated probabilities and a confidence, never with text. Code composes the answers. The language models keep everything that needs a sentence or a plan.

The research note (`docs/research/typesafe-system-one.md`) measured this on the fixture mailbox: nine Threads, six Judgments each, one second, about $0.00004 per Thread; routing right on eight of nine with the ninth correctly uncertain; "Brief worth" reproduced the user's brief policy as a score. That price and speed are what make the rest possible: Judgments on every arrival, Sections and Groups the user describes in their own words, actions the user defines per Group, and a palette that understands a typed sentence without opening a Session.

## Considered options

- Keep the LLM prompts and lower the cost with Haiku. Rejected: still tens of milliseconds to seconds per call, output parsed from JSON the model wrote, no calibrated uncertainty, and each new Judgment is a new prompt to maintain.
- A local classifier per Workspace. Rejected for v1: no training data on day one; kept as a later step over Jev's probabilities (the research note's section 10).
- Run every Judgment through the Agent. Rejected: the Agent is the wrong tool for a thousand decisions a day; it stays the tool for conversation and multi-step work.

## Consequences

- A **Judge** seam beside `run` and `converse` on the Hosted runtime: `judge(task, state, questions)`, metered under `judge.*` tasks with TypeSafe as a key provider like any other (its key under the envelope, its own share switch). `ai.judge.provider` picks TypeSafe, the language model, or auto; every Judgment keeps a prompt path for the language model and a header rule as the floor, so nothing depends on TypeSafe being up.
- TypeSafe is a first-class choice on onboarding's runtime step: a TypeSafe key alone runs sorting, Sections, chips and the brief policy; a language model (a key or a local CLI) is needed for the composer and generation. The AI level cards say so.
- Judgments are Settings: every question's instructions and criteria live in the schema so the user, or the Agent, can reword them; thresholds are Settings tuned against a pinned model version (`ai.judge.model`).
- "Needs a decision" is the model's own confidence, not a threshold over a number an LLM invented.
- Jev reads literally, does no arithmetic, and is not adversarially robust: criteria state the exact condition, code owns dates and counts, and tool tiers and approvals (ADR 0002) stay the guard around anything that acts.
- Thread text leaves the mailbox for a Judgment as it does for a Brief; the same share switch and threat-model line apply.
