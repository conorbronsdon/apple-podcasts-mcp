/**
 * Reporter podcast listening report types.
 *
 * The tools request the show and episode types only. The channel types are
 * listed because Reporter accepts them and a channel owner will look for them,
 * but nothing here requests one and they are untested against a real account.
 */
export const REPORT_TYPES = {
  episode: "apEpisodeListening",
  "episode-worldwide": "apEpisodeListeningWorldwide",
  show: "apShowListening",
  "show-worldwide": "apShowListeningWorldwide",
  channel: "apChannelListening",
  "channel-worldwide": "apChannelListeningWorldwide",
} as const;

export type ReportKey = keyof typeof REPORT_TYPES;

/** Reporter date types. Daily/Weekly take YYYYMMDD; Monthly takes YYYYMM. */
export const PERIODS = ["Daily", "Weekly", "Monthly"] as const;
export type Period = (typeof PERIODS)[number];

/** One parsed TSV row: header name -> cell value, both as written by Apple. */
export type ReportRow = Record<string, string>;

/** A report fetched for a single Reporter date. */
export interface FetchedReport {
  /** The date string as sent to Reporter (YYYYMMDD or YYYYMM). */
  date: string;
  columns: string[];
  rows: ReportRow[];
}

/** A date that returned no report, with the reason Apple gave. */
export interface MissingReport {
  date: string;
  reason: string;
}

/** Result of fetching a range: the reports that existed plus the gaps. */
export interface RangeResult {
  reports: FetchedReport[];
  missing: MissingReport[];
}
