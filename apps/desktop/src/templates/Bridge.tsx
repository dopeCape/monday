// Hands the compose surfaces their Templates (link.ts): rendered once beside
// the compose layer, where the Shell and the Store are at hand, it keeps the
// Composer's Template link in step with the library, the Settings and the
// strings. Renders nothing.

import { useEffect, useMemo } from "react";
import type { Composer } from "../screens/compose/composer.ts";
import { useShell } from "../shell/Shell.tsx";
import { setTemplateLink, type TemplateLink } from "./link.ts";
import { templateStrings } from "./strings.ts";
import { useTemplateLibrary } from "./useTemplates.ts";

export function TemplatesBridge({ composer }: { composer: Composer }) {
  const shell = useShell();
  const { library } = useTemplateLibrary();
  const s = shell.settings;
  const strings = useMemo(() => templateStrings(s), [s]);
  const link = useMemo<TemplateLink>(
    () => ({
      enabled: s["templates.enabled"],
      trigger: s["templates.trigger"],
      openKey: s["compose.templates.open"],
      library,
      strings,
      fill: async (templateId, from) => {
        try {
          return await shell.api.templates.fill(composer.workspaceId, templateId, from);
        } catch {
          return null;
        }
      },
    }),
    [s, library, strings, shell.api, composer.workspaceId],
  );
  useEffect(() => {
    setTemplateLink(composer, link);
  }, [composer, link]);
  useEffect(() => () => setTemplateLink(composer, null), [composer]);
  return null;
}
