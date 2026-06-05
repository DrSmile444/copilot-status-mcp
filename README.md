# copilot-status-mcp

Check your GitHub Copilot quota and rate-limit status from Claude Code, Copilot, or any MCP client.

`copilot-status-mcp` solves a visibility problem: when Copilot blocks your request with "You've hit
your rate limit", you know you're blocked — but not for how long, how close you were before it
happened, or what your monthly quota looks like. This package exposes all of that as a CLI command
and MCP tool.

```sh
claude mcp add --scope user copilot-status-mcp -- npx -y copilot-status-mcp --mcp
```

## Features

- Detects active rate limits and shows the exact reset time (5-hour session and weekly windows).
- Shows window usage percentage when available (server sends it above 50% used).
- Reports monthly quota for chat, completions, and premium model interactions.
- Works for free and paid Copilot plans.
- `--pretty` flag for a readable terminal summary.
- Exposes a single MCP tool: `get_copilot_status`.
- Does not read, store, log, or print your Copilot access token.

## Quick Start

Print your current Copilot status in the terminal:

```sh
npx copilot-status-mcp
```

Pretty-print for humans:

```sh
npx copilot-status-mcp --pretty
```

Add to Claude Code:

```sh
claude mcp add --scope user copilot-status-mcp -- npx -y copilot-status-mcp --mcp
```

Then ask:

```text
What is my current Copilot quota?
Am I rate limited on Copilot right now?
```

## Programmatic Usage

Install the package and import directly:

```sh
npm install copilot-status-mcp
```

```typescript
import { getCopilotStatus } from "copilot-status-mcp";

const result = await getCopilotStatus();
console.log(result.shortTermRateLimit.rateLimited); // true or false
console.log(result.shortTermRateLimit.sessionResetsAt); // ISO date if rate limited
```

With options:

```typescript
import { getCopilotStatus } from "copilot-status-mcp";

const result = await getCopilotStatus({
  timeoutMs: 30000,
  includeLogin: true,
});
```

The package exports:
- `getCopilotStatus(options?)` — fetch current Copilot quota; returns `CopilotStatusResult`
- `CopilotStatusError` — thrown when the CAPI probe or token exchange fails
- `DEFAULT_TIMEOUT_MS` — default timeout (15 000 ms)
- `getCopilotOAuthToken()` — resolve Copilot OAuth token only
- `getGhToken()` — resolve a general GitHub token
- `CredentialError` — thrown when no token can be found

## Requirements

- Node.js 18 or newer.
- One of the following for full support (session + weekly rate limits):
  - JetBrains Copilot plugin installed and authenticated
  - GitHub Copilot CLI: `npm install -g @github/copilot && copilot auth login`
  - `GITHUB_COPILOT_TOKEN` env var set to a Copilot-issued OAuth token
- For monthly quota only: `gh` CLI authenticated, or `GITHUB_TOKEN` env var set.

## CLI Usage

### Default — JSON output

```sh
npx copilot-status-mcp
```

Example output:

```json
{
  "source": "copilot-status-mcp",
  "tokenSource": "apps.json",
  "account": {
    "plan": "individual",
    "sku": "yearly_subscriber_quota"
  },
  "shortTermRateLimit": {
    "rateLimited": false,
    "session": {
      "percentUsed": 64.7,
      "percentRemaining": 35.3,
      "entitlement": 0,
      "resetsAt": "2026-06-01T16:29:39.000Z"
    },
    "weekly": {
      "percentUsed": 55.1,
      "percentRemaining": 44.9,
      "entitlement": 0,
      "resetsAt": "2026-06-08T00:00:00.000Z"
    },
    "probeAvailable": true
  },
  "monthlyQuota": {
    "resetsAt": "2026-07-01T00:00:00.000Z",
    "chat": { "unlimited": true, "percentRemaining": 100 },
    "completions": { "unlimited": true, "percentRemaining": 100 },
    "premiumInteractions": { "remaining": 299, "entitlement": 300, "percentRemaining": 99.6 }
  }
}
```

When rate limited:

```json
{
  "shortTermRateLimit": {
    "rateLimited": true,
    "sessionResetsAt": "2026-06-08T00:00:00.000Z",
    "sessionRetryAfterSecs": 310852,
    "limitKey": "global-usage-weekly-key",
    "probeAvailable": true
  }
}
```

### Pretty output

```sh
npx copilot-status-mcp --pretty
```

```
━━━ Account ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Plan:         individual
  SKU:          yearly_subscriber_quota
  Token source: apps.json

━━━ Short-Term Rate Limit ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✅  Not rate limited
  5h session:        64.7% used  [█████████████░░░░░░░]  35.3% remaining
  Session resets at: 2026-06-01T16:29:39.000Z (in 2h 40m)
  Weekly:            55.1% used  [███████████░░░░░░░░░]  44.9% remaining
  Weekly resets at:  2026-06-08T00:00:00.000Z (in 154h 11m)

━━━ Monthly Quota ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Chat:               unlimited  (100.0% remaining)
  Completions:        unlimited  (100.0% remaining)
  Premium models:     299 / 300  (99.6% remaining)
  Monthly resets at:  2026-07-01T00:00:00.000Z
  Monthly resets in:  706h 11m
```

