import { getStoreDiagnostics, loadStore, saveStore, updateAccount } from './store.js';
import { ensureValidToken } from './auth.js';
function shuffled(input) {
    const a = [...input];
    for (let i = a.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}
function utilizationFromWindow(window) {
    if (!window)
        return 0;
    if (typeof window.limit !== 'number' || typeof window.remaining !== 'number')
        return 0;
    if (!Number.isFinite(window.limit) || !Number.isFinite(window.remaining) || window.limit <= 0) {
        return 0;
    }
    return Math.min(1, Math.max(0, (window.limit - window.remaining) / window.limit));
}
function isOverThreshold(account, thresholds) {
    if (!account)
        return false;
    const fiveHour = utilizationFromWindow(account.rateLimits?.fiveHour);
    const weekly = utilizationFromWindow(account.rateLimits?.weekly);
    return fiveHour > thresholds.fiveHour || weekly > thresholds.weekly;
}
function utilizationScore(account, thresholds) {
    if (!account)
        return 0;
    const fiveHour = utilizationFromWindow(account.rateLimits?.fiveHour);
    const weekly = utilizationFromWindow(account.rateLimits?.weekly);
    return Math.max(fiveHour / Math.max(0.01, thresholds.fiveHour), weekly / Math.max(0.01, thresholds.weekly));
}
function earliestResetAt(account) {
    if (!account?.rateLimits)
        return null;
    const resets = [account.rateLimits.fiveHour?.resetAt, account.rateLimits.weekly?.resetAt].filter((value) => typeof value === 'number');
    if (resets.length === 0)
        return null;
    return Math.min(...resets);
}
export async function getNextAccount(config) {
    let store = loadStore();
    const aliases = Object.keys(store.accounts);
    if (aliases.length === 0) {
        const diag = getStoreDiagnostics();
        const extra = diag.error ? ` (${diag.error})` : '';
        console.error(`[multi-auth] No accounts configured. Run: opencode-multi-auth add <alias>${extra}`);
        if (process.env.OPENCODE_MULTI_AUTH_DEBUG === '1') {
            console.error(`[multi-auth] store file: ${diag.storeFile}`);
        }
        return null;
    }
    const now = Date.now();
    const availableAliases = aliases.filter(alias => {
        const acc = store.accounts[alias];
        const notRateLimited = !acc.rateLimitedUntil || acc.rateLimitedUntil < now;
        const notModelUnsupported = !acc.modelUnsupportedUntil || acc.modelUnsupportedUntil < now;
        const notWorkspaceDeactivated = !acc.workspaceDeactivatedUntil || acc.workspaceDeactivatedUntil < now;
        const notInvalidated = !acc.authInvalid;
        return notRateLimited && notModelUnsupported && notWorkspaceDeactivated && notInvalidated;
    });
    if (availableAliases.length === 0) {
        console.warn('[multi-auth] No available accounts (rate-limited or invalidated).');
        return null;
    }
    const tokenFailureCooldownMs = (() => {
        const raw = process.env.OPENCODE_MULTI_AUTH_TOKEN_FAILURE_COOLDOWN_MS;
        const parsed = raw ? Number(raw) : NaN;
        if (Number.isFinite(parsed) && parsed > 0)
            return parsed;
        return 60_000;
    })();
    const buildCandidates = () => {
        switch (config.rotationStrategy) {
            case 'sticky-threshold': {
                const allAliases = aliases;
                const primaryAlias = allAliases[0];
                const thresholds = {
                    fiveHour: config.stickyThresholdFiveHour,
                    weekly: config.stickyThresholdWeekly
                };
                const activeAlias = store.activeAlias && availableAliases.includes(store.activeAlias)
                    ? store.activeAlias
                    : null;
                const primaryAvailable = Boolean(primaryAlias && availableAliases.includes(primaryAlias));
                const pickFallback = () => {
                    const fallbacks = availableAliases.filter(alias => alias !== primaryAlias);
                    if (fallbacks.length === 0)
                        return null;
                    const underThreshold = fallbacks.find(alias => {
                        const acc = store.accounts[alias];
                        return !isOverThreshold(acc, thresholds);
                    });
                    if (underThreshold)
                        return underThreshold;
                    return [...fallbacks].sort((a, b) => {
                        const scoreA = utilizationScore(store.accounts[a], thresholds);
                        const scoreB = utilizationScore(store.accounts[b], thresholds);
                        if (scoreA !== scoreB)
                            return scoreA - scoreB;
                        return a.localeCompare(b);
                    })[0];
                };
                let selected;
                let selectedPrimary = false;
                if (!activeAlias) {
                    selected = primaryAvailable ? primaryAlias : availableAliases[0];
                    selectedPrimary = selected === primaryAlias;
                }
                else if (activeAlias === primaryAlias) {
                    const primaryUsage = store.accounts[primaryAlias];
                    if (primaryAvailable && isOverThreshold(primaryUsage, thresholds)) {
                        selected = pickFallback() || activeAlias;
                        selectedPrimary = selected === primaryAlias;
                    }
                    else {
                        selected = activeAlias;
                        selectedPrimary = true;
                    }
                }
                else {
                    selected = activeAlias;
                    selectedPrimary = false;
                    if (primaryAvailable && primaryAlias) {
                        const recoveryInterval = Math.max(1_000, config.stickyRecoveryCheckIntervalMs);
                        const lastCheck = store.lastPrimaryCheck || 0;
                        const resetAt = earliestResetAt(store.accounts[primaryAlias]);
                        const resetPassed = Boolean(resetAt && resetAt <= now && resetAt > lastCheck);
                        const intervalPassed = now - lastCheck >= recoveryInterval;
                        if (resetPassed || intervalPassed) {
                            store.lastPrimaryCheck = now;
                            if (!isOverThreshold(store.accounts[primaryAlias], thresholds)) {
                                selected = primaryAlias;
                                selectedPrimary = true;
                            }
                        }
                    }
                }
                const rest = availableAliases.filter(alias => alias !== selected);
                return {
                    aliases: [selected, ...rest],
                    selectedByPolicy: selected,
                    selectedPrimary
                };
            }
            case 'least-used': {
                const sorted = [...availableAliases].sort((a, b) => {
                    const aa = store.accounts[a];
                    const bb = store.accounts[b];
                    const usageDiff = (aa?.usageCount || 0) - (bb?.usageCount || 0);
                    if (usageDiff !== 0)
                        return usageDiff;
                    const lastDiff = (aa?.lastUsed || 0) - (bb?.lastUsed || 0);
                    if (lastDiff !== 0)
                        return lastDiff;
                    return a.localeCompare(b);
                });
                return { aliases: sorted };
            }
            case 'random': {
                return { aliases: shuffled(availableAliases) };
            }
            case 'round-robin':
            default: {
                const start = store.rotationIndex % availableAliases.length;
                const rr = availableAliases.map((_, i) => availableAliases[(start + i) % availableAliases.length]);
                const nextIndex = (selected) => {
                    const idx = availableAliases.indexOf(selected);
                    if (idx < 0)
                        return store.rotationIndex;
                    return (idx + 1) % availableAliases.length;
                };
                return { aliases: rr, nextIndex };
            }
        }
    };
    const { aliases: candidates, nextIndex, selectedByPolicy, selectedPrimary } = buildCandidates();
    for (const candidate of candidates) {
        const token = await ensureValidToken(candidate);
        if (!token) {
            // Don't hard-fail the whole system on a single broken account.
            // Put it on a short cooldown so rotation can keep working.
            store = updateAccount(candidate, {
                rateLimitedUntil: now + tokenFailureCooldownMs,
                limitError: '[multi-auth] Token unavailable (refresh failed?)',
                lastLimitErrorAt: now
            });
            continue;
        }
        store = updateAccount(candidate, {
            usageCount: (store.accounts[candidate]?.usageCount || 0) + 1,
            lastUsed: now,
            limitError: undefined
        });
        store.activeAlias = candidate;
        store.lastRotation = now;
        if (config.rotationStrategy === 'sticky-threshold') {
            if (!selectedPrimary) {
                store.lastPrimaryCheck = now;
            }
            if (selectedByPolicy && selectedByPolicy !== candidate) {
                store.lastPrimaryCheck = now;
            }
        }
        if (nextIndex) {
            store.rotationIndex = nextIndex(candidate);
        }
        saveStore(store);
        return { account: store.accounts[candidate], token };
    }
    console.error('[multi-auth] No available accounts (token refresh failed on all candidates).');
    return null;
}
export function markRateLimited(alias, cooldownMs) {
    updateAccount(alias, {
        rateLimitedUntil: Date.now() + cooldownMs
    });
    console.warn(`[multi-auth] Account ${alias} marked rate-limited for ${cooldownMs / 1000}s`);
}
export function clearRateLimit(alias) {
    updateAccount(alias, {
        rateLimitedUntil: undefined
    });
}
export function markModelUnsupported(alias, cooldownMs, info) {
    updateAccount(alias, {
        modelUnsupportedUntil: Date.now() + cooldownMs,
        modelUnsupportedAt: Date.now(),
        modelUnsupportedModel: info?.model,
        modelUnsupportedError: info?.error
    });
    const extra = info?.model ? ` (model=${info.model})` : '';
    console.warn(`[multi-auth] Account ${alias} marked model-unsupported for ${cooldownMs / 1000}s${extra}`);
}
export function clearModelUnsupported(alias) {
    updateAccount(alias, {
        modelUnsupportedUntil: undefined,
        modelUnsupportedAt: undefined,
        modelUnsupportedModel: undefined,
        modelUnsupportedError: undefined
    });
}
export function markWorkspaceDeactivated(alias, cooldownMs, info) {
    updateAccount(alias, {
        workspaceDeactivatedUntil: Date.now() + cooldownMs,
        workspaceDeactivatedAt: Date.now(),
        workspaceDeactivatedError: info?.error
    });
    console.warn(`[multi-auth] Account ${alias} marked workspace-deactivated for ${cooldownMs / 1000}s`);
}
export function clearWorkspaceDeactivated(alias) {
    updateAccount(alias, {
        workspaceDeactivatedUntil: undefined,
        workspaceDeactivatedAt: undefined,
        workspaceDeactivatedError: undefined
    });
}
export function markAuthInvalid(alias) {
    updateAccount(alias, {
        authInvalid: true,
        authInvalidatedAt: Date.now()
    });
    console.warn(`[multi-auth] Account ${alias} marked invalidated`);
}
export function clearAuthInvalid(alias) {
    updateAccount(alias, {
        authInvalid: false,
        authInvalidatedAt: undefined
    });
}
//# sourceMappingURL=rotation.js.map