import { afterEach, describe, expect, it, vi } from "vitest";
import { ReporterClient } from "../client.js";
import {
  NoDataError,
  RateLimitError,
  ReporterError,
  TokenExpiredError,
  VendorError,
} from "../errors.js";
import {
  ERROR_BAD_VENDOR,
  ERROR_DELAYED,
  ERROR_NO_DATA,
  ERROR_NO_DATA_TEXT,
  ERROR_TOKEN_EXPIRED,
  ERROR_TOKEN_EXPIRED_JSON,
  ERROR_TOKEN_EXPIRED_TEXT,
  errorResponse,
  gzipReport,
  HTML_BLOCK_PAGE_ECHOING_TOKEN,
  HTML_MAINTENANCE_PAGE,
  htmlResponse,
  SHOW_WORLDWIDE_TSV,
  textResponse,
  VENDORS_TEXT,
  VIEW_TOKEN_TEXT,
} from "./fixtures/reports.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Capture the requests the client makes so the wire format can be asserted. */
function stubFetch(responder: (call: number) => Response) {
  const calls: { url: string; body: string; headers: Record<string, string> }[] =
    [];
  let n = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({
        url,
        body: String(init.body),
        headers: init.headers as Record<string, string>,
      });
      return responder(n++);
    }),
  );
  return calls;
}

/** Pull the decoded jsonRequest object out of a captured form body. */
function jsonRequestOf(body: string): Record<string, string> {
  const params = new URLSearchParams(body);
  return JSON.parse(params.get("jsonRequest") ?? "{}");
}

