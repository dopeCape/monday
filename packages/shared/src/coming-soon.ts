// Options shown in the app but not usable yet: they read "Coming soon" and
// cannot be picked. Not Settings on purpose: each one is switched on here, in
// code, once it has been tested and is ready.

export const COMING_SOON = {
  /** Microsoft sign-in (Outlook, Microsoft 365) when adding an account. */
  microsoft: true,
  /** Cloud servers: deploying one, copying the database to it, connecting to it. */
  cloud: true,
} as const;
