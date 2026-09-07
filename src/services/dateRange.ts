// Plain-English period parsing for reports: "last month", "june 2025",
// "last 30 days", "this week", ... -> a half-open [start, end) instant range.
//
// Boundaries are computed in the business timezone (REPORT_TZ_OFFSET, default
// +05:30 / IST) so "last month" means the store's calendar month, not UTC's.

export interface DateRange {
  /** Inclusive start instant. */
  start: Date;
  /** Exclusive end instant. */
  end: Date;
  /** Human label for headings, e.g. "August 2026" or "last 30 days". */
  label: string;
}

/** Minutes east of UTC for the business calendar. */
function tzOffsetMinutes(): number {
  const raw = (process.env.REPORT_TZ_OFFSET || "+05:30").trim();
  const m = /^([+-])(\d{1,2}):?(\d{2})?$/.exec(raw);
  if (!m) return 330;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/** The instant of local midnight starting the given local calendar day. */
function localMidnight(y: number, mo: number, d: number): Date {
  return new Date(Date.UTC(y, mo, d) - tzOffsetMinutes() * 60_000);
}

/** Today's local calendar parts. */
function localToday(now: Date): { y: number; mo: number; d: number } {
  const shifted = new Date(now.getTime() + tzOffsetMinutes() * 60_000);
  return {
    y: shifted.getUTCFullYear(),
    mo: shifted.getUTCMonth(),
    d: shifted.getUTCDate(),
  };
}

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];
const MONTH_ABBR = MONTHS.map((m) => m.slice(0, 3));

function monthLabel(y: number, mo: number): string {
  return `${MONTHS[mo][0].toUpperCase()}${MONTHS[mo].slice(1)} ${y}`;
}

/** Words that only describe a time period — never part of a reseller's name. */
export const PERIOD_WORDS = new Set([
  ...MONTHS, ...MONTH_ABBR,
  "last", "past", "previous", "prev", "this", "current", "recent",
  "today", "todays", "yesterday", "day", "days", "week", "weeks",
  "month", "months", "year", "years", "quarter", "ytd", "mtd",
  "since", "between", "from", "till", "until", "upto",
]);

/**
 * Parse a period out of a question. Returns null when no period is mentioned
 * (the caller should then report over all time).
 */
