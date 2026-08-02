import { describe, expect, it } from "vitest";
import {
  normalizeHeader,
  parseTsv,
  resolveColumn,
  resolveColumns,
  toNumber,
  unmappedColumns,
} from "../tsv.js";
import {
  EPISODE_WORLDWIDE_TSV,
  RENAMED_COLUMNS_TSV,
  SHOW_WORLDWIDE_TSV,
} from "./fixtures/reports.js";

describe("parseTsv", () => {
  it("parses the header and rows from a recorded show report", () => {
    const { columns, rows } = parseTsv(SHOW_WORLDWIDE_TSV);
    expect(columns).toContain("Plays");
    expect(rows).toHaveLength(1);
    expect(rows[0]["Show Name"]).toBe("Chain of Thought");
    // Apple writes thousands separators; the raw cell keeps them.
    expect(rows[0].Plays).toBe("1,204");
  });

  it("parses multi-row reports", () => {
    const { rows } = parseTsv(EPISODE_WORLDWIDE_TSV);
    expect(rows).toHaveLength(3);
    expect(rows[1]["Episode Name"]).toBe("What evals actually measure");
  });

  it("returns empty results for an empty body", () => {
    expect(parseTsv("")).toEqual({ columns: [], rows: [] });
    expect(parseTsv("\n\n  \n")).toEqual({ columns: [], rows: [] });
  });

  it("does not treat quotes as delimiters", () => {
    // Reporter does no quoting. A CSV parser would mangle this title.
    const body = 'Episode Name\tPlays\nThe "hard" part\t42\n';
    const { rows } = parseTsv(body);
    expect(rows[0]["Episode Name"]).toBe('The "hard" part');
    expect(rows[0].Plays).toBe("42");
  });

  it("zips a short row positionally instead of throwing", () => {
    const body = "A\tB\tC\n1\t2\n";
    const { rows } = parseTsv(body);
    expect(rows[0]).toEqual({ A: "1", B: "2", C: "" });
  });
});

describe("toNumber", () => {
  it("strips thousands separators", () => {
    expect(toNumber("1,204")).toBe(1204);
    expect(toNumber("9,430")).toBe(9430);
  });

  it("returns undefined for blank and non-numeric cells, never 0", () => {
    // A silent 0 would be indistinguishable from real zero activity.
    expect(toNumber("")).toBeUndefined();
    expect(toNumber("   ")).toBeUndefined();
    expect(toNumber("n/a")).toBeUndefined();
    expect(toNumber(undefined)).toBeUndefined();
  });

  it("reads a real zero as 0", () => {
    expect(toNumber("0")).toBe(0);
  });
});

describe("column resolution", () => {
  it("normalizes headers case- and punctuation-insensitively", () => {
    expect(normalizeHeader("Unique Listeners")).toBe("uniquelisteners");
    expect(normalizeHeader("UNIQUE_LISTENERS")).toBe("uniquelisteners");
  });

  it("resolves known metrics to Apple's exact column name", () => {
    const { columns } = parseTsv(SHOW_WORLDWIDE_TSV);
    expect(resolveColumn(columns, "plays")).toBe("Plays");
    expect(resolveColumn(columns, "uniqueListeners")).toBe("Unique Listeners");
    expect(resolveColumn(columns, "followers")).toBe("Followers");
  });

  it("returns undefined for a metric the report does not carry", () => {
    const { columns } = parseTsv(RENAMED_COLUMNS_TSV);
    expect(resolveColumn(columns, "plays")).toBeUndefined();
  });

  it("reports renamed columns as unmapped instead of ignoring them", () => {
    const { columns } = parseTsv(RENAMED_COLUMNS_TSV);
    expect(unmappedColumns(columns)).toEqual(["Total Streams", "Widget Score"]);
  });

  it("omits unresolvable keys from resolveColumns", () => {
    const { columns } = parseTsv(RENAMED_COLUMNS_TSV);
    expect(resolveColumns(columns, ["plays", "date"])).toEqual({ date: "Date" });
  });
});
