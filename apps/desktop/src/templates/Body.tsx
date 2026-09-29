// A Template's text as the compose editor shows it: each declared {name} a
// chip, everything else plain text. Used by the Agent's Template card and the
// sheet that writes a Template from a message.

import type { Placeholder } from "@monday/shared";
import { placeholderLabel } from "@monday/shared";
import type { ReactNode } from "react";

/** A Template's text with each {name} as a chip, as the compose editor shows it. */
export function TemplateBody({
  body,
  placeholders,
}: {
  body: string;
  placeholders: readonly Placeholder[];
}) {
  const known = new Set(placeholders.map((p) => p.name));
  const parts: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of body.matchAll(/\{([a-z][a-z0-9_]{0,63})(\?)?\}/g)) {
    const start = m.index ?? 0;
    if (start > last) parts.push(body.slice(last, start));
    const name = m[1] ?? "";
    parts.push(
      known.has(name) ? (
        <span key={`p${n++}`} className="ph-chip" data-optional={m[2] ? "true" : undefined}>
          {placeholderLabel(name)}
        </span>
      ) : (
        m[0]
      ),
    );
    last = start + m[0].length;
  }
  if (last < body.length) parts.push(body.slice(last));
  return <div className="body tpl-body-view tiptap">{parts}</div>;
}
