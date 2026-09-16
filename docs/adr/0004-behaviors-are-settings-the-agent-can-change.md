---
status: accepted
---

# Product behaviors are Settings with defaults, never constants, so the Agent can change them

Routing thresholds, the Needs a decision cap, re-evaluation policy, the Section set and its rules, learning behavior, and every similar policy in monday are stored as Settings in the server database with shipped defaults. None of them is a constant in code. The Agent changes them through the same reversible settings tool as appearance, with Undo, and the Config file may pin any of them. Sections are user-defined rules seeded with four defaults rather than a fixed enum.

## Considered options

- Fixed behavior with tunable numbers only. Rejected: the user asked that all behavior be changeable by talking to the Agent, and a fixed Section set blocks "section by project instead of urgency".
- Behavior adjustable only from Settings screens. Rejected: contradicts the Agent-first brief.

## Consequences

- Every feature-behavior ticket must name its behaviors as Settings with defaults, not describe them as fixed.
- Settings need a schema with types and ranges so the Agent's edits validate, and the Settings screens render from that schema.
- A default is a value in the schema, so onboarding can seed different defaults per user without special code.
