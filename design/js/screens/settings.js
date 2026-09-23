// Settings: three columns (the section nav, the page, the "On this page"
// index), a search field over everything, and every group as a stack of
// cards: title, one-line help, the control beside or below, and a footer with
// the scope, the default and Reset when changed. The app renders the same
// markup from the settings schema; this page mirrors what it shows on a
// fresh install, section by section, so scripts/shot.ts can compare them:
// each section opens with its overview, groups show their primary cards with
// "More settings (n)" in place, groups with nothing primary fold to their
// heading, and the fine-tuning sits in one Advanced row at the bottom.
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

/** A group: heading, optional intro, the stack of cards, then "More settings (n)" in place. */
function group(name, cards, { intro = "", more = 0, heading = true } = {}) {
  const id = "group-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `<section class="sgroup" id="${id}" data-group="${name}">
    ${heading ? `<h3>${name}</h3>` : ""}${intro ? `<p>${intro}</p>` : ""}
    <div class="stack">${cards.join("")}${more ? moreLine(`More settings (${more})`) : ""}</div>
  </section>`;
}

const caret = () => `<i class="ph ph-caret-right disclosure-caret"></i>`;
const moreLine = (label) => `<div class="disclosure more"><button class="disclosure-toggle" aria-expanded="false">${caret()}<span class="disclosure-summary">${label}</span></button></div>`;

/** A group folded to its heading: name and one line; it opens in place. */
function folded(name, line) {
  const id = "group-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `<section class="sgroup folded-group" id="${id}" data-group="${name}"><div class="disclosure group-toggle"><h3 class="disclosure-heading"><button class="disclosure-toggle" aria-expanded="false">${caret()}<span class="disclosure-summary"><span class="g-name">${name}</span><span class="g-line">${line}</span></span></button></h3></div></section>`;
}

const ADVANCED = "For fine-tuning. The defaults suit almost everyone; a wrong value here can slow sync or confuse sorting.";

/** The overview card at the top of a section: its state in plain words and its common actions. */
const overview = (line, actions) => `<section class="soverview"><p>${line}</p><div class="soverview-actions">${actions.map(a => btn(a)).join("")}</div></section>`;

/** Index entries: a name, or [name, true] for one that starts folded. */
function index(groups) {
  if (groups.length < 2) return `<aside class="settings-index" aria-hidden="true"></aside>`;
  return `<aside class="settings-index"><h5>On this page</h5>${groups.map((g, i) => {
    const [name, fold] = Array.isArray(g) ? g : [g, false];
    return `<a href="#" class="${i === 0 ? "on" : ""} ${fold ? "folded" : ""}">${name}</a>`;
  }).join("")}</aside>`;
}

const search = () => `<div class="settings-search"><label class="settings-search-box"><span class="search-ic">${ic("ph-magnifying-glass")}</span><input type="search" placeholder="Search settings" spellcheck="false"><kbd class="kbd search-key">/</kbd></label></div>`;

function page(title, intro, top, groups) {
  return `<div class="settings-content"><header class="settings-head"><h1>${title}</h1><p>${intro}</p></header>${top}${groups.map(g => g.html).join("")}</div>${index(groups.map(g => g.fold ? [g.name, true] : g.name))}`;
}

const G = (name, html) => ({ name, html });
const F = (name, line) => ({ name, html: folded(name, line), fold: true });

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
  return page("Accounts", "Each account is its own workspace. The agent only sees the one you are in.",
    overview("No accounts yet. Connect one to start.", ["Connect an account"]), [
    G("Your accounts", group("Your accounts", [connect])),
    F("Sign-in apps", "For the whole app, not one account: Google and Microsoft accounts sign in through an app you register once."),
    G("For every account", group("For every account", [
      card({ key: "send.signature", title: "Signature", help: "Added below new messages and replies. An account can have its own in its card above. Plain text; a blank line starts a paragraph.", ctrl: area("", 2), block: true, dflt: "empty" }),
      card({ key: "calendar.meeting_link", title: "Meeting link", help: "The video link added to a new event: the account's own, none, Google Meet, Teams, Jitsi, or your own URL.", ctrl: select(["Provider", "None", "Google meet", "Teams", "Jitsi", "Custom"], "Provider"), dflt: "Provider" }),
    ], { intro: "Used by every account, unless an account sets its own in its card above.", more: 1 })),
    G("Sending", group("Sending", [card({ key: "send.delay_seconds", title: "Undo send", help: "Seconds you have to take a message back after pressing Send. Zero sends at once.", ctrl: num(30), dflt: "30" })], { more: 3 })),
    G("Notifications", group("Notifications", [card({ key: "notifications.enabled", title: "Desktop notifications", help: "Show desktop notifications on this computer.", ctrl: sw(true), scope: "device", dflt: "On" })], { more: 1 })),
    F("Sync", "2 settings"),
    F("Advanced", ADVANCED),
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
  return page("Appearance", "The agent and this page save to your settings. A key set in your config file wins and shows here as pinned.",
    overview(`${mode} mode, Graphite colors, stream layout, comfortable density.`, ["Use dark", "Pick colors"]), [
    G("Theme", group("Theme", [
      card({ key: "appearance.mode", title: "Light or dark", help: "Light, dark, or follow your computer's setting.", ctrl: segIcons([["System", "ph-monitor"], ["Light", "ph-sun"], ["Dark", "ph-moon"]], mode), dflt: "System", changed: mode !== "System" }),
    ])),
    G("Palette", group("Palette", [
      card({ key: "appearance.palette", title: "Colors", help: "One of the shipped palettes, or your own palette file (token TOML or base16 YAML).", ctrl: `<div class="swatches">${palettes.map(swatch).join("")}${custom}</div>`, block: true, dflt: "graphite", changed: state.palette !== "graphite" }),
    ], { intro: "Shipped palettes below, or point the config at your own. Each has a light and a dark half." })),
    G("Layout", group("Layout", [
      card({ key: "layout.preset", title: "Layout", help: "Where the list, the reader and the agent sit. Custom when you set the three parts yourself.", ctrl: seg(["Stream", "Columns", "Agent left"], "Stream"), dflt: "Stream" }),
      card({ key: "appearance.density", title: "Density", help: "How much fits on screen: the size of text, icons and rows. On this computer only.", ctrl: seg(["Compact", "Comfortable", "Spacious"], "Comfortable"), scope: "device", dflt: "Comfortable" }),
    ], { intro: "Everything here is a value in the config file. Presets are named combinations, and the agent can set any of it when you ask.", more: 4 })),
    G("Text", group("Text", [card({ key: "appearance.font_size", title: "Text size", help: "The base size of text, in pixels. On this computer only.", ctrl: num(14), scope: "device", dflt: "14" })], { more: 2 })),
    F("Views", "Saved layouts you can switch between. Ask the agent for one and it names it, sets a shortcut, and writes it to the file."),
    F("Inbox", "4 settings"),
    F("Calendar", "5 settings"),
    F("Search", "2 settings"),
    G("Config file", group("Config file", [panel({ id: "config", title: "Config file", help: "Yours, never written by the app unless you ask.", ctrl: `<div class="code"># no config file yet</div>`, block: true })])),
    F("Advanced", ADVANCED),
  ]);
}

