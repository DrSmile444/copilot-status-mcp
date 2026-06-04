import { getCopilotOAuthToken, getGhToken, type TokenSource } from "./credentials.js";

export const DEFAULT_TIMEOUT_MS = 15_000;

export class CopilotStatusError extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CopilotStatusError";
  }
}

// ── Public result types ───────────────────────────────────────────────────────

export interface QuotaSnapshot {
  remaining?: number;
  entitlement?: number;
  percentRemaining?: number;
  unlimited?: boolean;
}

export interface WindowQuotaInfo {
  percentUsed: number;
  percentRemaining: number;
  entitlement: number;
  resetsAt?: string;  // ISO 8601
}

export interface ShortTermRateLimit {
  /** Whether the 5-hour session window is currently exhausted. */
  rateLimited: boolean;
  /** Present when rate limited: ISO date when session window resets. */
  sessionResetsAt?: string;
  /** Present when rate limited: seconds until session resets. */
  sessionRetryAfterSecs?: number;
  /** Present when rate limited: key identifying the exceeded limit (e.g. "global-usage-5-hour-key"). */
  limitKey?: string;
  /** Present when not rate limited and server includes session header: current 5h window usage. */
  session?: WindowQuotaInfo;
  /** Present when server includes weekly header or rate limited: weekly window info. */
  weekly?: WindowQuotaInfo;
  /** False when no Copilot session token was available (short-term probe skipped). */
  probeAvailable: boolean;
}

export interface MonthlyQuota {
  chat?: QuotaSnapshot;
  completions?: QuotaSnapshot;
  premiumInteractions?: QuotaSnapshot;
  resetsAt?: string;  // ISO 8601
}

export interface CopilotStatusResult {
  source: "copilot-status-mcp";
  tokenSource: TokenSource;
  account: {
    login?: string;
    plan?: string;
    sku?: string;
  };
  shortTermRateLimit: ShortTermRateLimit;
  monthlyQuota: MonthlyQuota;
}

// ── Internal types ────────────────────────────────────────────────────────────

interface CopilotTokenEnvelope {
  token: string;
  expires_at: number;
  refresh_in: number;
  sku?: string;
  endpoints?: { api?: string; proxy?: string };
}

interface CopilotUserResponse {
  login?: string;
  access_type_sku?: string;
  copilot_plan?: string;
  quota_snapshots?: {
    chat?: { remaining?: number; entitlement?: number; percent_remaining?: number; unlimited?: boolean };
    completions?: { remaining?: number; entitlement?: number; percent_remaining?: number; unlimited?: boolean };
    premium_interactions?: { remaining?: number; entitlement?: number; percent_remaining?: number; unlimited?: boolean };
  };
  quota_reset_date_utc?: string;
  quota_reset_date?: string;
  limited_user_quotas?: { chat?: number; completions?: number } | null;
  limited_user_reset_date?: number | string | null;
}

interface ParsedWindowHeader {
  entitlement: number;
  percentRemaining: number;
  percentUsed: number;
  resetsAt?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseWindowHeader(raw: string | null): ParsedWindowHeader | undefined {
  if (!raw) return undefined;
  try {
    const p = new URLSearchParams(raw);
    const ent = Number.parseInt(p.get("ent") ?? "0", 10);
    const rem = Number.parseFloat(p.get("rem") ?? "100");
    const rst = p.get("rst") ?? "";
    return {
      entitlement: ent,
      percentRemaining: rem,
      percentUsed: Math.max(0, 100 - rem),
      resetsAt: rst || undefined,
    };
  } catch {
    return undefined;
  }
}

function nextWeeklyReset(): string {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const daysUntilMonday = day === 1 ? 7 : (8 - day) % 7;
  const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilMonday));
  return reset.toISOString();
}

function toWindowQuotaInfo(parsed: ParsedWindowHeader): WindowQuotaInfo {
  return {
    percentUsed: parsed.percentUsed,
    percentRemaining: parsed.percentRemaining,
    entitlement: parsed.entitlement,
    resetsAt: parsed.resetsAt,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new CopilotStatusError(`Request timed out after ${ms}ms`)), ms),
    ),
  ]);
}

// ── API calls ─────────────────────────────────────────────────────────────────

async function getCAPISessionToken(oauthToken: string): Promise<CopilotTokenEnvelope> {
  const resp = await fetch("https://api.github.com/copilot_internal/v2/token", {
    headers: {
      Authorization: `token ${oauthToken}`,
      "Editor-Version": "JetBrains-IC/2025.2.0",
      "Editor-Plugin-Version": "copilot/1.5.37.8720",
      "User-Agent": "GithubCopilot/1.5.37.8720",
    },
  });

  if (!resp.ok) {
    throw new CopilotStatusError(`Failed to get CAPI session token: HTTP ${resp.status}`);
  }

  return resp.json() as Promise<CopilotTokenEnvelope>;
}

