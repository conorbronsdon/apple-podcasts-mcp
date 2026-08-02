import type { ReportRow } from "./types.js";

/**
 * Parse a Reporter TSV body into a header list plus row objects.
 *
 * Reporter reports are tab-separated with a single header line and no quoting
 * — Apple escapes nothing, so a naive split is correct here and a CSV parser
 * would be wrong (it would treat a quote character in an episode title as a
 * delimiter). Rows with a different column count than the header are kept and
 * zipped positionally; a truncated trailing row is more useful than a throw.
 */
export function parseTsv(text: string): { columns: string[]; rows: ReportRow[] } {
  const lines = text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);

  if (lines.length === 0) return { columns: [], rows: [] };

  const columns = lines[0].split("\t").map((c) => c.trim());
  const rows: ReportRow[] = [];

  for (const line of lines.slice(1)) {
    const cells = line.split("\t");
    const row: ReportRow = {};
    for (let i = 0; i < columns.length; i++) {
      row[columns[i]] = (cells[i] ?? "").trim();
    }
    rows.push(row);
  }

  return { columns, rows };
}

/** Lowercase and strip everything but letters and digits, for header matching. */
export function normalizeHeader(header: string): string {
  return header.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Column aliases for the fields this server surfaces.
 *
 * Apple does not publish the column names for the podcast listening reports,
 * and has renamed columns between report versions before. Rather than hardcode
 * one spelling and silently return zeros when Apple changes it, every metric
 * resolves through an alias list, and every tool response reports which column
 * it actually matched (`resolvedColumns`) plus the columns it did not
 * recognize (`unmappedColumns`). If Apple ships a new name, the response shows
 * the mismatch instead of hiding it.
 */
export const COLUMN_ALIASES = {
  plays: ["plays", "totalplays", "playcount", "playscount"],
  uniqueListeners: [
    "uniquelisteners",
    "listeners",
    "totallisteners",
    "uniquelistenercount",
  ],
  engagedListeners: ["engagedlisteners", "engagedlistenercount"],
  followers: [
    "followers",
    "totalfollowers",
    "followercount",
    "newfollowers",
    "subscribers",
  ],
  timeListened: [
    "timelistened",
    "totaltimelistened",
    "listeningtime",
    "timelistenedseconds",
  ],
  episodeId: ["episodeappleid", "episodeid", "appleid"],
  episodeName: ["episodename", "episodetitle", "title", "name"],
  episodeGuid: ["episodeguid", "guid"],
  showId: ["showappleid", "showid"],
  showName: ["showname", "showtitle"],
  date: ["date", "reportdate", "day", "startdate", "periodstart"],
  storefront: ["storefront", "storefrontname", "country", "countrycode"],
} as const;

export type MetricKey = keyof typeof COLUMN_ALIASES;

/**
 * Find which of `columns` corresponds to `key`, or undefined if none does.
 * Returns the column name exactly as Apple wrote it, so callers can index rows.
 */
export function resolveColumn(
  columns: string[],
  key: MetricKey,
): string | undefined {
  const aliases: readonly string[] = COLUMN_ALIASES[key];
  for (const alias of aliases) {
    const hit = columns.find((c) => normalizeHeader(c) === alias);
    if (hit) return hit;
  }
  return undefined;
}

/** Resolve every metric key against a header list. Missing keys are omitted. */
export function resolveColumns(
  columns: string[],
  keys: readonly MetricKey[],
): Partial<Record<MetricKey, string>> {
  const out: Partial<Record<MetricKey, string>> = {};
  for (const key of keys) {
    const hit = resolveColumn(columns, key);
    if (hit) out[key] = hit;
  }
  return out;
}

/** Columns that matched no known alias — surfaced so schema drift is visible. */
export function unmappedColumns(columns: string[]): string[] {
  const known = new Set(
    Object.values(COLUMN_ALIASES).flatMap((aliases) => aliases as readonly string[]),
  );
  return columns.filter((c) => !known.has(normalizeHeader(c)));
}

/**
 * Read a numeric cell. Apple writes thousands separators in some reports and
 * an empty cell for zero in others; both must read as a number, and anything
 * genuinely non-numeric must read as undefined rather than NaN or 0 (a
 * silent 0 would be indistinguishable from real zero activity).
 */
export function toNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const cleaned = value.replace(/[,\s]/g, "");
  if (cleaned === "") return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}