describe("wire protocol", () => {
  it("POSTs a form-encoded jsonRequest, not JSON or a REST path", async () => {
    const calls = stubFetch(() => gzipReport(SHOW_WORLDWIDE_TSV));
    const client = new ReporterClient("tok", "87654321");
    await client.getReport({
      reportType: "apShowListeningWorldwide",
      period: "Daily",
      date: "20260728",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      "https://reportingitc-reporter.apple.com/reportservice/sales/v1",
    );
    expect(calls[0].headers["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    // The whole request is one form field.
    expect([...new URLSearchParams(calls[0].body).keys()]).toEqual([
      "jsonRequest",
    ]);
  });

  it("sends version 2.2 and the access token inside the JSON payload", async () => {
    const calls = stubFetch(() => gzipReport(SHOW_WORLDWIDE_TSV));
    await new ReporterClient("secret-token", "87654321").getReport({
      reportType: "apShowListeningWorldwide",
      period: "Daily",
      date: "20260728",
    });

    const payload = jsonRequestOf(calls[0].body);
    // generateToken auth requires Reporter 2.2 or later; an older version
    // string makes Apple reject the token outright (code 115/121).
    expect(payload.version).toBe("2.2");
    expect(payload.accesstoken).toBe("secret-token");
    expect(payload.mode).toBe("Robot.XML");
  });

  it("wraps the command in the bracketed properties form Apple requires", async () => {
    const calls = stubFetch(() => gzipReport(SHOW_WORLDWIDE_TSV));
    await new ReporterClient("tok", "87654321").getReport({
      reportType: "apEpisodeListening",
      period: "Weekly",
      date: "20260726",
    });

    expect(jsonRequestOf(calls[0].body).queryInput).toBe(
      "[p=Reporter.properties, Sales.getReport, 87654321,apEpisodeListening,Summary,Weekly,20260726]",
    );
  });

  it("omits the account field unless one is configured, and sends it when it is", async () => {
    // Reporter answers an empty account field with a 404, so "not configured"
    // has to mean "absent", not "empty string". A token with access to several
    // accounts fails with code 214 until this is set.
    let calls = stubFetch(() => gzipReport(SHOW_WORLDWIDE_TSV));
    await new ReporterClient("tok", "87654321").getReport({
      reportType: "apShowListeningWorldwide",
      period: "Daily",
      date: "20260728",
    });
    expect("account" in jsonRequestOf(calls[0].body)).toBe(false);

    vi.unstubAllGlobals();
    calls = stubFetch(() => gzipReport(SHOW_WORLDWIDE_TSV));
    await new ReporterClient("tok", "87654321", {
      accountId: "2011425",
    }).getReport({
      reportType: "apShowListeningWorldwide",
      period: "Daily",
      date: "20260728",
    });
    expect(jsonRequestOf(calls[0].body).account).toBe("2011425");
  });

  it("gunzips an application/a-gzip report body", async () => {
    stubFetch(() => gzipReport(SHOW_WORLDWIDE_TSV));
    const report = await new ReporterClient("tok", "87654321").getReport({
      reportType: "apShowListeningWorldwide",
      period: "Daily",
      date: "20260728",
    });
    expect(report.columns).toContain("Plays");
    expect(report.rows[0].Plays).toBe("1,204");
    expect(report.date).toBe("20260728");
  });
});

describe("error handling", () => {
  const failWith = async (xml: string, status = 200) => {
    stubFetch(() => errorResponse(xml, status));
    return new ReporterClient("tok", "87654321")
      .getReport({
        reportType: "apShowListeningWorldwide",
        period: "Daily",
        date: "20260728",
      })
      .then(
        () => {
          throw new Error("expected a rejection");
        },
        (e) => e,
      );
  };

  it("treats an error envelope under HTTP 200 as a failure", async () => {
    // Reporter routinely returns errors with a 200 status. Trusting response.ok
    // would parse the XML envelope as a TSV report and return nonsense rows.
    const err = await failWith(ERROR_TOKEN_EXPIRED, 200);
    expect(err).toBeInstanceOf(TokenExpiredError);
  });

  it("surfaces an expired token distinctly from a bad vendor number", async () => {
    expect(await failWith(ERROR_TOKEN_EXPIRED)).toBeInstanceOf(TokenExpiredError);
    expect(await failWith(ERROR_BAD_VENDOR)).toBeInstanceOf(VendorError);
  });

  it("surfaces no-data and throttling as their own types", async () => {
    expect(await failWith(ERROR_NO_DATA)).toBeInstanceOf(NoDataError);
    expect(await failWith(ERROR_DELAYED)).toBeInstanceOf(RateLimitError);
  });

  it("maps a bare HTTP failure with no parseable body", async () => {
    const err = await failWith("gateway timeout", 503);
    expect(err).toBeInstanceOf(RateLimitError);
  });

  it("wraps a network failure instead of leaking a fetch TypeError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const err = await new ReporterClient("tok", "87654321")
      .getReport({
        reportType: "apShowListeningWorldwide",
        period: "Daily",
        date: "20260728",
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ReporterError);
    expect(err.message).toMatch(/Network error reaching Reporter/);
  });
});

describe("getReportRange", () => {
  it("makes one call per date and returns them oldest-first", async () => {
    const calls = stubFetch(() => gzipReport(SHOW_WORLDWIDE_TSV));
    const { reports, missing } = await new ReporterClient(
      "tok",
      "87654321",
    ).getReportRange({
      reportType: "apShowListeningWorldwide",
      period: "Daily",
      dates: ["20260726", "20260727", "20260728"],
    });

    expect(calls).toHaveLength(3);
    expect(reports.map((r) => r.date)).toEqual([
      "20260726",
      "20260727",
      "20260728",
    ]);
    expect(missing).toEqual([]);
  });

  it("records a no-data date as missing and keeps going", async () => {
    stubFetch((n) =>
      n === 1 ? errorResponse(ERROR_NO_DATA) : gzipReport(SHOW_WORLDWIDE_TSV),
    );
    const { reports, missing } = await new ReporterClient(
      "tok",
      "87654321",
    ).getReportRange({
      reportType: "apShowListeningWorldwide",
      period: "Daily",
      dates: ["20260726", "20260727", "20260728"],
    });

    expect(reports.map((r) => r.date)).toEqual(["20260726", "20260728"]);
    expect(missing).toEqual([
      { date: "20260727", reason: "no report published for this period" },
    ]);
  });

  it("aborts the range on a rate limit rather than hammering the rest", async () => {
    const calls = stubFetch((n) =>
      n === 1 ? errorResponse(ERROR_DELAYED) : gzipReport(SHOW_WORLDWIDE_TSV),
    );
    await expect(
      new ReporterClient("tok", "87654321").getReportRange({
        reportType: "apShowListeningWorldwide",
        period: "Daily",
        dates: ["20260726", "20260727", "20260728", "20260729"],
      }),
    ).rejects.toBeInstanceOf(RateLimitError);
    expect(calls).toHaveLength(2);
  });
});

describe("getVendors and viewToken", () => {
  it("returns only numeric vendor ids from the Normal-mode body", async () => {
    const calls = stubFetch(() => textResponse(VENDORS_TEXT));
    const vendors = await new ReporterClient("tok", "87654321").getVendors();
    expect(vendors).toEqual(["87654321", "87654399"]);
    expect(jsonRequestOf(calls[0].body).mode).toBe("Normal");
  });

  it("extracts the token expiry date from viewToken", async () => {
    stubFetch(() => textResponse(VIEW_TOKEN_TEXT));
    expect(await new ReporterClient("tok", "87654321").viewToken()).toBe(
      "2027-01-24",
    );
  });
});

describe("non-XML error envelopes under HTTP 200", () => {
  it("throws on a plain-text error instead of parsing it as a vendor list", async () => {
    stubFetch(() => textResponse(ERROR_TOKEN_EXPIRED_TEXT));
    await expect(
      new ReporterClient("tok", "87654321").getVendors(),
    ).rejects.toBeInstanceOf(TokenExpiredError);
  });

  it("throws on a JSON error instead of parsing it as a vendor list", async () => {
    stubFetch(() => textResponse(ERROR_TOKEN_EXPIRED_JSON));
    await expect(
      new ReporterClient("tok", "87654321").getVendors(),
    ).rejects.toBeInstanceOf(TokenExpiredError);
  });

  it("treats a plain-text no-data error as a missing period, not a report", async () => {
    stubFetch((n) =>
      n === 0 ? textResponse(ERROR_NO_DATA_TEXT) : gzipReport(SHOW_WORLDWIDE_TSV),
    );
    const { reports, missing } = await new ReporterClient(
      "tok",
      "87654321",
    ).getReportRange({
      reportType: "apShowListeningWorldwide",
      period: "Daily",
      dates: ["20260727", "20260728"],
    });
    expect(missing).toEqual([
      { date: "20260727", reason: "no report published for this period" },
    ]);
    expect(reports.map((r) => r.date)).toEqual(["20260728"]);
  });
});

describe("getVendors on a body that is not a vendor list", () => {
  const NOT_A_VENDOR_LIST =
    "Apple Reporter error (0) on Sales.getVendors: Reporter answered with a body that is not a vendor list and carries no Reporter error code, so the token could not be verified. This is usually an HTML maintenance page, a proxy or firewall block page, or a captive portal rather than Apple's Reporter service. Retry later, or from a network that reaches reportingitc-reporter.apple.com directly. Body began: ";

  it("throws on an HTML maintenance page under HTTP 200 instead of returning []", async () => {
    stubFetch(() => htmlResponse(HTML_MAINTENANCE_PAGE));
    const err = await new ReporterClient("tok", "87654321")
      .getVendors()
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(ReporterError);
    const re = err as ReporterError;
    expect(re.code).toBe(0);
    expect(re.command).toBe("Sales.getVendors");
    expect(re.message).toBe(
      NOT_A_VENDOR_LIST + HTML_MAINTENANCE_PAGE.trim().slice(0, 200),
    );
  });

  it("redacts a token mirrored back in the body it quotes", async () => {
    stubFetch(() => htmlResponse(HTML_BLOCK_PAGE_ECHOING_TOKEN));
    const err = (await new ReporterClient("tok", "87654321")
      .getVendors()
      .catch((e: unknown) => e)) as ReporterError;
    expect(err.message).toBe(
      NOT_A_VENDOR_LIST + "<html><body>Request blocked: jsonRequest=[redacted]",
    );
    expect(err.message).not.toContain("example-token-abc123");
  });

  it("still returns the exact vendor numbers from a CRLF- or comma-separated list", async () => {
    stubFetch(() => textResponse("87654321\r\n87654399, 87650000\r\n"));
    expect(await new ReporterClient("tok", "87654321").getVendors()).toEqual([
      "87654321",
      "87654399",
      "87650000",
    ]);
  });

  it("keeps an empty body as an empty list: Reporter's zero-vendor answer is unconfirmed", async () => {
    stubFetch(() => textResponse(" \n"));
    expect(await new ReporterClient("tok", "87654321").getVendors()).toEqual([]);
  });
});

describe("isConfigured", () => {
  it("requires both a token and a vendor number", () => {
    expect(new ReporterClient("tok", "87654321").isConfigured).toBe(true);
    expect(new ReporterClient("", "87654321").isConfigured).toBe(false);
    expect(new ReporterClient("tok", "").isConfigured).toBe(false);
  });
});
