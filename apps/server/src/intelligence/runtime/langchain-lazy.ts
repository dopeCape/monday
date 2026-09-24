// The LangChain models, loaded on the first hosted-model call. LangChain and
// its provider packages cost tens of megabytes once evaluated, and a Server
// that never calls a hosted model (AI level off, a Local runtime, no keys)
// should not carry them. The first call imports langchain.ts; every later
// call reuses the loaded module.

import { lazy } from "../../lazy.ts";
import type { ChatModel, ConverseModel } from "./index.ts";

/** langchain.ts and its provider packages, imported once on first use. */
export const loadLangChain = lazy(() => import("./langchain.ts"));

/** The chat seam over LangChain, the packages loaded by its first call. */
export function lazyLangChainChat(): ChatModel {
  let chat: ChatModel | null = null;
  return async (call) => {
    chat ??= (await loadLangChain()).createLangChainChat();
    return chat(call);
  };
}

/** The agent loop's seam over LangChain, the packages loaded by its first call. */
export function lazyLangChainConverse(): ConverseModel {
  let converse: ConverseModel | null = null;
  return async (call) => {
    converse ??= (await loadLangChain()).createLangChainConverse();
    return converse(call);
  };
}
