import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReporterClient } from "../client.js";
import { createServer, READ_ONLY_ANNOTATIONS } from "../server.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** List tools over a real MCP session, the way a client sees them. */
async function listTools() {
  // tools/list must never reach Apple. Fail loudly if anything tries.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("tools/list must not call fetch");
    }),
  );
  const server = createServer(new ReporterClient("tok", "87654321"));
  const client = new Client({ name: "annotations-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

/** The tools with an annotation that differs from the read-only contract. */
function notReadOnly(
  tools: { name: string; annotations?: Record<string, unknown> }[],
): string[] {
  return tools
    .filter(
      (t) =>
        t.annotations?.readOnlyHint !== true ||
        t.annotations?.destructiveHint !== false ||
        t.annotations?.idempotentHint !== true ||
        t.annotations?.openWorldHint !== true,
    )
    .map((t) => t.name);
}

describe("tool annotations", () => {
  it("the shared annotation object is exactly the read-only, open-world set", () => {
    expect(READ_ONLY_ANNOTATIONS).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it("every listed tool declares the exact read-only annotations", async () => {
    const tools = await listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "apple_podcasts_check_access",
      "apple_podcasts_episodes",
      "apple_podcasts_followers",
      "apple_podcasts_summary",
    ]);
    for (const tool of tools) {
      expect(tool.annotations, tool.name).toEqual(READ_ONLY_ANNOTATIONS);
    }
    expect(notReadOnly(tools)).toEqual([]);
  });

  it("the completeness filter catches a tool with no annotations (negative control)", async () => {
    const tools = await listTools();
    // A tool registered without annotations gets the spec defaults, which a
    // client must read as "may write". The filter has to flag it.
    const withRogue = [...tools, { name: "apple_podcasts_rogue" }];
    expect(notReadOnly(withRogue)).toEqual(["apple_podcasts_rogue"]);
    const destructive = [
      ...tools,
      {
        name: "apple_podcasts_destructive",
        annotations: { ...READ_ONLY_ANNOTATIONS, destructiveHint: true },
      },
    ];
    expect(notReadOnly(destructive)).toEqual(["apple_podcasts_destructive"]);
  });
});
