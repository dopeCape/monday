// Shared UI components. Each returns an HTML string.
import { workspace, nav, groups, emails, suggestions, commands, agentThread, agentThreadShort, people } from "./data.js";

export const ic = (name, w = "") => `<i class="ph${w ? "-" + w : ""} ${name}"></i>`;

export function initials(name) {
  return name.split(/\s+/).map(s => s[0]).slice(0, 2).join("").toUpperCase();
}
export function avatar(p, cls = "") {
  return `<span class="avatar ${cls}" style="--c:${p.c}">${initials(p.name)}</span>`;
}

/* ------------------------------ NAV ------------------------------ */
export function navSidebar(route) {
  const item = (it, on, sub = false) => `
    <button class="nav-item ${on ? "on" : ""} ${sub ? "sub" : ""}" data-go="${it.href}">
      ${it.dot ? `<span class="dot" style="background:${it.dot}"></span>` : ic(it.icon)}
      <span>${it.label}</span>
      ${it.n ? `<span class="n ${it.hot ? "hot" : ""}">${it.n}</span>` : ""}
      ${it.running ? `<span class="smart" title="3 running">${ic("ph-circle-notch")}</span>` : ""}
      ${it.smart ? `<span class="smart" title="Routed by the agent">${ic("ph-sparkle", "fill")}</span>` : ""}
    </button>`;
  const main = nav.main.map(it => item({ ...it, href: `#/${it.key === "inbox" ? "inbox" : "inbox/" + it.key}` }, route.folder === it.key)).join("");
  const smart = nav.smart.map(g => {
    const on = route.folder === g.key;
    return item({ ...g, href: `#/inbox/${g.key}` }, on) +
      (g.children ? g.children.map(c => item({ ...c, dot: g.color, href: `#/inbox/${c.key}` }, route.folder === c.key, true)).join("") : "");
  }).join("");
  const auto = nav.automation.map(it => item({ ...it, href: `#/${it.key}` }, route.screen === it.key)).join("");
  return `
  <aside class="nav">
    <button class="ws">
      <span class="avatar sq" style="--c:var(--fg)">${workspace.initials}</span>
      <span>${workspace.name}<span class="sub">${workspace.email}</span></span>
      ${ic("ph-caret-up-down")}
    </button>
    <button class="nav-search" data-act="cmdk">${ic("ph-magnifying-glass")} Search or command <span class="kbd">⌘K</span></button>
    <button class="nav-compose" data-act="compose">${ic("ph-pencil-simple-line")} New message <span class="kbd" style="background:transparent;border-color:transparent;color:inherit;opacity:.6">C</span></button>
    ${main}
    <div class="nav-sec">Smart inboxes <button title="Ask the agent to add a group">${ic("ph-plus")}</button></div>
    ${smart}
    <div class="nav-sec">Automation</div>
    ${auto}
    <div class="nav-foot">
      <div class="sync"><span class="live"></span> Server synced 12s ago <span class="sp"></span><span class="mono">1,204</span></div>
      <button class="nav-item ${route.screen === "settings" ? "on" : ""}" data-go="#/settings/appearance">${ic("ph-gear-six")} <span>Settings</span><span class="n">⌘,</span></button>
    </div>
  </aside>`;
}

export function rail(route) {
  const b = (icon, href, on, title, badge) => `<button class="${on ? "on" : ""}" data-go="${href}" title="${title}">${ic(icon)}${badge ? '<span class="badge"></span>' : ""}</button>`;
  return `
  <nav class="rail">
    <span class="avatar sq" style="--c:var(--fg)">${workspace.initials}</span>
    ${b("ph-magnifying-glass", "#cmdk", false, "Search ⌘K")}
    ${b("ph-pencil-simple-line", "#compose", false, "New message")}
    ${b("ph-tray", "#/inbox", route.screen === "inbox" && !route.folder, "Inbox", true)}
    ${b("ph-users-three", "#/inbox/hiring", route.folder === "hiring", "Hiring")}
    ${b("ph-receipt", "#/inbox/finance", route.folder === "finance", "Finance")}
    ${b("ph-handshake", "#/inbox/investors", route.folder === "investors", "Investors")}
    ${b("ph-github-logo", "#/inbox/community", route.folder === "community", "Community")}
    <span class="sp"></span>
    ${b("ph-flow-arrow", "#/workflows", route.screen === "workflows", "Workflows")}
    ${b("ph-git-branch", "#/routing", route.screen === "routing", "Routing")}
    ${b("ph-gear-six", "#/settings/appearance", route.screen === "settings", "Settings")}
  </nav>`;
}

