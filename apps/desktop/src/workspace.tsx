// The current Workspace (CONTEXT.md: one at a time). In the app it is the
// Account the `workspace.current` Setting names (per device), or the first
// connected one; the browser dev server and the tests run on the design
// fixture's. Everything that names a Workspace or the owner's address reads it
// here, never from the fixtures directly. Switching is writing that Setting:
// the gate picks the Account again and remounts the Store on its Cache file.

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

/** What the gate needs of an Account to open its Workspace. */
export interface WorkspaceAccount {
  id: Id;
  workspaceId: Id;
  address: string;
}

/**
 * The Account whose Workspace to show: the one `workspace.current` names
 * when it is still connected, else the first; null with none.
 */
export function pickAccount<A extends WorkspaceAccount>(
  accounts: readonly A[] | null | undefined,
  currentId: string,
): A | null {
  if (!accounts || accounts.length === 0) return null;
  return accounts.find((a) => a.id === currentId) ?? accounts[0] ?? null;
}

/** The CurrentWorkspace an Account opens. */
export function workspaceOf(account: WorkspaceAccount): CurrentWorkspace {
  return { id: account.workspaceId, accountId: account.id, address: account.address };
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
