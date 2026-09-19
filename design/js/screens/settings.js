// Settings: three columns (the section nav, the page, the "On this page"
// index), a search field over everything, and every group as a stack of
// cards: title, one-line help, the control beside or below, and a footer with
// the scope, the default and Reset when changed. The app renders the same
// markup from the settings schema; this page mirrors what it shows on a
// fresh install, section by section, so scripts/shot.ts can compare them.
import { palettes } from "../data.js";
import { ic } from "../components.js";
import { state, resolvedTheme } from "../theme.js";

const sections = [
  { key: "accounts", label: "Accounts", icon: "ph-at" },
  { key: "appearance", label: "Appearance", icon: "ph-palette" },
  { key: "routing", label: "Routing", icon: "ph-shuffle" },
  { key: "ai", label: "AI and agent", icon: "ph-cpu" },
  { key: "workflows", label: "Workflows", icon: "ph-flow-arrow" },
  { key: "server", label: "Sync server", icon: "ph-cloud" },
  { key: "shortcuts", label: "Shortcuts", icon: "ph-keyboard" },
  { key: "about", label: "About", icon: "ph-info" },
];

/* ------------------------------ pieces ------------------------------ */

const seg = (opts, on) => `<div class="seg">${opts.map(o => `<button class="${o === on ? "on" : ""}" aria-pressed="${o === on}">${o}</button>`).join("")}</div>`;
const segIcons = (opts, on) => `<div class="seg">${opts.map(([label, icon]) => `<button class="${label === on ? "on" : ""}">${ic(icon)} ${label}</button>`).join("")}</div>`;
const sw = (on) => `<button class="switch ${on ? "on" : ""}" role="switch" aria-checked="${on}"></button>`;
const num = (v) => `<input class="input num" type="number" value="${v}">`;
const text = (v, cls = "text") => `<input class="input ${cls}" type="text" value="${v}">`;
const select = (opts, on) => `<select class="select">${opts.map(o => `<option ${o === on ? "selected" : ""}>${o}</option>`).join("")}</select>`;
const area = (v = "", rows = 2, mono = false) => `<textarea class="input area ${mono ? "mono" : ""}" rows="${rows}" spellcheck="false">${v}</textarea>`;
const btn = (label, cls = "btn sm") => `<button class="${cls}">${label}</button>`;
const tag = (label, kind = "") => `<span class="tag ${kind}">${label}</span>`;

/** The standard footer line: the scope, then the default, with Reset when the value differs. */
function foot(scope, dflt, extra = "", changed = false) {
  return `<span class="scope">${scope === "device" ? "Per device" : "Every device"}</span>${extra}<span class="sp"></span><span class="dflt">Default: ${dflt}</span>${changed ? `<button class="link">Reset</button>` : ""}`;
}

/** One setting card. */
function card({ key, title, help, ctrl, scope = "global", dflt, block = false, changed = false, extra = "" }) {
  return `<div class="scard ${block ? "block" : ""}" data-setting="${key}">
    <div class="scard-main">
      <div class="scard-text"><b class="scard-title">${title}</b>${help ? `<span class="scard-hint">${help}</span>` : ""}</div>
      ${ctrl !== undefined ? `<div class="scard-ctl">${ctrl}</div>` : ""}
    </div>
    <div class="scard-foot">${foot(scope, dflt, extra, changed)}</div>
  </div>`;
}

/** A panel card: no schema key, its own footer or none. */
function panel({ id, title, help, ctrl, block = false, footer = "" }) {
  return `<div class="scard ${block ? "block" : ""}" data-panel="${id}">
    <div class="scard-main">
      <div class="scard-text"><b class="scard-title">${title}</b>${help ? `<span class="scard-hint">${help}</span>` : ""}</div>
      ${ctrl !== undefined ? `<div class="scard-ctl">${ctrl}</div>` : ""}
    </div>
    ${footer ? `<div class="scard-foot">${footer}</div>` : ""}
  </div>`;
}

