// The Template library a screen reads: the Workspace's own Templates from the
// Cache (kept in step by cache.ts) and the built-ins neither replaced by a
// copy nor hidden by templates.builtin.hidden, own first (docs/spec/templates.md,
// "The picker"). Outside a StoreProvider (a screen rendered on its own) only
// the built-ins are listed.

import type { Template } from "@monday/shared";
import { templateLibrary } from "@monday/shared";
import { useEffect, useMemo, useState } from "react";
import { useShell } from "../shell/Shell.tsx";
import { useOptionalStore } from "../store/react.tsx";
import { ensureTemplateSync, OWN_TEMPLATES_SQL, rowToTemplate } from "./cache.ts";

export interface TemplateLibrary {
  /** The Workspace's own Templates; undefined until the Cache has answered. */
  own: Template[] | undefined;
  /** What the picker lists: own first, then the built-ins shown. */
  library: Template[];
  hidden: readonly string[];
}

export function useTemplateLibrary(): TemplateLibrary {
  const shell = useShell();
  const store = useOptionalStore();
  const [own, setOwn] = useState<Template[] | undefined>(undefined);
  useEffect(() => {
    if (!store) return;
    ensureTemplateSync(store, (workspaceId) => shell.api.templates.list(workspaceId));
    const live = store.live<Record<string, unknown>>(OWN_TEMPLATES_SQL, []);
    const off = live.subscribe((rows) =>
      setOwn(rows.map((r) => rowToTemplate(r, store.workspaceId))),
    );
    return () => {
      off();
      live.close();
    };
  }, [store, shell.api]);
  const hidden = shell.settings["templates.builtin.hidden"];
  const library = useMemo(() => templateLibrary(own ?? [], hidden), [own, hidden]);
  return { own, library, hidden };
}
