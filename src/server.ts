import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ReporterClient } from "./client.js";
import { resolveRange } from "./dates.js";
import { ReporterError } from "./errors.js";
import { rollupEpisodes, stripNulls, summarize, trend } from "./shape.js";
import { resolveColumns, unmappedColumns, type MetricKey } from "./tsv.js";
import { PERIODS, REPORT_TYPES, type Period } from "./types.js";

const VERSION = "0.1.0";

const json = (data: unknown) => ({
  content: [
    { type: "text" as const, text: JSON.stringify(stripNulls(data), null, 2) },
  ],
});

const errorResult = (message: string) => ({
  isError: true as const,
  content: [{ type: "text" as const, text: message }],
});

/**
 * Every tool goes through here so a Reporter failure becomes a readable
 * message instead of a stack trace, and so a missing credential is caught
 * before a pointless round trip to Apple.
 */
async function guard(
  client: ReporterClient,
  fn: () => Promise<ReturnType<typeof json>>,
): Promise<ReturnType<typeof json> | ReturnType<typeof errorResult>> {
  if (!client.isConfigured) {
    return errorResult(
      "Apple Podcasts credentials are not configured. Set APPLE_PODCASTS_ACCESS_TOKEN and APPLE_PODCASTS_VENDOR_ID. Both require an Apple Podcasters Program membership — the token comes from Reporter's generateToken command and expires 180 days after you create it. See the README.",
    );
  }
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ReporterError) return errorResult(err.message);
    return errorResult(
      err instanceof Error ? err.message : String(err),
    );
  }
}

const periodArg = z
  .enum(PERIODS)
  .optional()
  .default("Daily")
  .describe(
    "Reporter period. Daily and Weekly take YYYY-MM-DD dates; Monthly takes YYYY-MM. Weekly dates are Apple's week-ending Sundays.",
  );

const startArg = z
  .string()
  .optional()
  .describe(
    "Start of the range, YYYY-MM-DD (or YYYY-MM for Monthly). Defaults to 7 days back for Daily, 7 weeks for Weekly, 6 months for Monthly — each sized to fit the default max_periods of 7.",
  );

const endArg = z
  .string()
  .optional()
  .describe(
    "End of the range, YYYY-MM-DD (or YYYY-MM for Monthly). Defaults to 2 days ago, because Apple publishes reports on a lag.",
  );

const maxPeriodsArg = (fallback: number) =>
  z
    .number()
    .int()
    .optional()
    .default(fallback)
    .describe(
      `How many periods to fetch, cap 31. Reporter has no range query, so each period is a separate call to Apple and a wide range will hit their throttle. Default ${fallback}. Ranges longer than this are truncated to the most recent periods.`,
    );

const PERIOD_CAP = 31;

/**
 * The answer for a range that produced no Reporter dates at all.
 *
 * A Weekly range with no week-ending Sunday in it — say Monday to Friday —
 * expands to zero dates, so nothing is ever sent to Apple. Answering that with
 * the "Apple returned no report" note would invent a cause for a request that
 * never left the process, and send the user looking at Apple's publishing lag
 * for a range they can fix themselves.
 */
const emptyRangeNote = (period: Period, start: string, end: string): string =>
  period === "Weekly"
    ? `No request was made to Apple. Weekly reports are keyed to the Sunday that ends the week, and no Sunday falls between ${start} and ${end}, so this range contains no report date. Widen the range to include a Sunday, or use the Daily period.`
    : `No request was made to Apple: no ${period} report date falls between ${start} and ${end}.`;

/**
 * The metric columns an episode report is expected to carry. Followers is not
 * among them: Apple reports followers for the show, not per episode.
 *
 * Resolving none of these is the signal that Apple renamed the columns, which
 * is what `schemaNote` reports.
 */
const EPISODE_METRICS: readonly MetricKey[] = [
  "plays",
  "uniqueListeners",
  "engagedListeners",
  "timeListened",
];

const SCHEMA_NOTE =
  "None of the known metric columns were found in this report. Apple may have renamed them; see unmappedColumns below for what the report actually contains.";

const SUMMARY_METRICS: readonly MetricKey[] = [
  "plays",
  "uniqueListeners",
  "engagedListeners",
  "followers",
  "timeListened",
];

