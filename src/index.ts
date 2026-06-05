// Public SDK entry point
export { getCopilotStatus, CopilotStatusError, DEFAULT_TIMEOUT_MS } from "./quota.js";
export type {
  CopilotStatusOptions,
  CopilotStatusResult,
  ShortTermRateLimit,
  MonthlyQuota,
  QuotaSnapshot,
  WindowQuotaInfo,
} from "./quota.js";
export { getCopilotOAuthToken, getGhToken, CredentialError } from "./credentials.js";
export type { CopilotOAuthToken, GhToken, TokenSource } from "./credentials.js";