/* ------------------------------ LIST ------------------------------ */
export function messageList(route, ui) {
  const title = ({ inbox: "Inbox", hiring: "Hiring", candidates: "Candidates", interviews: "Interviews", finance: "Finance", invoices: "Invoices", receipts: "Receipts", investors: "Investors", community: "Community", press: "Press", starred: "Starred", snoozed: "Snoozed", drafts: "Drafts", sent: "Sent", archive: "Archive" })[route.folder || "inbox"] || "Inbox";
  const row = e => `
    <div class="row ${e.unread ? "unread" : ""} ${ui.selected === e.id ? "on" : ""}" data-open="${e.id}">
      ${avatar(e.from)}
      <div class="from"><span>${e.from.name}</span>${e.count > 1 ? `<span class="cnt">${e.count}</span>` : ""}</div>
      <div class="time">${e.time}</div>
      <div class="subj" data-snip=" ${e.snippet}">${e.subject}</div>
      <div class="snip">${e.snippet}</div>
      <div class="meta">
        ${e.tags.map(t => `<span class="tag ${t.k}">${t.t}</span>`).join("")}
        ${e.att ? `<span class="ic">${ic("ph-paperclip")}</span>` : ""}
      </div>
      <div class="actions">
        <button class="btn sm icon" title="Archive (E)">${ic("ph-archive")}</button>
        <button class="btn sm icon" title="Snooze (H)">${ic("ph-clock")}</button>
        <button class="btn sm icon" title="Ask the agent">${ic("ph-sparkle")}</button>
      </div>
    </div>`;
  const grouped = groups.map(g => {
    const items = emails.filter(e => e.group === g.key);
    if (!items.length) return "";
    return `
      <div class="list-group">${ic(g.icon)} ${g.label} <span class="n">${items.length}</span>${g.ai ? `<span class="ai">${ic("ph-sparkle", "fill")} ${g.ai}</span>` : ""}</div>
      <div class="stream-block">${items.map(row).join("")}</div>`;
  }).join("");
  return `
  <section class="col list">
    <div class="col-head">
      <h2>${title} <span class="count">14</span></h2>
      <span class="sp"></span>
      <button class="btn icon" title="Mark all read">${ic("ph-checks")}</button>
      <button class="btn icon" title="Sort and view">${ic("ph-sliders-horizontal")}</button>
    </div>
    <div class="list-filters">
      <button class="chip on">All</button>
      <button class="chip">Unread <span class="faint">4</span></button>
      <button class="chip">${ic("ph-arrow-bend-up-left")} Needs reply</button>
      <button class="chip">${ic("ph-paperclip")} Files</button>
      <button class="chip">${ic("ph-sparkle")} Ask</button>
    </div>
    <div class="col-body">${grouped}</div>
  </section>`;
}

