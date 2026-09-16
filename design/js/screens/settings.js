import { palettes, toml, workspace } from "../data.js";
import { ic } from "../components.js";
import { state, resolvedTheme } from "../theme.js";

const sections = [
  { key: "accounts", label: "Accounts", icon: "ph-at" },
  { key: "appearance", label: "Appearance", icon: "ph-palette" },
  { key: "ai", label: "AI and agent", icon: "ph-cpu" },
  { key: "workflows", label: "Workflows", icon: "ph-flow-arrow" },
  { key: "server", label: "Sync server", icon: "ph-cloud" },
  { key: "shortcuts", label: "Shortcuts", icon: "ph-keyboard" },
  { key: "about", label: "About", icon: "ph-info" },
];

function field(b, s, ctrl) {
  return `<div class="field"><div class="l"><b>${b}</b><span>${s}</span></div>${ctrl}</div>`;
}
const sel = (v) => `<button class="select">${v} ${ic("ph-caret-down")}</button>`;
const sw = (on) => `<span class="switch ${on ? "on" : ""}"></span>`;

function appearance() {
  const t = resolvedTheme();
  const swatch = p => {
    const c = p[t];
    return `<button class="sw ${state.palette === p.key ? "on" : ""}" data-palette="${p.key}" style="--s-bg:${c.bg};--s-panel:${c.panel};--s-fg:${c.fg};--s-accent:${c.accent};--s-border:${c.border}">
      <div class="pv"><div></div><div><span class="ac"></span><span class="ln"></span><span class="ln s"></span></div></div>
      <div class="lb">${p.label}<span>${p.by}</span></div></button>`;
  };
  return `
    <h1>Appearance</h1><p>Every option here is also a line in your config file, and the agent can change any of it when you ask.</p>
    <div class="sect">
      <h3>Theme</h3>
      ${field("Mode", "Follows the system by default", `<div class="seg"><button class="${state.theme === "system" ? "on" : ""}" data-theme="system">${ic("ph-monitor")} System</button><button class="${state.theme === "light" ? "on" : ""}" data-theme="light">${ic("ph-sun")} Light</button><button class="${state.theme === "dark" ? "on" : ""}" data-theme="dark">${ic("ph-moon")} Dark</button></div>`)}
    </div>
    <div class="sect">
      <h3>Palette</h3><p>Shipped palettes below, or point the config at your own. Each has a light and a dark half.</p>
      <div class="swatches">${palettes.map(swatch).join("")}
        <button class="sw" style="--s-bg:var(--sunken);--s-panel:var(--panel);--s-fg:var(--fg-faint);--s-accent:var(--fg-faint);--s-border:var(--border)"><div class="pv" style="place-items:center;display:grid;color:var(--fg-faint);font-size:22px">${ic("ph-plus")}</div><div class="lb">Custom<span>from file</span></div></button>
      </div>
    </div>
    <div class="sect">
      <h3>Layout</h3><p>Everything here is a value in the config file. Presets are named combinations, and the agent can set any of it when you ask.</p>
      ${field("Layout preset", "A named combination of the knobs below", `<div class="seg"><button class="${state.layout === "stream" ? "on" : ""}" data-layout="stream">Stream</button><button class="${state.layout === "columns" ? "on" : ""}" data-layout="columns">Columns</button><button class="${state.layout === "agent-left" ? "on" : ""}" data-layout="agent-left">Agent left</button>${state.layout === "custom" ? `<button class="on">Custom</button>` : ""}</div>`)}
      ${field("Navigation", "Full sidebar, icon rail, or none (⌘K still works)", `<div class="seg"><button class="${state.nav === "full" ? "on" : ""}" data-nav="full">Full</button><button class="${state.nav === "rail" ? "on" : ""}" data-nav="rail">Rail</button><button class="${state.nav === "hidden" ? "on" : ""}" data-nav="hidden">Hidden</button></div>`)}
      ${field("Agent", "Where the composer lives", `<div class="seg"><button class="${state.agent === "bottom" ? "on" : ""}" data-agent="bottom">Bottom bar</button><button class="${state.agent === "left" ? "on" : ""}" data-agent="left">Left column</button><button class="${state.agent === "right" ? "on" : ""}" data-agent="right">Right column</button></div>`)}
      ${field("List", "One sectioned stream, or list beside reader", `<div class="seg"><button class="${state.list === "stream" ? "on" : ""}" data-list="stream">Stream</button><button class="${state.list === "split" ? "on" : ""}" data-list="split">Split</button></div>`)}
      ${field("Density", "Text, icons and rows scale together", `<div class="seg"><button class="${state.density === "compact" ? "on" : ""}" data-density="compact">Compact</button><button class="${state.density === "comfortable" ? "on" : ""}" data-density="comfortable">Comfortable</button><button class="${state.density === "spacious" ? "on" : ""}" data-density="spacious">Spacious</button></div>`)}
    </div>
    <div class="sect">
      <h3>Views</h3><p>Saved layouts you can switch between. Ask the agent for one and it names it, sets a shortcut, and writes it to the file.</p>
      <div class="views">
        <div class="v"><div><b>Default</b><span>stream · full nav · agent bottom</span></div><span class="tag">${state.layout === "stream" ? "current" : ""}</span><span class="kbd">⌘1</span></div>
        <div class="v"><div><b>Triage</b><span>stream · nav hidden · agent bottom · one-line rows</span></div><span class="tag">by monday</span><span class="kbd">⌘2</span></div>
        <div class="v"><div><b>Focus</b><span>stream · nav hidden · agent right · invoices get a forward button</span></div><span class="tag">by monday</span><span class="kbd">⌘3</span></div>
      </div>
    </div>
    <div class="sect">
      <h3>Type</h3>
      ${field("Font", "Interface font", sel("Geist Variable"))}
      ${field("Font size", "Base size for the interface", sel("13"))}
      ${field("Monospace", "Used for shortcuts, code and the config file", sel("Geist Mono"))}
    </div>
    <div class="sect">
      <h3>Config file</h3><p>On Linux this is the source of truth. Edit it by hand, generate it from your rice, or let the agent write it.</p>
      <div class="code-head"><span class="live"></span> watching <span style="color:var(--fg)">~/.config/monday/monday.toml</span> <span class="sp"></span> reloaded 2 min ago</div>
      <div class="code">${toml}</div>
    </div>`;
}

