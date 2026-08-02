import { afterEach, describe, expect, it, vi } from "vitest";
import { ReporterClient } from "../client.js";
import { createServer } from "../server.js";
import {
  EPISODE_WORLDWIDE_TSV,
  EPISODE_WORLDWIDE_TSV_DAY2,
  ERROR_NO_DATA,
  ERROR_TOKEN_EXPIRED,
  errorResponse,
  FOLLOWERS_ONLY_TSV,
  gzipReport,
  RENAMED_COLUMNS_TSV,
  SHOW_WORLDWIDE_TSV,
  SHOW_WORLDWIDE_TSV_DAY2,
  textResponse,
  VENDORS_TEXT,
  VIEW_TOKEN_TEXT,
} from "./fixtures/reports.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Drive a registered MCP tool's handler directly and parse its result. The MCP
 * SDK stores registered tools on `_registeredTools`; each has a `handler`. The
 * SDK applies zod defaults before dispatch, so parse the input schema here too
 * and exercise the real input path rather than raw args.
 */
async function callTool(
  server: ReturnType<typeof createServer>,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ isError: boolean; text: string; data: any }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tools = (server as any)._registeredTools as Record<string, any>;
  const tool = tools[name];
  if (!tool) throw new Error(`tool ${name} not registered`);
  const parsed = tool.inputSchema ? tool.inputSchema.parse(args) : args;
  const result = await tool.handler(parsed, {} as any);
  const text = result.content[0].text as string;
  return {
    isError: Boolean(result.isError),
    text,
    data: result.isError ? undefined : JSON.parse(text),
  };
}

function stubFetch(responder: (call: number) => Response) {
  const bodies: string[] = [];
  let n = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return responder(n++);
    }),
  );
  return bodies;
}

const queryInputOf = (body: string) =>
  JSON.parse(new URLSearchParams(body).get("jsonRequest") ?? "{}").queryInput as string;

const client = () => new ReporterClient("tok", "87654321");

describe("tool registration", () => {
  it("registers exactly the four bounded tools and no raw dump tool", async () => {
    const server = createServer(client());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const names = Object.keys((server as any)._registeredTools).sort();
    expect(names).toEqual([
      "apple_podcasts_check_access",
      "apple_podcasts_episodes",
      "apple_podcasts_followers",
      "apple_podcasts_summary",
    ]);
  });
});

describe("missing credentials", () => {
  it("fails every data tool with a specific message and makes no request", async () => {
    const bodies = stubFetch(() => gzipReport(SHOW_WORLDWIDE_TSV));
    const server = createServer(new ReporterClient("", ""));
    for (const name of [
      "apple_podcasts_summary",
      "apple_podcasts_episodes",
      "apple_podcasts_followers",
      "apple_podcasts_check_access",
    ]) {
      const res = await callTool(server, name);
      expect(res.isError).toBe(true);
      expect(res.text).toMatch(/APPLE_PODCASTS_ACCESS_TOKEN/);
      expect(res.text).toMatch(/180 days/);
    }
    expect(bodies).toHaveLength(0);
  });
});

