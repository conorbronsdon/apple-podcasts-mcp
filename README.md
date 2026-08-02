<div align="center">

# apple-podcasts-mcp

Owner-side Apple Podcasts analytics for AI agents: plays, followers, and per-episode listening, over the Apple Podcasts Connect Reporter protocol. Read-only.

[![npm version](https://img.shields.io/npm/v/@conorbronsdon/apple-podcasts-mcp?style=flat-square)](https://www.npmjs.com/package/@conorbronsdon/apple-podcasts-mcp)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/Node-20.19+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Glama score](https://glama.ai/mcp/servers/conorbronsdon/apple-podcasts-mcp/badges/score.svg)](https://glama.ai/mcp/servers/conorbronsdon/apple-podcasts-mcp)
[![Podcast](https://img.shields.io/badge/Podcast-Chain_of_Thought-purple?style=flat-square)](https://chainofthought.show/?utm_source=github&utm_medium=referral&utm_campaign=repo-readme&utm_content=apple-podcasts-mcp)
[![X](https://img.shields.io/badge/X-@ConorBronsdon-black?style=flat-square&logo=x)](https://x.com/ConorBronsdon)

</div>

---

An MCP server for the analytics Apple shows the person who owns the show: how many plays an episode got, how far into it people got, and whether the follower count is moving. That data lives behind Apple Podcasts Connect and the Reporter service, and it is not in Apple's public catalog API.

**Nothing here has been checked against a live Apple account.** The protocol is implemented from Apple's Reporter documentation and tested against fixtures written by hand. No request this server sends and no response it parses has been confirmed on the wire. If you run it against a real vendor number, an issue saying what came back is the most useful thing you can send.

**Read-only.** Reporter only reads. Nothing this server does can change a show, an episode, or an account.

## What this does not do

This is not the iTunes Search / public catalog API. It does not look up shows by name, read public charts, fetch artwork, or return reviews and ratings. The other "Apple Podcasts" MCP servers I have looked at wrap the public catalog, which needs no credentials. This one needs your vendor number and your access token, and in exchange it returns your own listening data.

It also does not cover:

- **Subscriptions and revenue.** Reporter has `apSubscriptionsSales` and friends. This server does not wrap them.
- **Anything before you had a Podcasts Connect account.** Reporter reports on what Apple recorded for your vendor number.
- **Today.** Apple publishes on a one-to-two day lag, so ranges default to ending two days back.
- **Downloads.** Apple reports plays and listeners, which are not downloads. If you want download counts, use a hosting or prefix analytics source such as [op3-mcp](https://github.com/conorbronsdon/op3-mcp).

## Tools

| Tool | What it returns |
|------|-----------------|
| `apple_podcasts_check_access` | Whether the token works, which vendor numbers it can read, and the token expiry when Apple returns one. No listening data. |
| `apple_podcasts_summary` | Show-level plays, unique listeners, engaged listeners, and followers over a date range, per period and totalled. Listener counts are devices, not people — see [What the metrics mean](#what-the-metrics-mean). |
| `apple_podcasts_episodes` | Per-episode plays and listener counts over a date range, rolled up across periods and ranked. |
| `apple_podcasts_followers` | Follower value per period across a range, with the change over the window. |

There is deliberately no "fetch the raw report" tool. Reporter returns one report per date, each with a row per episode and, in the non-worldwide variants, a row per storefront per episode. A month of that is tens of thousands of rows, and handing it to an agent verbatim is how you spend a context window on tab-separated text.

Every tool takes an explicit date range and a cap:

- `max_periods` limits how many Reporter calls a single tool call makes. Hard cap 31. Reporter has no range query — one date is one HTTP round trip — so this is a rate-limit guard, not a formality. A range wider than the cap is truncated to the **most recent** periods, and the response says so with `rangeTruncated`.
- `limit` on `apple_podcasts_episodes` caps returned rows at 50.
- Ranges default short: 7 days for Daily, 7 weeks for Weekly, 6 months for Monthly. Each default is sized to fit inside the default `max_periods` of 7, so a call with no dates returns a whole window rather than a truncated one.

## What the metrics mean

Apple's numbers are not headcounts. Podcasts Connect Analytics aggregates "listening and viewing completion rates from unique devices" ([Apple](https://podcasters.apple.com/support/5392-listener-analytics)), so a listener is a device. One person with a phone and a CarPlay head unit can be two.

- **Plays** — times someone pressed play on an episode.
- **Unique listeners** — devices that played more than zero seconds.
- **Engaged listeners** — devices that played at least **20 minutes or 40%** of an episode. That is Apple's threshold for depth. It is not a completion rate, and 40% of an episode is not finishing it.
- **Followers** — a level, not a flow. See [About the column names](#about-the-column-names) for why this one needs care.

## Setup

### 1. Get your vendor number and access token

1. Sign in to [Apple Podcasts Connect](https://podcastsconnect.apple.com).
2. Go to **Settings**. Your vendor number is there — digits only, something like `87654321`.
3. On the same page, generate an **Access Token**. Copy the whole string; it is long and truncating it produces a confusing "invalid token" rather than an obvious paste error.

### 2. Build it

Published on npm. The config blocks below use `npx`, which fetches it on first run; no clone required.

```bash
git clone https://github.com/conorbronsdon/apple-podcasts-mcp.git
cd apple-podcasts-mcp
npm install
npm run build
```

### 3. Configure your MCP client

#### Claude Code

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "apple-podcasts": {
      "command": "npx",
      "args": ["-y", "@conorbronsdon/apple-podcasts-mcp"],
      "env": {
        "APPLE_PODCASTS_ACCESS_TOKEN": "your-access-token",
        "APPLE_PODCASTS_VENDOR_ID": "87654321"
      }
    }
  }
}
```

#### Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.apple-podcasts]
command = "npx"
args = ["-y", "@conorbronsdon/apple-podcasts-mcp"]
env = { APPLE_PODCASTS_ACCESS_TOKEN = "your-access-token", APPLE_PODCASTS_VENDOR_ID = "87654321" }
```

#### Claude Desktop

Same block as Claude Code, in `claude_desktop_config.json`.

The server starts without credentials so a client can list its tools. Each tool call then fails with a message telling you which variable is missing.

#### If your token can read more than one account

`APPLE_PODCASTS_ACCOUNT_ID` is optional and most setups do not need it. Set it when Reporter answers with code 214, "this token has access to more than one account; specify an account number" — Reporter will not pick one for you, so every call fails until you name it.

```json
"env": {
  "APPLE_PODCASTS_ACCESS_TOKEN": "your-access-token",
  "APPLE_PODCASTS_VENDOR_ID": "87654321",
  "APPLE_PODCASTS_ACCOUNT_ID": "2011425"
}
```

It is an environment variable rather than a tool argument because it is part of the credential, not part of a question: it does not vary between calls, and putting it in every tool's schema would spend context on an argument almost no one sets. Leave it unset if you have one account — Reporter rejects an empty account field, so the server omits it entirely rather than sending a blank. `apple_podcasts_check_access` echoes back the account number in use.

### 3. Verify

Ask your assistant: **"Check my Apple Podcasts access."** That runs `apple_podcasts_check_access`, which proves the token works and shows whether your vendor number is one the token can read — the two failures that look identical from the outside.

## Token rotation, every 180 days

**Apple Reporter access tokens expire 180 days after you generate one.** This is the thing that will break your setup, and it will break it silently: the server keeps starting, the tools keep listing, and every call starts failing.

When a token expires, tools return:

```
Apple Reporter error (123) on Sales.getReport: Access token is expired. Reporter tokens
last 180 days. Generate a new one in Apple Podcasts Connect > Settings > Access Token and
update APPLE_PODCASTS_ACCESS_TOKEN.
```

To rotate:

1. Apple Podcasts Connect → **Settings** → **Access Token**.
2. Generate a new token. The old one stops working, so do this when you can update the config in the same sitting.
3. Replace `APPLE_PODCASTS_ACCESS_TOKEN` wherever you set it, and restart the MCP client so it picks up the new environment.

Two things worth doing when you set this up:

- Run `apple_podcasts_check_access` and note the `tokenExpires` date if Apple returns one. Not every account gets an expiry back from `Sales.viewToken`; when it does not, the response says so and you should track the date yourself.
- Put a calendar reminder at day 170. Rotation is 30 seconds of work; discovering it expired mid-analysis is not.

Expiry (code 123) and a rejected token (code 124) are separate error types here, because the fix is different: one means rotate, the other means you pasted it wrong.

## Worked example

> **You:** How did the show do on Apple last week, and which episodes carried it?

The assistant runs two calls.

`apple_podcasts_summary` with `period: "Daily"`, `start: "2026-07-24"`, `end: "2026-07-30"`:

```json
{
  "reportType": "apShowListeningWorldwide",
  "period": "Daily",
  "requestedRange": { "start": "20260724", "end": "20260730" },
  "periodsReturned": 7,
  "totals": { "plays": 8940, "uniqueListeners": 5620, "engagedListeners": 3810 },
  "totalsNote": "Totals sum the flow metrics (plays, listeners, time listened) across periods. Followers is a level, not a flow, so it is reported per period in the series and is deliberately absent from totals.",
  "series": [
    { "date": "20260724", "rows": 1, "metrics": { "plays": 1204, "followers": 9430 } },
    { "date": "20260725", "rows": 1, "metrics": { "plays": 1530, "followers": 9512 } }
  ],
  "resolvedColumns": { "plays": "Plays", "followers": "Followers" }
}
```

Then `apple_podcasts_episodes` over the same range, `sort_by: "engagedListeners"`, `limit: 5`:

```json
{
  "totalEpisodes": 43,
  "returned": 5,
  "sortedBy": "engagedListeners",
  "episodes": [
    { "episodeId": "1000712346", "episodeName": "What evals actually measure",
      "plays": 830, "uniqueListeners": 635, "engagedListeners": 530 }
  ]
}
```

`engagedListeners` is the interesting one. Plays counts starts; engaged listeners counts the devices that got at least 20 minutes or 40% into the episode. An episode that leads on plays and trails on engagement got clicked, not heard.

(Values above are illustrative. Column names come from your account's report — see the next section.)

## About the column names

Apple does not publish the column layout for the podcast listening reports, and has renamed columns between report versions. So this server does not hardcode column names. Each metric resolves through an alias table (`src/tsv.ts`), and every response reports:

- `resolvedColumns` — which column each metric actually matched in your report.
- `unmappedColumns` — columns present in the report that matched nothing known.

If Apple renames a column, `apple_podcasts_summary` and `apple_podcasts_episodes` return a `schemaNote` alongside the unmapped name, not a quiet zero. If you see a metric you care about sitting in `unmappedColumns`, open an issue with the column name and it goes in the alias table.

The same caution applies to followers. Apple's follower column has been both a running total and a per-period count. `apple_podcasts_followers` returns `resolvedColumn`, `change` (latest minus first), and `sumAcrossPeriods`, and tells you which to read for which case rather than guessing on your behalf.

## Errors

Reporter is not REST. It answers most failures with a numeric code in the body, frequently under HTTP 200, so a client that trusts the status code will parse an error envelope as a report. This server checks the body. Codes map to typed errors (`src/errors.ts`):

| Error | Reporter code | Means |
|-------|---------------|-------|
| `TokenExpiredError` | 123 | The 180-day clock ran out. Rotate. |
| `TokenInvalidError` | 124, 125, 132, HTTP 401/403 | Token missing, malformed, or rejected. |
| `VendorError` | 200, 300 | The vendor number is not one this token can read. Run `apple_podcasts_check_access`. |
| `AccountError` | 214, 215 | The token reaches several Apple accounts and Reporter will not choose, or the account number given is wrong. Set `APPLE_PODCASTS_ACCOUNT_ID`. |
| `NoDataError` | 209, 211, 213 | Valid request, no report for that period. Routine — reports lag, and quiet periods produce nothing. |
| `RateLimitError` | 117, HTTP 429/503 | Apple is throttling or reports are delayed. Narrow the range. |
| `BadRequestError` | 201–208 | Bad report type, date type, or combination. |
| `ReporterError` | anything else | Base class, also used for network failures. |

`NoDataError` is handled rather than raised when it happens mid-range: the date is recorded under `missingPeriods` and the rest of the range still returns. A range that comes back completely empty gets an explanation, not a page of zeros.

A range that produces no Reporter dates at all is a separate answer. Weekly reports are keyed to the Sunday that ends the week, so a Monday-to-Friday Weekly range contains no report date and nothing is sent to Apple. The response says that, rather than blaming Apple's publishing lag for a request that was never made.

## Protocol notes

Reporter takes an HTTP POST with a single form-encoded field, `jsonRequest`, holding a JSON document with the token and a bracketed command:

```
POST https://reportingitc-reporter.apple.com/reportservice/sales/v1
Content-Type: application/x-www-form-urlencoded

jsonRequest={"accesstoken":"...","version":"2.2","mode":"Robot.XML",
             "queryInput":"[p=Reporter.properties, Sales.getReport, 87654321,apShowListeningWorldwide,Summary,Daily,20260728]"}
```

Version `2.2` matters: token-based auth (`generateToken`) requires Reporter 2.2 or later, and an older version string gets the token rejected. Successful reports come back gzipped (`Content-Type: application/a-gzip`) as tab-separated text with one header line and no quoting.

When `APPLE_PODCASTS_ACCOUNT_ID` is set, an `account` field joins the same JSON document. It is left out when unset: Reporter treats an empty `account` as an error rather than as "no preference".

Apple's own client is a Java jar. This server reimplements the wire protocol directly, so there is no JVM anywhere in the dependency tree. Apple's reference: [Reporter User Guide](https://help.apple.com/itc/podcastsreporterguide/).

## Development

```bash
git clone https://github.com/conorbronsdon/apple-podcasts-mcp.git
cd apple-podcasts-mcp
npm install
npm run build
npm test
```

Run locally:

```bash
APPLE_PODCASTS_ACCESS_TOKEN=... APPLE_PODCASTS_VENDOR_ID=... npm start
```

Tests stub `fetch` and run against hand-built fixtures in `src/__tests__/fixtures/`. No test touches Apple. Read the provenance comment at the top of the fixtures file before treating its column names as Apple's schema: the fixtures pin the parsing, aggregation, date, and error paths, which is what they exist for. They were written to match Apple's documented response shape, not captured from an account, and neither was the reference implementation this was ported from.

### Releasing

`.github/workflows/publish.yml` publishes on a version bump using npm Trusted Publishing. Trusted Publishing is configured per package on npmjs.com, so **the first publish has to be done by hand** (`npm publish --access public`) or with a granular access token. Until the package exists and this repository is registered as its trusted publisher, the workflow runs and fails at the publish step. The workflow header has the steps.

## Contributing

Issues and pull requests welcome. Three things are especially useful, in order:

- **Anything at all from a live account.** No response this server parses has been verified against real Apple data — the implementation reads Apple's documentation and the tests run on fixtures. If you point it at a real vendor number, say what happened, working or not. That is the gap nothing else here closes.
- **Column names from a real account.** If a metric you care about shows up in `unmappedColumns`, post the column name. It cannot be derived from public documentation.
- **A Reporter code this server maps badly.** Include the code and Apple's message.

Keep the read-only contract, and keep new tools bounded — an explicit range and a row cap, no raw dumps.

## About

Built and maintained by [Conor Bronsdon](https://github.com/conorbronsdon). I host the [Chain of Thought](https://chainofthought.show/?utm_source=github&utm_medium=referral&utm_campaign=repo-readme&utm_content=apple-podcasts-mcp) podcast, which covers AI infrastructure, developer tools, and how practitioners actually use this stuff. I built this because Apple has the listening data that matters for a show and the only supported way to get it was a Java jar and a spreadsheet.

Companion tools:

- [op3-mcp](https://github.com/conorbronsdon/op3-mcp): OP3 download analytics — geography, apps, per-episode downloads. Downloads where this covers plays.
- [Transistor-MCP](https://github.com/conorbronsdon/Transistor-MCP): the Transistor.fm MCP server. Episodes, transcripts, hosting-side counts.
- [podcastindex-mcp](https://github.com/conorbronsdon/podcastindex-mcp): the Podcast Index MCP server, search by person or topic, trending shows, feed health.
- [podcast-benchmark](https://github.com/conorbronsdon/podcast-benchmark): benchmark your show against peers on public signals.
- [ai-tools-for-creators](https://github.com/conorbronsdon/ai-tools-for-creators): a curated list of AI skills and MCP servers for people who ship ideas for a living.

More at [chainofthought.show](https://chainofthought.show/?utm_source=github&utm_medium=referral&utm_campaign=repo-readme&utm_content=apple-podcasts-mcp) and on [X](https://x.com/ConorBronsdon).

---

## Disclaimer

*This is an independent personal project, not affiliated with, sponsored by, or endorsed by Apple Inc. All views expressed are my own.*

## License

Apache-2.0
