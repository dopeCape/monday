---
status: accepted
---

# LangChain and LangGraph are the Hosted runtime layer and the agent loop

The Hosted runtime must reach Anthropic, Gemini, OpenAI, Kimi and OpenRouter through one interface, and the agentic Workflow step and the composer need an agent loop that can pause for approval and resume. We decided to adopt LangChain's JavaScript packages for the provider abstraction and LangGraph for the agent loop, rather than the Vercel AI SDK or hand-written clients. LangGraph's checkpointing and interrupts map directly onto Runs that pause at an always-ask Step and resume after a Standing approval or a user click, and its state can be persisted in the same Postgres the jobs table lives in. monday's tools stay in the MCP tool server from ADR 0002 and are exposed to LangGraph through its MCP adapter, so approvals still live inside the tools.

## Considered options

- Vercel AI SDK for providers and its built-in tool loop. Rejected by the user in favor of LangGraph's graph orchestration, checkpointing and human-in-the-loop interrupts.
- Official SDKs with one adapter each. Rejected: five clients to maintain.
- OpenRouter as the only provider. Rejected: a third party in every call and no direct provider features.

## Consequences

- LangGraph's Postgres checkpointer is the persistence for paused agentic Runs; the hybrid step runner from ADR 0003 stays ours and invokes LangGraph only for agent Steps.
- Every model call goes through one place, so metering, provider price tables and the task-to-model map are enforced once.
- The dependency is heavy and must run on Bun, Node, Vercel and Netlify; the client architecture ticket verifies bundle size for the Sidecar.
