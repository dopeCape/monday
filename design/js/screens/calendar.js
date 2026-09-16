// Calendar prototype: Week view, Agenda, the Today panel, and an invite in a thread.
// Throwaway: answers "where does the calendar live and what does a week look like".
import { ic, mark, agentDock } from "../components.js";
import { state } from "../theme.js";

const days = ["Mon 15", "Tue 16", "Wed 17", "Thu 18", "Fri 19"];
const hours = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
const events = [
  { d: 0, s: 9, e: 9.5, t: "Standup", k: "own" },
  { d: 0, s: 14, e: 15, t: "Icon review with Mateus", k: "own" },
  { d: 1, s: 11, e: 12, t: "Term sheet call, Meridian", k: "own", who: "Kenji, Ravi" },
  { d: 2, s: 10, e: 10.5, t: "Standup", k: "own" },
  { d: 3, s: 15, e: 15.75, t: "Aoife Brennan, take-home", k: "agent", who: "created by monday" },
  { d: 3, s: 9, e: 10, t: "Focus", k: "busy" },
  { d: 4, s: 13, e: 14, t: "Podcast recording", k: "tentative", who: "Sofia Lindqvist" },
];

function grid() {
  const col = d => events.filter(e => e.d === d).map(e => {
    const top = (e.s - 8) * 48, h = (e.e - e.s) * 48;
    return `<div class="ev ${e.k}" style="top:${top}px;height:${h}px"><b>${e.t}</b>${e.who ? `<span>${e.who}</span>` : ""}</div>`;
  }).join("");
  return `
  <div class="cal-grid">
    <div class="cal-hours">${hours.map(h => `<div>${String(h).padStart(2, "0")}:00</div>`).join("")}</div>
    ${days.map((d, i) => `<div class="cal-day ${i === 3 ? "today" : ""}"><div class="cal-dh">${d}</div><div class="cal-col">${hours.map(() => `<div class="cal-slot"></div>`).join("")}${col(i)}</div></div>`).join("")}
  </div>`;
}

function agenda() {
  return `
  <div class="agenda">
    <div class="sec">Today, Thursday 18</div>
    ${[["09:00", "10:00", "Focus", ""], ["15:00", "15:45", "Aoife Brennan, take-home", "meet.genai-labs.io/aoife · created by monday"]].map(r => `<div class="ag-row"><span class="ag-t">${r[0]}<br><i>${r[1]}</i></span><span class="ag-b"><b>${r[2]}</b>${r[3] ? `<span>${r[3]}</span>` : ""}</span><span class="ag-a"><button class="btn sm">Join</button></span></div>`).join("")}
    <div class="sec">Tomorrow, Friday 19</div>
    <div class="ag-row"><span class="ag-t">13:00<br><i>14:00</i></span><span class="ag-b"><b>Podcast recording</b><span>Sofia Lindqvist · tentative</span></span><span class="ag-a"><button class="btn sm">Accept</button><button class="btn sm">Decline</button></span></div>
  </div>`;
}

export function render(route, ui) {
  const view = route.id || "week";
  return `
  <div class="main page">
    <div class="page-wrap cal-wrap">
      <div class="col-head">
        <h2>Calendar</h2><span class="count">September 2026</span>
        <span class="vr"></span>
        <button class="btn icon" title="Previous">${ic("ph-caret-left")}</button>
        <button class="btn">Today</button>
        <button class="btn icon" title="Next">${ic("ph-caret-right")}</button>
        <span class="sp"></span>
        <div class="seg">${["day", "week", "month", "agenda"].map(v => `<button class="${view === v ? "on" : ""}" data-go="#/calendar/${v}">${v[0].toUpperCase() + v.slice(1)}</button>`).join("")}</div>
        <button class="btn">${ic("ph-plus")} Event</button>
        <button class="btn" data-act="agent-open">${mark("sm")} Schedule</button>
      </div>
      <div class="cal-body">
        ${view === "agenda" ? agenda() : grid()}
        <aside class="cal-side">
          <div class="side-card" style="border-top:0;padding-top:4px">
            <h3>Today</h3>
            <div class="today-panel">
              <div class="tp-row"><span>09:00</span><b>Focus</b></div>
              <div class="tp-row now"><span>15:00</span><b>Aoife Brennan, take-home</b><button class="btn sm">Join</button></div>
            </div>
            <p class="faint" style="font-size:var(--fs-xs);margin:10px 0 0;line-height:1.5">This is the Today panel from the catalog. The agent can place it beside the stream or in the reader header.</p>
          </div>
          <div class="side-card">
            <h3>Invite in a thread</h3>
            <div class="invite">
              <div class="inv-h">${ic("ph-calendar-blank")} Podcast recording <span class="tag">Tentative</span></div>
              <div class="inv-d">Fri 19 Sep · 13:00 to 14:00 · Sofia Lindqvist</div>
              <div class="inv-c">${ic("ph-warning")} Overlaps Focus, 13:00 to 14:00</div>
              <div class="inv-a"><button class="btn sm primary">Accept</button><button class="btn sm">Tentative</button><button class="btn sm">Decline</button></div>
            </div>
            <p class="faint" style="font-size:var(--fs-xs);margin:10px 0 0;line-height:1.5">How an invite bar renders inside the reader. Answered through the calendar API where one exists.</p>
          </div>
          <div class="side-card">
            <h3>Calendars</h3>
            <div class="cal-list"><label><input type="checkbox" checked> tejas@genai-labs.io</label><label><input type="checkbox" checked> Team (shared)</label><label><input type="checkbox"> Holidays</label></div>
          </div>
        </aside>
      </div>
    </div>
    ${state.agent === "bottom" ? agentDock(ui) : ""}
  </div>`;
}