function routing() {
  return page("Routing", "How mail lands in Groups and Sections, and which threads get a Brief. The agent can change any of it when you ask.",
    overview("New mail is sorted into Groups as it arrives. TypeSafe decides which threads get a Brief. 4 Sections split the stream.", ["Edit Sections", "Briefs"]), [
    G("Sorting", group("Sorting", [card({ key: "routing.on_arrival", title: "Sort new mail as it arrives", help: "Every new thread is placed in a Group as it arrives, on your Sync server. Off sorts only when you re-run a rule.", ctrl: sw(true), dflt: "On" })], { intro: "How new mail finds its Group, and when mail already sorted is looked at again.", more: 4 })),
    G("Groups", group("Groups", [panel({ id: "groups", title: "Your Groups", help: "Each Group's rule, threshold and evidence. Change them on the Routing page or by asking.", ctrl: `<div class="groups-tree"><div class="note">No groups yet. Ask for one on the Routing page.</div></div>`, block: true })], { more: 2 })),
    G("Sections", group("Sections", [])),
    G("Custom actions", group("Custom actions", [])),
    G("Briefs", group("Briefs", [])),
    F("Confidence", "How sure monday must be before it moves a thread on its own, and when it asks you instead."),
    F("Reading", "3 settings"),
    F("Advanced", ADVANCED),
  ]);
}

