#!/usr/bin/env node
import { runMcpServer } from "./mcp.js";
import { getCopilotStatus, CopilotStatusError, type CopilotStatusResult } from "./quota.js";

// ── Pretty printer ────────────────────────────────────────────────────────────

function humanDiff(isoDate: string): string {
  const diffSecs = Math.round((new Date(isoDate).getTime() - Date.now()) / 1000);
  if (diffSecs <= 0) return "already passed";
  const h = Math.floor(diffSecs / 3600);
  const m = Math.floor((diffSecs % 3600) / 60);
  const s = diffSecs % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function buildBar(usedPercent: number, width = 20): string {
  const filled = Math.round((usedPercent / 100) * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

function printPretty(result: CopilotStatusResult): void {
  const { account, shortTermRateLimit: stl, monthlyQuota: mq, tokenSource } = result;

  process.stdout.write("\n");

  // Account
  process.stdout.write("━━━ Account ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  if (account.login) process.stdout.write(`  Login:        ${account.login}\n`);
  process.stdout.write(`  Plan:         ${account.plan ?? "N/A"}\n`);
  process.stdout.write(`  SKU:          ${account.sku ?? "N/A"}${account.sku === "free_limited_copilot" ? " (free tier)" : ""}\n`);
  process.stdout.write(`  Token source: ${tokenSource}\n`);

  // Short-term rate limit
  process.stdout.write("\n━━━ Short-Term Rate Limit ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  if (!stl.probeAvailable) {
    process.stdout.write("  ⚠  Probe unavailable — install JetBrains Copilot plugin or set GITHUB_COPILOT_TOKEN\n");
    process.stdout.write("  (monthly quota below is still accurate)\n");
  } else if (stl.rateLimited) {
    const limitLabel = stl.limitKey?.includes("weekly") ? "Weekly limit" : "5h session";
    process.stdout.write("  ⛔  RATE LIMITED — 0% remaining\n");
    if (stl.sessionResetsAt) {
      process.stdout.write(`  ${limitLabel} resets at:   ${stl.sessionResetsAt} (in ${humanDiff(stl.sessionResetsAt)})\n`);
    }
    if (stl.sessionRetryAfterSecs) {
      process.stdout.write(`  retry-after:          ${stl.sessionRetryAfterSecs}s\n`);
    }
    if (stl.limitKey) {
      process.stdout.write(`  Limit key:            ${stl.limitKey}\n`);
    }
    if (stl.weekly?.resetsAt && !stl.limitKey?.includes("weekly")) {
      process.stdout.write(`  Weekly resets at:     ${stl.weekly.resetsAt} (in ${humanDiff(stl.weekly.resetsAt)}) — usage % unavailable while rate limited\n`);
    }
  } else {
    process.stdout.write("  ✅  Not rate limited\n");
    if (stl.session) {
      const s = stl.session;
      const bar = buildBar(s.percentUsed);
      process.stdout.write(`  5h session:        ${s.percentUsed.toFixed(1)}% used  ${bar}  ${s.percentRemaining.toFixed(1)}% remaining\n`);
      if (s.resetsAt) process.stdout.write(`  Session resets at: ${s.resetsAt} (in ${humanDiff(s.resetsAt)})\n`);
    }
    if (stl.weekly) {
      const w = stl.weekly;
      const bar = buildBar(w.percentUsed);
      process.stdout.write(`  Weekly:            ${w.percentUsed.toFixed(1)}% used  ${bar}  ${w.percentRemaining.toFixed(1)}% remaining\n`);
      if (w.resetsAt) process.stdout.write(`  Weekly resets at:  ${w.resetsAt} (in ${humanDiff(w.resetsAt)})\n`);
    }
    if (!stl.session && !stl.weekly) {
      process.stdout.write("  Window usage: < 50% (server only sends usage headers above 50% threshold)\n");
    }
  }

  // Monthly quota
  process.stdout.write("\n━━━ Monthly Quota ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  function fmtSnap(label: string, snap: NonNullable<typeof mq.chat>): void {
    const rem = snap.remaining;
    const ent = snap.entitlement;
    const pct = snap.percentRemaining;
    const unlimited = snap.unlimited;
    const counts = unlimited ? "unlimited" : rem != null && ent != null ? `${rem} / ${ent}` : "N/A";
    const pctStr = pct != null ? `${pct.toFixed(1)}% remaining` : unlimited ? "100% remaining" : "";
    process.stdout.write(`  ${label.padEnd(20)}${counts}  (${pctStr})\n`);
  }

  if (mq.chat)                fmtSnap("Chat:",               mq.chat);
  if (mq.completions)         fmtSnap("Completions:",        mq.completions);
  if (mq.premiumInteractions) fmtSnap("Premium models:",     mq.premiumInteractions);

  if (mq.resetsAt) {
    process.stdout.write(`  Monthly resets at:  ${mq.resetsAt}\n`);
    process.stdout.write(`  Monthly resets in:  ${humanDiff(mq.resetsAt)}\n`);
  }

  process.stdout.write("\n");
}

// ── CLI ───────────────────────────────────────────────────────────────────────

interface CliOptions {
  mcp: boolean;
  pretty: boolean;
  includeLogin: boolean;
  timeoutMs?: number;
  help: boolean;
}

function printHelp(): void {
  process.stdout.write(`copilot-status-mcp

Fetch GitHub Copilot quota and rate-limit status, or run as an MCP stdio server.

Usage:
  copilot-status-mcp [options]
  copilot-status-mcp --mcp
  copilot-status-mcp --help

Options:
  --pretty               Print a human-readable summary instead of JSON.
  --include-login        Include GitHub login in output.
  --timeout-ms <ms>      Timeout for API requests (default: 15000).
  --mcp                  Run as an MCP stdio server.
  --help, -h             Show this help message.

Token resolution (for short-term rate limit probe):
  1. GITHUB_COPILOT_TOKEN env var
  2. ~/.config/github-copilot/apps.json  (JetBrains / Copilot CLI)

Token resolution (for monthly quota):
  1. GITHUB_COPILOT_TOKEN env var
  2. ~/.config/github-copilot/apps.json
  3. GITHUB_TOKEN env var
  4. \`gh auth token\`
`);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { mcp: false, pretty: false, includeLogin: false, help: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--mcp":           options.mcp = true; break;
      case "--pretty":        options.pretty = true; break;
      case "--include-login": options.includeLogin = true; break;
      case "--help": case "-h": options.help = true; break;
      case "--timeout-ms": {
        i++;
        if (!argv[i]) throw new Error("--timeout-ms requires a value.");
        const parsed = Number(argv[i]);
        if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("--timeout-ms must be a positive number.");
        options.timeoutMs = parsed;
        break;
      }
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  if (options.mcp) {
    await runMcpServer();
    return;
  }

  const result = await getCopilotStatus({
    timeoutMs: options.timeoutMs,
    includeLogin: options.includeLogin,
  });

  if (options.pretty) {
    printPretty(result);
  } else {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }

  // undici (Node.js fetch) keeps its connection pool alive after requests finish,
  // preventing natural process exit. Force-exit after output is written.
  process.exit(0);
}

main().catch((error: unknown) => {
  if (error instanceof CopilotStatusError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exitCode = 1;
});
