import { gunzipSync } from "node:zlib";
import {
  mapReporterError,
  NoDataError,
  parseReporterError,
  ReporterError,
} from "./errors.js";
import { parseTsv } from "./tsv.js";
import type {
  FetchedReport,
  MissingReport,
  Period,
  RangeResult,
} from "./types.js";

const SALES_URL =
  "https://reportingitc-reporter.apple.com/reportservice/sales/v1";

/** Reporter protocol version. `generateToken` auth requires 2.2 or later. */
const REPORTER_VERSION = "2.2";

const VERSION = "0.1.0";

/**
 * Client for Apple Podcasts Connect's Reporter service.
 *
 * Reporter is not a REST API. Every call is an HTTP POST of a single
 * form-encoded field, `jsonRequest`, whose value is a JSON document carrying
 * the access token and a bracketed command string:
 *
 *   jsonRequest={"accesstoken":"...","version":"2.2","mode":"Robot.XML",
 *                "queryInput":"[p=Reporter.properties, Sales.getReport, 1234,apShowListening,Summary,Daily,20260731]"}
 *
 * A successful report comes back gzipped (Content-Type: application/a-gzip)
 * with a tab-separated body. Failures come back as XML or text carrying a
 * numeric Reporter code, sometimes under HTTP 200. See `errors.ts`.
 *
 * Ported from a reference Python implementation of the same wire protocol,
 * written to avoid Apple's Reporter.jar. That reference has not itself been
 * exercised against a live Apple account, so treat the request shape as read
 * from Apple's documentation rather than confirmed on the wire.
 */
export class ReporterClient {
  constructor(
    private accessToken: string,
    private vendorId: string,
    private opts: {
      /**
       * Apple account number. Only needed when the access token can read more
       * than one account, which Reporter reports as code 214. Omitted from the
       * payload when empty: Reporter answers an empty `account` with a 404.
       */
      accountId?: string;
      timeoutMs?: number;
    } = {},
  ) {}

  /** The configured account number, if any. Surfaced by the access check. */
  get account(): string | undefined {
    return this.opts.accountId || undefined;
  }

  /** True when both credentials are present. Tools check this before calling. */
  get isConfigured(): boolean {
    return Boolean(this.accessToken && this.vendorId);
  }

  get vendor(): string {
    return this.vendorId;
  }

  /**
   * POST one Reporter command and return the decoded body.
   *
   * `command` is the inner command only ("Sales.getReport, 123,...") — the
   * properties prefix is added here so every call site cannot forget it.
   */
  private async post(
    command: string,
    opts: { mode?: "Robot.XML" | "Normal"; date?: string } = {},
  ): Promise<string> {
    const commandName = command.split(",")[0].trim();
    const jsonRequest = JSON.stringify({
      accesstoken: this.accessToken,
      version: REPORTER_VERSION,
      mode: opts.mode ?? "Robot.XML",
      // Only present when configured. An empty account field is not the same
      // as no account field: Reporter answers the empty one with a 404.
      ...(this.opts.accountId ? { account: this.opts.accountId } : {}),
      queryInput: `[p=Reporter.properties, ${command}]`,
    });

    const body = new URLSearchParams({ jsonRequest }).toString();

    let response: Response;
    try {
      response = await fetch(SALES_URL, {
        method: "POST",
        headers: {
          Accept: "text/html,image/gif,image/jpeg; q=.2, */*; q=.2",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": `apple-podcasts-mcp/${VERSION}`,
        },
        body,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60000),
      });
    } catch (err) {
      throw new ReporterError(
        0,
        `Network error reaching Reporter: ${err instanceof Error ? err.message : String(err)}`,
        commandName,
      );
    }

    const contentType = response.headers.get("content-type") ?? "";
    const buffer = Buffer.from(await response.arrayBuffer());

    if (!response.ok) {
      const { code, message } = parseReporterError(
        buffer.toString("utf-8"),
      );
      throw mapReporterError({
        code,
        message,
        command: commandName,
        httpStatus: response.status,
        vendorId: this.vendorId,
        accountId: this.opts.accountId,
        date: opts.date,
      });
    }

    // Successful reports are gzipped; errors are not, even under HTTP 200.
    if (contentType.includes("a-gzip") || contentType.includes("gzip")) {
      try {
        return gunzipSync(buffer).toString("utf-8");
      } catch (err) {
        throw new ReporterError(
          119,
          `Report was not fully downloaded or could not be decompressed: ${
            err instanceof Error ? err.message : String(err)
          }`,
          commandName,
        );
      }
    }

    const text = buffer.toString("utf-8");

    // Reporter frequently returns an error document under HTTP 200. Anything
    // that carries an <Error>/<Code> envelope is a failure, not a report.
    if (/<Error>|<Code>\s*\d+\s*<\/Code>/i.test(text)) {
      const { code, message } = parseReporterError(text);
      throw mapReporterError({
        code,
        message,
        command: commandName,
        httpStatus: response.status,
        vendorId: this.vendorId,
        accountId: this.opts.accountId,
        date: opts.date,
      });
    }

    return text;
  }

  /**
   * Fetch one listening report for a single Reporter date.
   *
   * `date` is YYYYMMDD for Daily and Weekly, YYYYMM for Monthly.
   */
  async getReport(args: {
    reportType: string;
    period: Period;
    date: string;
  }): Promise<FetchedReport> {
    const command = `Sales.getReport, ${this.vendorId},${args.reportType},Summary,${args.period},${args.date}`;
    const text = await this.post(command, { date: args.date });
    const { columns, rows } = parseTsv(text);
    return { date: args.date, columns, rows };
  }

  /**
   * Fetch a report for each date in `dates`, tolerating the dates Apple has no
   * data for.
   *
   * Every date is a separate Reporter round trip — that is the protocol, not a
   * design choice — so callers must cap the list before getting here. Requests
   * run serially to stay under Apple's throttle. A rate-limit error aborts the
   * whole range rather than hammering through the remaining dates.
   */
  async getReportRange(args: {
    reportType: string;
    period: Period;
    dates: string[];
  }): Promise<RangeResult> {
    const reports: FetchedReport[] = [];
    const missing: MissingReport[] = [];

    for (const date of args.dates) {
      try {
        reports.push(
          await this.getReport({
            reportType: args.reportType,
            period: args.period,
            date,
          }),
        );
      } catch (err) {
        if (err instanceof NoDataError) {
          missing.push({ date, reason: "no report published for this period" });
          continue;
        }
        throw err;
      }
    }

    return { reports, missing };
  }

  /**
   * `Sales.getVendors` — the vendor numbers this token can read. Used by the
   * access check: it is the cheapest call that proves the token works and
   * proves the configured vendor number is one of the token's own.
   */
  async getVendors(): Promise<string[]> {
    const text = await this.post("Sales.getVendors", { mode: "Normal" });
    return text
      .split(/[\r\n,]+/)
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s));
  }

  /**
   * `Sales.viewToken` — best effort. When Apple answers, the body carries the
   * token's expiration date, which is the single most useful thing to show a
   * user (tokens die silently at 180 days). Some Reporter deployments require
   * a password for this command and reject a token-only call, so callers must
   * treat a failure here as "unknown", never as a broken setup.
   */
  async viewToken(): Promise<string | undefined> {
    const text = await this.post("Sales.viewToken", { mode: "Normal" });
    const match = /(\d{4}-\d{2}-\d{2})/.exec(text);
    return match?.[1];
  }
}
