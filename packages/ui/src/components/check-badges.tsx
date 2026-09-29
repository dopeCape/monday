// The three check badges of a Message drafted from a Template (docs/spec/
// templates.md, "Badges on the approval card"): answers every question, no
// promise the thread does not support, no outside details. Clean, flagged,
// or Unsure ("Could not check"). The words come from the caller.

import { CheckCircleIcon, QuestionIcon, WarningIcon } from "@phosphor-icons/react";
import { cx } from "../format.ts";
import { Icon } from "./icon.tsx";

export interface CheckBadge {
  key: string;
  state: "clean" | "flagged" | "unsure";
  text: string;
}

const GLYPH = { clean: CheckCircleIcon, flagged: WarningIcon, unsure: QuestionIcon } as const;

export function CheckBadges({
  badges,
  className,
}: {
  badges: readonly CheckBadge[];
  className?: string | undefined;
}) {
  if (badges.length === 0) return null;
  return (
    <ul className={cx("check-badges", className)}>
      {badges.map((b) => (
        <li key={b.key} className="check-badge" data-check={b.key} data-state={b.state}>
          <Icon icon={GLYPH[b.state]} weight={b.state === "clean" ? "fill" : "regular"} />
          <span>{b.text}</span>
        </li>
      ))}
    </ul>
  );
}
