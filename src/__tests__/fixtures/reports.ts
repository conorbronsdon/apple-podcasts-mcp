import { gzipSync } from "node:zlib";

/**
 * Hand-built response shapes for the Reporter protocol.
 *
 * PROVENANCE, read this before trusting the column names: these bodies were
 * built to match the *shape* Reporter returns (gzipped, tab-separated, one
 * header line, Apple's XML error envelope), taken from the wire behaviour of
 * the reference Python implementation and Apple's Reporter User Guide. Apple
 * does not publish the column names for the podcast listening reports, and
 * these were not captured from a live account. Neither was the reference
 * implementation this server was ported from: no response here, and no request
 * this server makes, has been checked against Apple. The production code never
 * hardcodes a column name for that reason: every metric resolves through the
 * alias table in `src/tsv.ts`, and each tool response reports which column it
 * matched. These fixtures pin the parsing, aggregation, date, and error paths,
 * which is what they are for. They do not certify Apple's schema.
 */

const tsv = (lines: string[][]) => lines.map((l) => l.join("\t")).join("\n") + "\n";

/** apShowListeningWorldwide, Daily. One row per period. */
export const SHOW_WORLDWIDE_TSV = tsv([
  ["Date", "Show Apple ID", "Show Name", "Plays", "Unique Listeners", "Engaged Listeners", "Followers", "Time Listened"],
  ["2026-07-28", "1234567890", "Chain of Thought", "1,204", "812", "540", "9,430", "412300"],
]);

/** The same report a day later, for trend assertions. */
export const SHOW_WORLDWIDE_TSV_DAY2 = tsv([
  ["Date", "Show Apple ID", "Show Name", "Plays", "Unique Listeners", "Engaged Listeners", "Followers", "Time Listened"],
  ["2026-07-29", "1234567890", "Chain of Thought", "1,530", "990", "651", "9,512", "501200"],
]);

/** apShowListening (per-storefront), Daily. Several rows for one period. */
export const SHOW_STOREFRONT_TSV = tsv([
  ["Date", "Storefront Name", "Show Apple ID", "Plays", "Unique Listeners", "Followers"],
  ["2026-07-28", "United States", "1234567890", "800", "540", "6100"],
  ["2026-07-28", "United Kingdom", "1234567890", "260", "170", "2000"],
  ["2026-07-28", "Germany", "1234567890", "144", "102", "1330"],
]);

/** apEpisodeListeningWorldwide, Daily. */
export const EPISODE_WORLDWIDE_TSV = tsv([
  ["Date", "Episode Apple ID", "Episode Name", "Plays", "Unique Listeners", "Engaged Listeners", "Time Listened"],
  ["2026-07-28", "1000712345", "Agent memory is a systems problem", "420", "310", "244", "180000"],
  ["2026-07-28", "1000712346", "What evals actually measure", "610", "455", "390", "260000"],
  ["2026-07-28", "1000712347", "The context window is not the bottleneck", "174", "120", "88", "72300"],
]);

/** The next day's episode report, overlapping episode IDs, for rollup tests. */
export const EPISODE_WORLDWIDE_TSV_DAY2 = tsv([
  ["Date", "Episode Apple ID", "Episode Name", "Plays", "Unique Listeners", "Engaged Listeners", "Time Listened"],
  ["2026-07-29", "1000712345", "Agent memory is a systems problem", "380", "290", "210", "160000"],
  ["2026-07-29", "1000712346", "What evals actually measure", "220", "180", "140", "95000"],
]);

/**
 * A report whose metric columns Apple has renamed. Nothing in the alias table
 * matches "Total Streams", so the tools must report it as unmapped rather than
 * silently returning zero.
 */
export const RENAMED_COLUMNS_TSV = tsv([
  ["Date", "Show Apple ID", "Total Streams", "Widget Score"],
  ["2026-07-28", "1234567890", "1204", "17"],
]);

/**
 * A show report carrying followers and nothing else.
 *
 * Followers is a level, so it never reaches `totals`. A tool that decides
 * "no metric columns found" from empty totals calls this report unreadable
 * while printing its follower numbers in the same response.
 */
export const FOLLOWERS_ONLY_TSV = tsv([
  ["Date", "Show Apple ID", "Followers"],
  ["2026-07-28", "1234567890", "9,430"],
]);

/** Reporter's XML error envelope, returned for a failed command. */
export const errorXml = (code: number, message: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<Error>\n  <Code>${code}</Code>\n  <Message>${message}</Message>\n</Error>\n`;

export const ERROR_TOKEN_EXPIRED = errorXml(123, "Your Access Token is expired");
export const ERROR_TOKEN_INVALID = errorXml(124, "Your Access Token is invalid");
export const ERROR_BAD_VENDOR = errorXml(200, "Invalid vendor number specified");
export const ERROR_NO_DATA = errorXml(213, "There were no sales for the date specified");
export const ERROR_DELAYED = errorXml(117, "Podcast reports are delayed");
export const ERROR_BAD_DATE = errorXml(205, "Invalid date");

/** Sales.getVendors, Normal mode. */
export const VENDORS_TEXT = "87654321\n87654399\n";

/** Sales.viewToken, Normal mode. */
export const VIEW_TOKEN_TEXT =
  "Your access token is active and expires on 2027-01-24.\n";

/** Wrap a TSV body the way Reporter ships a successful report. */
export function gzipReport(body: string): Response {
  const gz = gzipSync(Buffer.from(body, "utf-8"));
  return new Response(gz, {
    status: 200,
    headers: { "content-type": "application/a-gzip" },
  });
}

/** Reporter returns error envelopes as plain text, often under HTTP 200. */
export function errorResponse(xml: string, status = 200): Response {
  return new Response(xml, {
    status,
    headers: { "content-type": "text/xml" },
  });
}

/** Plain text body, as Normal-mode commands return. */
export function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain" },
  });
}