const levels = [
  { key: "off", t: "Just mail", s: "No AI at all. A fast mail client with Groups you make by hand, search, keymaps and the calendar. No provider key asked for." },
  { key: "assist", t: "Mail with an assistant", s: "The agent bar and what it reaches: draft, find, summarize, change settings, undo. Briefs when you open a thread. Nothing runs without you asking. With a TypeSafe key the palette also answers typed sentences." },
  { key: "automate", t: "Mail that sorts and acts for me", s: "Everything: routing into Groups and Sections you describe in your own words, Briefs in the background, custom actions, Workflows with their approvals. Sorting runs on TypeSafe when its key exists, on the language model otherwise.", on: true },
];

function ai() {
  const bare = (key, inner, scope, dflt, changed) => `<div class="scard bare" data-setting="${key}"><div class="scard-main">${inner}</div><div class="scard-foot">${foot(scope, dflt, "", changed)}</div></div>`;
  const cli = (lg, name, on) => `<button class="prov ${on ? "on" : ""}" aria-pressed="${on}"><span class="lg">${lg}</span><div><b>${name}</b><span>Not found in PATH</span></div><span class="st">Install</span></button>`;
  return page("AI and agent", "Two ways to run the agent, tagging and workflows. Pick one, or use both and choose per workflow.",
    overview("Claude Code on this computer answers the agent. The language model answers judgments. No provider has a key.", ["Change how it runs", "This month's usage"]), [
    G("Level", group("Level", [bare("ai.level",
      `<div class="choice-cards" data-count="3">${levels.map(c => `<button class="choice-card ${c.on ? "on" : ""}" data-value="${c.key}"><b>${c.t}</b><span>${c.s}</span></button>`).join("")}</div><p class="choice-note">Yours to change at any time. Moving down disables, never deletes; moving up brings everything back.</p>`,
      "global", "Off", true)])),
    G("Runtime", group("Runtime", [
      bare("ai.mode", `<div class="mode"><button class="on" aria-pressed="true">${ic("ph-terminal-window")}<b>Local CLI</b><span>Uses Claude Code, Codex or OpenCode already installed on this machine. Nothing leaves your laptop except what the CLI sends.</span></button><button aria-pressed="false">${ic("ph-key")}<b>API key</b><span>Talks to a provider directly. Lets the sync server run workflows and tagging while this device is off.</span></button></div>`, "device", "Local", false),
      card({ key: "ai.local.cli", title: "Command-line agent", help: "Detected on this machine. The agent talks to them over their local protocol, no extra setup.", ctrl: `<div class="providers">${cli("CC", "Claude Code", true)}${cli("CX", "Codex", false)}${cli("OC", "OpenCode", false)}</div>`, block: true, scope: "device", dflt: "Claude code" }),
    ], { intro: "What answers the agent: a command-line agent on this computer, or a provider you reach with an API key.", more: 1 })),
    G("TypeSafe", group("TypeSafe", [], {})),
    F("Permissions", "What the agent may do without asking. Anything that leaves the mailbox always asks first."),
    G("Meter", group("Meter", [])),
    F("Typed commands", "2 settings"),
    F("Conversations", "2 settings"),
    F("Activity log", "Every tool call the agent made, who approved it, and Undo while it still works."),
    F("External access", "Keys and signed-in clients that reach this mailbox from outside."),
    F("Advanced", ADVANCED),
  ]);
}

