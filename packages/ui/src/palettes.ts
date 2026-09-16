// The seven shipped palettes as data. tokens.css holds the full token sets;
// this is what the Settings page needs to draw a swatch and name each one.

export type PaletteKey =
  | "graphite"
  | "catppuccin"
  | "gruvbox"
  | "nord"
  | "tokyonight"
  | "rosepine"
  | "everforest";

export interface PalettePreview {
  bg: string;
  panel: string;
  fg: string;
  accent: string;
  border: string;
}

export interface Palette {
  key: PaletteKey;
  label: string;
  /** Who made it, or the names of its light and dark halves. */
  by: string;
  light: PalettePreview;
  dark: PalettePreview;
}

export const palettes: readonly Palette[] = [
  {
    key: "graphite",
    label: "Graphite",
    by: "monday",
    light: {
      bg: "#f4f4f5",
      panel: "#ffffff",
      fg: "#18181b",
      accent: "#3d63dd",
      border: "rgba(24,24,27,.1)",
    },
    dark: {
      bg: "#0c0c0e",
      panel: "#131316",
      fg: "#ececef",
      accent: "#7c96ff",
      border: "rgba(255,255,255,.1)",
    },
  },
  {
    key: "catppuccin",
    label: "Catppuccin",
    by: "Latte / Mocha",
    light: {
      bg: "#e6e9ef",
      panel: "#eff1f5",
      fg: "#4c4f69",
      accent: "#8839ef",
      border: "rgba(76,79,105,.14)",
    },
    dark: {
      bg: "#181825",
      panel: "#1e1e2e",
      fg: "#cdd6f4",
      accent: "#cba6f7",
      border: "rgba(205,214,244,.1)",
    },
  },
  {
    key: "gruvbox",
    label: "Gruvbox",
    by: "Light / Dark",
    light: {
      bg: "#f2e5bc",
      panel: "#fbf1c7",
      fg: "#3c3836",
      accent: "#d65d0e",
      border: "rgba(60,56,54,.14)",
    },
    dark: {
      bg: "#1d2021",
      panel: "#282828",
      fg: "#ebdbb2",
      accent: "#fe8019",
      border: "rgba(235,219,178,.1)",
    },
  },
  {
    key: "nord",
    label: "Nord",
    by: "Snow Storm / Polar Night",
    light: {
      bg: "#e5e9f0",
      panel: "#eceff4",
      fg: "#2e3440",
      accent: "#5e81ac",
      border: "rgba(46,52,64,.14)",
    },
    dark: {
      bg: "#272c36",
      panel: "#2e3440",
      fg: "#eceff4",
      accent: "#88c0d0",
      border: "rgba(236,239,244,.1)",
    },
  },
  {
    key: "tokyonight",
    label: "Tokyo Night",
    by: "Day / Night",
    light: {
      bg: "#d5d6db",
      panel: "#e1e2e7",
      fg: "#343b58",
      accent: "#2e7de9",
      border: "rgba(55,96,191,.14)",
    },
    dark: {
      bg: "#16161e",
      panel: "#1a1b26",
      fg: "#c0caf5",
      accent: "#7aa2f7",
      border: "rgba(192,202,245,.1)",
    },
  },
  {
    key: "rosepine",
    label: "Rosé Pine",
    by: "Dawn / Main",
    light: {
      bg: "#f2e9e1",
      panel: "#faf4ed",
      fg: "#575279",
      accent: "#907aa9",
      border: "rgba(87,82,121,.14)",
    },
    dark: {
      bg: "#16141f",
      panel: "#191724",
      fg: "#e0def4",
      accent: "#c4a7e7",
      border: "rgba(224,222,244,.1)",
    },
  },
  {
    key: "everforest",
    label: "Everforest",
    by: "Light / Dark",
    light: {
      bg: "#f4f0d9",
      panel: "#fdf6e3",
      fg: "#5c6a72",
      accent: "#8da101",
      border: "rgba(92,106,114,.14)",
    },
    dark: {
      bg: "#232a2e",
      panel: "#2d353b",
      fg: "#d3c6aa",
      accent: "#a7c080",
      border: "rgba(211,198,170,.1)",
    },
  },
];

export const paletteKeys: readonly PaletteKey[] = palettes.map((p) => p.key);

export function findPalette(key: string): Palette | undefined {
  return palettes.find((p) => p.key === key);
}
