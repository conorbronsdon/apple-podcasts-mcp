import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReporterClient } from "../client.js";
import { createServer, EPISODE_ROW_CAP, PERIOD_CAP } from "../server.js";
import { gzipReport, SHOW_WORLDWIDE_TSV } from "./fixtures/reports.js";

// #18: the schema advertises the caps the handlers enforce, and out-of-range
// input is a tool error the agent can see instead of a silent clamp.

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch() {
  const fetch = vi.fn(async () => gzipReport(SHOW_WORLDWIDE_TSV));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

async function connect() {
  const server = createServer(new ReporterClient("tok", "87654321"));
  const client = new Client({ name: "bounds-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const DATA_TOOLS = ["apple_podcasts_summary", "apple_podcasts_episodes", "apple_podcasts_followers"];
const WIDE_RANGE = { start: "2026-01-01", end: "2026-07-30" };

describe("advertised bounds", () => {
  it("tools/list publishes max_periods 1..PERIOD_CAP on every data tool and limit 1..EPISODE_ROW_CAP", async () => {
    stubFetch();
    const client = await connect();
    const { tools } = await client.listTools();
    await client.close();
    for (const name of DATA_TOOLS) {
      const props = tools.find((t) => t.name === name)!.inputSchema.properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(PERIOD_CAP).toBe(31);
      expect(props.max_periods, name).toMatchObject({ type: "integer", minimum: 1, maximum: PERIOD_CAP });
      expect(props.max_periods.description, name).toContain(`an integer from 1 to ${PERIOD_CAP}`);
    }
    const episodes = tools.find((t) => t.name === "apple_podcasts_episodes")!;
    const limit = (episodes.inputSchema.properties as Record<string, Record<string, unknown>>).limit;
    expect(EPISODE_ROW_CAP).toBe(50);
    expect(limit).toMatchObject({ type: "integer", minimum: 1, maximum: EPISODE_ROW_CAP });
    expect(limit.description).toContain(`An integer from 1 to ${EPISODE_ROW_CAP}`);
  });

  it.each(DATA_TOOLS.flatMap((name) => [0, PERIOD_CAP + 1, 500].map((max_periods) => [name, max_periods] as const)))(
    "%s rejects max_periods %d as a tool error without calling Apple",
    async (name, max_periods) => {
      const fetch = stubFetch();
      const client = await connect();
      const result = await client.callTool({ name, arguments: { ...WIDE_RANGE, max_periods } });
      await client.close();
      expect(result.isError).toBe(true);
      expect((result.content as { text: string }[])[0].text).toMatch(/Invalid arguments.*max_periods/s);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([0, EPISODE_ROW_CAP + 1, 9999])("apple_podcasts_episodes rejects limit %d as a tool error", async (limit) => {
    const fetch = stubFetch();
    const client = await connect();
    const result = await client.callTool({
      name: "apple_podcasts_episodes",
      arguments: { start: "2026-07-28", end: "2026-07-28", limit },
    });
    await client.close();
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toMatch(/Invalid arguments.*limit/s);
    expect(fetch).not.toHaveBeenCalled();
  });

  // The values in between matter as much as the edges: a handler that
  // replaced the argument with the cap (or a fixed number) would still pass
  // at the cap itself, so 7 and 13 pin that the value is used as given.
  it.each(DATA_TOOLS)("%s makes exactly max_periods Apple calls for 1, 7 and PERIOD_CAP", async (name) => {
    for (const max_periods of [1, 7, PERIOD_CAP]) {
      const fetch = stubFetch();
      const client = await connect();
      const result = await client.callTool({ name, arguments: { ...WIDE_RANGE, max_periods } });
      await client.close();
      expect(result.isError, `max_periods=${max_periods}`).toBeFalsy();
      expect(fetch).toHaveBeenCalledTimes(max_periods);
    }
  });

  it("apple_podcasts_episodes returns exactly limit rows for 1, 13 and EPISODE_ROW_CAP", async () => {
    const header =
      "Date\tEpisode Apple ID\tEpisode Name\tPlays\tUnique Listeners\tEngaged Listeners\n";
    const rows = Array.from(
      { length: 200 },
      (_, i) => `2026-07-28\t100${i}\tEp ${i}\t${200 - i}\t10\t5`,
    ).join("\n");
    for (const limit of [1, 13, EPISODE_ROW_CAP]) {
      vi.stubGlobal("fetch", vi.fn(async () => gzipReport(header + rows + "\n")));
      const client = await connect();
      const result = await client.callTool({
        name: "apple_podcasts_episodes",
        arguments: { start: "2026-07-28", end: "2026-07-28", limit },
      });
      await client.close();
      expect(result.isError, `limit=${limit}`).toBeFalsy();
      const data = JSON.parse((result.content as { text: string }[])[0].text);
      expect(data.returned, `limit=${limit}`).toBe(limit);
      expect(data.episodes, `limit=${limit}`).toHaveLength(limit);
      expect(data.totalEpisodes).toBe(200);
    }
  });
});