function workflowsPrefs() {
  return page("Workflows", "Defaults for workflows the agent writes.",
    overview("New Workflows run on your Sync server, so they keep going while this computer is off. 0 connected tools.", ["Connect a tool"]), [
    G("Defaults", group("Defaults", [
      card({ key: "workflows.placement", title: "Where new Workflows run", help: "On your Sync server, so they run while this computer is off (needs an API key), or on this computer while monday is open.", ctrl: seg(["Server", "Local"], "Server"), dflt: "Server" }),
      card({ key: "workflows.ask_before_enable", title: "Try a Workflow before turning it on", help: "Show what a new Workflow would have done on recent mail, and ask before it is turned on.", ctrl: sw(true), dflt: "On" }),
      card({ key: "workflows.notify_on_failure", title: "Notify on failure", help: "Show a desktop notification when a Workflow run fails.", ctrl: sw(true), dflt: "On" }),
    ], { more: 3 })),
    F("Limits", "3 settings"),
    G("MCP servers", group("MCP servers", [])),
    F("Advanced", ADVANCED),
  ]);
}

function server() {
  return page("Sync server", "A small TypeScript service that receives provider webhooks and keeps a copy so new mail is ready the moment you open the app.",
    overview("monday cannot reach a server right now.", ["Check now", "Keep syncing while this computer is off", "Devices"]), [
    G("Server", group("Server", [panel({ id: "mode", title: "Talking to", help: "No server yet", ctrl: `${tag("Sidecar only")}${btn("Check now")}` })])),
    G("Storage", group("Storage", [
      panel({ id: "storage", title: "Stored mail", help: "Mail and attachments this server holds for every account.", ctrl: `<span class="stat">Not reachable</span>` }),
      panel({ id: "recovery", title: "Recovery file", help: "The key that unlocks every message on your server, kept in this device's keychain. Export a copy and keep it safe; without it a new install cannot read your mail.", ctrl: `<span class="key-row">${btn("Export")}${btn("Import")}</span>`, footer: `${tag("In the keychain", "ok")}<span class="sp"></span><span>Save this file somewhere safe. A new device pastes it to read this server's mail.</span>` }),
    ], { more: 4 })),
    G("Devices", group("Devices", [])),
    F("Connection", "1 setting"),
    F("Cloud", "Deploy a Cloud server, copy your mail into its database, then connect this device to it."),
    F("Advanced", ADVANCED),
  ]);
}

function shortcuts() {
  const k = (action, label, key) => `<div class="binding" data-action="${action}"><div class="l"><b>${label}</b></div><button class="chord-btn"><kbd class="kbd">${key}</kbd></button><span class="reset-slot"></span></div>`;
  const area = (name, n, open, rows = "") => `<div class="disclosure bindings-area ${open ? "open" : ""}"><button class="disclosure-toggle" aria-expanded="${open}">${caret()}<span class="disclosure-summary"><span class="g-name">${name}</span><span class="g-line">${n} keys</span></span></button>${rows}</div>`;
  const bindings = area("Navigate", 6, true, `<div class="bindings">${k("move.down", "Move down", "J")}${k("move.up", "Move up", "K")}${k("thread.open", "Open thread", "Enter")}${k("sheet.close", "Close", "Esc")}${k("palette.open", "Command palette", "Ctrl K")}${k("agent.focus", "Ask monday", "/")}</div>`)
    + area("Act", 7, false) + area("Compose", 4, false) + area("Select", 3, false) + area("Views", 9, false);
  return page("Shortcuts", "Vim-style by default. Every key can be remapped here or in the config file.",
    overview("Vim keys.", ["Change a key"]), [
    G("Keymap", group("Keymap", [
      card({ key: "keyboard.keymap", title: "Keymap", help: "The built-in set of keys: Vim, Gmail or Natural.", ctrl: seg(["Vim", "Gmail", "Natural"], "Vim"), dflt: "Vim" }),
      card({ key: "keyboard.bindings", title: "Keys", help: "Every action and its key. Click a key to change it; a clash is marked.", ctrl: bindings, block: true, dflt: "none" }),
    ])),
    F("After an action", "2 settings"),
    F("Advanced", ADVANCED),
  ]);
}

function about() {
  return page("About", "monday is free, open source and self-hostable. Desktop first, mobile later.", "", [
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
