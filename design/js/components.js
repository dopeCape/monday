// Shared UI components. Each returns an HTML string.
// Calm rules: one surface per pane, no cards inside cards, no icons in list rows,
// color only for state, secondary actions appear on hover or focus.
import { workspace, nav, groups, emails, suggestions, commands, agentThread, agentThreadShort, agentThreadLayout } from "./data.js";
import { state } from "./theme.js";

export const ic = (name, w = "") => `<i class="ph${w ? "-" + w : ""} ${name}"></i>`;
export const mark = (cls = "") => `<span class="mk ${cls}" aria-hidden="true">m</span>`;

export function initials(name) {
  return name.split(/\s+/).map(s => s[0]).slice(0, 2).join("").toUpperCase();
}
export function avatar(p, cls = "") {
  return `<span class="avatar ${cls}" style="--c:${p.c}">${initials(p.name)}</span>`;
}

/* ------------------------------ NAV ------------------------------ */
/* The workspace switcher: every connected Account, the current one checked, then Add and Settings. */
export function wsMenu() {
  const marks = ["ph-google-logo", "FM", "ph-envelope-simple"];
  const states = ["Connected", "Synced Today 09:58", "Not synced yet"];
  const accounts = workspace.accounts.map((a, i) => {
    const m = marks[i] ?? "@";
    const mark = m.startsWith("ph-") ? ic(m) : m;
    return `<button class="pop-item ws-acct ${i === 0 ? "current" : ""}" role="menuitemradio" aria-checked="${i === 0}">
      <span class="lg">${mark}</span>
      <span class="ws-acct-text"><span class="addr">${a}</span><span class="st">${states[i] ?? ""}</span></span>
      ${i === 0 ? ic("ph-check", "") : ""}
    </button>`;
  }).join("");
  return `<div class="pop ws-menu" role="menu" aria-label="Switch account">
    <div class="pop-h">Accounts</div>
    ${accounts}
    <hr class="pop-sep">
    <button class="pop-item" role="menuitem" data-go="#/settings/accounts">${ic("ph-plus")}<span>Add an account</span></button>
    <button class="pop-item" role="menuitem" data-go="#/settings/appearance">${ic("ph-gear-six")}<span>Settings</span></button>
  </div>`;
}

export function navSidebar(route, switcher = false) {
  const item = (it, on, sub = false) => `
    <button class="nav-item ${on ? "on" : ""} ${sub ? "sub" : ""}" data-go="${it.href}">
      ${it.icon ? ic(it.icon) : ""}<span>${it.label}</span>
      ${it.n ? `<span class="n">${it.n}</span>` : ""}
    </button>`;
  const main = nav.main.map(it => item({ ...it, href: `#/${it.key === "inbox" ? "inbox" : "inbox/" + it.key}` }, route.folder === it.key)).join("");
  const smart = nav.smart.map(g => item({ ...g, href: `#/inbox/${g.key}` }, route.folder === g.key) +
    (g.children ? g.children.map(c => item({ ...c, href: `#/inbox/${c.key}` }, route.folder === c.key, true)).join("") : "")).join("");
  const auto = nav.automation.map(it => item({ ...it, n: 0, href: `#/${it.key}` }, route.screen === it.key)).join("");
  // Sections the user placed in the nav (CONTEXT.md "Section rule"), under Groups.
  const sections = (nav.sections ?? []).map(sec => item({ ...sec, href: `#/inbox/section/${sec.key}` }, route.folder === `section:${sec.key}`)).join("");
  return `
  <aside class="nav">
    <button class="ws" title="Connected" data-act="ws" aria-haspopup="menu" aria-expanded="${switcher}">
      <span class="avatar sq" style="--c:var(--fg)">${workspace.initials}<span class="live"></span></span>
      <span class="ws-name">${workspace.name}</span>
      ${ic("ph-caret-up-down")}
    </button>
    ${switcher ? wsMenu() : ""}
    <button class="nav-item" data-act="cmdk">${ic("ph-magnifying-glass")}<span>Search</span><span class="kbd">⌘K</span></button>
    <button class="nav-item" data-act="compose">${ic("ph-pencil-simple-line")}<span>New message</span><span class="kbd">C</span></button>
    <div class="nav-sec">Mail</div>
    ${main}
    ${item({ ...nav.calendar[0], href: "#/calendar" }, route.screen === "calendar")}
    <div class="nav-sec">Groups</div>
    ${smart}
    ${sections ? `<div class="nav-sec">Sections</div>${sections}` : ""}
    <div class="nav-sec">Automation</div>
    ${auto}
    <div class="nav-foot">
      <button class="nav-item ${route.screen === "settings" ? "on" : ""}" data-go="#/settings/appearance">${ic("ph-gear-six")}<span>Settings</span></button>
    </div>
  </aside>`;
}

