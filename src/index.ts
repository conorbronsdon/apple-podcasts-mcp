#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ReporterClient } from "./client.js";
import { createServer } from "./server.js";

async function main() {
  const token = process.env.APPLE_PODCASTS_ACCESS_TOKEN || "";
  const vendorId = process.env.APPLE_PODCASTS_VENDOR_ID || "";
  // Optional. Only tokens with access to several Apple accounts need it, and
  // Reporter rejects an empty account field, so it stays out of the payload
  // unless it is set. Reporter code 214 is what tells you that you need it.
  const accountId = process.env.APPLE_PODCASTS_ACCOUNT_ID || "";

  // Lazy auth: the server starts and answers tools/list without credentials so
  // a client can inspect it. Each tool call fails with a specific message.
  if (!token || !vendorId) {
    const names = [
      !token ? "APPLE_PODCASTS_ACCESS_TOKEN" : null,
      !vendorId ? "APPLE_PODCASTS_VENDOR_ID" : null,
    ].filter(Boolean);
    console.error(
      `Warning: ${names.join(" and ")} ${names.length > 1 ? "are" : "is"} not set. Tools will error until configured.`,
    );
    console.error(
      "Generate an access token in Apple Podcasts Connect > Settings > Access Token (it expires after 180 days) and find your vendor number on the same settings page. See README.md.",
    );
  }

  const client = new ReporterClient(token, vendorId, { accountId });
  const server = createServer(client);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Apple Podcasts MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
