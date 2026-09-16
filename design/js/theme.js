// Theme / palette / density / layout state. Mirrors what monday.toml would hold.
// Layout is composed from knobs; presets are named combinations of them.
import { palettes, layouts } from "./data.js";

const KEY = "monday.design";
export const presets = {
  stream: { nav: "full", agent: "bottom", list: "stream" },
  columns: { nav: "full", agent: "bottom", list: "split" },
  "agent-left": { nav: "rail", agent: "left", list: "split" },
};
const defaults = { theme: "system", palette: "graphite", density: "comfortable", layout: "stream", ...presets.stream };

function fromStorage() {
  try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; }
}
function fromUrl() {
  const q = new URLSearchParams(location.search);
  const o = {};
  for (const k of Object.keys(defaults)) if (q.get(k)) o[k] = q.get(k);
  if (o.layout && presets[o.layout]) Object.assign(o, presets[o.layout], pick(o, ["nav", "agent", "list"]));
  return o;
}
const pick = (o, ks) => Object.fromEntries(ks.filter(k => k in o).map(k => [k, o[k]]));

export const state = { ...defaults, ...fromStorage(), ...fromUrl() };
export const chromeless = new URLSearchParams(location.search).get("chrome") === "0";
const mq = matchMedia("(prefers-color-scheme: dark)");

export function resolvedTheme() {
  return state.theme === "system" ? (mq.matches ? "dark" : "light") : state.theme;
}
export function presetName() {
  return Object.keys(presets).find(k => ["nav", "agent", "list"].every(x => presets[k][x] === state[x])) || "custom";
}

export function apply() {
  const r = document.documentElement;
  state.layout = presetName();
  r.dataset.theme = resolvedTheme();
  r.dataset.palette = state.palette;
  r.dataset.density = state.density;
  r.dataset.layout = state.layout;
  r.dataset.nav = state.nav;
  r.dataset.agent = state.agent;
  r.dataset.list = state.list;
  try { if (!chromeless) localStorage.setItem(KEY, JSON.stringify(state)); } catch {}
  document.dispatchEvent(new CustomEvent("theme", { detail: { ...state } }));
  syncToolbar();
}

export function set(patch) {
  if (patch.layout && presets[patch.layout]) Object.assign(patch, presets[patch.layout]);
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
    <select data-k="layout" title="Layout preset">${layouts.map(l => `<option value="${l.key}">${l.label}</option>`).join("")}<option value="custom">Custom</option></select>
    <select data-k="nav" title="Navigation"><option value="full">Nav: full</option><option value="rail">Nav: rail</option><option value="hidden">Nav: hidden</option></select>
    <select data-k="agent" title="Agent position"><option value="bottom">Agent: bottom</option><option value="left">Agent: left</option><option value="right">Agent: right</option></select>
    <select data-k="list" title="List mode"><option value="stream">List: stream</option><option value="split">List: split</option></select>
    <select data-k="palette" title="Palette">${palettes.map(p => `<option value="${p.key}">${p.label}</option>`).join("")}</select>
    <select data-k="theme" title="Theme"><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select>
    <select data-k="density" title="Density"><option value="compact">Compact</option><option value="comfortable">Comfortable</option><option value="spacious">Spacious</option></select>
    <span class="sep"></span>
    <a class="btn sm" href="./index.html" title="Back to the design hub"><i class="ph ph-squares-four"></i> Hub</a>
    </span>`;
  bar.querySelector("[data-toggle]").addEventListener("click", () => bar.classList.toggle("open"));
  bar.addEventListener("change", e => {
    const k = e.target.dataset.k;
    if (k === "layout" && e.target.value === "custom") return;
    if (k) set({ [k]: e.target.value });
  });
  document.body.appendChild(bar);
  syncToolbar();
}

function syncToolbar() {
  if (!bar) return;
  for (const s of bar.querySelectorAll("select")) s.value = state[s.dataset.k];
}

addEventListener("keydown", e => {
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "d") {
    e.preventDefault();
    set({ theme: resolvedTheme() === "dark" ? "light" : "dark" });
  }
});