export function rail(route, switcher = false) {
  const b = (icon, href, on, title) => `<button class="${on ? "on" : ""}" data-go="${href}" title="${title}">${ic(icon)}</button>`;
  return `
  <nav class="rail">
    <button class="rail-ws" data-act="ws" title="${workspace.name}" aria-haspopup="menu" aria-expanded="${switcher}"><span class="avatar sq" style="--c:var(--fg)">${workspace.initials}</span></button>
    ${switcher ? wsMenu() : ""}
    ${b("ph-magnifying-glass", "#cmdk", false, "Search ⌘K")}
    ${b("ph-pencil-simple-line", "#compose", false, "New message")}
    <span class="gap"></span>
    ${b("ph-tray", "#/inbox", route.screen === "inbox" && !route.folder, "Inbox")}
    ${b("ph-star", "#/inbox/starred", route.folder === "starred", "Starred")}
    ${b("ph-clock", "#/inbox/snoozed", route.folder === "snoozed", "Snoozed")}
    ${b("ph-note-pencil", "#/inbox/drafts", route.folder === "drafts", "Drafts")}
    ${b("ph-paper-plane-tilt", "#/inbox/sent", route.folder === "sent", "Sent")}
    ${b("ph-archive", "#/inbox/archive", route.folder === "archive", "Archive")}
    ${b("ph-users-three", "#/inbox/hiring", route.folder === "hiring", "Hiring")}
    ${b("ph-receipt", "#/inbox/finance", route.folder === "finance", "Finance")}
    ${b("ph-handshake", "#/inbox/investors", route.folder === "investors", "Investors")}
    <span class="sp"></span>
    ${b("ph-calendar-blank", "#/calendar", route.screen === "calendar", "Calendar")}
    ${b("ph-flow-arrow", "#/workflows", route.screen === "workflows", "Workflows")}
    ${b("ph-git-branch", "#/routing", route.screen === "routing", "Routing")}
    ${b("ph-gear-six", "#/settings/appearance", route.screen === "settings", "Settings")}
  </nav>`;
}

/* ------------------------------ LIST ------------------------------ */
const titles = { inbox: "Inbox", hiring: "Hiring", candidates: "Candidates", interviews: "Interviews", rejected: "Rejected", finance: "Finance", invoices: "Invoices", receipts: "Receipts", investors: "Investors", community: "Community", press: "Press", starred: "Starred", snoozed: "Snoozed", drafts: "Drafts", sent: "Sent", archive: "Archive" };

export function messageList(route, ui) {
  const title = titles[route.folder || "inbox"] || "Inbox";
  // An open thread reads itself (the app's reader.mark_read_on_open), so the selected row drops its dot.
  const unread = e => e.unread && !(ui.readerOpen && ui.selected === e.id);
  const row = e => `
    <div class="row ${unread(e) ? "unread" : ""} ${ui.selected === e.id ? "on" : ""}" data-open="${e.id}">
      <span class="dot"></span>
      <span class="from">${e.from.name}${e.count > 1 ? ` <span class="cnt">${e.count}</span>` : ""}</span>
      <span class="subj"><b>${e.subject}</b><span class="snip">${e.snippet}</span></span>
      <span class="meta">${e.att ? ic("ph-paperclip") : ""}<span class="lbl">${e.tags[0].t}</span></span>
      <span class="time">${e.time}</span>
      <span class="actions">
        <button class="btn icon" title="Archive (E)">${ic("ph-archive")}</button>
        <button class="btn icon" title="Snooze (H)">${ic("ph-clock")}</button>
        <button class="btn icon" title="Ask about this">${mark("sm")}</button>
      </span>
    </div>`;
  const grouped = groups.map(g => {
    const items = emails.filter(e => e.group === g.key);
    return items.length ? `<div class="sec">${g.label}</div>${items.map(row).join("")}` : "";
  }).join("");
  const stream = state.list === "stream";
  return `
  <section class="col list">
    <div class="col-head">
      ${state.nav === "hidden" ? `<button class="btn icon" data-act="cmdk" title="Search ⌘K">${ic("ph-magnifying-glass")}</button><button class="btn icon" data-act="compose" title="New message (C)">${ic("ph-pencil-simple-line")}</button><span class="vr"></span>` : ""}
      <h2>${title}</h2><span class="count">14</span>
      <span class="sp"></span>
      ${stream ? `<button class="btn">${ic("ph-funnel-simple")} Filter</button>` : ""}
      <button class="btn icon" title="More">${ic(stream ? "ph-dots-three" : "ph-funnel-simple")}</button>
    </div>
    <div class="col-body">${grouped}</div>
  </section>`;
}

