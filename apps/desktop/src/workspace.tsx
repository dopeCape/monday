// The current Workspace (CONTEXT.md: one at a time). In the app it comes from
// the first connected Account; the browser dev server and the tests run on the
// design fixture's. Everything that names a Workspace or the owner's address
// reads it here, never from the fixtures directly.

import type { Id } from "@monday/shared";
import { account, workspace } from "@monday/ui/fixtures";
import { createContext, type ReactNode, useContext } from "react";

export interface CurrentWorkspace {
  id: Id;
  accountId: Id;
  /** The owner's address on this Workspace's Account. */
  address: string;
}

/** The design fixture's Workspace, for the dev server and the tests. */
export const FIXTURE_WORKSPACE: CurrentWorkspace = {
  id: workspace.id,
  accountId: account.id,
  address: account.address,
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
