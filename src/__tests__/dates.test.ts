import { describe, expect, it } from "vitest";
import {
  buildDateList,
  formatReporterDate,
  parseIsoish,
  resolveRange,
} from "../dates.js";

describe("formatReporterDate", () => {
  it("uses YYYYMMDD for daily and weekly, YYYYMM for monthly", () => {
    const d = new Date("2026-03-07T00:00:00Z");
    expect(formatReporterDate(d, "Daily")).toBe("20260307");
    expect(formatReporterDate(d, "Weekly")).toBe("20260307");
    expect(formatReporterDate(d, "Monthly")).toBe("202603");
  });

  it("zero-pads single-digit months and days", () => {
    // A %Y%-m%-d bug produces "202637", which is the same length as no other
    // valid date but would pass a length-only assertion.
    expect(formatReporterDate(new Date("2026-03-07T00:00:00Z"), "Daily")).toBe(
      "20260307",
    );
    expect(formatReporterDate(new Date("2026-12-25T00:00:00Z"), "Daily")).toBe(
      "20261225",
    );
  });
});

describe("parseIsoish", () => {
  it("accepts hyphenated and compact forms", () => {
    expect(parseIsoish("2026-07-28")?.toISOString()).toBe(
      "2026-07-28T00:00:00.000Z",
    );
    expect(parseIsoish("20260728")?.toISOString()).toBe(
      "2026-07-28T00:00:00.000Z",
    );
    expect(parseIsoish("2026-07")?.toISOString()).toBe(
      "2026-07-01T00:00:00.000Z",
    );
  });

  it("rejects garbage", () => {
    expect(parseIsoish("last tuesday")).toBeUndefined();
    expect(parseIsoish("2026")).toBeUndefined();
  });
});

describe("buildDateList", () => {
  it("steps daily dates one day at a time, oldest first", () => {
    const { dates } = buildDateList({
      period: "Daily",
      start: new Date("2026-07-26T00:00:00Z"),
      end: new Date("2026-07-29T00:00:00Z"),
      maxDates: 31,
    });
    expect(dates).toEqual(["20260726", "20260727", "20260728", "20260729"]);
  });

  it("snaps weekly dates to Sundays and steps by seven days", () => {
    // 2026-07-26 is a Sunday; 2026-07-27 is a Monday and must snap to 08-02.
    const { dates } = buildDateList({
      period: "Weekly",
      start: new Date("2026-07-27T00:00:00Z"),
      end: new Date("2026-08-16T00:00:00Z"),
      maxDates: 31,
    });
    expect(dates).toEqual(["20260802", "20260809", "20260816"]);
    for (const d of dates) {
      const asDate = new Date(
        `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T00:00:00Z`,
      );
      expect(asDate.getUTCDay()).toBe(0);
    }
  });

  it("returns no dates for a weekly range that contains no Sunday", () => {
    // Monday to Friday. There is no week-ending date to ask Apple for, and the
    // caller has to be able to tell that apart from "Apple had no data".
    const { dates, truncated } = buildDateList({
      period: "Weekly",
      start: new Date("2026-07-27T00:00:00Z"),
      end: new Date("2026-07-31T00:00:00Z"),
      maxDates: 31,
    });
    expect(dates).toEqual([]);
    expect(truncated).toBe(false);
  });

  it("steps monthly dates by calendar month across a year boundary", () => {
    const { dates } = buildDateList({
      period: "Monthly",
      start: new Date("2026-11-14T00:00:00Z"),
      end: new Date("2027-02-03T00:00:00Z"),
      maxDates: 31,
    });
    expect(dates).toEqual(["202611", "202612", "202701", "202702"]);
  });

  it("truncates to the most recent dates when the range exceeds the cap", () => {
    const { dates, truncated } = buildDateList({
      period: "Daily",
      start: new Date("2026-01-01T00:00:00Z"),
      end: new Date("2026-12-31T00:00:00Z"),
      maxDates: 3,
    });
    expect(truncated).toBe(true);
    // Most recent, not oldest — an oldest-first truncation would silently
    // answer "how did last week go" with data from January.
    expect(dates).toEqual(["20261229", "20261230", "20261231"]);
  });
});

describe("resolveRange", () => {
  const now = new Date("2026-08-01T12:00:00Z");

  it("defaults the end to two days back, not today, because reports lag", () => {
    const { end } = resolveRange({ period: "Daily", maxDates: 31, now });
    expect(end).toBe("20260730");
  });

  it("defaults daily to a 7-period window ending at the lagged end", () => {
    const { dates } = resolveRange({ period: "Daily", maxDates: 31, now });
    expect(dates).toEqual([
      "20260724",
      "20260725",
      "20260726",
      "20260727",
      "20260728",
      "20260729",
      "20260730",
    ]);
  });

  it("defaults weekly to 7 week-ending dates, which is the default cap", () => {
    // The documented default span and the default max_periods have to agree,
    // or every no-argument Weekly call comes back truncated.
    const { dates, truncated } = resolveRange({
      period: "Weekly",
      maxDates: 7,
      now,
    });
    expect(dates).toHaveLength(7);
    expect(truncated).toBe(false);
    expect(dates[dates.length - 1]).toBe("20260726");
  });

  it("returns an empty date list for a weekly range with no Sunday in it", () => {
    const { dates } = resolveRange({
      period: "Weekly",
      start: "2026-07-27",
      end: "2026-07-31",
      maxDates: 7,
      now,
    });
    expect(dates).toEqual([]);
  });

  it("caps the number of requests regardless of how wide the range is", () => {
    const { dates, truncated } = resolveRange({
      period: "Daily",
      start: "2026-01-01",
      end: "2026-07-30",
      maxDates: 5,
      now,
    });
    expect(dates).toHaveLength(5);
    expect(truncated).toBe(true);
  });

  it("throws a readable error on an unparseable date", () => {
    expect(() =>
      resolveRange({ period: "Daily", start: "yesterday", maxDates: 5, now }),
    ).toThrow(/Could not parse start date/);
  });

  it("throws when the start is after the end", () => {
    expect(() =>
      resolveRange({
        period: "Daily",
        start: "2026-07-30",
        end: "2026-07-01",
        maxDates: 5,
        now,
      }),
    ).toThrow(/after the end date/);
  });
});