/** A group: heading, optional intro, the stack of cards, Advanced folded. */
function group(name, cards, { intro = "", advanced = false, heading = true } = {}) {
  const id = "group-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `<section class="sgroup" id="${id}" data-group="${name}">
    ${heading ? `<h3>${name}</h3>` : ""}${intro ? `<p>${intro}</p>` : ""}
    <div class="stack">${cards.join("")}${advanced ? `<details class="advanced"><summary>Advanced</summary></details>` : ""}</div>
  </section>`;
}

function index(groups) {
  if (groups.length < 2) return `<aside class="settings-index" aria-hidden="true"></aside>`;
  return `<aside class="settings-index"><h5>On this page</h5>${groups.map((g, i) => `<a href="#" class="${i === 0 ? "on" : ""}">${g}</a>`).join("")}</aside>`;
}

const search = () => `<div class="settings-search"><label class="settings-search-box"><span class="search-ic">${ic("ph-magnifying-glass")}</span><input type="search" placeholder="Search settings" spellcheck="false"><kbd class="kbd search-key">/</kbd></label></div>`;

function page(title, intro, groups) {
  return `<div class="settings-content"><header class="settings-head"><h1>${title}</h1><p>${intro}</p></header>${groups.map(g => g.html).join("")}</div>${index(groups.map(g => g.name))}`;
}

const G = (name, html) => ({ name, html });

/* ------------------------------ sections ------------------------------ */

function accounts() {
  const prov = (id, logo, title, needs) => `<button class="prov big" data-provider="${id}"><span class="lg">${logo}</span><div><b>${title}</b><span>${needs}</span></div><span class="st">${ic("ph-plus")}</span></button>`;
  const connect = `<div class="stack" data-panel="accounts"><div class="connect" data-panel="connect">
    <div class="connect-head"><h2 class="connect-title">Connect an account</h2><p>Pick how your mail is hosted. Mail syncs to your own server and stays there; nothing is shared with anyone else.</p></div>
    <div class="providers">
      ${prov("jmap", "FM", "Fastmail or JMAP", "Needs an API token from Fastmail settings")}
      ${prov("imap", ic("ph-envelope-simple"), "IMAP", "Needs your password or an app password")}
      ${prov("google", ic("ph-google-logo"), "Google", "Needs a Google Cloud project with OAuth credentials")}
      ${prov("microsoft", ic("ph-windows-logo"), "Microsoft", "Needs an app registration in Azure")}
    </div></div></div>`;
  return page("Accounts", "Each account is its own workspace. The agent only sees the one you are in.", [
    G("Accounts", group("Accounts", [connect], { advanced: true, heading: false })),
    G("Signature", group("Signature", [
      card({ key: "send.signature", title: "Signature", help: "Appended below new Messages and replies. Plain text; blank lines separate paragraphs.", ctrl: area("", 2), block: true, dflt: "empty" }),
      card({ key: "send.signatures", title: "Signature per Account", help: "An Account address to its own signature, overriding the shared one.", ctrl: `<div class="record"></div>`, block: true, dflt: "none" }),
    ])),
    G("Meetings", group("Meetings", [
      panel({ id: "caldav", title: "CalDAV calendar", help: "An Account without a calendar API uses the Local calendar. Link a CalDAV calendar (Fastmail, iCloud, Nextcloud) to read and write it instead.", block: true }),
      card({ key: "calendar.meeting_link", title: "Meeting link", help: "The kind of link the scheduling tool adds to a new Event.", ctrl: select(["Provider", "None", "Google meet", "Teams", "Jitsi", "Custom"], "Provider"), dflt: "Provider" }),
    ])),
    G("Voice profile", group("Voice profile", [panel({ id: "voice", title: "Match my voice", help: "The server is not reachable." })])),
    G("Send", group("Send", [card({ key: "send.delay_seconds", title: "Undo send window", help: "Seconds a send Job waits before it runs. Zero sends at once (ADR 0010).", ctrl: num(30), dflt: "30" })])),
    G("Sync", group("Sync", [card({ key: "sync.body_window_days", title: "Body window", help: "Bodies and attachments are fetched for Messages newer than this many days during sync; older ones on open.", ctrl: num(90), dflt: "90" })])),
    G("Notifications", group("Notifications", [card({ key: "notifications.enabled", title: "Desktop notifications", help: "Show desktop notifications on this device.", ctrl: sw(true), scope: "device", dflt: "On" })])),
  ]);
}

function appearance() {
  const t = resolvedTheme();
  const swatch = p => {
    const c = p[t];
    return `<button class="sw ${state.palette === p.key ? "on" : ""}" data-palette="${p.key}" aria-pressed="${state.palette === p.key}" style="--s-bg:${c.bg};--s-panel:${c.panel};--s-fg:${c.fg};--s-accent:${c.accent};--s-border:${c.border}">
      <div class="pv"><div></div><div><span class="ac"></span><span class="ln"></span><span class="ln s"></span></div></div>
      <div class="lb">${p.label}<span>${p.by}</span></div></button>`;
  };
  const custom = `<button class="sw custom" style="--s-bg:var(--sunken);--s-panel:var(--panel);--s-fg:var(--fg-faint);--s-accent:var(--fg-faint);--s-border:var(--border)"><div class="pv"><div></div><div>${ic("ph-plus")}</div></div><div class="lb">Custom<span>from file</span></div></button>`;
  const mode = { system: "System", light: "Light", dark: "Dark" }[state.theme];
  return page("Appearance", "The agent and this page save to your settings. A key set in your config file wins and shows here as pinned.", [
    G("Theme", group("Theme", [
      card({ key: "appearance.mode", title: "Mode", help: "Light, dark, or follow the system.", ctrl: segIcons([["System", "ph-monitor"], ["Light", "ph-sun"], ["Dark", "ph-moon"]], mode), dflt: "System", changed: mode !== "System" }),
    ])),
    G("Palette", group("Palette", [
      card({ key: "appearance.palette", title: "Palette", help: "One of the shipped palettes, or a path to a palette file (token TOML or base16 YAML).", ctrl: `<div class="swatches">${palettes.map(swatch).join("")}${custom}</div>`, block: true, dflt: "graphite", changed: state.palette !== "graphite" }),
    ], { intro: "Shipped palettes below, or point the config at your own. Each has a light and a dark half.", advanced: true })),
    G("Layout", group("Layout", [
      card({ key: "layout.preset", title: "Layout preset", help: "A built-in named Layout. Derived from the three knobs; custom when they match no preset.", ctrl: seg(["Stream", "Columns", "Agent left"], "Stream"), dflt: "Stream" }),
      card({ key: "layout.nav", title: "Navigation", help: "Full sidebar, a narrow rail, or hidden.", ctrl: seg(["Full", "Rail", "Hidden"], "Full"), dflt: "Full" }),
      card({ key: "layout.agent", title: "Agent", help: "Where the Agent composer sits: a bottom bar, a left column or a right column.", ctrl: seg(["Bottom", "Left", "Right"], "Bottom"), dflt: "Bottom" }),
    ], { intro: "Everything here is a value in the config file. Presets are named combinations, and the agent can set any of it when you ask." })),
    G("Views", group("Views", [card({ key: "views.list", title: "Views", help: "Saved Layouts with a shortcut, shared across Workspaces.", ctrl: `<div class="views"><div class="note">No views yet. Ask for one below.</div></div>`, block: true, dflt: "none" })], { intro: "Saved layouts you can switch between. Ask the agent for one and it names it, sets a shortcut, and writes it to the file." })),
    G("Type", group("Type", [card({ key: "appearance.font", title: "Font", help: "The interface font family.", ctrl: select(["Geist Variable", "Inter", "IBM Plex Sans", "system-ui", "Other"], "Geist Variable"), dflt: "Geist Variable" })])),
    G("Config file", group("Config file", [panel({ id: "config", title: "Config file", help: "Yours, never written by the app unless you ask.", ctrl: `<div class="code"># no config file yet</div>`, block: true })])),
    G("Inbox", group("Inbox", [])),
    G("Calendar", group("Calendar", [])),
    G("Search", group("Search", [])),
    G("Settings page", group("Settings page", [])),
  ]);
}

