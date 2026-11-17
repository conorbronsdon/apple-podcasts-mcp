import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReporterClient } from "../client.js";
import { createServer } from "../server.js";
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
  it("tools/list publishes max_periods 1..31 on every data tool and limit 1..50", async () => {
    stubFetch();
    const client = await connect();
    const { tools } = await client.listTools();
    await client.close();
    for (const name of DATA_TOOLS) {
      const props = tools.find((t) => t.name === name)!.inputSchema.properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(props.max_periods, name).toMatchObject({ type: "integer", minimum: 1, maximum: 31 });
    }
    const episodes = tools.find((t) => t.name === "apple_podcasts_episodes")!;
    expect((episodes.inputSchema.properties as Record<string, unknown>).limit).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 50,
    });
  });

  it.each(DATA_TOOLS.flatMap((name) => [0, 32, 500].map((max_periods) => [name, max_periods] as const)))(
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

  it.each([0, 51, 9999])("apple_podcasts_episodes rejects limit %d as a tool error", async (limit) => {
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

  it.each(DATA_TOOLS)("%s still accepts max_periods 1 and 31", async (name) => {
    for (const max_periods of [1, 31]) {
      const fetch = stubFetch();
      const client = await connect();
      const result = await client.callTool({ name, arguments: { ...WIDE_RANGE, max_periods } });
      await client.close();
      expect(result.isError, `max_periods=${max_periods}`).toBeFalsy();
      expect(fetch).toHaveBeenCalledTimes(max_periods);
    }
  });

  it("apple_podcasts_episodes still accepts limit 1 and 50", async () => {
    for (const limit of [1, 50]) {
      stubFetch();
      const client = await connect();
      const result = await client.callTool({
        name: "apple_podcasts_episodes",
        arguments: { start: "2026-07-28", end: "2026-07-28", limit },
      });
      await client.close();
      expect(result.isError, `limit=${limit}`).toBeFalsy();
    }
  });
});
