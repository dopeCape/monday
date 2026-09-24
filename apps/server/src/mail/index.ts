// What the reader shows for one Message: sanitised HTML when the Message has
// an HTML part, the text part converted otherwise. Inline parts are resolved
// by Content-ID to the attachment route.

import type { AttachmentHeader } from "../mailstore/index.ts";
import { type SanitizeOptions, sanitizeHtml } from "./sanitize.ts";
import { textToHtml } from "./text.ts";

export type { SanitizedHtml, SanitizeOptions } from "./sanitize.ts";
export { escapeHtml, isTrackerImage, safeHref, sanitizeHtml, sanitizeStyle } from "./sanitize.ts";
export type { TextHtml } from "./text.ts";
export { linkify, quoteStart, textToHtml } from "./text.ts";

export interface DisplayBody {
  html: string;
  quoted: boolean;
  blockedImages: number;
}

export interface DisplayOptions {
  allowRemoteImages?: boolean;
  /** The reader.tracker_hosts Setting. */
  trackerHosts?: readonly string[];
  /** Where an attachment id is served; defaults to /attachments/:id. */
  attachmentUrl?: (attachmentId: string) => string;
}

export function displayBody(
  body: { text: string; html: string | null },
  attachments: readonly AttachmentHeader[],
  options: DisplayOptions = {},
): DisplayBody {
  const url = options.attachmentUrl ?? ((id) => `/attachments/${encodeURIComponent(id)}`);
  const byCid = new Map<string, string>();
  for (const a of attachments) {
    if (a.contentId) byCid.set(a.contentId.toLowerCase(), url(a.id));
  }
  if (body.html && body.html.trim() !== "") {
    const sanitizeOptions: SanitizeOptions = {
      cidUrl: (id) => byCid.get(id.toLowerCase()) ?? null,
      ...(options.allowRemoteImages !== undefined
        ? { allowRemoteImages: options.allowRemoteImages }
        : {}),
      ...(options.trackerHosts ? { trackerHosts: options.trackerHosts } : {}),
    };
    const out = sanitizeHtml(body.html, sanitizeOptions);
    return { html: out.html, quoted: out.quoted, blockedImages: out.blockedImages };
  }
  const out = textToHtml(body.text);
  return { html: out.html, quoted: out.quoted, blockedImages: 0 };
}
