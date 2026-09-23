// First sync (docs/spec/onboarding.md, "First sync"): the screen right after
// the first Account is connected. It stands in for the whole app until the
// Inbox is fetched: headers for every Inbox Message, then the bodies inside
// the body window. Calm and spacious; no nav, no agent bar, no sparkle.
// Hash routes: #/first-sync (syncing), #/first-sync/pacing, #/first-sync/error.

import { ic } from "../components.js";

const account = { address: "tejas@genai-labs.io", provider: "Gmail", logo: "ph-google-logo" };

const lines = [
  { phase: "headers", label: "Finding your messages", detail: "Done", p: 1, state: "done" },
  { phase: "bodies", label: "Fetching messages", detail: "380 of 640", p: 380 / 640, state: "active" },
];

function line(l) {
  return `
    <div class="first-sync-line" data-phase="${l.phase}" data-state="${l.state}">
      <div class="first-sync-row"><span class="first-sync-label">${l.label}</span><span class="first-sync-detail">${l.detail}</span></div>
      <div class="first-sync-bar" role="progressbar" aria-label="${l.label}"><span style="--p: ${l.p}"></span></div>
    </div>`;
}

function note(state) {
  if (state === "error") {
    return `
      <div class="first-sync-error" role="alert">${ic("ph-warning-circle")}
        <div><b>Syncing stopped</b><span>Gmail no longer accepts monday's sign-in for ${account.address}. Reconnect the account in Settings.</span></div>
      </div>
      <div class="actions"><span class="sp"></span><button class="btn">Open settings</button><button class="btn primary">Retry</button></div>`;
  }
  if (state === "pacing") {
    return `<p class="first-sync-note">Gmail asked monday to slow down to stay within its limits. Syncing carries on at a gentler pace.</p>`;
  }
  return `<p class="first-sync-note">About 2 minutes left</p>`;
}

export function render(route) {
  const state = route.id || "syncing";
  return `
  <div class="main page" data-screen="first-sync" data-state="${state}">
    <div class="first-sync">
      <div class="first-sync-in">
        <div class="first-sync-account">
          <span class="lg">${ic(account.logo)}</span>
          <div><b>${account.address}</b><span>${account.provider}</span></div>
        </div>
        <h1>Getting your inbox ready</h1>
        <p>monday reads your inbox once so it opens instantly from now on.</p>
        <div class="first-sync-lines">${lines.map(line).join("")}</div>
        ${note(state)}
      </div>
    </div>
  </div>`;
}