/* ------------------------------ READER ------------------------------ */
export function reader(e, opts = {}) {
  if (!e) return `<section class="col reader"><div class="empty" style="margin:auto"><div class="ico">${ic("ph-envelope-open")}</div><h3>Nothing selected</h3><p>Pick a conversation, or press <span class="kbd">J</span> / <span class="kbd">K</span> to move.</p></div></section>`;
  const msg = m => m.collapsed ? `
    <div class="msg collapsed" data-act="expand">
      <div class="msg-head">${avatar(m.who)}<div class="who"><b>${m.who.name}</b><span class="prev">${m.prev}</span></div><span class="when">${m.when}</span></div>
    </div>` : `
    <div class="msg">
      <div class="msg-head">
        ${avatar(m.who)}
        <div class="who"><b>${m.who.name}</b><span>${m.who.email} · to ${e.to.map(t => t.name.split(" ")[0]).join(", ")}</span></div>
        <span class="when">${m.when}</span>
        <button class="btn sm icon" title="Reply">${ic("ph-arrow-bend-up-left")}</button>
        <button class="btn sm icon" title="More">${ic("ph-dots-three")}</button>
      </div>
      <div class="msg-body">${m.body.map(pp => `<p>${pp}</p>`).join("")}</div>
      ${m.atts ? `<div class="attachments">${m.atts.map(a => `<button class="att"><span class="ft">${ic(a.ic)}</span><span><b>${a.name}</b><span>${a.size}</span></span></button>`).join("")}</div>` : ""}
    </div>`;
  return `
  <section class="col reader ${opts.sheet ? "sheet" : ""}">
    <div class="col-head">
      ${opts.sheet ? `<button class="btn icon" data-act="close-reader" title="Close (Esc)">${ic("ph-x")}</button>` : ""}
      <button class="btn icon" title="Archive (E)">${ic("ph-archive")}</button>
      <button class="btn icon" title="Snooze (H)">${ic("ph-clock")}</button>
      <button class="btn icon" title="Label (L)">${ic("ph-tag")}</button>
      <button class="btn icon" title="Move">${ic("ph-folder-simple")}</button>
      <button class="btn icon danger" title="Delete (#)">${ic("ph-trash")}</button>
      <span class="sp"></span>
      <button class="btn soft sm" data-act="agent-open">${ic("ph-sparkle", "fill")} Ask about this thread</button>
      <button class="btn icon" title="Previous (K)">${ic("ph-caret-up")}</button>
      <button class="btn icon" title="Next (J)">${ic("ph-caret-down")}</button>
    </div>
    <div class="reader-body">
      <div class="reader-inner">
        <h1>${e.subject}</h1>
        <div class="subline">
          ${e.tags.map(t => `<span class="tag ${t.k}">${t.t}</span>`).join("")}
          <span>${e.count} message${e.count > 1 ? "s" : ""}</span>
          <span>·</span><span>${e.from.name}, you${e.to.length > 1 ? ", " + e.to[1].name.split(" ")[0] : ""}</span>
        </div>
        <div class="brief">
          <div class="brief-head">${ic("ph-sparkle", "fill")} Brief <span class="src">${ic("ph-terminal-window")} Claude Code, local</span></div>
          <ul>${e.brief.map(b => `<li>${b}</li>`).join("")}</ul>
          <div class="brief-actions">${e.actions.map(a => `<button class="chip">${ic("ph-lightning")} ${a}</button>`).join("")}</div>
        </div>
        ${e.thread.map(msg).join("")}
        <div class="reply">
          <div class="reply-top">${ic("ph-arrow-bend-up-left")} Reply to ${e.from.name} <span class="sp"></span><button class="btn sm">${ic("ph-arrow-bend-double-up-left")} Reply all</button><button class="btn sm">${ic("ph-arrow-bend-up-right")} Forward</button></div>
          ${e.drafts.length ? `<div class="reply-drafts">${e.drafts.map(d => `<button class="chip">${ic("ph-sparkle")} ${d}</button>`).join("")}</div>` : ""}
          <textarea placeholder="Write, or pick a draft above. Type / for the agent."></textarea>
          <div class="reply-bottom">
            <button class="btn primary sm">Send <span class="kbd" style="background:transparent;border-color:transparent;color:inherit;opacity:.7">⌘↵</span></button>
            <button class="btn sm">${ic("ph-clock")} Send later</button>
            <span class="sp"></span>
            <button class="btn sm icon" title="Attach">${ic("ph-paperclip")}</button>
            <button class="btn sm icon" title="Adjust tone">${ic("ph-text-aa")}</button>
            <button class="btn sm icon" title="Shorten">${ic("ph-arrows-in-line-vertical")}</button>
            <button class="btn sm icon" title="Translate">${ic("ph-translate")}</button>
          </div>
        </div>
      </div>
    </div>
  </section>`;
}

