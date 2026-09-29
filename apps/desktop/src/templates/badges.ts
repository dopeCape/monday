// The check badges in the app's words (strings.templates.badge.*), for the
// approval card, the Approvals queue and the Run's Step cards (slice 38).

import type { BadgeStrings, Settings, TemplateChecks, ToolPreview } from "@monday/shared";
import { templateBadges } from "@monday/shared";
import type { CheckBadge } from "@monday/ui";

/** The Settings the badges read. */
export type BadgeSettings = Pick<
  Settings,
  | "strings.templates.badge.answers_all"
  | "strings.templates.badge.answers_some"
  | "strings.templates.badge.no_promises"
  | "strings.templates.badge.promises"
  | "strings.templates.badge.no_details"
  | "strings.templates.badge.details"
  | "strings.templates.badge.confidential"
  | "strings.templates.badge.could_not_check"
>;

export function badgeStrings(s: BadgeSettings): BadgeStrings {
  return {
    answersAll: s["strings.templates.badge.answers_all"],
    answersSome: s["strings.templates.badge.answers_some"],
    noPromises: s["strings.templates.badge.no_promises"],
    promises: s["strings.templates.badge.promises"],
    noDetails: s["strings.templates.badge.no_details"],
    details: s["strings.templates.badge.details"],
    confidential: s["strings.templates.badge.confidential"],
    couldNotCheck: s["strings.templates.badge.could_not_check"],
  };
}

export function checkBadges(
  checks: TemplateChecks | null | undefined,
  s: BadgeSettings,
): CheckBadge[] {
  return checks ? templateBadges(checks, badgeStrings(s)) : [];
}

/** The badges a waiting send carries on its preview, if any. */
export function previewBadges(
  preview: ToolPreview | null | undefined,
  s: BadgeSettings,
): CheckBadge[] {
  return preview?.kind === "send" ? checkBadges(preview.checks, s) : [];
}
