export const DEFAULT_CONFIG = {
    rotationStrategy: 'sticky-threshold',
    autoRefreshTokens: true,
    rateLimitCooldownMs: 5 * 60 * 1000, // 5 minutes
    modelUnsupportedCooldownMs: 30 * 60 * 1000, // 30 minutes
    workspaceDeactivatedCooldownMs: 30 * 60 * 1000, // 30 minutes
    stickyThresholdFiveHour: 0.7,
    stickyThresholdWeekly: 0.7,
    stickyRecoveryCheckIntervalMs: 60 * 60 * 1000,
    modelFilter: /^gpt-5/
};
//# sourceMappingURL=types.js.map