function ai() {
  return `
    <h1>AI and agent</h1><p>Two ways to run the agent, tagging and workflows. Pick one, or use both and choose per workflow.</p>
    <div class="sect">
      <div class="mode">
        <button class="on">${ic("ph-terminal-window")}<b>Local CLI</b><span>Uses Claude Code, Codex or OpenCode already installed on this machine. Nothing leaves your laptop except what the CLI sends.</span></button>
        <button>${ic("ph-key")}<b>API key</b><span>Talks to a provider directly. Lets the sync server run workflows and tagging while this device is off.</span></button>
      </div>
      <h3>Local CLI</h3><p>Detected on this machine. The agent talks to them over their local protocol, no extra setup.</p>
      <div class="providers">
        <div class="prov on"><span class="lg">CC</span><div><b>Claude Code</b><span>2.1.4 · ~/.local/bin/claude</span></div><span class="st ok">Connected</span></div>
        <div class="prov"><span class="lg">CX</span><div><b>Codex</b><span>0.42 · /usr/local/bin/codex</span></div><span class="st ok">Available</span></div>
        <div class="prov"><span class="lg">OC</span><div><b>OpenCode</b><span>Not found in PATH</span></div><span class="st">Install</span></div>
      </div>
    </div>
    <div class="sect">
      <h3>API key</h3><p>Keys are stored in the system keychain. The server receives a scoped token, never the key itself.</p>
      <div class="providers">
        <div class="prov"><span class="lg">A</span><div><b>Anthropic</b><span>claude-fable-5-1</span></div><span class="st ok">Key set</span></div>
        <div class="prov"><span class="lg">G</span><div><b>Gemini</b><span>gemini-2.5-pro</span></div><span class="st">Add key</span></div>
        <div class="prov"><span class="lg">O</span><div><b>OpenAI</b><span>gpt-5</span></div><span class="st">Add key</span></div>
        <div class="prov"><span class="lg">K</span><div><b>Kimi</b><span>kimi-k2</span></div><span class="st">Add key</span></div>
        <div class="prov"><span class="lg">OR</span><div><b>OpenRouter</b><span>any model</span></div><span class="st">Add key</span></div>
      </div>
    </div>
    <div class="sect">
      <h3>What runs where</h3>
      <div class="matrix">
        <div class="mr h"><div>Capability</div><div>Local CLI</div><div>API key</div></div>
        <div class="mr"><div>Agent composer</div><div>${ic("ph-check-circle", "fill")} <span class="y">while app is open</span></div><div>${ic("ph-check-circle", "fill")} <span class="y">always</span></div></div>
        <div class="mr"><div>Smart routing and tags</div><div>${ic("ph-clock", "fill")} <span class="p">catches up on launch</span></div><div>${ic("ph-check-circle", "fill")} <span class="y">on the server, instantly</span></div></div>
        <div class="mr"><div>Workflows</div><div>${ic("ph-clock", "fill")} <span class="p">catches up on launch</span></div><div>${ic("ph-check-circle", "fill")} <span class="y">on the server, device off</span></div></div>
        <div class="mr"><div>Brief on every thread</div><div>${ic("ph-check-circle", "fill")} <span class="y">on open</span></div><div>${ic("ph-check-circle", "fill")} <span class="y">pre-computed</span></div></div>
        <div class="mr"><div>Cost</div><div>${ic("ph-check-circle", "fill")} <span class="y">your CLI subscription</span></div><div>${ic("ph-minus-circle", "fill")} <span class="n">per token</span></div></div>
      </div>
    </div>
    <div class="sect">
      <h3>Permissions</h3>
      ${field("Ask before sending", "The agent shows a preview and waits for you", sw(true))}
      ${field("Ask before deleting", "Also covers emptying trash and unsubscribing", sw(true))}
      ${field("Change settings without asking", "Theme, font, layout and similar", sw(true))}
      ${field("Read attachments", "Lets the agent open PDFs and images in threads", sw(true))}
    </div>`;
}

