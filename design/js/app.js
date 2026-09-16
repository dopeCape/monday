import { apply, mountToolbar, set, state } from "./theme.js";
import { navSidebar, rail, agentColumn, cmdk, compose } from "./components.js";
import * as inbox from "./screens/inbox.js";
import * as workflows from "./screens/workflows.js";
import * as routing from "./screens/routing.js";
import * as settings from "./screens/settings.js";

const screens = { inbox, workflows, routing, settings };
const q = new URLSearchParams(location.search);

export const ui = {
  selected: q.get("sel") || "e1",
  readerOpen: q.get("reader") !== "0",
  agentOpen: q.get("agent") === "1",
  overlay: q.get("overlay") || null, // cmdk | compose
};

function parseRoute() {
  const h = location.hash.replace(/^#\/?/, "");
  const [screen = "inbox", id] = h.split("/");
  if (!screens[screen]) return { screen: "inbox", folder: null };
  if (screen === "inbox") return { screen, folder: id && id !== "inbox" ? id : null };
  return { screen, id };
}

function render() {
  const route = parseRoute();
  const root = document.getElementById("app");
  const shell = state.layout === "agent-left" ? rail(route) + agentColumn() : navSidebar(route);
  root.innerHTML = shell + screens[route.screen].render(route, ui) +
    (ui.overlay === "cmdk" ? cmdk() : ui.overlay === "compose" ? compose() : "");
  const focus = root.querySelector("[autofocus]");
  if (focus) focus.focus();
}

document.addEventListener("click", e => {
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
  if (act === "close-overlay" && (e.target.classList.contains("scrim") || e.target.closest("button[data-act=close-overlay]"))) {
    ui.overlay = null; return render();
  }
  if (act === "agent-open") { ui.agentOpen = true; return render(); }
  if (act === "agent-close") { ui.agentOpen = false; return render(); }
  if (act === "close-reader") { ui.readerOpen = false; return render(); }
  if (act === "expand") { e.target.closest(".msg").classList.remove("collapsed"); return; }

  const pal = e.target.closest("[data-palette]");
  if (pal) return set({ palette: pal.dataset.palette });
  const th = e.target.closest("[data-theme]");
  if (th) return set({ theme: th.dataset.theme });
  const lay = e.target.closest("[data-layout]");
  if (lay) return set({ layout: lay.dataset.layout });
  const den = e.target.closest("[data-density]");
  if (den) return set({ density: den.dataset.density });

  const sw = e.target.closest(".switch");
  if (sw) sw.classList.toggle("on");
  const chip = e.target.closest(".list-filters .chip");
  if (chip) { chip.parentElement.querySelectorAll(".chip").forEach(c => c.classList.remove("on")); chip.classList.add("on"); }
});

document.addEventListener("focusin", e => {
  if (e.target.matches("[data-act=agent-focus]") && !ui.agentOpen && state.layout !== "agent-left") {
    ui.agentOpen = true; render();
    document.querySelector("[data-act=agent-focus]")?.focus();
  }
});

document.addEventListener("keydown", e => {
  const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName);
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); ui.overlay = ui.overlay === "cmdk" ? null : "cmdk"; return render(); }
  if (e.key === "Escape") {
    if (ui.overlay) { ui.overlay = null; return render(); }
    if (ui.agentOpen) { ui.agentOpen = false; document.activeElement?.blur(); return render(); }
    if (state.layout === "stream" && ui.readerOpen) { ui.readerOpen = false; return render(); }
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
