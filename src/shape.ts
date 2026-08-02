import { resolveColumn, toNumber, type MetricKey } from "./tsv.js";
import type { FetchedReport } from "./types.js";

/** Recursively drop null, undefined, and empty-string fields to save tokens. */
export function stripNulls<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripNulls(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null || v === undefined || v === "") continue;
      out[k] = stripNulls(v);
    }
    return out as T;
  }
  return value;
}

/**
 * Metrics that are counts of events in the reporting period, so they add up
 * across periods.
 */
export const FLOW_METRICS: readonly MetricKey[] = [
  "plays",
  "uniqueListeners",
  "engagedListeners",
  "timeListened",
];

/**
 * Sum a flow metric across every row of one report.
 *
 * Returns undefined — not 0 — when the column is absent, so a missing column
 * reads as "unknown" rather than "zero activity". The two are very different
 * answers to "how many plays did I get".
 */
export function sumMetric(
  report: FetchedReport,
  key: MetricKey,
): number | undefined {
  const column = resolveColumn(report.columns, key);
  if (!column) return undefined;
  let total = 0;
  let sawValue = false;
  for (const row of report.rows) {
    const n = toNumber(row[column]);
    if (n === undefined) continue;
    total += n;
    sawValue = true;
  }
  return sawValue ? total : 0;
}

export interface PeriodPoint {
  date: string;
  rows: number;
  metrics: Partial<Record<MetricKey, number>>;
}

/** Per-period totals, oldest first, plus the sum of each flow metric. */
export function summarize(
  reports: FetchedReport[],
  keys: readonly MetricKey[],
): { series: PeriodPoint[]; totals: Partial<Record<MetricKey, number>> } {
  const series: PeriodPoint[] = [];
  const totals: Partial<Record<MetricKey, number>> = {};

  for (const report of reports) {
    const metrics: Partial<Record<MetricKey, number>> = {};
    for (const key of keys) {
      const value = sumMetric(report, key);
      if (value === undefined) continue;
      metrics[key] = value;
      if (FLOW_METRICS.includes(key)) {
        totals[key] = (totals[key] ?? 0) + value;
      }
    }
    series.push({ date: report.date, rows: report.rows.length, metrics });
  }

  return { series, totals };
}

export interface EpisodeRollup {
  episodeId?: string;
  episodeName?: string;
  plays?: number;
  uniqueListeners?: number;
  engagedListeners?: number;
  timeListened?: number;
}

export type EpisodeSortKey = "plays" | "uniqueListeners" | "engagedListeners";

/**
 * Roll episode-level rows up across every period in the range, keyed by
 * episode id when Apple provides one and by episode name otherwise.
 *
 * Episode reports repeat a row per storefront in the non-worldwide variants,
 * so the same episode appears many times in one report; summing per key is
 * what turns that into a per-episode number.
 */
export function rollupEpisodes(
  reports: FetchedReport[],
  sortBy: EpisodeSortKey,
  limit: number,
): { episodes: EpisodeRollup[]; totalEpisodes: number } {
  const byKey = new Map<string, EpisodeRollup>();

  for (const report of reports) {
    const idCol = resolveColumn(report.columns, "episodeId");
    const nameCol = resolveColumn(report.columns, "episodeName");
    const cols = {
      plays: resolveColumn(report.columns, "plays"),
      uniqueListeners: resolveColumn(report.columns, "uniqueListeners"),
      engagedListeners: resolveColumn(report.columns, "engagedListeners"),
      timeListened: resolveColumn(report.columns, "timeListened"),
    };

    for (const row of report.rows) {
      const id = idCol ? row[idCol] : undefined;
      const name = nameCol ? row[nameCol] : undefined;
      const key = id || name;
      if (!key) continue;

      let entry = byKey.get(key);
      if (!entry) {
        entry = { episodeId: id || undefined, episodeName: name || undefined };
        byKey.set(key, entry);
      }
      // A later report may carry a name the first one lacked.
      if (!entry.episodeName && name) entry.episodeName = name;

      for (const metric of ["plays", "uniqueListeners", "engagedListeners", "timeListened"] as const) {
        const col = cols[metric];
        if (!col) continue;
        const n = toNumber(row[col]);
        if (n === undefined) continue;
        entry[metric] = (entry[metric] ?? 0) + n;
      }
    }
  }

  const all = [...byKey.values()];
  all.sort((a, b) => (b[sortBy] ?? 0) - (a[sortBy] ?? 0));
  return {
    episodes: all.slice(0, Math.max(1, limit)),
    totalEpisodes: all.length,
  };
}

export interface TrendPoint {
  date: string;
  value: number;
}

/**
 * Build a per-period series for one metric, plus first/latest/change.
 *
 * `change` is latest minus first. Whether that is meaningful depends on what
 * Apple's column actually is: if it is a running follower total, the change is
 * net growth over the window; if it is new followers in the period, the series
 * is a flow and `total` is the number to read. Callers surface the resolved
 * column name so the distinction is visible rather than assumed.
 */
export function trend(
  reports: FetchedReport[],
  key: MetricKey,
): {
  points: TrendPoint[];
  first?: number;
  latest?: number;
  change?: number;
  total?: number;
} {
  const points: TrendPoint[] = [];
  for (const report of reports) {
    const value = sumMetric(report, key);
    if (value === undefined) continue;
    points.push({ date: report.date, value });
  }
  if (points.length === 0) return { points };

  const first = points[0].value;
  const latest = points[points.length - 1].value;
  return {
    points,
    first,
    latest,
    change: latest - first,
    total: points.reduce((a, p) => a + p.value, 0),
  };
}