function routing() {
  return page("Routing", "How mail lands in Groups and Sections, and which threads get a Brief. The agent can change any of it when you ask.", [
    G("Groups", group("Groups", [panel({ id: "groups", title: "Your Groups", help: "Each Group's rule, threshold and evidence. Change them on the Routing page or by asking.", ctrl: `<div class="groups-tree"><div class="note">No groups yet. Ask for one on the Routing page.</div></div>`, block: true })])),
    G("Sections", group("Sections", [])),
    G("Briefs", group("Briefs", [])),
    G("Thresholds", group("Thresholds", [])),
    G("Re-evaluation", group("Re-evaluation", [])),
    G("Reader", group("Reader", [])),
  ]);
}

const levels = [
  { key: "off", t: "Just mail", s: "No AI at all. A fast mail client with Groups you make by hand, search, keymaps and the calendar. No provider key asked for." },
  { key: "assist", t: "Mail with an assistant", s: "The agent bar and what it reaches: draft, find, summarize, change settings, undo. Briefs when you open a thread. Nothing runs without you asking." },
  { key: "automate", t: "Mail that sorts and acts for me", s: "Everything: routing into Groups, Briefs in the background, Workflows with their approvals.", on: true },
];

function ai() {
  const bare = (key, inner, scope, dflt, changed) => `<div class="scard bare" data-setting="${key}"><div class="scard-main">${inner}</div><div class="scard-foot">${foot(scope, dflt, "", changed)}</div></div>`;
  const cli = (lg, name, on) => `<button class="prov ${on ? "on" : ""}" aria-pressed="${on}"><span class="lg">${lg}</span><div><b>${name}</b><span>Not found in PATH</span></div><span class="st">Install</span></button>`;
  const prov = (lg, name, model, on) => `<button class="prov ${on ? "on" : ""}" aria-pressed="${on}"><span class="lg">${lg}</span><div><b>${name}</b><span>${model}</span></div><span class="st">Add key</span></button>`;
  return page("AI and agent", "Two ways to run the agent, tagging and workflows. Pick one, or use both and choose per workflow.", [
    G("Level", group("Level", [bare("ai.level",
      `<div class="choice-cards" data-count="3">${levels.map(c => `<button class="choice-card ${c.on ? "on" : ""}" data-value="${c.key}"><b>${c.t}</b><span>${c.s}</span></button>`).join("")}</div><p class="choice-note">Yours to change at any time. Moving down disables, never deletes; moving up brings everything back.</p>`,
      "global", "Off", true)])),
    G("Runtime", group("Runtime", [
      bare("ai.mode", `<div class="mode"><button class="on" aria-pressed="true">${ic("ph-terminal-window")}<b>Local CLI</b><span>Uses Claude Code, Codex or OpenCode already installed on this machine. Nothing leaves your laptop except what the CLI sends.</span></button><button aria-pressed="false">${ic("ph-key")}<b>API key</b><span>Talks to a provider directly. Lets the sync server run workflows and tagging while this device is off.</span></button></div>`, "device", "Local", false),
      card({ key: "ai.local.cli", title: "Local CLI", help: "Detected on this machine. The agent talks to them over their local protocol, no extra setup.", ctrl: `<div class="providers">${cli("CC", "Claude Code", true)}${cli("CX", "Codex", false)}${cli("OC", "OpenCode", false)}</div>`, block: true, scope: "device", dflt: "Claude code" }),
      card({ key: "ai.hosted.provider", title: "Hosted provider", help: "Keys are stored in the system keychain. The server receives a copy only when you share it below.", ctrl: `<div class="providers">${prov("A", "Anthropic", "claude-sonnet-5", true)}${prov("G", "Gemini", "gemini-2.5-pro", false)}${prov("O", "OpenAI", "gpt-5", false)}${prov("K", "Kimi", "kimi-k2-thinking", false)}${prov("OR", "OpenRouter", "anthropic/claude-sonnet-5", false)}</div>`, block: true, dflt: "Anthropic" }),
    ], { advanced: true })),
    G("Anthropic", group("Anthropic", [])),
    G("Gemini", group("Gemini", [])),
    G("OpenAI", group("OpenAI", [])),
    G("Kimi", group("Kimi", [])),
    G("OpenRouter", group("OpenRouter", [])),
    G("Tasks", group("Tasks", [])),
    G("Meter", group("Meter", [])),
    G("Permissions", group("Permissions", [])),
    G("Activity log", group("Activity log", [])),
    G("Sessions", group("Sessions", [])),
    G("External access", group("External access", [])),
  ]);
}