export function parseDateRange(text: string, now: Date = new Date()): DateRange | null {
  const q = text.toLowerCase();
  const { y, mo, d } = localToday(now);
  const todayStart = localMidnight(y, mo, d);

  // Explicit ISO range: "from 2026-01-01 to 2026-03-31"
  const iso = /(\d{4})-(\d{2})-(\d{2})\s*(?:to|-|until|till|through)\s*(\d{4})-(\d{2})-(\d{2})/.exec(q);
  if (iso) {
    const start = localMidnight(+iso[1], +iso[2] - 1, +iso[3]);
    const endDay = localMidnight(+iso[4], +iso[5] - 1, +iso[6]);
    const end = new Date(endDay.getTime() + 86_400_000); // inclusive end date
    return { start, end, label: `${iso[1]}-${iso[2]}-${iso[3]} to ${iso[4]}-${iso[5]}-${iso[6]}` };
  }

  if (/\btoday\b/.test(q)) {
    return { start: todayStart, end: localMidnight(y, mo, d + 1), label: "today" };
  }
  if (/\byesterday\b/.test(q)) {
    return { start: localMidnight(y, mo, d - 1), end: todayStart, label: "yesterday" };
  }

  // "last 30 days" / "past 6 months" / "previous 2 weeks"
  const rolling = /\b(?:last|past|previous)\s+(\d{1,3})\s+(day|days|week|weeks|month|months|year|years)\b/.exec(q);
  if (rolling) {
    const n = Number(rolling[1]);
    const unit = rolling[2];
    const end = localMidnight(y, mo, d + 1); // include today
    let start: Date;
    if (unit.startsWith("day")) start = localMidnight(y, mo, d - (n - 1));
    else if (unit.startsWith("week")) start = localMidnight(y, mo, d - (n * 7 - 1));
    else if (unit.startsWith("month")) start = localMidnight(y, mo - n, d + 1);
    else start = localMidnight(y - n, mo, d + 1);
    return { start, end, label: `last ${n} ${unit.replace(/s$/, "")}${n > 1 ? "s" : ""}` };
  }

  // Named month, optionally with a year: "june", "june 2025", "jun 2025".
  const named = new RegExp(
    `\\b(${MONTHS.join("|")}|${MONTH_ABBR.join("|")})\\b(?:\\s+(\\d{4}))?`
  ).exec(q);
  if (named) {
    const idx = MONTHS.indexOf(named[1]) >= 0
      ? MONTHS.indexOf(named[1])
      : MONTH_ABBR.indexOf(named[1]);
    // No year given: use the most recent occurrence of that month.
    const year = named[2] ? Number(named[2]) : idx > mo ? y - 1 : y;
    return {
      start: localMidnight(year, idx, 1),
      end: localMidnight(year, idx + 1, 1),
      label: monthLabel(year, idx),
    };
  }

  const isLast = /\b(last|previous|prev)\b/.test(q);
  const isThis = /\b(this|current)\b/.test(q);

  if (/\bweek\b/.test(q)) {
    // Weeks start on Monday.
    const dow = (new Date(todayStart.getTime() + tzOffsetMinutes() * 60_000).getUTCDay() + 6) % 7;
    const thisWeek = localMidnight(y, mo, d - dow);
    if (isLast) {
      const start = localMidnight(y, mo, d - dow - 7);
      return { start, end: thisWeek, label: "last week" };
    }
    if (isThis) return { start: thisWeek, end: localMidnight(y, mo, d + 1), label: "this week" };
  }

  if (/\bmonth\b/.test(q)) {
    if (isLast) {
      return {
        start: localMidnight(y, mo - 1, 1),
        end: localMidnight(y, mo, 1),
        label: monthLabel(mo === 0 ? y - 1 : y, (mo + 11) % 12),
      };
    }
    if (isThis || /\bmtd\b/.test(q)) {
      return {
        start: localMidnight(y, mo, 1),
        end: localMidnight(y, mo, d + 1),
        label: `${monthLabel(y, mo)} (month to date)`,
      };
    }
  }

  const yearOnly = /\b(?:in|for|during|year)\s+(20\d{2})\b/.exec(q) || /\b(20\d{2})\b/.exec(q);
  if (/\byear\b/.test(q) || /\bytd\b/.test(q) || yearOnly) {
    if (isLast && /\byear\b/.test(q)) {
      return { start: localMidnight(y - 1, 0, 1), end: localMidnight(y, 0, 1), label: String(y - 1) };
    }
    if ((isThis || /\bytd\b/.test(q)) && /\b(year|ytd)\b/.test(q)) {
      return { start: localMidnight(y, 0, 1), end: localMidnight(y, mo, d + 1), label: `${y} (year to date)` };
    }
    if (yearOnly) {
      const yr = Number(yearOnly[1]);
      return { start: localMidnight(yr, 0, 1), end: localMidnight(yr + 1, 0, 1), label: String(yr) };
    }
  }

  return null;
}

/** "1 Aug 2026 - 31 Aug 2026" for a range's printable span (end is exclusive). */
export function formatRangeSpan(range: DateRange): string {
  const fmt = (dt: Date) => {
    const shifted = new Date(dt.getTime() + tzOffsetMinutes() * 60_000);
    const mon = MONTH_ABBR[shifted.getUTCMonth()];
    return `${shifted.getUTCDate()} ${mon[0].toUpperCase()}${mon.slice(1)} ${shifted.getUTCFullYear()}`;
  };
  return `${fmt(range.start)} - ${fmt(new Date(range.end.getTime() - 1))}`;
}