/* ------------------------------ READER ------------------------------ */
export function reader(e, opts = {}) {
  if (!e) return `<section class="col reader"><div class="empty"><h3>Nothing open</h3><p>Pick a conversation, or use <span class="kbd">J</span> and <span class="kbd">K</span>.</p></div></section>`;
  const msg = m => m.collapsed ? `
    <div class="msg collapsed" data-act="expand">
      <div class="msg-head"><b>${m.who.name}</b><span class="prev">${m.prev}</span><span class="when">${m.when}</span></div>
    </div>` : `
    <div class="msg">
      <div class="msg-head">
        ${avatar(m.who)}
        <div class="who"><b>${m.who.name}</b><span>to ${e.to.map(t => t.name.split(" ")[0]).join(", ")}</span></div>
        <span class="when">${m.when}</span>
      </div>
      <div class="msg-body">${m.body.map(pp => `<p>${pp}</p>`).join("")}</div>
      ${m.atts ? `<div class="attachments">${m.atts.map(a => `<button class="att">${ic(a.ic)}<span>${a.name}</span><span class="sz">${a.size}</span></button>`).join("")}</div>` : ""}
    </div>`;
  const invoice = e.tags.some(t => t.t === "Invoice");
  return `
  <section class="col reader ${opts.sheet ? "sheet" : ""}">
    <div class="col-head">
      ${opts.sheet ? `<button class="btn icon" data-act="close-reader" title="Close (Esc)">${ic("ph-x")}</button><span class="vr"></span>` : ""}
      <button class="btn icon" title="Archive (E)">${ic("ph-archive")}</button>
      <button class="btn icon" title="Snooze (H)">${ic("ph-clock")}</button>
      <button class="btn icon" title="Move">${ic("ph-folder-simple")}</button>
      <button class="btn icon" title="Delete (#)">${ic("ph-trash")}</button>
      <span class="sp"></span>
      ${invoice ? `<button class="btn">${ic("ph-arrow-bend-up-right")} Forward to accounting</button>` : ""}
      <button class="btn" data-act="agent-open">${mark("sm")} Ask</button>
      <button class="btn icon" title="More">${ic("ph-dots-three")}</button>
    </div>
    <div class="reader-body">
      <div class="reader-inner">
        <h1>${e.subject}</h1>
        <div class="subline">${e.from.name} · ${e.count} message${e.count > 1 ? "s" : ""} · ${e.tags.map(t => t.t).join(", ")}</div>
        <div class="brief">
          <div class="brief-h">Brief <span>Claude Code, on this machine</span></div>
          <ul>${e.brief.map(b => `<li>${b}</li>`).join("")}</ul>
          ${e.actions.length ? `<div class="brief-actions">${e.actions.slice(0, 3).map(a => `<button class="chip">${a}</button>`).join("")}</div>` : ""}
        </div>
        ${e.thread.map(msg).join("")}
        <div class="reply">
          <textarea placeholder="Reply to ${e.from.name.split(" ")[0]}…"></textarea>
          <div class="reply-bottom">
            <button class="btn primary">Send</button>
            ${e.drafts.length ? `<button class="btn">${mark("sm")} Draft a reply</button>` : ""}
            <span class="sp"></span>
            <button class="btn icon" title="Attach">${ic("ph-paperclip")}</button>
            <button class="btn icon" title="Reply all">${ic("ph-arrow-bend-double-up-left")}</button>
            <button class="btn icon" title="Forward">${ic("ph-arrow-bend-up-right")}</button>
          </div>
        </div>
      </div>
    </div>
  </section>`;
}

/* ------------------------------ AGENT ------------------------------ */
export function toolCard(t) {
  return `
  <div class="tool ${t.st}">
    <span class="t">${t.t}</span>
    <span class="st">${t.st === "ok" ? ic("ph-check") : t.st === "run" ? ic("ph-circle-notch") : ""} ${t.stt}</span>
    <span class="d">${t.d}</span>
    ${t.preview ? `<div class="preview">${t.preview}</div>` : ""}
    ${t.acts ? `<div class="acts">${t.acts.map((a, i) => `<button class="btn sm ${i === 0 ? "primary" : ""}" ${t.sets ? `data-set='${JSON.stringify(t.sets[i])}'` : ""}>${a}</button>`).join("")}</div>` : ""}
  </div>`;
}

export function threadHtml(thread) {
  return thread.map(m => {
    if (m.u) return `<div class="u">${m.u}</div>`;
    return `<div class="a">${m.a.map(part => {
      if (part.p) return `<p>${part.p}</p>`;
      if (part.tool) return toolCard(part.tool);
      if (part.results) return `<div class="results">${part.results.map(r => `<div class="r"><b>${r.b}</b><span>${r.s}</span><span class="t">${r.t}</span></div>`).join("")}</div>`;
      return "";
    }).join("")}</div>`;
  }).join("");
}