function workflowsPrefs() {
  return page("Workflows", "Defaults for workflows the agent writes.", [
    G("Defaults", group("Defaults", [
      card({ key: "workflows.placement", title: "Default Placement", help: "Where a new Workflow runs: on the Server with a Hosted runtime, or on a Local runtime while the client is open.", ctrl: seg(["Server", "Local"], "Server"), dflt: "Server" }),
      card({ key: "workflows.ask_before_enable", title: "Ask before enabling", help: "Show a Dry run and ask before a new Workflow is enabled.", ctrl: sw(true), dflt: "On" }),
      card({ key: "workflows.notify_on_failure", title: "Notify on failure", help: "Send a desktop notification when a Run fails.", ctrl: sw(true), dflt: "On" }),
      card({ key: "workflows.run_retention_days", title: "Run log retention", help: "Days a Run and its log are kept.", ctrl: num(30), dflt: "30" }),
      card({ key: "workflows.silence.check_cron", title: "Silence check", help: "When Workflows with a silence trigger look for Threads with no reply, as a five-field cron in UTC.", ctrl: text("0 9 * * *"), dflt: "0 9 * * *" }),
      card({ key: "workflows.page.refresh_seconds", title: "Workflows page refresh", help: "Seconds between refreshes of the Run log while the Workflows page is open; 0 turns it off.", ctrl: num(15), dflt: "15" }),
    ], { advanced: true })),
    G("Budget", group("Budget", [])),
    G("MCP servers", group("MCP servers", [])),
  ]);
}

