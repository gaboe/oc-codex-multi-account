// Account credentials stored locally
export interface AccountCredentials {
  alias: string
  accessToken: string
  refreshToken: string
  idToken?: string
  accountId?: string
  expiresAt: number // Unix timestamp
  email?: string
  lastRefresh?: string
  lastSeenAt?: number
  lastActiveUntil?: number
  lastUsed?: number
  usageCount: number
  rateLimitedUntil?: number // If hit rate limit, when it resets
  // Some accounts don't have access to a given Codex model yet (staged rollout).
  // We temporarily skip them instead of hard-invalidating the account.
  modelUnsupportedUntil?: number
  modelUnsupportedAt?: number
  modelUnsupportedModel?: string
  modelUnsupportedError?: string
  // Some ChatGPT accounts can be in a deactivated workspace state (402 Payment Required,
  // detail.code = "deactivated_workspace"). Treat this as a temporary block and rotate.
  workspaceDeactivatedUntil?: number
  workspaceDeactivatedAt?: number
  workspaceDeactivatedError?: string
  authInvalid?: boolean
  authInvalidatedAt?: number
  rateLimits?: AccountRateLimits
  rateLimitHistory?: RateLimitHistoryEntry[]
  limitStatus?: LimitStatus
  limitError?: string
  lastLimitProbeAt?: number
  lastLimitErrorAt?: number
  tags?: string[]
  notes?: string
  source?: 'opencode' | 'codex'
}

export interface RateLimitWindow {
  limit?: number
  remaining?: number
  resetAt?: number
  updatedAt?: number
}

export interface AccountRateLimits {
  fiveHour?: RateLimitWindow
  weekly?: RateLimitWindow
}

export interface RateLimitSnapshot {
  remaining?: number
  limit?: number
  resetAt?: number
}

export interface RateLimitHistoryEntry {
  at: number
  fiveHour?: RateLimitSnapshot
  weekly?: RateLimitSnapshot
}

export type LimitStatus = 'idle' | 'queued' | 'running' | 'success' | 'error' | 'stopped'

// Local store for all accounts
export interface AccountStore {
  accounts: Record<string, AccountCredentials>
  activeAlias: string | null
  rotationIndex: number
  lastRotation: number
  lastPrimaryCheck?: number
}

// OpenAI model info
export interface OpenAIModel {
  id: string
  object: string
  created: number
  owned_by: string
}

// Plugin config
export interface PluginConfig {
  rotationStrategy: 'sticky-threshold' | 'round-robin' | 'least-used' | 'random'
  autoRefreshTokens: boolean
  rateLimitCooldownMs: number // How long to skip rate-limited accounts
  modelUnsupportedCooldownMs: number // How long to skip accounts that don't support the requested model
  workspaceDeactivatedCooldownMs: number // How long to skip accounts with deactivated workspaces
  stickyThresholdFiveHour: number
  stickyThresholdWeekly: number
  stickyRecoveryCheckIntervalMs: number
  modelFilter: RegExp // Which models to expose
}

// OpenCode provider model definition
export interface ProviderModel {
  name: string
  limit: {
    context: number
    output: number
  }
  modalities: {
    input: string[]
    output: string[]
  }
  options: {
    reasoningEffort: string
    reasoningSummary: string
    textVerbosity: string
    include: string[]
    store: boolean
  }
}

export const DEFAULT_CONFIG: PluginConfig = {
  rotationStrategy: 'sticky-threshold',
  autoRefreshTokens: true,
  rateLimitCooldownMs: 5 * 60 * 1000, // 5 minutes
  modelUnsupportedCooldownMs: 30 * 60 * 1000, // 30 minutes
  workspaceDeactivatedCooldownMs: 30 * 60 * 1000, // 30 minutes
  stickyThresholdFiveHour: 0.7,
  stickyThresholdWeekly: 0.7,
  stickyRecoveryCheckIntervalMs: 60 * 60 * 1000,
  modelFilter: /^gpt-5/
}
