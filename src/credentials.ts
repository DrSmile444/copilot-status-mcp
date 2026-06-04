import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class CredentialError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CredentialError";
  }
}

export type TokenSource =
  | "GITHUB_COPILOT_TOKEN env"
  | "apps.json"
  | "GITHUB_TOKEN env"
  | "gh-cli";

export interface CopilotOAuthToken {
  token: string;
  source: TokenSource;
  user?: string;
}

export interface GhToken {
  token: string;
  source: "GITHUB_TOKEN env" | "gh-cli";
}

async function readAppsJson(): Promise<CopilotOAuthToken | undefined> {
  const path = resolve(homedir(), ".config/github-copilot/apps.json");
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Record<string, { oauth_token?: string; user?: string }>;
    const entries = Object.values(parsed);
    if (entries.length === 0) return undefined;
    const entry = entries[0];
    if (!entry.oauth_token) return undefined;
    return { token: entry.oauth_token, source: "apps.json", user: entry.user };
  } catch {
    return undefined;
  }
}

/**
 * Resolves a Copilot-specific OAuth token.
 * Required for: short-term rate limit probe (v2/token + CAPI).
 *
 * Resolution order:
 *   1. GITHUB_COPILOT_TOKEN env var
 *   2. ~/.config/github-copilot/apps.json  (JetBrains / Copilot CLI)
 */
export async function getCopilotOAuthToken(): Promise<CopilotOAuthToken> {
  const envToken = process.env.GITHUB_COPILOT_TOKEN?.trim();
  if (envToken) {
    return { token: envToken, source: "GITHUB_COPILOT_TOKEN env" };
  }

  const fromApps = await readAppsJson();
  if (fromApps) return fromApps;

  throw new CredentialError(
    "No Copilot OAuth token found.\n" +
    "  Option 1: Set GITHUB_COPILOT_TOKEN env var\n" +
    "  Option 2: Install JetBrains Copilot plugin (creates ~/.config/github-copilot/apps.json)\n" +
    "  Option 3: Install GitHub Copilot CLI and run: npm install -g @github/copilot && copilot auth login",
  );
}

/**
 * Resolves a general GitHub OAuth token.
 * Sufficient for: monthly quota (/copilot_internal/user).
 *
 * Resolution order:
 *   1. GITHUB_TOKEN env var
 *   2. `gh auth token` CLI
 */
export async function getGhToken(): Promise<GhToken | undefined> {
  const envToken = process.env.GITHUB_TOKEN?.trim();
  if (envToken) {
    return { token: envToken, source: "GITHUB_TOKEN env" };
  }

  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], { timeout: 10_000 });
    const token = stdout.trim();
    if (token) return { token, source: "gh-cli" };
  } catch {
    // gh not installed or not authenticated
  }

  return undefined;
}
