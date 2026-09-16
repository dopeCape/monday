import { routing } from "../data.js";
import { ic, mark, agentDock, initials } from "../components.js";
import { state } from "../theme.js";

export function render(route, ui) {
  const grp = g => `
    <div class="grp">
      <div class="grp-h">
        <span class="dot" style="background:${g.color}"></span>
        <b>${g.label}</b><span class="n">${g.n} unread</span>
        <span class="tag">${Math.round(g.conf * 100)}% confident</span>
        <div class="acts"><button class="btn sm">Change rule</button><button class="btn sm icon">${ic("ph-dots-three")}</button></div>
      </div>
      <div class="rule">${ic("ph-git-branch")}<div>${g.rule}</div></div>
      ${g.subs.length ? `<div class="sub-list">${g.subs.map(s => `
        <div class="subg">${ic(s.i)}<div>${s.label}<span class="d">${s.d}</span></div><div class="r">${s.n ? `<span class="tag">${s.n}</span>` : ""}<button class="btn sm icon">${ic("ph-caret-right")}</button></div></div>`).join("")}</div>` : ""}
    </div>`;

  return `
  <div class="main page">
    <div class="page-wrap">
      <div class="page-in">
        <div class="page-head">
          <div><h1>Routing</h1><p>Groups, sub-groups and inbox types. Each rule is plain language the agent wrote, and it learns from every message you move.</p></div>
          <div class="acts"><button class="btn outline">${ic("ph-arrows-clockwise")} Re-run on inbox</button><button class="btn primary">${ic("ph-plus")} New group</button></div>
        </div>
        <div class="two">
          <div class="tree">${routing.map(grp).join("")}</div>
          <aside>
            <div class="side-card">
              <h3>Ask for a group</h3>
              <div class="ask">${mark("sm")}<input placeholder="A Support inbox for anything from customers" /></div>
              <p class="faint" style="font-size:var(--fs-xs);margin:8px 0 0;line-height:1.5">The agent proposes a rule, shows which existing mail would move, and only applies it after you say yes.</p>
            </div>
            <div class="side-card">
              <h3>Needs a decision <span class="tag">2</span></h3>
              <div class="sample"><span class="avatar" style="--c:var(--fg-muted)">${initials("Ola Nordmann")}</span><span>Quick question about your open roles</span><div class="acts"><button class="btn sm">Hiring</button><button class="btn sm">Community</button></div></div>
              <div class="sample"><span class="avatar" style="--c:var(--fg-muted)">${initials("Deel")}</span><span>Contractor payment scheduled</span><div class="acts"><button class="btn sm">Finance</button><button class="btn sm icon">${ic("ph-x")}</button></div></div>
            </div>
            <div class="side-card">
              <h3>Recently routed</h3>
              ${routing.flatMap(g => g.samples.slice(0, 2).map(s => `<div class="sample"><span class="avatar" style="--c:${g.color}">${initials(s.who)}</span><span>${s.s}</span><span class="tag" style="margin-left:auto;flex:none">${s.to}</span></div>`)).join("")}
            </div>
          </aside>
        </div>
      </div>
    </div>
    ${state.agent === "bottom" ? agentDock(ui) : ""}
  </div>`;
}
