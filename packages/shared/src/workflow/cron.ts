// A five-field cron (minute hour day-of-month month day-of-week), UTC, for the
// schedule Trigger: `*`, lists, ranges and `*/n` steps. Enough for "every
// Friday at 16:00" and "the 1st of the month at 06:00"; plain-language
// schedules become one of these when the Agent writes the document.

export interface CronSchedule {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  days: ReadonlySet<number>;
  months: ReadonlySet<number>;
  weekdays: ReadonlySet<number>;
  /** True when day-of-month or day-of-week was `*`; then the other alone decides (cron's rule). */
  anyDay: boolean;
  anyWeekday: boolean;
}

const NAMES: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

function parseField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  const value = (s: string): number => {
    const named = NAMES[s.toLowerCase()];
    const n = named !== undefined ? named : Number(s);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`cron: bad value "${s}"`);
    return n;
  };
  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new Error(`cron: bad step "${part}"`);
    let lo: number;
    let hi: number;
    if (rangePart === "*" || rangePart === undefined) {
      lo = min;
      hi = max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-");
      lo = value(a ?? "");
      hi = value(b ?? "");
      if (hi < lo) throw new Error(`cron: bad range "${part}"`);
    } else {
      lo = value(rangePart);
      hi = stepPart === undefined ? lo : max;
    }
    for (let n = lo; n <= hi; n += step) out.add(n === 7 && max === 6 ? 0 : n);
  }
  return out;
}

/** Throws on anything it does not understand; the schema calls it so a bad cron never saves. */
export function parseCron(expression: string): CronSchedule {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("cron: five fields expected");
  const [m, h, d, mo, w] = fields as [string, string, string, string, string];
  return {
    minutes: parseField(m, 0, 59),
    hours: parseField(h, 0, 23),
    days: parseField(d, 1, 31),
    months: parseField(mo, 1, 12),
    weekdays: parseField(w.replace(/\b7\b/g, "0"), 0, 6),
    anyDay: d === "*",
    anyWeekday: w === "*",
  };
}

export function cronMatches(schedule: CronSchedule, at: Date): boolean {
  if (!schedule.minutes.has(at.getUTCMinutes())) return false;
  if (!schedule.hours.has(at.getUTCHours())) return false;
  if (!schedule.months.has(at.getUTCMonth() + 1)) return false;
  const dayOk = schedule.days.has(at.getUTCDate());
  const weekdayOk = schedule.weekdays.has(at.getUTCDay());
  if (schedule.anyDay && schedule.anyWeekday) return true;
  if (schedule.anyDay) return weekdayOk;
  if (schedule.anyWeekday) return dayOk;
  return dayOk || weekdayOk;
}

/** The first minute strictly after `after` the schedule fires at, or null within two years. */
export function nextCronRun(schedule: CronSchedule, after: Date): Date | null {
  const t = new Date(after.getTime());
  t.setUTCSeconds(0, 0);
  t.setUTCMinutes(t.getUTCMinutes() + 1);
  const limit = after.getTime() + 2 * 366 * 86_400_000;
  while (t.getTime() <= limit) {
    if (!schedule.months.has(t.getUTCMonth() + 1)) {
      t.setUTCMonth(t.getUTCMonth() + 1, 1);
      t.setUTCHours(0, 0, 0, 0);
      continue;
    }
    const dayOk = schedule.days.has(t.getUTCDate());
    const weekdayOk = schedule.weekdays.has(t.getUTCDay());
    const dayMatches =
      schedule.anyDay && schedule.anyWeekday
        ? true
        : schedule.anyDay
          ? weekdayOk
          : schedule.anyWeekday
            ? dayOk
            : dayOk || weekdayOk;
    if (!dayMatches) {
      t.setUTCDate(t.getUTCDate() + 1);
      t.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!schedule.hours.has(t.getUTCHours())) {
      t.setUTCHours(t.getUTCHours() + 1, 0, 0, 0);
      continue;
    }
    if (!schedule.minutes.has(t.getUTCMinutes())) {
      t.setUTCMinutes(t.getUTCMinutes() + 1, 0, 0);
      continue;
    }
    return t;
  }
  return null;
}
