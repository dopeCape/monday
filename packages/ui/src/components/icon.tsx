import type { Icon as PhosphorIcon } from "@phosphor-icons/react";
import { cx } from "../format.ts";

/** A Phosphor icon component, the only kind of icon monday draws. */
export type IconComponent = PhosphorIcon;

export type IconWeight = "regular" | "fill";

export interface IconProps {
  icon: IconComponent;
  /** Regular everywhere; fill only where the mock uses it. */
  weight?: IconWeight | undefined;
  className?: string | undefined;
}

/**
 * Wraps a Phosphor SVG in the <i class="ph"> the CSS sizes and colors.
 * The SVG is 1em, so the wrapper's font-size is the icon size.
 */
export function Icon({ icon: Glyph, weight = "regular", className }: IconProps) {
  return (
    <i className={cx(weight === "fill" ? "ph-fill" : "ph", className)} aria-hidden="true">
      <Glyph weight={weight} />
    </i>
  );
}
