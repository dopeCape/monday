// Hands the compose surfaces their Templates (link.ts): rendered once beside
// the compose layer, where the Shell and the Store are at hand, it keeps the
// Composer's Template link in step with the library, the Settings and the
// strings, and shows the sheet that writes a Template from a message when a
// surface or the reader asks for it.

import { useEffect, useMemo, useState } from "react";
import type { Composer } from "../screens/compose/composer.ts";
import { useShell } from "../shell/Shell.tsx";
import { TemplateDraftSheet } from "./DraftSheet.tsx";
import { setTemplateLink, type TemplateDraftSource, type TemplateLink } from "./link.ts";
import { templateStrings } from "./strings.ts";
import { useTemplateLibrary } from "./useTemplates.ts";

export function TemplatesBridge({ composer }: { composer: Composer }) {
  const shell = useShell();
  const { library } = useTemplateLibrary();
  const s = shell.settings;
  const strings = useMemo(() => templateStrings(s), [s]);
  const [drafting, setDrafting] = useState<TemplateDraftSource | null>(null);
  const suggestion = useMemo(
    () => ({
      enabled: s["templates.suggest.enabled"] && s["ai.level"] !== "off",
      debounceMs: s["templates.suggest.debounce_ms"],
      minIntervalMs: s["templates.suggest.min_interval_ms"],
      maxTypedChars: s["templates.suggest.max_typed_chars"],
    }),
    [s],
  );
  const link = useMemo<TemplateLink>(
    () => ({
      enabled: s["templates.enabled"],
      trigger: s["templates.trigger"],
      openKey: s["compose.templates.open"],
      library,
      strings,
      suggestion,
      fill: async (templateId, from) => {
        try {
          return await shell.api.templates.fill(composer.workspaceId, templateId, from);
        } catch {
          return null;
        }
      },
      suggest: async (request) => {
        try {
          return await shell.api.templates.suggest({ workspace: composer.workspaceId, ...request });
        } catch {
          return null;
        }
      },
      draftFrom: (source) => setDrafting(source),
      onOpen: {
        enabled: suggestion.enabled && s["templates.suggest.on_open"],
        needsReplyAt: s["templates.suggest.needs_reply_at"],
        suggest: async (threadId) => {
          try {
            return await shell.api.templates.suggestOnOpen(composer.workspaceId, threadId);
          } catch {
            return null;
          }
        },
      },
    }),
    [s, library, strings, suggestion, shell.api, composer.workspaceId],
  );
  useEffect(() => {
    setTemplateLink(composer, link);
  }, [composer, link]);
  useEffect(() => () => setTemplateLink(composer, null), [composer]);
  return drafting ? (
    <TemplateDraftSheet
      workspaceId={composer.workspaceId}
      source={drafting}
      api={shell.api.templates}
      strings={strings}
      defaultScope={s["templates.default_scope"]}
      onClose={() => setDrafting(null)}
    />
  ) : null;
}
