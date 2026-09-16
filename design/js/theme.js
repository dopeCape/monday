// Theme / palette / density / layout state. Mirrors what monday.toml would hold.
import { palettes, layouts } from "./data.js";

const KEY = "monday.design";
const defaults = { theme: "system", palette: "graphite", density: "comfortable", layout: "columns" };

function fromStorage() {
  try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; }
}
function fromUrl() {
  const q = new URLSearchParams(location.search);
  const o = {};
  for (const k of Object.keys(defaults)) if (q.get(k)) o[k] = q.get(k);
  return o;
}

export const state = { ...defaults, ...fromStorage(), ...fromUrl() };
export const chromeless = new URLSearchParams(location.search).get("chrome") === "0";
const mq = matchMedia("(prefers-color-scheme: dark)");

export function resolvedTheme() {
  return state.theme === "system" ? (mq.matches ? "dark" : "light") : state.theme;
}

export function apply() {
  const r = document.documentElement;
  r.dataset.theme = resolvedTheme();
  r.dataset.palette = state.palette;
  r.dataset.density = state.density;
  r.dataset.layout = state.layout;
  try { if (!chromeless) localStorage.setItem(KEY, JSON.stringify(state)); } catch {}
  document.dispatchEvent(new CustomEvent("theme", { detail: { ...state } }));
  syncToolbar();
}

export function set(patch) {
  Object.assign(state, patch);
  apply();
}

mq.addEventListener("change", () => state.theme === "system" && apply());

let bar;
export function mountToolbar() {
  if (chromeless || bar) return;
  bar = document.createElement("div");
  bar.className = "dt";
  bar.innerHTML = `
    <b data-toggle><i class="ph ph-paint-brush"></i> design</b>
    <span class="body">
    <select data-k="layout" title="Layout">${layouts.map(l => `<option value="${l.key}">${l.label}</option>`).join("")}</select>
    <select data-k="palette" title="Palette">${palettes.map(p => `<option value="${p.key}">${p.label}</option>`).join("")}</select>
    <select data-k="theme" title="Theme"><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select>
    <select data-k="density" title="Density"><option value="comfortable">Comfortable</option><option value="compact">Compact</option></select>
    <span class="sep"></span>
    <a class="btn sm" href="./index.html" title="Back to the design hub"><i class="ph ph-squares-four"></i> Hub</a>
    </span>`;
  bar.querySelector("[data-toggle]").addEventListener("click", () => bar.classList.toggle("open"));
  bar.addEventListener("change", e => {
    const k = e.target.dataset.k;
    if (k) set({ [k]: e.target.value });
  });
  document.body.appendChild(bar);
  syncToolbar();
}

function syncToolbar() {
  if (!bar) return;
  for (const s of bar.querySelectorAll("select")) s.value = state[s.dataset.k];
}

// keyboard: ⌘⇧D cycles theme quickly while reviewing
addEventListener("keydown", e => {
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "d") {
    e.preventDefault();
    set({ theme: resolvedTheme() === "dark" ? "light" : "dark" });
  }
});
