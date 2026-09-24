// A module loaded on first use. The heavy packages (LangChain, LangGraph and
// its Postgres checkpointer, the MCP SDK, imapflow, nodemailer, the reader's
// sanitiser) cost tens of megabytes once evaluated, so they load through a
// dynamic import() the first time something needs them instead of at boot.
// The first call starts the import, every later call gets the same promise,
// and a failed import is tried again by the next call.

export function lazy<T>(load: () => Promise<T>): () => Promise<T> {
  let loading: Promise<T> | null = null;
  return () => {
    loading ??= load().catch((error) => {
      loading = null;
      throw error;
    });
    return loading;
  };
}