describe("apple_podcasts_summary", () => {
  it("sums flow metrics across periods and keeps followers out of totals", async () => {
    stubFetch((n) =>
      gzipReport(n === 0 ? SHOW_WORLDWIDE_TSV : SHOW_WORLDWIDE_TSV_DAY2),
    );
    const { data } = await callTool(createServer(client()), "apple_podcasts_summary", {
      start: "2026-07-28",
      end: "2026-07-29",
    });

    expect(data.periodsReturned).toBe(2);
    expect(data.totals.plays).toBe(1204 + 1530);
    expect(data.totals.uniqueListeners).toBe(812 + 990);
    // Followers is a level. Summing 9,430 + 9,512 would report ~19k followers
    // for a show with ~9.5k, so it must not appear in totals.
    expect(data.totals.followers).toBeUndefined();
    expect(data.series[0].metrics.followers).toBe(9430);
    expect(data.series[1].metrics.followers).toBe(9512);
  });

  it("requests the worldwide report by default and the storefront one on request", async () => {
    let bodies = stubFetch(() => gzipReport(SHOW_WORLDWIDE_TSV));
    await callTool(createServer(client()), "apple_podcasts_summary", {
      start: "2026-07-28",
      end: "2026-07-28",
    });
    expect(queryInputOf(bodies[0])).toContain("apShowListeningWorldwide");

    vi.unstubAllGlobals();
    bodies = stubFetch(() => gzipReport(SHOW_WORLDWIDE_TSV));
    await callTool(createServer(client()), "apple_podcasts_summary", {
      start: "2026-07-28",
      end: "2026-07-28",
      worldwide: false,
    });
    expect(queryInputOf(bodies[0])).toContain(",apShowListening,");
  });

  it("caps the number of Apple calls no matter how wide the range", async () => {
    const bodies = stubFetch(() => gzipReport(SHOW_WORLDWIDE_TSV));
    const { data } = await callTool(
      createServer(client()),
      "apple_podcasts_summary",
      { start: "2026-01-01", end: "2026-07-30", max_periods: 3 },
    );
    expect(bodies).toHaveLength(3);
    expect(data.rangeTruncated).toBe(true);
  });

  it("clamps max_periods to the hard cap of 31", async () => {
    const bodies = stubFetch(() => gzipReport(SHOW_WORLDWIDE_TSV));
    await callTool(createServer(client()), "apple_podcasts_summary", {
      start: "2026-01-01",
      end: "2026-07-30",
      max_periods: 5000,
    });
    expect(bodies).toHaveLength(31);
  });

  it("reports missing periods instead of pretending the range was complete", async () => {
    stubFetch((n) =>
      n === 1 ? errorResponse(ERROR_NO_DATA) : gzipReport(SHOW_WORLDWIDE_TSV),
    );
    const { data } = await callTool(
      createServer(client()),
      "apple_podcasts_summary",
      { start: "2026-07-26", end: "2026-07-28" },
    );
    expect(data.periodsReturned).toBe(2);
    expect(data.missingPeriods).toEqual([
      { date: "20260727", reason: "no report published for this period" },
    ]);
  });

  it("explains an empty range rather than returning zeros", async () => {
    stubFetch(() => errorResponse(ERROR_NO_DATA));
    const { data } = await callTool(
      createServer(client()),
      "apple_podcasts_summary",
      { start: "2026-07-28", end: "2026-07-28" },
    );
    expect(data.totals).toBeUndefined();
    expect(data.note).toMatch(/lag/i);
  });

  it("surfaces an expired token as a tool error naming the rotation", async () => {
    stubFetch(() => errorResponse(ERROR_TOKEN_EXPIRED));
    const res = await callTool(createServer(client()), "apple_podcasts_summary", {
      start: "2026-07-28",
      end: "2026-07-28",
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/180 days/);
    expect(res.text).toMatch(/Podcasts Connect/);
  });

  it("flags renamed columns rather than silently reporting nothing", async () => {
    stubFetch(() => gzipReport(RENAMED_COLUMNS_TSV));
    const { data } = await callTool(
      createServer(client()),
      "apple_podcasts_summary",
      { start: "2026-07-28", end: "2026-07-28" },
    );
    expect(data.totals).toBeUndefined();
    expect(data.schemaNote).toMatch(/renamed/);
    expect(data.unmappedColumns).toContain("Total Streams");
    expect(data.resolvedColumns.plays).toBeUndefined();
  });

  it("reads a followers-only report instead of calling it unreadable", async () => {
    // Followers never enters `totals` (it is a level, not a flow), so deciding
    // "no metric columns found" from empty totals contradicts the series in
    // the same response. The renamed-column test cannot catch this: there,
    // totals and resolved columns are both empty.
    stubFetch(() => gzipReport(FOLLOWERS_ONLY_TSV));
    const { data } = await callTool(
      createServer(client()),
      "apple_podcasts_summary",
      { start: "2026-07-28", end: "2026-07-28" },
    );

    expect(data.series[0].metrics.followers).toBe(9430);
    expect(data.resolvedColumns.followers).toBe("Followers");
    expect(data.schemaNote).toBeUndefined();
    // No flow metric resolved, so there is genuinely nothing to total.
    expect(data.totals).toBeUndefined();
    expect(data.totalsNote).toBeUndefined();
  });

  it("says no request was made when a Weekly range holds no Sunday", async () => {
    // 2026-07-27 is a Monday and 2026-07-31 a Friday, so the range expands to
    // zero week-ending dates. Blaming Apple's publishing lag here would
    // explain a request that never left the process.
    const bodies = stubFetch(() => gzipReport(SHOW_WORLDWIDE_TSV));
    const { data } = await callTool(
      createServer(client()),
      "apple_podcasts_summary",
      { period: "Weekly", start: "2026-07-27", end: "2026-07-31" },
    );

    expect(bodies).toHaveLength(0);
    expect(data.periodsRequested).toBe(0);
    expect(data.note).toMatch(/No request was made to Apple/);
    expect(data.note).toMatch(/Sunday/);
    expect(data.note).not.toMatch(/lag/i);
  });

  it("rejects an unparseable date with a readable error", async () => {
    stubFetch(() => gzipReport(SHOW_WORLDWIDE_TSV));
    const res = await callTool(createServer(client()), "apple_podcasts_summary", {
      start: "last tuesday",
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/Could not parse start date/);
  });
});

describe("apple_podcasts_episodes", () => {
  it("rolls the same episode up across periods and ranks by plays", async () => {
    stubFetch((n) =>
      gzipReport(n === 0 ? EPISODE_WORLDWIDE_TSV : EPISODE_WORLDWIDE_TSV_DAY2),
    );
    const { data } = await callTool(
      createServer(client()),
      "apple_podcasts_episodes",
      { start: "2026-07-28", end: "2026-07-29" },
    );

    expect(data.totalEpisodes).toBe(3);
    expect(data.episodes[0].episodeName).toBe("What evals actually measure");
    expect(data.episodes[0].plays).toBe(610 + 220);
    expect(data.episodes[1].plays).toBe(420 + 380);
    // The episode present in only one period must survive, not be dropped.
    expect(data.episodes[2].plays).toBe(174);
  });

  it("honors sort_by", async () => {
    stubFetch(() => gzipReport(EPISODE_WORLDWIDE_TSV));
    const { data } = await callTool(
      createServer(client()),
      "apple_podcasts_episodes",
      { start: "2026-07-28", end: "2026-07-28", sort_by: "engagedListeners" },
    );
    expect(data.sortedBy).toBe("engagedListeners");
    expect(data.episodes[0].engagedListeners).toBe(390);
  });

  it("flags renamed metric columns rather than returning rows with no numbers", async () => {
    stubFetch(() => gzipReport(RENAMED_COLUMNS_TSV));
    const { data } = await callTool(
      createServer(client()),
      "apple_podcasts_episodes",
      { start: "2026-07-28", end: "2026-07-28" },
    );
    expect(data.schemaNote).toMatch(/renamed/);
    expect(data.unmappedColumns).toContain("Total Streams");
    expect(data.resolvedColumns.plays).toBeUndefined();
  });

  it("says no request was made when a Weekly range holds no Sunday", async () => {
    const bodies = stubFetch(() => gzipReport(EPISODE_WORLDWIDE_TSV));
    const { data } = await callTool(
      createServer(client()),
      "apple_podcasts_episodes",
      { period: "Weekly", start: "2026-07-27", end: "2026-07-31" },
    );
    expect(bodies).toHaveLength(0);
    expect(data.note).toMatch(/No request was made to Apple/);
  });

  it("caps returned rows at 50 while still reporting the true episode count", async () => {
    const header =
      "Date\tEpisode Apple ID\tEpisode Name\tPlays\tUnique Listeners\tEngaged Listeners\n";
    const rows = Array.from(
      { length: 200 },
      (_, i) => `2026-07-28\t100${i}\tEp ${i}\t${200 - i}\t10\t5`,
    ).join("\n");
    stubFetch(() => gzipReport(header + rows + "\n"));

    const { data } = await callTool(
      createServer(client()),
      "apple_podcasts_episodes",
      { start: "2026-07-28", end: "2026-07-28", limit: 9999 },
    );
    expect(data.returned).toBe(50);
    expect(data.totalEpisodes).toBe(200);
    expect(data.episodes[0].plays).toBe(200);
  });
});

describe("apple_podcasts_followers", () => {
  it("returns a series plus the change across the window", async () => {
    stubFetch((n) =>
      gzipReport(n === 0 ? SHOW_WORLDWIDE_TSV : SHOW_WORLDWIDE_TSV_DAY2),
    );
    const { data } = await callTool(
      createServer(client()),
      "apple_podcasts_followers",
      { start: "2026-07-28", end: "2026-07-29" },
    );

    expect(data.resolvedColumn).toBe("Followers");
    expect(data.first).toBe(9430);
    expect(data.latest).toBe(9512);
    expect(data.change).toBe(82);
    expect(data.series).toEqual([
      { date: "20260728", value: 9430 },
      { date: "20260729", value: 9512 },
    ]);
    expect(data.interpretationNote).toMatch(/running follower total/);
  });

  it("says no request was made when a Weekly range holds no Sunday", async () => {
    const bodies = stubFetch(() => gzipReport(SHOW_WORLDWIDE_TSV));
    const { data } = await callTool(
      createServer(client()),
      "apple_podcasts_followers",
      { period: "Weekly", start: "2026-07-27", end: "2026-07-31" },
    );
    expect(bodies).toHaveLength(0);
    expect(data.note).toMatch(/No request was made to Apple/);
  });

  it("says so plainly when the report has no follower column", async () => {
    stubFetch(() => gzipReport(RENAMED_COLUMNS_TSV));
    const { data } = await callTool(
      createServer(client()),
      "apple_podcasts_followers",
      { start: "2026-07-28", end: "2026-07-28" },
    );
    expect(data.note).toMatch(/No follower column/);
    expect(data.availableColumns).toContain("Total Streams");
    expect(data.series).toBeUndefined();
  });
});

describe("apple_podcasts_check_access", () => {
  it("reports the authorized vendors and whether the configured one is among them", async () => {
    stubFetch((n) =>
      textResponse(n === 0 ? VENDORS_TEXT : VIEW_TOKEN_TEXT),
    );
    const { data } = await callTool(
      createServer(client()),
      "apple_podcasts_check_access",
    );
    expect(data.tokenWorks).toBe(true);
    expect(data.authorizedVendors).toEqual(["87654321", "87654399"]);
    expect(data.configuredVendorIsAuthorized).toBe(true);
    expect(data.tokenExpires).toBe("2027-01-24");
  });

  it("flags a vendor number the token cannot read", async () => {
    stubFetch((n) => textResponse(n === 0 ? VENDORS_TEXT : VIEW_TOKEN_TEXT));
    const { data } = await callTool(
      createServer(new ReporterClient("tok", "11111111")),
      "apple_podcasts_check_access",
    );
    expect(data.configuredVendorIsAuthorized).toBe(false);
  });

  it("still succeeds when viewToken is unavailable for the account", async () => {
    // viewToken failing says nothing about report access, which getVendors
    // already proved. Failing the whole check here would send users chasing a
    // credential problem they do not have.
    stubFetch((n) =>
      n === 0 ? textResponse(VENDORS_TEXT) : errorResponse(ERROR_TOKEN_EXPIRED),
    );
    const res = await callTool(
      createServer(client()),
      "apple_podcasts_check_access",
    );
    expect(res.isError).toBe(false);
    expect(res.data.tokenWorks).toBe(true);
    expect(res.data.tokenExpires).toBeUndefined();
    expect(res.data.tokenExpiryNote).toMatch(/180-day/);
  });
});
