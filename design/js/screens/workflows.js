import { workflows } from "../data.js";
import { ic, agentDock } from "../components.js";
import { state } from "../theme.js";

export function render(route, ui) {
  const sel = workflows.find(w => w.id === (route.id || "w1")) || workflows[0];
  const card = w => `
    <div class="wf-card ${w.id === sel.id ? "on" : ""}" data-go="#/workflows/${w.id}">
      <div class="wf-top">
        ${ic(w.on ? "ph-play-circle" : "ph-pause-circle", "fill")}
        <b>${w.name}</b>
        ${w.today ? `<span class="tag ai">${w.today} today</span>` : ""}
        <span class="where">${w.where === "server" ? ic("ph-cloud") + " Runs on your server" : ic("ph-terminal-window") + " Runs here via Claude Code"}</span>
      </div>
      <p class="wf-desc">${w.desc}</p>
      <div class="flow">${w.flow.map((n, i) => `${i ? '<span class="edge"></span>' : ""}<span class="node ${n.k}">${ic(n.i)} ${n.t}${n.s ? ` <span class="k">${n.s}</span>` : ""}</span>`).join("")}</div>
      <div class="wf-foot">
        <span class="runs">${w.runs.map(r => `<i class="${r ? "" : "f"}" style="height:${6 + Math.round(Math.random() * 8)}px"></i>`).join("")}</span>
        <span>Last run ${w.last}</span>
        <span class="switch ${w.on ? "on" : ""}"></span>
      </div>
    </div>`;

  return `
  <div class="main page">
    <div class="page-wrap">
      <div class="page-in">
        <div class="page-head">
          <div><h1>Workflows</h1><p>Written by the agent from what you asked for. No editor to learn, describe the change instead.</p></div>
          <div class="acts"><button class="btn outline">${ic("ph-clock-counter-clockwise")} Run history</button><button class="btn primary">${ic("ph-sparkle", "fill")} New workflow</button></div>
        </div>
        <div class="two">
          <div>
            <div class="tabs" style="margin-bottom:12px"><button class="on">Active <span class="n">3</span></button><button>Paused <span class="n">1</span></button><button>Suggested by the agent <span class="n">2</span></button></div>
            <div class="wf">${workflows.map(card).join("")}</div>
            <div class="empty" style="padding-top:36px">
              <div class="ico">${ic("ph-flow-arrow")}</div>
              <h3>Describe the next one</h3>
              <p>Say what should happen and when. The agent writes the workflow, shows you the steps, and asks before anything leaves your mailbox.</p>
              <div class="examples">
                <button>${ic("ph-sparkle")} When a customer replies angry, draft an apology and flag it to me on Slack</button>
                <button>${ic("ph-sparkle")} Every Monday, list open threads older than 5 days and snooze the rest</button>
                <button>${ic("ph-sparkle")} When a calendar invite lands, check for conflicts and propose a new time</button>
                <button>${ic("ph-sparkle")} Forward every invoice over 500 EUR to accounting with a summary</button>
              </div>
            </div>
          </div>
          <aside>
            <div class="side-card">
              <h3>${ic("ph-pencil-simple")} ${sel.name} <button class="btn sm">${ic("ph-code")} Source</button></h3>
              <div class="ask">${ic("ph-sparkle", "fill")}<input placeholder="Ask the agent to change this workflow" /><button class="send">${ic("ph-arrow-up", "bold")}</button></div>
              <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
                <button class="chip">Also post to Discord</button><button class="chip">Skip if I already replied</button><button class="chip">Pause on weekends</button>
              </div>
            </div>
            <div class="side-card">
              <h3>${ic("ph-list-checks")} Recent runs</h3>
              <div class="runlog">${sel.log.map(l => `<div class="r">${ic(l.ok ? "ph-check-circle" : "ph-warning-circle", "fill")}<div>${l.m}<span>${l.d}</span></div><span class="t">${l.t}</span></div>`).join("")}</div>
            </div>
            <div class="side-card">
              <h3>${ic("ph-cpu")} Where it runs</h3>
              <div class="note">${ic("ph-info")}<div>${sel.where === "server" ? "Runs on <b>sync.genai-labs.io</b> with your Anthropic API key, so it keeps working when this laptop is closed." : "Runs on this machine through <b>Claude Code</b>. It waits while the app is closed and catches up on launch."}</div></div>
            </div>
          </aside>
        </div>
      </div>
    </div>
    ${state.layout !== "agent-left" ? agentDock(ui) : ""}
  </div>`;
}
