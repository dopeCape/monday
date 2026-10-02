// Hands the compose surfaces their Templates (link.ts): rendered once beside
// the compose layer, where the Shell and the Store are at hand, it keeps the
// Composer's Template link in step with the library, the Settings and the
// strings, and shows the sheet that writes a Template from a message when a
// surface or the reader asks for it. It also keeps Jev's picker ranking for a
// short while (rank.ts), the one-time hint's device flag, and the way to
// Settings › Templates.

import { useEffect, useMemo, useState } from "react";
import type { Composer } from "../screens/compose/composer.ts";
import { useShell } from "../shell/Shell.tsx";
import { TemplateDraftSheet } from "./DraftSheet.tsx";
import { setTemplateLink, type TemplateDraftSource, type TemplateLink } from "./link.ts";
import { createRankCache } from "./rank.ts";
import { templateStrings } from "./strings.ts";
import { useTemplateLibrary } from "./useTemplates.ts";

export interface TemplatesBridgeProps {
  composer: Composer;
  /** Opens Settings › Templates (the picker's "Manage templates"). */
  onManage?: (() => void) | undefined;
}

export function TemplatesBridge({ composer, onManage }: TemplatesBridgeProps) {
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
  const ttl = s["templates.picker.rank_cache_ms"];
  const ranks = useMemo(() => createRankCache(ttl), [ttl]);
  const seen = s["templates.hint.trigger_seen"];
  const api = shell.api;
  const setSetting = shell.set;
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
          return await api.templates.fill(composer.workspaceId, templateId, from);
        } catch {
          return null;
        }
      },
      suggest: async (request) => {
        try {
          const r = await api.templates.suggest({
            workspace: composer.workspaceId,
            ...request,
          });
          ranks.learn(request.threadId, request.draft.typed, r);
          return r;
        } catch {
          return null;
        }
      },
      ranking: {
        enabled: suggestion.enabled && s["templates.picker.rank"],
        suggestedMax: s["templates.picker.suggested_max"],
        suggestedFloor: s["templates.picker.suggested_floor"],
        rank: async (request) => {
          const known = ranks.get(request.threadId, request.draft.typed);
          if (known) return known;
          try {
            const r = await api.templates.suggest({
              workspace: composer.workspaceId,
              ...request,
              rankOnly: true,
            });
            ranks.learn(request.threadId, request.draft.typed, r);
            return r.status === "ranked" ? r.ranking : null;
          } catch {
            return null;
          }
        },
      },
      hint: {
        show: !seen,
        dismiss: () => {
          if (!seen) void setSetting("templates.hint.trigger_seen", true);
        },
      },
      manage: onManage,
      draftFrom: (source) => setDrafting(source),
      onOpen: {
        enabled: suggestion.enabled && s["templates.suggest.on_open"],
        needsReplyAt: s["templates.suggest.needs_reply_at"],
        suggest: async (threadId) => {
          try {
            return await api.templates.suggestOnOpen(composer.workspaceId, threadId);
          } catch {
            return null;
          }
        },
      },
    }),
    [s, library, strings, suggestion, api, setSetting, composer.workspaceId, ranks, seen, onManage],
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
