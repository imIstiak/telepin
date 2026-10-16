import { DateTime, IANAZone } from "luxon";

export function isValidTimezone(tz: string): boolean {
  return IANAZone.isValidZone(tz);
}

/** Computes publish times for N items: start, start+interval, ... (interval 0 = all at start). */
export function buildTimeline(startUtc: Date, count: number, intervalMinutes: number): Date[] {
  return Array.from({ length: count }, (_, i) => new Date(startUtc.getTime() + i * intervalMinutes * 60_000));
}

export function formatLocal(d: Date, tz: string, fmt = "dd LLL yyyy, hh:mm a"): string {
  return DateTime.fromJSDate(d).setZone(tz).toFormat(fmt);
}

/**
 * Parses user-entered start times in the user's timezone. Accepts:
 *  "now", "in 30m", "in 2h", "+90m", "tomorrow 10:00", "today 18:30", "10:00", "10pm",
 *  "2026-10-17 10:00", "17/10/2026 10:00", "17-10 10:00"
 * Returns a UTC Date or null.
 */
export function parseUserDateTime(input: string, tz: string, now: Date = new Date()): Date | null {
  const s = input.trim().toLowerCase().replace(/\s+/g, " ");
  const base = DateTime.fromJSDate(now).setZone(tz);
  if (!base.isValid) return null;
  if (s === "now") return now;

  const rel = s.match(/^(?:in |\+)?(\d+)\s*(m|min|mins|minutes?|h|hr|hrs|hours?)$/);
  if (rel && (s.startsWith("in ") || s.startsWith("+"))) {
    const n = Number(rel[1]);
    const mins = rel[2]!.startsWith("h") ? n * 60 : n;
    return base.plus({ minutes: mins }).toJSDate();
  }

  const parseClock = (t: string): { hour: number; minute: number } | null => {
    const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
    if (!m) return null;
    let hour = Number(m[1]);
    const minute = m[2] ? Number(m[2]) : 0;
    const ap = m[3];
    if (ap) {
      if (hour < 1 || hour > 12) return null;
      if (ap === "pm" && hour !== 12) hour += 12;
      if (ap === "am" && hour === 12) hour = 0;
    } else if (!m[2]) {
      return null; // bare number like "10" is ambiguous
    }
    if (hour > 23 || minute > 59) return null;
    return { hour, minute };
  };

  const dayWord = s.match(/^(today|tomorrow) (.+)$/);
  if (dayWord) {
    const c = parseClock(dayWord[2]!);
    if (!c) return null;
    const day = dayWord[1] === "tomorrow" ? base.plus({ days: 1 }) : base;
    return day.set({ ...c, second: 0, millisecond: 0 }).toJSDate();
  }

  const clockOnly = parseClock(s);
  if (clockOnly) {
    let dt = base.set({ ...clockOnly, second: 0, millisecond: 0 });
    if (dt <= base) dt = dt.plus({ days: 1 });
    return dt.toJSDate();
  }

  const formats = [
    "yyyy-MM-dd HH:mm",
    "yyyy-MM-dd H:mm",
    "yyyy-MM-dd'T'HH:mm",
    "yyyy-MM-dd hh:mm a",
    "yyyy-MM-dd h:mm a",
    "dd/MM/yyyy HH:mm",
    "d/M/yyyy H:mm",
    "dd-MM-yyyy HH:mm",
    "d/M H:mm",
    "d-M H:mm",
  ];
  for (const f of formats) {
    const dt = DateTime.fromFormat(s, f, { zone: tz, locale: "en" });
    if (dt.isValid) {
      // Year-less formats: assume the next occurrence.
      if (!f.includes("yyyy") && dt < base) return dt.plus({ years: 1 }).toJSDate();
      return dt.toJSDate();
    }
  }
  return null;
}

export function minutesLabel(m: number): string {
  if (m === 0) return "immediately";
  if (m % 60 === 0) return m === 60 ? "every 1 hour" : `every ${m / 60} hours`;
  return `every ${m} minutes`;
}
