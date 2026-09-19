// The motion tokens as code reads them (tokens.css: --t-fast, --t-med,
// --t-slow). A component that keeps something on screen while it leaves
// asks here how long, so the Setting appearance.transitions and the
// system's reduce-motion preference, which both zero the tokens, stop the
// wait too. Nothing in code holds a literal duration.

export type MotionToken = "--t-fast" | "--t-med" | "--t-slow";

/** "220ms" or "0.22s" as milliseconds; anything else reads as 0. */
export function parseDuration(value: string): number {
  const trimmed = value.trim();
  const m = /^(-?\d*\.?\d+)(ms|s)$/.exec(trimmed);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return 0;
  return m[2] === "s" ? n * 1000 : n;
}

/**
 * The token's duration on the root right now, in milliseconds. Zero where
 * there is no document, where the token is unset (tests), where the Setting
 * turned transitions off, and where the system asks for less motion.
 */
export function motionMs(token: MotionToken): number {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return 0;
  const root = document.documentElement;
  if (root.dataset.transitions === "off") return 0;
  if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches)
    return 0;
  return parseDuration(getComputedStyle(root).getPropertyValue(token));
}