export function createServer(client: ReporterClient): McpServer {
  const server = new McpServer({
    name: "apple-podcasts-mcp",
    version: VERSION,
  });

  // --- Credential and access check ---

  server.tool(
    "apple_podcasts_check_access",
    "Verify the configured Apple Podcasts Connect credentials and list the vendor numbers this access token can read. Run this first, and run it whenever another tool reports an auth failure: Reporter access tokens expire 180 days after they are generated, and the failure looks like a permissions problem rather than an expiry. Returns no listening data.",
    {},
    async () =>
      guard(client, async () => {
        const vendors = await client.getVendors();
        let tokenExpires: string | undefined;
        let tokenExpiryNote: string | undefined;
        try {
          tokenExpires = await client.viewToken();
        } catch {
          // Sales.viewToken is not available to every account. A failure here
          // says nothing about whether the token works for reports, which
          // getVendors already proved, so it must not fail the whole check.
          tokenExpiryNote =
            "Apple did not return a token expiry for this account. Track the 180-day rotation date yourself.";
        }
        const configured = client.vendor;
        return json({
          tokenWorks: true,
          configuredVendorId: configured,
          configuredAccountId: client.account,
          configuredVendorIsAuthorized: vendors.length
            ? vendors.includes(configured)
            : undefined,
          authorizedVendors: vendors,
          tokenExpires,
          tokenExpiryNote,
        });
      }),
  );

  // --- Show-level summary ---

  server.tool(
    "apple_podcasts_summary",
    "Show-level listening summary from Apple Podcasts Connect over a date range: plays, unique listeners, engaged listeners, and followers, per period and totalled. Apple aggregates listening from unique devices, so listener counts are devices, not people, and an engaged listener is a device that played at least 20 minutes or 40% of an episode. This is the owner-side data Apple's hosting APIs do not expose. Use it for 'how is the show doing on Apple' questions. Keep the range short; each period is a separate call to Apple.",
    {
      period: periodArg,
      start: startArg,
      end: endArg,
      max_periods: maxPeriodsArg(7),
      worldwide: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "Use the worldwide report (one row per period) instead of the per-storefront report (one row per storefront). Worldwide is smaller and is what you want unless you need geography.",
        ),
    },
    async ({ period, start, end, max_periods, worldwide }) =>
      guard(client, async () => {
        const cap = Math.min(Math.max(1, max_periods), PERIOD_CAP);
        const range = resolveRange({
          period: period as Period,
          start,
          end,
          maxDates: cap,
        });
        const reportType = worldwide
          ? REPORT_TYPES["show-worldwide"]
          : REPORT_TYPES.show;

        if (range.dates.length === 0) {
          return json({
            reportType,
            period,
            requestedRange: { start: range.start, end: range.end },
            periodsRequested: 0,
            note: emptyRangeNote(period as Period, range.start, range.end),
          });
        }

        const { reports, missing } = await client.getReportRange({
          reportType,
          period: period as Period,
          dates: range.dates,
        });

        if (reports.length === 0) {
          return json({
            reportType,
            period,
            requestedRange: { start: range.start, end: range.end },
            periodsRequested: range.dates.length,
            note: "Apple returned no report for any period in this range. Reports lag by one to two days and are not published for periods with no activity. Try an earlier range or a Weekly period.",
            missing,
          });
        }

        const columns = reports[0].columns;
        const resolvedColumns = resolveColumns(columns, SUMMARY_METRICS);
        const { series, totals } = summarize(reports, SUMMARY_METRICS);
        // Two different questions. `noMetrics` is "is this report readable at
        // all", which must be answered from the resolved columns — a report
        // carrying only followers resolves a column, produces a series, and
        // still has empty totals, because followers is a level and never sums.
        const noMetrics = Object.keys(resolvedColumns).length === 0;
        const noTotals = Object.keys(totals).length === 0;

        return json({
          reportType,
          period,
          requestedRange: { start: range.start, end: range.end },
          rangeTruncated: range.truncated || undefined,
          periodsReturned: reports.length,
          missingPeriods: missing.length ? missing : undefined,
          schemaNote: noMetrics ? SCHEMA_NOTE : undefined,
          totals: noTotals ? undefined : totals,
          totalsNote: noTotals
            ? undefined
            :
            "Totals sum the flow metrics (plays, listeners, time listened) across periods. Followers is a level, not a flow, so it is reported per period in the series and is deliberately absent from totals.",
          series,
          resolvedColumns,
          unmappedColumns: unmappedColumns(columns),
        });
      }),
  );

  // --- Per-episode consumption ---

  server.tool(
    "apple_podcasts_episodes",
    "Per-episode listening from Apple Podcasts Connect over a date range: plays, unique listeners, and engaged listeners for each episode, rolled up across the range and ranked. Answers 'which episodes held attention on Apple'. Apple aggregates from unique devices, so these are device counts, not headcounts, and an engaged listener is a device that played at least 20 minutes or 40% of an episode — a depth threshold, not a completion. Takes an explicit date range and a row cap; both are required to keep the response bounded.",
    {
      period: periodArg,
      start: startArg,
      end: endArg,
      max_periods: maxPeriodsArg(7),
      limit: z
        .number()
        .int()
        .optional()
        .default(10)
        .describe("Max episodes to return, ranked by sort_by. Default 10, cap 50."),
      sort_by: z
        .enum(["plays", "uniqueListeners", "engagedListeners"])
        .optional()
        .default("plays")
        .describe("Which metric ranks the episodes. Default plays."),
      worldwide: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "Use the worldwide episode report instead of the per-storefront one. Per-storefront repeats every episode once per country, which is far more rows for the same totals.",
        ),
    },
    async ({ period, start, end, max_periods, limit, sort_by, worldwide }) =>
      guard(client, async () => {
        const cap = Math.min(Math.max(1, max_periods), PERIOD_CAP);
        const rowCap = Math.min(Math.max(1, limit), 50);
        const range = resolveRange({
          period: period as Period,
          start,
          end,
          maxDates: cap,
        });
        const reportType = worldwide
          ? REPORT_TYPES["episode-worldwide"]
          : REPORT_TYPES.episode;

        if (range.dates.length === 0) {
          return json({
            reportType,
            period,
            requestedRange: { start: range.start, end: range.end },
            periodsRequested: 0,
            note: emptyRangeNote(period as Period, range.start, range.end),
          });
        }

        const { reports, missing } = await client.getReportRange({
          reportType,
          period: period as Period,
          dates: range.dates,
        });

        if (reports.length === 0) {
          return json({
            reportType,
            period,
            requestedRange: { start: range.start, end: range.end },
            note: "Apple returned no episode report for any period in this range. Reports lag by one to two days. Try an earlier range.",
            missing,
          });
        }

        const columns = reports[0].columns;
        const resolvedColumns = resolveColumns(columns, [
          "episodeId",
          "episodeName",
          ...EPISODE_METRICS,
        ]);
        // Same drift signal the summary tool emits. Without it a renamed
        // metric column returns episodes with no numbers and no explanation.
        const noMetrics = EPISODE_METRICS.every((k) => !resolvedColumns[k]);
        const { episodes, totalEpisodes } = rollupEpisodes(
          reports,
          sort_by,
          rowCap,
        );

        return json({
          reportType,
          period,
          requestedRange: { start: range.start, end: range.end },
          rangeTruncated: range.truncated || undefined,
          periodsReturned: reports.length,
          missingPeriods: missing.length ? missing : undefined,
          sortedBy: sort_by,
          schemaNote: noMetrics ? SCHEMA_NOTE : undefined,
          totalEpisodes,
          returned: episodes.length,
          episodes,
          resolvedColumns,
          unmappedColumns: unmappedColumns(columns),
        });
      }),
  );

  // --- Follower trend ---

  server.tool(
    "apple_podcasts_followers",
    "Follower trend for the show on Apple Podcasts over a date range: one value per period plus the change across the window. Use it for 'is my Apple following growing'. Read the resolvedColumn field in the response before interpreting the numbers: Apple's follower column has been both a running total and a per-period count, and which one you get changes what 'change' means.",
    {
      period: periodArg,
      start: startArg,
      end: endArg,
      max_periods: maxPeriodsArg(14),
    },
    async ({ period, start, end, max_periods }) =>
      guard(client, async () => {
        const cap = Math.min(Math.max(1, max_periods), PERIOD_CAP);
        const range = resolveRange({
          period: period as Period,
          start,
          end,
          maxDates: cap,
        });

        if (range.dates.length === 0) {
          return json({
            period,
            requestedRange: { start: range.start, end: range.end },
            periodsRequested: 0,
            note: emptyRangeNote(period as Period, range.start, range.end),
          });
        }

        const { reports, missing } = await client.getReportRange({
          reportType: REPORT_TYPES["show-worldwide"],
          period: period as Period,
          dates: range.dates,
        });

        if (reports.length === 0) {
          return json({
            period,
            requestedRange: { start: range.start, end: range.end },
            note: "Apple returned no show report for any period in this range.",
            missing,
          });
        }

        const columns = reports[0].columns;
        const resolved = resolveColumns(columns, ["followers"]);
        const series = trend(reports, "followers");

        if (!resolved.followers) {
          return json({
            period,
            requestedRange: { start: range.start, end: range.end },
            periodsReturned: reports.length,
            note: "No follower column in this report. Apple's show listening report did not include a column matching any known follower field name, so follower numbers are unavailable for this account or report version.",
            availableColumns: columns,
          });
        }

        return json({
          period,
          requestedRange: { start: range.start, end: range.end },
          rangeTruncated: range.truncated || undefined,
          periodsReturned: reports.length,
          missingPeriods: missing.length ? missing : undefined,
          resolvedColumn: resolved.followers,
          first: series.first,
          latest: series.latest,
          change: series.change,
          sumAcrossPeriods: series.total,
          interpretationNote:
            "If resolvedColumn is a running follower total, read `change`. If it is a per-period new-follower count, read `sumAcrossPeriods` and ignore `change`.",
          series: series.points,
        });
      }),
  );

  return server;
}
