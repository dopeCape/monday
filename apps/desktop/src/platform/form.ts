// What kind of device and window the webview runs in, for the phone form.
// Two separate answers: the device (a phone or tablet OS, which has no window
// frame, no Sidecar and no command-line runtimes), and the form (one column at
// a time, under the appearance.mobile_breakpoint Setting). A narrow desktop
// window gets the phone form and keeps its desktop features; a tablet held
// wide keeps the desktop form and still hides them.
//
// The platform may say which OS it runs on (a `kind` or `os` field the Tauri
// mobile host fills); without one the user agent decides. No React here.

export type MobileOs = "ios" | "android";
export type Form = "phone" | "desktop";

const MOBILE_KINDS: Record<string, MobileOs> = {
  ios: "ios",
  ipados: "ios",
  android: "android",
};

/** The mobile OS a platform object names, if it names one. */
function kindOf(platform: unknown): MobileOs | "desktop" | null {
  if (!platform || typeof platform !== "object") return null;
  // The browser fake says nothing: the agent decides there.
  for (const field of ["os", "kind"]) {
    const v = (platform as Record<string, unknown>)[field];
    if (typeof v !== "string") continue;
    const os = MOBILE_KINDS[v.toLowerCase()];
    if (os) return os;
    if (v === "mobile") {
      const agent = typeof navigator === "undefined" ? "" : (navigator.userAgent ?? "");
      return mobileOsOfAgent(agent, 2) ?? "android";
    }
    if (v === "desktop" || v === "linux" || v === "macos" || v === "windows") return "desktop";
  }
  return null;
}

/** The mobile OS a user agent reads as, or null. iPadOS that claims to be a Mac counts by its touch points. */
export function mobileOsOfAgent(agent: string, touchPoints = 0): MobileOs | null {
  if (/Android/i.test(agent)) return "android";
  if (/iPhone|iPad|iPod/i.test(agent)) return "ios";
  if (/Macintosh/i.test(agent) && touchPoints > 1) return "ios";
  return null;
}

/**
 * The mobile OS this webview runs on, or null on a desktop: the platform's
 * own word first (`kind` or `os`: "ios", "android", "mobile" with the agent
 * deciding which), then the user agent.
 */
export function mobileOs(platform?: unknown): MobileOs | null {
  const said = kindOf(platform);
  if (said === "desktop") return null;
  if (said) return said;
  if (typeof navigator === "undefined") return null;
  return mobileOsOfAgent(navigator.userAgent ?? "", navigator.maxTouchPoints ?? 0);
}

/** Whether this webview runs on a phone or tablet OS. */
export function isMobile(platform?: unknown): boolean {
  return mobileOs(platform) !== null;
}

/**
 * The form for a viewport: phone under the breakpoint. On a mobile OS the
 * shorter side counts, so a phone turned sideways keeps one column. A
 * breakpoint of 0 never switches.
 */
export function formOf(
  size: { width: number; height: number },
  breakpoint: number,
  os: MobileOs | null,
): Form {
  if (breakpoint <= 0) return "desktop";
  const side = os ? Math.min(size.width, size.height) : size.width;
  return side < breakpoint ? "phone" : "desktop";
}

/** The viewport now, or a wide one where there is no window (a test without a DOM). */
export function viewport(): { width: number; height: number } {
  if (typeof window === "undefined") return { width: 1440, height: 900 };
  return { width: window.innerWidth, height: window.innerHeight };
}
