import type { Period } from "./types.js";

const DAY_MS = 86400000;

/** Format a Date as the string Reporter expects for the given period. */
export function formatReporterDate(date: Date, period: Period): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  if (period === "Monthly") return `${y}${m}`;
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

/** Parse YYYY-MM-DD, YYYYMMDD, YYYY-MM, or YYYYMM into a UTC Date. */
export function parseIsoish(value: string): Date | undefined {
  const compact = value.replace(/-/g, "");
  if (/^\d{8}$/.test(compact)) {
    const iso = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}T00:00:00Z`;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  if (/^\d{6}$/.test(compact)) {
    const iso = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-01T00:00:00Z`;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

/**
 * Build the list of Reporter dates covering [start, end] for a period.
 *
 * Reporter has no range query: one date is one request. `maxDates` is a hard
 * stop so a wide range cannot turn into hundreds of calls against Apple's
 * throttle. When the range exceeds the cap the list is truncated to the most
 * recent `maxDates` entries, and the caller reports the truncation.
 *
 * Weekly reports are keyed by the week's end date, which Apple defines as a
 * Sunday, so the start is snapped *forward* to the first Sunday at or after it
 * and stepped by seven days. Snapping backward would request a week-ending
 * date outside the caller's range. Monthly dates step by calendar month.
 *
 * A Weekly range that contains no Sunday therefore yields an empty list. That
 * is a real answer, not a failure — callers must check for it and say no
 * request was made, rather than reporting it as Apple having no data.
 *
 * Returns dates oldest-first.
 */
export function buildDateList(args: {
  period: Period;
  start: Date;
  end: Date;
  maxDates: number;
}): { dates: string[]; truncated: boolean } {
  const { period, start, end, maxDates } = args;
  const dates: string[] = [];

  if (period === "Monthly") {
    const cursor = new Date(
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1),
    );
    const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
    while (cursor.getTime() <= last.getTime() && dates.length < 10000) {
      dates.push(formatReporterDate(cursor, "Monthly"));
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  } else {
    const step = period === "Weekly" ? 7 : 1;
    let cursorMs = start.getTime();
    if (period === "Weekly") {
      // Snap forward to the first Sunday at or after the start date.
      const dow = new Date(cursorMs).getUTCDay();
      if (dow !== 0) cursorMs += (7 - dow) * DAY_MS;
    }
    while (cursorMs <= end.getTime() && dates.length < 10000) {
      dates.push(formatReporterDate(new Date(cursorMs), period));
      cursorMs += step * DAY_MS;
    }
  }

  if (dates.length > maxDates) {
    return { dates: dates.slice(dates.length - maxDates), truncated: true };
  }
  return { dates, truncated: false };
}

/**
 * Resolve a tool's date arguments into a capped date list.
 *
 * Apple publishes on a lag, so the default end is two days back rather than
 * today: defaulting to today would make every no-argument call return a
 * "no data" gap for the most recent period.
 */
export function resolveRange(args: {
  period: Period;
  start?: string;
  end?: string;
  maxDates: number;
  now?: Date;
}): { dates: string[]; truncated: boolean; start: string; end: string } {
  const now = args.now ?? new Date();
  const defaultEnd = new Date(now.getTime() - 2 * DAY_MS);

  const end = args.end ? parseIsoish(args.end) : defaultEnd;
  if (!end) {
    throw new Error(
      `Could not parse end date "${args.end}". Use YYYY-MM-DD (or YYYY-MM for a monthly period).`,
    );
  }

  // Default spans are sized to land inside the default `max_periods` of 7, so
  // a no-argument call returns a complete window instead of a truncated one.
  // 49 days is exactly 7 week-ending Sundays; 180 days is 6 calendar months.
  const defaultSpanDays =
    args.period === "Monthly" ? 180 : args.period === "Weekly" ? 49 : 7;
  const start = args.start
    ? parseIsoish(args.start)
    : new Date(end.getTime() - (defaultSpanDays - 1) * DAY_MS);
  if (!start) {
    throw new Error(
      `Could not parse start date "${args.start}". Use YYYY-MM-DD (or YYYY-MM for a monthly period).`,
    );
  }

  if (start.getTime() > end.getTime()) {
    throw new Error(
      `Start date (${formatReporterDate(start, args.period)}) is after the end date (${formatReporterDate(end, args.period)}).`,
    );
  }

  const { dates, truncated } = buildDateList({
    period: args.period,
    start,
    end,
    maxDates: args.maxDates,
  });

  return {
    dates,
    truncated,
    start: formatReporterDate(start, args.period),
    end: formatReporterDate(end, args.period),
  };
}