export function agentBar(placeholder = "Ask or tell monday") {
  return `
  <div class="agent-bar">
    ${mark()}
    <input data-act="agent-focus" placeholder="${placeholder}" />
    <span class="kbd">↵</span>
  </div>`;
}

export function agentDock(ui) {
  const open = ui.agentOpen;
  return `
  <div class="agent-dock">
    ${open ? `
    <div class="agent-panel">
      <div class="col-head">
        <h2>monday</h2><span class="count">Claude Code · ${workspace.email}</span>
        <span class="sp"></span>
        <button class="btn icon" title="History">${ic("ph-clock-counter-clockwise")}</button>
        <button class="btn icon" data-act="agent-close" title="Collapse (Esc)">${ic("ph-caret-down")}</button>
      </div>
      <div class="agent-thread">${threadHtml(ui.thread === "layout" ? agentThreadLayout : agentThread)}</div>
      <div class="agent-suggest">${suggestions.map(s => `<button class="chip" ${s.set ? `data-set='${JSON.stringify(s.set)}'` : ""}>${s.t}</button>`).join("")}</div>
    </div>` : ""}
    ${agentBar(open ? "Reply, or ask something else" : "Ask or tell monday")}
  </div>`;
}

export function agentColumn(side = "left") {
  return `
  <section class="agent-col ${side}">
    <div class="col-head">
      <h2>monday</h2><span class="count">Claude Code</span>
      <span class="sp"></span>
      <button class="btn icon" title="New conversation">${ic("ph-plus")}</button>
      <button class="btn icon" title="History">${ic("ph-clock-counter-clockwise")}</button>
    </div>
    <div class="agent-thread">
      ${threadHtml(agentThreadShort)}
      ${threadHtml(agentThreadLayout)}
      ${threadHtml(agentThread)}
    </div>
    ${agentBar("Reply, or ask something else")}
  </section>`;
}

/* ------------------------------ OVERLAYS ------------------------------ */
export function cmdk() {
  return `
  <div class="scrim" data-act="close-overlay">
    <div class="cmdk" data-stop>
      <div class="cmdk-in">${ic("ph-magnifying-glass")}<input autofocus placeholder="Search, jump, or ask" /><span class="kbd">esc</span></div>
      ${commands.map((s, si) => `<div class="cmdk-sec">${s.sec}</div>${s.items.map((it, i) => `
        <div class="cmdk-item ${si === 0 && i === 0 ? "on" : ""}">${it.ai ? mark("sm") : ic(it.i)}<span>${it.t}</span>${it.k ? `<span class="kbd">${it.k}</span>` : ""}</div>`).join("")}`).join("")}
      <div class="cmdk-foot"><span><span class="kbd">↑↓</span> move</span><span><span class="kbd">↵</span> select</span><span><span class="kbd">tab</span> ask instead</span></div>
    </div>
  </div>`;
}

export function compose() {
  return `
  <div class="scrim" data-act="close-overlay">
    <div class="compose" data-stop>
      <div class="col-head"><h2>New message</h2><span class="sp"></span><button class="btn icon" data-act="close-overlay" title="Close">${ic("ph-x")}</button></div>
      <div class="c-field"><label>To</label><span class="pill">Kenji Watanabe</span><input /><span class="cc"><span>Cc</span><span>Bcc</span></span></div>
      <div class="c-field"><label>Subject</label><input value="Re: Term sheet redline, v3" /></div>
      <div class="c-body">
        <p>Kenji,</p>
        <p>Thanks for turning v3 around quickly. The 1x pro-rata cap is fine with us.</p>
        <p><span class="ghost">On the observer seat, we would prefer to keep the full board seat as discussed on the call, but are open to revisiting it at the Series A. Happy to jump on a short call before Friday if that helps close. <span class="kbd">tab</span></span></p>
      </div>
      <div class="c-ai">${mark("sm")}<div>Ravi has not replied to Kenji yet. Cc him and mention he will confirm the board point? <button class="btn sm primary">Yes</button><button class="btn sm">No</button></div></div>
      <div class="c-foot">
        <button class="btn primary">Send</button>
        <button class="btn">${ic("ph-clock")} Later</button>
        <span class="sp"></span>
        <button class="btn icon" title="Attach">${ic("ph-paperclip")}</button>
        <button class="btn icon" title="Formatting">${ic("ph-text-aa")}</button>
        <button class="btn">${mark("sm")} Rewrite</button>
      </div>
    </div>
  </div>`;
}
