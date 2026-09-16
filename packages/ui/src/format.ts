// Small pure helpers the components share. No DOM, no React.

/** Joins class names, skipping falsy parts. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** "Aoife Brennan" to "AB". */
export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((s) => s[0] ?? "")
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/** A stable tag color for a name, as a CSS custom property reference. */
export function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `var(--tag-${1 + (h % 5)})`;
}

export function firstName(name: string): string {
  return name.split(/\s+/)[0] ?? name;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((startOfDay(b) - startOfDay(a)) / 86_400_000);
}

export function clock(d: Date): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function dayLabel(d: Date, now: Date): string {
  const days = daysBetween(d, now);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days > 1 && days < 7) return WEEKDAYS[d.getDay()] ?? "";
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** List time: "09:41" today, "Yesterday", "Mon" this week, "Sep 5" otherwise. */
export function formatListTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const label = dayLabel(d, now);
  return label === "Today" ? clock(d) : label;
}

/** Reader time: "Today 09:41", "Yesterday 17:20", "Mon 14:02", "Sep 5 16:00". */
export function formatWhen(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${dayLabel(d, now)} ${clock(d)}`;
}

/** 214 KB, 1.9 MB. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Splits plain text into paragraphs on blank lines. */
export function paragraphs(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** The first line of a body, for collapsed messages. */
export function preview(text: string | undefined): string {
  return paragraphs(text)[0]?.split("\n")[0] ?? "";
}

/** React keys for items that carry no id: the text, numbered when it repeats. */
export function uniqueKeys(texts: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return texts.map((t) => {
    const count = seen.get(t) ?? 0;
    seen.set(t, count + 1);
    return count ? `${t} ${count + 1}` : t;
  });
}

/** "search_mail" to "Search mail". */
export function humanize(id: string): string {
  const words = id.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
