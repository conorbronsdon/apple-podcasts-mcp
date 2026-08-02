# apple-podcasts-mcp

MCP server for Apple Podcasts Connect owner analytics over the Reporter protocol — plays, followers, per-episode listening. Not the public iTunes catalog.

## Architecture
- `src/index.ts` — stdio bootstrap, env var read, lazy-auth warning
- `src/client.ts` — Reporter wire protocol: form-encoded POST of a `jsonRequest` field, gzip decode, per-date range fetch
- `src/errors.ts` — Reporter numeric code -> typed error hierarchy, plus body parsing (XML / JSON / text)
- `src/tsv.ts` — TSV parsing and the column alias table
- `src/dates.ts` — Reporter date formatting and capped range expansion
- `src/shape.ts` — flow-vs-level aggregation, episode rollup, trend series
- `src/server.ts` — 4 tool handlers
- `src/__tests__/` — vitest, fixtures in `__tests__/fixtures/`

## Key constraints
- Reporter is not REST. Errors come back with a numeric code in the body, often under HTTP 200 — never trust `response.ok` alone.
- `version` must be `"2.2"`. Token auth requires Reporter 2.2+.
- Reporter has no range query: one date is one HTTP call. `max_periods` (hard cap 31) exists to keep a tool call from making hundreds.
- Never hardcode an Apple column name in a handler. Resolve through `COLUMN_ALIASES` and report `resolvedColumns` / `unmappedColumns`.
- Followers is a level, not a flow. It must not be summed into `totals` — and "no metric columns found" must be decided from the resolved columns, not from empty totals, or a followers-only report reads as unreadable.
- A Weekly range with no Sunday in it expands to zero dates. That is "no request was made", not "Apple had no data"; never explain it with the publishing lag.
- Listener counts are unique devices, not people. An engaged listener is a device that played at least 20 minutes or 40% of an episode — not a completion.
- `account` goes in the request payload only when `APPLE_PODCASTS_ACCOUNT_ID` is set. Reporter 404s on an empty account field.
- Tests must never call Apple. Stub `fetch`.
- Never commit a token, a vendor number, or a real report body.

## Development
```bash
npm ci
npm run lint    # tsc --noEmit
npm run build   # tsc -> dist/
npm test        # vitest run
```

## Agent workflow
- Always work on a branch. Never push directly to main.
- CI must pass (lint + build + test).
- Run `npm test` locally before pushing.
