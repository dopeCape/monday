// The Budget's error, apart from the graph so the Agent host can name it
// without loading LangGraph.

/** An agentic Step spent more than its Budget allows (CONTEXT.md "Budget": the Run fails). */
export class BudgetExceededError extends Error {
  constructor(readonly cap: "calls" | "tokens" | "minutes") {
    super(`budget exceeded: ${cap}`);
    this.name = "BudgetExceededError";
  }
}