/* ------------------------------ AGENT ------------------------------ */
export function toolCard(t) {
  return `
  <div class="tool ${t.st === "wait" ? "wait" : ""}">
    <span class="ic">${ic(t.i)}</span>
    <span class="t">${t.t}</span>
    <span class="st ${t.st}">${t.st === "ok" ? ic("ph-check") : t.st === "run" ? ic("ph-circle-notch") : ic("ph-hand-palm")} ${t.stt}</span>
    <span class="d">${t.d}</span>
    ${t.preview ? `<div class="preview">${t.preview}</div>` : ""}
    ${t.acts ? `<div class="acts">${t.acts.map((a, i) => `<button class="btn sm ${i === 0 ? "primary" : i === 1 ? "outline" : ""}">${a}</button>`).join("")}</div>` : ""}
  </div>`;
}

export function threadHtml(thread) {
  return thread.map(m => {
    if (m.u) return `<div class="u">${m.u}</div>`;
    return `<div class="a"><div class="who">${ic("ph-sparkle", "fill")} monday</div>${m.a.map(part => {
      if (part.p) return `<p>${part.p}</p>`;
      if (part.tool) return toolCard(part.tool);
      if (part.results) return `<div class="results">${part.results.map(r => `<div class="r">${ic("ph-envelope-simple")}<b>${r.b}</b><span>${r.s}</span><span class="t">${r.t}</span></div>`).join("")}</div>`;
      return "";
    }).join("")}</div>`;
  }).join("");
}

export function modelChip() {
  return `<button class="model" title="Runs through Claude Code on this machine. Switch in Settings › AI.">${ic("ph-terminal-window")} Claude Code</button>`;
}

export function agentBar(placeholder = "Ask monday, or tell it what to do") {
  return `
  <div class="agent-bar">
    <span class="spark">${ic("ph-sparkle", "fill")}</span>
    <input data-act="agent-focus" placeholder="${placeholder}" />
    ${modelChip()}
    <button class="btn icon" title="Voice">${ic("ph-microphone")}</button>
    <button class="send" title="Send">${ic("ph-arrow-up", "bold")}</button>
  </div>`;
}

export function agentDock(ui) {
  const open = ui.agentOpen;
  return `
  <div class="agent-dock">
    ${open ? `
    <div class="agent-panel">
      <div class="col-head">
        <h2>${ic("ph-sparkle", "fill")} Agent <span class="count">workspace: ${workspace.email}</span></h2>
        <span class="sp"></span>
        <button class="btn sm">${ic("ph-clock-counter-clockwise")} History</button>
        <button class="btn icon" data-act="agent-close" title="Collapse (Esc)">${ic("ph-caret-down")}</button>
      </div>
      <div class="agent-thread">${threadHtml(agentThread)}</div>
    </div>` : `
    <div class="agent-suggest">${suggestions.map(s => `<button class="chip" data-act="agent-open">${ic(s.i)} ${s.t}</button>`).join("")}</div>`}
    ${agentBar(open ? "Reply, or ask something else" : "Ask monday, or tell it what to do")}
  </div>`;
}

export function agentColumn() {
  return `
  <section class="agent-col">
    <div class="col-head">
      <h2>${ic("ph-sparkle", "fill")} Agent</h2>
      <span class="sp"></span>
      <button class="btn sm icon" title="New conversation">${ic("ph-plus")}</button>
      <button class="btn sm icon" title="History">${ic("ph-clock-counter-clockwise")}</button>
    </div>
    <div class="agent-thread">
      ${threadHtml(agentThreadShort)}
      ${threadHtml(agentThread)}
    </div>
    <div class="agent-suggest">${suggestions.slice(0, 2).map(s => `<button class="chip">${ic(s.i)} ${s.t}</button>`).join("")}</div>
    ${agentBar("Reply, or ask something else")}
  </section>`;
}