### All flags

```sh
npx copilot-status-mcp [options]

Options:
  --pretty               Human-readable summary instead of JSON.
  --include-login        Include GitHub login in output.
  --timeout-ms <ms>      Timeout for API requests (default: 15000).
  --mcp                  Run as an MCP stdio server.
  --help, -h             Show help.
```

## MCP Setup

The MCP server exposes one tool: `get_copilot_status`.

It returns the same JSON as the CLI. Optional arguments:

```json
{
  "timeoutMs": 15000,
  "includeLogin": false
}
```

### Claude Code

```sh
claude mcp add --scope user copilot-status-mcp -- npx -y copilot-status-mcp --mcp
```

Verify:

```sh
claude mcp list
claude mcp get copilot-status-mcp
```

Equivalent MCP JSON:

```json
{
  "mcpServers": {
    "copilot-status-mcp": {
      "command": "npx",
      "args": ["-y", "copilot-status-mcp", "--mcp"]
    }
  }
}
```

### Other MCP Clients

```json
{
  "mcpServers": {
    "copilot-status-mcp": {
      "command": "npx",
      "args": ["-y", "copilot-status-mcp", "--mcp"]
    }
  }
}
```

## How It Works

### Token resolution

Short-term rate limit probe requires a Copilot-specific OAuth token:

```
GITHUB_COPILOT_TOKEN env var
  └─ ~/.config/github-copilot/apps.json  (written by JetBrains / Copilot CLI)
```

Monthly quota works with any GitHub token:

```
GITHUB_COPILOT_TOKEN env var
  └─ ~/.config/github-copilot/apps.json
       └─ GITHUB_TOKEN env var
            └─ `gh auth token`
```

### What gets called

```
GET https://api.github.com/copilot_internal/v2/token
  → exchange OAuth token for a short-lived CAPI session token

POST https://api.individual.githubcopilot.com/chat/completions
  max_tokens=1, model=gpt-5-mini
  → 200: not rate limited; response headers carry window usage %
  → 429: rate limited; retry-after header carries seconds until reset

GET https://api.github.com/copilot_internal/user
  → monthly quota snapshots and reset date
```

### Rate limit windows

GitHub Copilot enforces two rolling windows on top of the monthly quota:

| Window | Key | Resets |
|--------|-----|--------|
| Session | `global-usage-5-hour-key` | Rolling 5 hours |
| Weekly | `global-usage-weekly-key` | Every Monday 00:00 UTC |

Window usage percentage is only returned by the server above the 50% threshold. Below 50%, the
response only confirms you are not rate limited.

## Local Checkout Setup

```sh
npm install
npm run build
node dist/cli.js
node dist/cli.js --pretty
node dist/cli.js --mcp
```

From TypeScript directly:

```sh
npx tsx src/cli.ts
npx tsx src/cli.ts --pretty
```

### Claude Code from local checkout

```sh
claude mcp add --scope user copilot-status-mcp -- node /absolute/path/to/copilot-status-mcp/dist/cli.js --mcp
```

## Development

```sh
npm install          # install dependencies
npm run status       # print status from TypeScript
npm run status:pretty  # pretty output from TypeScript
npm run dev          # run MCP server from TypeScript
npm run build        # compile to dist/
npm run typecheck    # type-check without emitting
npm pack --dry-run   # preview npm package contents
```

## Troubleshooting

### No short-term rate limit data

The tool falls back to monthly-quota-only mode when no Copilot OAuth token is found. Install one of:

- JetBrains Copilot plugin (authenticates automatically)
- Copilot CLI: `npm install -g @github/copilot && copilot auth login`
- Set `GITHUB_COPILOT_TOKEN` manually

### `probeAvailable: false` in output

Same as above — no Copilot session token was available for the CAPI probe.

### MCP tool does not show up

Restart Claude Code or your MCP client after adding the server.

### Timeout errors

Increase the timeout:

```json
{ "timeoutMs": 30000 }
```

## Security Notes

- OAuth tokens are read from environment variables or local config files and are never printed,
  logged, or stored beyond the lifetime of the request.
- The CAPI probe uses a single minimal chat request (`max_tokens: 1`) solely to read response
  headers. The response content is discarded.
- GitHub login is omitted from output by default; use `--include-login` only when needed.

## Related Packages

These packages are part of the same family of AI provider status tools:

- [claude-status-mcp](https://github.com/DrSmile444/claude-status-mcp) — Claude OAuth usage and rate-limit windows
- [codex-status-mcp](https://github.com/DrSmile444/codex-status-mcp) — Codex / ChatGPT rate-limit windows and credits
- [provider-status-mcp](https://github.com/DrSmile444/provider-status-mcp) — Aggregates Claude, Codex, and Copilot status into a single view

## License

MIT

---

Made with ❤️ by Dmytro Vakulenko, 2026