function accounts() {
  return `
    <h1>Accounts</h1><p>Each account is its own workspace. The agent only sees the one you are in.</p>
    <div class="sect">
      ${workspace.accounts.map((a, i) => field(a, i === 0 ? "Google · push via Pub/Sub · synced 12s ago" : i === 1 ? "HEY · IMAP polling every 60s" : "Fastmail · JMAP push", `<span class="tag ok">Connected</span><button class="btn sm icon">${ic("ph-dots-three")}</button>`)).join("")}
      <div style="margin-top:12px"><button class="btn outline">${ic("ph-plus")} Add account</button></div>
    </div>
    <div class="sect">
      <h3>Signature</h3>
      ${field("Default", "Tejas · GenAI Labs", `<button class="btn sm">Edit</button>`)}
      ${field("Let the agent match my voice", "Learns tone from sent mail for drafts", sw(true))}
    </div>`;
}

function server() {
  return `
    <h1>Sync server</h1><p>A small TypeScript service that receives provider webhooks and keeps a copy so new mail is ready the moment you open the app.</p>
    <div class="sect">
      ${field("Endpoint", "sync.genai-labs.io", `<span class="tag ok">${ic("ph-check")} Healthy · 41 ms</span>`)}
      ${field("Storage", "12,418 messages · 1.9 GB", `<button class="btn sm">Manage</button>`)}
      ${field("Webhooks", "Gmail Pub/Sub, JMAP push, IMAP IDLE fallback", `<span class="tag ok">3 active</span>`)}
      ${field("Run workflows when devices are offline", "Needs an API key provider", sw(true))}
      ${field("Pre-compute briefs and tags", "Runs on arrival so the client just renders", sw(true))}
    </div>
    <div class="sect">
      <h3>Self-host</h3><p>One container, one Postgres. Point the client at it and you are done.</p>
      <div class="code"><span class="c"># docker compose up -d</span>
<span class="k">services:</span>
  <span class="k">monday-sync:</span>
    <span class="k">image:</span> <span class="s">ghcr.io/monday-email/sync:latest</span>
    <span class="k">environment:</span>
      <span class="k">DATABASE_URL:</span> <span class="s">postgres://monday@db/monday</span>
      <span class="k">PUBLIC_URL:</span> <span class="s">https://sync.genai-labs.io</span></div>
    </div>`;
}

function shortcuts() {
  const k = (a, b) => field(a, "", `<span class="kbd">${b}</span>`);
  return `<h1>Shortcuts</h1><p>Vim-style by default. Every key can be remapped in the config file.</p>
    <div class="sect"><h3>Navigate</h3>${k("Next / previous conversation", "J / K")}${k("Open", "↵")}${k("Back to list", "esc")}${k("Go to inbox", "G I")}${k("Command palette", "⌘ K")}</div>
    <div class="sect"><h3>Act</h3>${k("Archive", "E")}${k("Snooze", "H")}${k("Reply", "R")}${k("Forward", "F")}${k("Talk to the agent", "/")}${k("New message", "C")}</div>`;
}

function about() {
  return `<h1>About</h1><p>monday is free, open source and self-hostable. Desktop first, mobile later.</p>
    <div class="sect">${field("Version", "0.1.0 · Tauri 2 · Linux x86_64", `<button class="btn sm">Check for updates</button>`)}${field("License", "AGPL-3.0", `<button class="btn sm">${ic("ph-github-logo")} Source</button>`)}${field("Telemetry", "Off. There is no switch to turn it on.", "")}</div>`;
}

function workflowsPrefs() {
  return `<h1>Workflows</h1><p>Defaults for workflows the agent writes.</p>
    <div class="sect">${field("Run new workflows on", "Where the agent puts them unless you say otherwise", sel("Server when possible"))}${field("Ask before enabling", "Show the steps and wait for a yes", sw(true))}${field("Notify on failure", "Desktop notification plus a note in the agent", sw(true))}${field("Keep run history", "", sel("30 days"))}</div>`;
}

export function render(route) {
  const cur = sections.find(s => s.key === route.id) || sections[1];
  const body = { accounts, appearance, ai, workflows: workflowsPrefs, server, shortcuts, about }[cur.key]();
  return `
  <div class="main page">
    <div class="settings">
      <nav class="settings-nav">
        <h4>Settings</h4>
        ${sections.map(s => `<button class="nav-item ${s.key === cur.key ? "on" : ""}" data-go="#/settings/${s.key}">${ic(s.icon)} <span>${s.label}</span></button>`).join("")}
      </nav>
      <div class="settings-body"><div class="settings-in">${body}</div></div>
    </div>
  </div>`;
}