async function probeCAPI(
  sessionToken: string,
  apiBase: string,
): Promise<ShortTermRateLimit> {
  const interactionId = crypto.randomUUID();

  const resp = await fetch(`${apiBase}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${sessionToken}`,
      "Content-Type": "application/json",
      "Copilot-Integration-Id": "vscode-chat",
      "Editor-Version": "vscode/1.95.0",
      "Editor-Plugin-Version": "copilot-chat/0.48.1",
      "X-GitHub-Api-Version": "2025-05-01",
      "X-Interaction-Id": interactionId,
      "X-Initiator": "user",
      "OpenAI-Intent": "conversation-panel",
    },
    body: JSON.stringify({
      model: "gpt-5-mini",
      messages: [{ role: "user", content: "." }],
      max_tokens: 1,
      stream: false,
    }),
  });

  if (resp.status === 429) {
    const retryAfterSecs = Number(
      resp.headers.get("retry-after") ??
      resp.headers.get("x-ratelimit-user-retry-after") ??
      "0",
    );
    const sessionResetsAt = retryAfterSecs > 0
      ? new Date(Date.now() + retryAfterSecs * 1000).toISOString()
      : undefined;
    const exceeded = resp.headers.get("x-ratelimit-exceeded") ?? undefined;
    const limitKey = exceeded?.split(":")?.[1];

    return {
      rateLimited: true,
      sessionResetsAt,
      sessionRetryAfterSecs: retryAfterSecs > 0 ? retryAfterSecs : undefined,
      limitKey,
      weekly: { percentUsed: 0, percentRemaining: 0, entitlement: 0, resetsAt: nextWeeklyReset() },
      probeAvailable: true,
    };
  }

  const sessionHeader = parseWindowHeader(resp.headers.get("x-usage-ratelimit-session"));
  const weeklyHeader  = parseWindowHeader(resp.headers.get("x-usage-ratelimit-weekly"));
  const chatSnapshot  = parseWindowHeader(
    resp.headers.get("x-quota-snapshot-chat") ??
    resp.headers.get("x-quota-snapshot-premium_interactions"),
  );

  return {
    rateLimited: false,
    session: sessionHeader ? toWindowQuotaInfo(sessionHeader) : undefined,
    weekly: weeklyHeader
      ? toWindowQuotaInfo(weeklyHeader)
      : chatSnapshot
        ? toWindowQuotaInfo(chatSnapshot)
        : undefined,
    probeAvailable: true,
  };
}

async function getCopilotUserInfo(token: string): Promise<CopilotUserResponse> {
  const resp = await fetch("https://api.github.com/copilot_internal/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!resp.ok) {
    throw new CopilotStatusError(`/copilot_internal/user returned HTTP ${resp.status}`);
  }
  return resp.json() as Promise<CopilotUserResponse>;
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface CopilotStatusOptions {
  timeoutMs?: number;
  includeLogin?: boolean;
}

export async function getCopilotStatus(
  options: CopilotStatusOptions = {},
): Promise<CopilotStatusResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Step 1: resolve tokens
  let copilotOAuth: Awaited<ReturnType<typeof getCopilotOAuthToken>> | undefined;
  let sessionEnvelope: CopilotTokenEnvelope | undefined;
  let ghToken: string | undefined;
  let tokenSource: TokenSource;

  try {
    copilotOAuth = await getCopilotOAuthToken();
    sessionEnvelope = await withTimeout(getCAPISessionToken(copilotOAuth.token), timeoutMs);
    ghToken = copilotOAuth.token;
    tokenSource = copilotOAuth.source;
  } catch {
    const gh = await getGhToken();
    if (!gh) {
      throw new CopilotStatusError(
        "No GitHub token found. Set GITHUB_COPILOT_TOKEN, GITHUB_TOKEN, or authenticate with `gh auth login`.",
      );
    }
    ghToken = gh.token;
    tokenSource = gh.source;
  }

  // Step 2: monthly quota (works with any token)
  const userInfo = await withTimeout(getCopilotUserInfo(ghToken), timeoutMs);

  // Step 3: rate limit probe (requires Copilot session token)
  let shortTerm: ShortTermRateLimit;
  if (sessionEnvelope) {
    const apiBase = sessionEnvelope.endpoints?.api ?? "https://api.individual.githubcopilot.com";
    shortTerm = await withTimeout(probeCAPI(sessionEnvelope.token, apiBase), timeoutMs);
  } else {
    shortTerm = { rateLimited: false, probeAvailable: false };
  }

  // Step 4: assemble result
  const snaps = userInfo.quota_snapshots;

  const monthlyQuota: MonthlyQuota = {
    resetsAt: userInfo.quota_reset_date_utc ?? userInfo.quota_reset_date,
  };

  if (snaps?.chat) {
    monthlyQuota.chat = {
      remaining: snaps.chat.remaining,
      entitlement: snaps.chat.entitlement,
      percentRemaining: snaps.chat.percent_remaining,
      unlimited: snaps.chat.unlimited,
    };
  }
  if (snaps?.completions) {
    monthlyQuota.completions = {
      remaining: snaps.completions.remaining,
      entitlement: snaps.completions.entitlement,
      percentRemaining: snaps.completions.percent_remaining,
      unlimited: snaps.completions.unlimited,
    };
  }
  if (snaps?.premium_interactions) {
    monthlyQuota.premiumInteractions = {
      remaining: snaps.premium_interactions.remaining,
      entitlement: snaps.premium_interactions.entitlement,
      percentRemaining: snaps.premium_interactions.percent_remaining,
      unlimited: snaps.premium_interactions.unlimited,
    };
  }

  const account: CopilotStatusResult["account"] = {
    plan: userInfo.copilot_plan,
    sku: userInfo.access_type_sku,
  };
  if (options.includeLogin) {
    account.login = userInfo.login;
  }

  return {
    source: "copilot-status-mcp",
    tokenSource,
    account,
    shortTermRateLimit: shortTerm,
    monthlyQuota,
  };
}
