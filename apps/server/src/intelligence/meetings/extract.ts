// Candidates code finds in a Message before any model reads it (the
// pre-parsed value extraction pattern): clock times ("3pm", "15:00", "at 4"),
// time zone mentions ("CET", "UTC+2", "London time"), whether the text holds a
// day or time at all, the gate words, the sender's UTC offset from the Date
// header, and whether the text reads as English. The judge picks among these
// spans; it never types a time back. Pure.

/** A clock time as written, with what code can read off it for sure. */
export interface ClockCandidate {
  /** The span verbatim, the option name the judge picks. */
  text: string;
  /** 0 to 23 when the span fixes it (a 24-hour time, am or pm written); else null. */
  hour24: number | null;
  /** 1 to 12 on a 12-hour face, or the 24-hour hour when that is all there is. */
  hour: number;
  minute: number;
  /** Written am or pm, when the span says. */
  meridiem: "am" | "pm" | null;
}

/** A time zone as written, and the IANA zone code maps it to (null when code cannot). */
export interface ZoneCandidate {
  text: string;
  zone: string | null;
}

const AMPM = /\b(1[0-2]|0?[1-9])(?:\s*[:.]\s*([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/gi;
const H24 = /\b([01]?\d|2[0-3])\s*[:.h]\s*([0-5]\d)\b(?!\s*(?:a\.?m\.?|p\.?m\.?|%))/gi;
const BARE =
  /\b(?:at|around|from|after|before|by|about)\s+(1[0-2]|[1-9])\b(?![:.]?\d|\s*(?:a\.?m|p\.?m|%|\/|st|nd|rd|th|minutes|mins|hours|days|weeks))/gi;
const NOON = /\b(noon|midday)\b/gi;

/** Every clock time in the text, deduplicated by span, in order, at most `max`. */
export function clockCandidates(text: string, max: number): ClockCandidate[] {
  const found: Array<ClockCandidate & { at: number }> = [];
  const taken: Array<[number, number]> = [];
  const overlaps = (s: number, e: number) => taken.some(([a, b]) => s < b && e > a);
  const add = (at: number, length: number, c: ClockCandidate) => {
    if (overlaps(at, at + length)) return;
    taken.push([at, at + length]);
    found.push({ ...c, at });
  };
  for (const m of text.matchAll(AMPM)) {
    const h = Number(m[1]);
    const mi = m[2] ? Number(m[2]) : 0;
    const pm = /^p/i.test(m[3] ?? "");
    const hour24 = pm ? (h % 12) + 12 : h % 12;
    add(m.index ?? 0, m[0].length, {
      text: m[0].trim(),
      hour24,
      hour: h,
      minute: mi,
      meridiem: pm ? "pm" : "am",
    });
  }
  for (const m of text.matchAll(H24)) {
    const raw = m[1] ?? "0";
    const h = Number(raw);
    const mi = Number(m[2]);
    // A leading zero ("09:00") or an hour past 12 fixes the hour; "9:30" leaves am or pm open.
    const fixed = h >= 13 || h === 0 || (raw.length === 2 && raw.startsWith("0"));
    add(m.index ?? 0, m[0].length, {
      text: m[0].trim(),
      hour24: fixed ? h : null,
      hour: h,
      minute: mi,
      meridiem: null,
    });
  }
  for (const m of text.matchAll(NOON)) {
    add(m.index ?? 0, m[0].length, {
      text: m[0].trim(),
      hour24: 12,
      hour: 12,
      minute: 0,
      meridiem: "pm",
    });
  }
  for (const m of text.matchAll(BARE)) {
    const h = Number(m[1]);
    add(m.index ?? 0, m[0].length, {
      text: m[0].trim(),
      hour24: null,
      hour: h,
      minute: 0,
      meridiem: null,
    });
  }
  found.sort((a, b) => a.at - b.at);
  const seen = new Set<string>();
  const out: ClockCandidate[] = [];
  for (const { at: _at, ...c } of found) {
    const key = c.text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

/** The clock a span names, read again from the span itself (a stored reading keeps only the text). */
export function parseClock(span: string): ClockCandidate | null {
  return clockCandidates(span, 1)[0] ?? null;
}

const ZONE_ABBREVIATIONS: Record<string, string> = {
  PT: "America/Los_Angeles",
  PST: "America/Los_Angeles",
  PDT: "America/Los_Angeles",
  ET: "America/New_York",
  EST: "America/New_York",
  EDT: "America/New_York",
  CT: "America/Chicago",
  CST: "America/Chicago",
  CDT: "America/Chicago",
  MT: "America/Denver",
  MST: "America/Denver",
  MDT: "America/Denver",
  UTC: "UTC",
  GMT: "UTC",
  BST: "Europe/London",
  WET: "Europe/Lisbon",
  WEST: "Europe/Lisbon",
  CET: "Europe/Paris",
  CEST: "Europe/Paris",
  EET: "Europe/Athens",
  EEST: "Europe/Athens",
  IST: "Asia/Kolkata",
  SGT: "Asia/Singapore",
  HKT: "Asia/Hong_Kong",
  JST: "Asia/Tokyo",
  KST: "Asia/Seoul",
  AEST: "Australia/Sydney",
  AEDT: "Australia/Sydney",
  NZST: "Pacific/Auckland",
  NZDT: "Pacific/Auckland",
};

const ZONE_NAMES: Record<string, string> = {
  pacific: "America/Los_Angeles",
  eastern: "America/New_York",
  central: "America/Chicago",
  mountain: "America/Denver",
  "new york": "America/New_York",
  "san francisco": "America/Los_Angeles",
  london: "Europe/London",
  uk: "Europe/London",
  dublin: "Europe/Dublin",
  irish: "Europe/Dublin",
  lisbon: "Europe/Lisbon",
  paris: "Europe/Paris",
  berlin: "Europe/Berlin",
  amsterdam: "Europe/Amsterdam",
  madrid: "Europe/Madrid",
  "central european": "Europe/Paris",
  athens: "Europe/Athens",
  india: "Asia/Kolkata",
  indian: "Asia/Kolkata",
  singapore: "Asia/Singapore",
  tokyo: "Asia/Tokyo",
  sydney: "Australia/Sydney",
};

const ABBREVIATION = new RegExp(
  `(?<![A-Za-z])(?:(UTC|GMT)\\s*([+-])\\s*(\\d{1,2})(?::?(\\d{2}))?|(${Object.keys(ZONE_ABBREVIATIONS).join("|")}))(?![A-Za-z])`,
  "g",
);
const NAMED = new RegExp(`\\b(${Object.keys(ZONE_NAMES).join("|")})\\s+time\\b`, "gi");

/** Every time zone the text names, deduplicated by span, in order, at most `max`. */
export function zoneCandidates(text: string, max: number): ZoneCandidate[] {
  const found: Array<ZoneCandidate & { at: number }> = [];
  for (const m of text.matchAll(ABBREVIATION)) {
    let zone: string | null = null;
    if (m[1]) {
      const hours = Number(m[3]);
      // Etc/GMT zones carry the sign the other way round; only whole hours exist there.
      if (!m[4] || m[4] === "00") {
        zone =
          hours === 0 ? "UTC" : hours <= 14 ? `Etc/GMT${m[2] === "+" ? "-" : "+"}${hours}` : null;
      }
    } else if (m[5]) {
      zone = ZONE_ABBREVIATIONS[m[5]] ?? null;
    }
    found.push({ text: m[0].trim(), zone, at: m.index ?? 0 });
  }
  for (const m of text.matchAll(NAMED)) {
    found.push({
      text: m[0].trim(),
      zone: ZONE_NAMES[(m[1] ?? "").toLowerCase()] ?? null,
      at: m.index ?? 0,
    });
  }
  found.sort((a, b) => a.at - b.at);
  const seen = new Set<string>();
  const out: ZoneCandidate[] = [];
  for (const { at: _at, ...c } of found) {
    if (seen.has(c.text)) continue;
    seen.add(c.text);
    out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

const DAY_WORDS =
  /\b(today|tonight|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|next week|this week|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b|\b\d{1,2}\/\d{1,2}\b|\b\d{4}-\d{2}-\d{2}\b/i;

/** Whether the text names a day or a clock time at all. */
export function mentionsTime(text: string): boolean {
  return DAY_WORDS.test(text) || clockCandidates(text, 1).length > 0;
}

/** Whether one of the gate words (Setting meetings.gate_words) is in the text, as a word or phrase. */
export function hasGateWord(text: string, words: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return words.some((w) => {
    const word = w.trim().toLowerCase();
    if (!word) return false;
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[^a-z])${escaped}(?:$|[^a-z])`).test(lower);
  });
}

/** The sender's UTC offset in minutes from a Date header ("Tue, 29 Sep 2026 10:15:00 +0200"), or null. */
export function offsetOfDateHeader(value: string | undefined): number | null {
  if (!value) return null;
  const m = /([+-])(\d{2})(\d{2})\s*(?:\([^)]*\))?\s*$/.exec(value.trim());
  if (!m) return /\b(?:GMT|UT|UTC|Z)\s*$/.test(value.trim()) ? 0 : null;
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === "-" ? -minutes : minutes;
}

const ENGLISH = new Set(
  "the a an and or but to of in on at for with is are be it this that you your we i me my our can could would will let know if not do does have has what when how about next week meet call works work time free please thanks".split(
    " ",
  ),
);

/**
 * Whether the text reads as English: at least a share of its words are
 * common English ones. Short text counts as English (nothing to go on).
 */
export function looksEnglish(text: string): boolean {
  const words = text.toLowerCase().match(/[a-zà-ÿ']+/g) ?? [];
  if (words.length < 8) return true;
  const hits = words.filter((w) => ENGLISH.has(w)).length;
  return hits / words.length >= 0.12;
}

/** The newest Message's own words: the quoted history and "> " lines cut off. */
export function ownText(text: string, quoteStart: (lines: readonly string[]) => number): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const at = quoteStart(lines);
  const kept = (at >= 0 ? lines.slice(0, at) : lines).filter((l) => !/^\s*>/.test(l));
  return kept.join("\n").trim();
}
