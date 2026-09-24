// Whether this Workspace's screen is the one on show. Every warmed Workspace
// keeps its screen mounted so switching is instant (main.tsx); the ones behind
// stay mounted but hidden, and must not answer keys, retitle the window or
// show their compose dock. Outside a pane (tests, a lone screen) it is on show.

import { createContext, useContext } from "react";

export const ActivePaneContext = createContext(true);

export function useIsActivePane(): boolean {
  return useContext(ActivePaneContext);
}
