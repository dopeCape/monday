import { apply, mountToolbar, set, state } from "./theme.js";
import { navSidebar, rail, agentColumn, cmdk, compose } from "./components.js";
import * as inbox from "./screens/inbox.js";
import * as workflows from "./screens/workflows.js";
import * as routing from "./screens/routing.js";
import * as settings from "./screens/settings.js";
import * as calendar from "./screens/calendar.js";
import * as onboarding from "./screens/onboarding.js";

const screens = { inbox, workflows, routing, settings, calendar, onboarding };
const q = new URLSearchParams(location.search);

export const ui = {
  selected: q.get("sel") || "e1",
  readerOpen: q.get("reader") === "1" || q.has("sel") || state.list === "split",
  agentOpen: q.get("open") === "1",
  thread: q.get("thread") || "default",
  overlay: q.get("overlay") || null, // cmdk | compose
};

function parseRoute() {
  const h = location.hash.replace(/^#\/?/, "");
  const [screen = "inbox", id] = h.split("/");
  if (!screens[screen]) return { screen: "inbox", folder: null };
  if (screen === "inbox") return { screen, folder: id && id !== "inbox" ? id : null };
  return { screen, id };
}

// The shell is composed from knobs: nav (full | rail | hidden), agent (bottom | left | right).
function render() {
  const route = parseRoute();
  const root = document.getElementById("app");
  const parts = [], cols = [];
  if (route.screen === "onboarding") {
    root.style.gridTemplateColumns = "minmax(0, 1fr)";
    root.innerHTML = screens.onboarding.render(route, ui);
    return;
  }
  if (state.nav === "full") { parts.push(navSidebar(route)); cols.push("var(--nav-w)"); }
  if (state.nav === "rail") { parts.push(rail(route)); cols.push("var(--rail-w)"); }
  if (state.agent === "left") { parts.push(agentColumn("left")); cols.push("var(--agent-w)"); }
  parts.push(screens[route.screen].render(route, ui)); cols.push("minmax(0, 1fr)");
  if (state.agent === "right") { parts.push(agentColumn("right")); cols.push("var(--agent-w)"); }
  root.style.gridTemplateColumns = cols.join(" ");
  root.innerHTML = parts.join("") + (ui.overlay === "cmdk" ? cmdk() : ui.overlay === "compose" ? compose() : "");
  root.querySelector("[autofocus]")?.focus();
}

document.addEventListener("click", e => {
  const setEl = e.target.closest("[data-set]");
  if (setEl) {
    const patch = JSON.parse(setEl.dataset.set);
    if (Object.keys(patch).length) set(patch);
    setEl.parentElement?.querySelectorAll(".btn").forEach(b => b.classList.remove("on"));
    setEl.classList.add("on");
    return;
  }
  const go = e.target.closest("[data-go]");
  if (go) {
    const href = go.dataset.go;
    if (href === "#cmdk") { ui.overlay = "cmdk"; return render(); }
    if (href === "#compose") { ui.overlay = "compose"; return render(); }
    location.hash = href;
    return;
  }
  const open = e.target.closest("[data-open]");
  if (open && !e.target.closest(".actions")) { ui.selected = open.dataset.open; ui.readerOpen = true; return render(); }

  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "cmdk") { ui.overlay = "cmdk"; return render(); }
  if (act === "compose") { ui.overlay = "compose"; return render(); }
  if (act === "close-overlay" && (e.target.classList.contains("scrim") || e.target.closest("button[data-act=close-overlay]"))) { ui.overlay = null; return render(); }
  if (act === "agent-open") { ui.agentOpen = true; return render(); }
  if (act === "agent-close") { ui.agentOpen = false; return render(); }
  if (act === "close-reader") { ui.readerOpen = false; return render(); }
  if (act === "expand") { e.target.closest(".msg").classList.remove("collapsed"); return; }

  for (const k of ["palette", "theme", "layout", "density", "nav", "agent", "list"]) {
    const el = e.target.closest(`[data-${k}]`);
    if (el && el.dataset[k]) return set({ [k]: el.dataset[k] });
  }

  const sw = e.target.closest(".switch");
  if (sw) sw.classList.toggle("on");
  const chip = e.target.closest(".list-filters .chip");
  if (chip) { chip.parentElement.querySelectorAll(".chip").forEach(c => c.classList.remove("on")); chip.classList.add("on"); }
});

document.addEventListener("focusin", e => {
  if (e.target.matches("[data-act=agent-focus]") && !ui.agentOpen && state.agent === "bottom") {
    ui.agentOpen = true; render();
    document.querySelector("[data-act=agent-focus]")?.focus();
  }
});

document.addEventListener("keydown", e => {
  const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName);
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); ui.overlay = ui.overlay === "cmdk" ? null : "cmdk"; return render(); }
  if ((e.metaKey || e.ctrlKey) && /^[123]$/.test(e.key)) {
    e.preventDefault();
    const views = { 1: { nav: "full", agent: "bottom", list: "stream" }, 2: { nav: "hidden", agent: "bottom", list: "stream" }, 3: { nav: "hidden", agent: "right", list: "stream" } };
    return set(views[e.key]);
  }
  if (e.key === "Escape") {
    if (ui.overlay) { ui.overlay = null; return render(); }
    if (ui.agentOpen) { ui.agentOpen = false; document.activeElement?.blur(); return render(); }
    if (state.list === "stream" && ui.readerOpen) { ui.readerOpen = false; return render(); }
  }
  if (typing) return;
  if (e.key === "c") { ui.overlay = "compose"; return render(); }
  if (e.key === "/") { e.preventDefault(); ui.agentOpen = true; render(); document.querySelector("[data-act=agent-focus]")?.focus(); }
  if (e.key === "j" || e.key === "k") {
    const rows = [...document.querySelectorAll("[data-open]")];
    const i = rows.findIndex(r => r.dataset.open === ui.selected);
    const next = rows[Math.min(rows.length - 1, Math.max(0, i + (e.key === "j" ? 1 : -1)))];
    if (next) { ui.selected = next.dataset.open; ui.readerOpen = true; render(); }
  }
});

addEventListener("hashchange", render);
document.addEventListener("theme", render);
apply();
mountToolbar();
render();