function server() {
  return page("Sync server", "A small TypeScript service that receives provider webhooks and keeps a copy so new mail is ready the moment you open the app.", [
    G("Server", group("Server", [panel({ id: "mode", title: "Talking to", help: "No server yet", ctrl: `${tag("Sidecar only")}${btn("Check now")}` })])),
    G("Storage", group("Storage", [
      panel({ id: "storage", title: "Stored mail", help: "Mail and attachments this server holds for every account.", ctrl: `<span class="stat">Not reachable</span>` }),
      panel({ id: "recovery", title: "Recovery file", help: "The key that unlocks every message on your server, kept in this device's keychain. Export a copy and keep it safe; without it a new install cannot read your mail.", ctrl: `<span class="key-row">${btn("Export")}${btn("Import")}</span>`, footer: `${tag("In the keychain", "ok")}<span class="sp"></span><span>Save this file somewhere safe. A new device pastes it to read this server's mail.</span>` }),
      card({ key: "search.cache_window_days", title: "Pre-warm window", help: "How many days of bodies the Cache pre-warms, newest first, within the size cap (ADR 0011). Per device.", ctrl: num(730), scope: "device", dflt: "730" }),
      card({ key: "search.cache_cap_gb", title: "Cache size cap", help: "The most the Cache may hold, in gigabytes. Per device.", ctrl: num(2), scope: "device", dflt: "2" }),
    ])),
    G("Connection", group("Connection", [])),
    G("Cloud", group("Cloud", [])),
    G("Devices", group("Devices", [])),
    G("Jobs", group("Jobs", [])),
  ]);
}

function shortcuts() {
  const k = (action, label, key) => `<div class="binding" data-action="${action}"><div class="l"><b>${label}</b></div><button class="chord-btn"><kbd class="kbd">${key}</kbd></button><span class="reset-slot"></span></div>`;
  const bindings = `<div class="bindings"><h4>Navigate</h4>${k("move.down", "Move down", "J")}${k("move.up", "Move up", "K")}${k("thread.open", "Open thread", "Enter")}${k("sheet.close", "Close", "Esc")}${k("palette.open", "Command palette", "Ctrl K")}${k("agent.focus", "Ask monday", "/")}</div>`;
  return page("Shortcuts", "Vim-style by default. Every key can be remapped here or in the config file.", [
    G("Keymap", group("Keymap", [
      card({ key: "keyboard.keymap", title: "Keymap", help: "The built-in binding set: Vim, Gmail or Natural.", ctrl: seg(["Vim", "Gmail", "Natural"], "Vim"), dflt: "Vim" }),
      card({ key: "keyboard.bindings", title: "Bindings", help: "Per-action overrides of the keymap, action name to key chord.", ctrl: bindings, block: true, dflt: "none" }),
    ])),
    G("After an action", group("After an action", [])),
  ]);
}

function about() {
  return page("About", "monday is free, open source and self-hostable. Desktop first, mobile later.", [
    G("About", group("About", [
      panel({ id: "about", title: "Version", help: "0.1.0 on Tauri 2, Linux x86_64", ctrl: btn("Check for updates") }),
      panel({ id: "license", title: "License", help: "MIT", ctrl: btn("Source") }),
      panel({ id: "telemetry", title: "Telemetry", help: "monday sends no telemetry." }),
    ], { heading: false })),
  ]);
}

export function render(route) {
  const cur = sections.find(s => s.key === route.id) || sections[1];
  const body = { accounts, appearance, routing, ai, workflows: workflowsPrefs, server, shortcuts, about }[cur.key]();
  return `
  <div class="main page">
    <div class="settings">
      <nav class="settings-nav">
        <h4>Settings</h4>
        ${sections.map(s => `<button class="nav-item ${s.key === cur.key ? "on" : ""}" data-go="#/settings/${s.key}">${ic(s.icon)} <span>${s.label}</span></button>`).join("")}
      </nav>
      <div class="settings-body" data-index="shown"><div class="settings-in" data-section="${cur.key}">${search()}<div class="settings-cols">${body}</div></div></div>
    </div>
  </div>`;
}