/* ------------------------------ OVERLAYS ------------------------------ */
export function cmdk() {
  return `
  <div class="scrim" data-act="close-overlay">
    <div class="cmdk" data-stop>
      <div class="cmdk-in">${ic("ph-magnifying-glass")}<input autofocus placeholder="Search mail, jump anywhere, or ask the agent…" /><span class="kbd">esc</span></div>
      ${commands.map((s, si) => `<div class="cmdk-sec">${s.sec}</div>${s.items.map((it, i) => `
        <div class="cmdk-item ${it.ai ? "ai" : ""} ${si === 0 && i === 0 ? "on" : ""}">${ic(it.i, it.ai ? "fill" : "")}<span>${it.t}</span>${it.k ? `<span class="kbd">${it.k}</span>` : it.ai ? `<span class="hint">↵ to run</span>` : ""}</div>`).join("")}`).join("")}
      <div class="cmdk-foot"><span><span class="kbd">↑↓</span> move</span><span><span class="kbd">↵</span> select</span><span><span class="kbd">tab</span> ask agent instead</span></div>
    </div>
  </div>`;
}

export function compose() {
  return `
  <div class="scrim" data-act="close-overlay">
    <div class="compose" data-stop>
      <div class="col-head"><h2>New message</h2><span class="sp"></span><span class="faint" style="font-size:var(--fs-xs)">Draft saved</span><button class="btn icon" title="Pop out">${ic("ph-arrow-square-out")}</button><button class="btn icon" data-act="close-overlay" title="Close">${ic("ph-x")}</button></div>
      <div class="c-field"><label>From</label><span>${workspace.email}</span><span class="cc">${ic("ph-caret-down")}</span></div>
      <div class="c-field"><label>To</label><span class="pill">${avatar(people.kenji)} Kenji Watanabe</span><input placeholder="" /><span class="cc"><span>Cc</span><span>Bcc</span></span></div>
      <div class="c-field"><label>Subject</label><input value="Re: Term sheet redline, v3" /></div>
      <div class="c-body">
        <p>Kenji,</p>
        <p>Thanks for turning v3 around quickly. The 1x pro-rata cap is fine with us.</p>
        <p><span class="ghost">On the observer seat, we would prefer to keep the full board seat as discussed on the call, but are open to revisiting it at the Series A. Happy to jump on a short call before Friday if that helps close.<span class="kbd">tab to accept</span></span></p>
      </div>
      <div class="c-ai">${ic("ph-sparkle", "fill")}<div><b>Ravi has not replied to Kenji yet.</b> Want me to cc him and add a line saying he will confirm the board point?<div class="acts"><button class="btn sm primary">Yes, cc Ravi</button><button class="btn sm">No</button></div></div></div>
      <div class="c-foot">
        <button class="btn primary">Send <span class="kbd" style="background:transparent;border-color:transparent;color:inherit;opacity:.7">⌘↵</span></button>
        <button class="btn">${ic("ph-clock")} Send later</button>
        <span class="sp"></span>
        <button class="btn icon" title="Attach">${ic("ph-paperclip")}</button>
        <button class="btn icon" title="Formatting">${ic("ph-text-aa")}</button>
        <div class="ai-tools">
          <button class="btn sm">${ic("ph-sparkle")} Draft from bullets</button>
          <button class="btn sm">${ic("ph-sliders")} Tone</button>
          <button class="btn sm">${ic("ph-arrows-in-line-vertical")} Shorter</button>
          <button class="btn sm">${ic("ph-translate")}</button>
        </div>
      </div>
    </div>
  </div>`;
}
