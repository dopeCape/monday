// The current Workspace (CONTEXT.md: one at a time). In the app it comes from
// the first connected Account; the browser dev server and the tests run on the
// design fixture's. Everything that names a Workspace or the owner's address
// reads it here, never from the fixtures directly.

import type { Id } from "@monday/shared";
import { createContext, type ReactNode, useContext } from "react";

export interface CurrentWorkspace {
  id: Id;
  accountId: Id;
  /** The owner's address on this Workspace's Account. */
  address: string;
  /**
   * A fixed wall clock the Workspace's mail is written against: the design
   * fixture's, so the dev server's relative times match the mock. Absent in
   * the app, where the screens read the real clock.
   */
  now?: Date | undefined;
}

/**
 * The design fixture's Workspace, for the dev server and the tests. Spelled
 * out here so this module never loads `@monday/ui/fixtures`; a test pins the
 * three values to the fixture's.
 */
export const FIXTURE_WORKSPACE: CurrentWorkspace = {
  id: "ws-genai",
  accountId: "acct-genai",
  address: "tejas@genai-labs.io",
  now: new Date("2026-09-16T10:00:00"),
};

const WorkspaceContext = createContext<CurrentWorkspace>(FIXTURE_WORKSPACE);

export function WorkspaceProvider({
  value,
  children,
}: {
  value: CurrentWorkspace;
  children: ReactNode;
}) {
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): CurrentWorkspace {
  return useContext(WorkspaceContext);
}
