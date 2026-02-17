#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { loginAccount } from './auth.js';
import { removeAccount, listAccounts, getStorePath, loadStore, getStoreConfig, updateStoreConfig, resetStoreConfig } from './store.js';
import { startWebConsole } from './web.js';
import { disableService, installService, serviceStatus } from './systemd.js';
import { DEFAULT_CONFIG } from './types.js';
const args = process.argv.slice(2);
const command = args[0];
const alias = args[1];
function getFlagValue(flag) {
    const idx = args.indexOf(flag);
    if (idx === -1)
        return undefined;
    return args[idx + 1];
}
function parseThreshold(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`Invalid threshold value: ${value}`);
    }
    return parsed > 1 ? parsed / 100 : parsed;
}
function parseIntervalMinutes(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid interval value: ${value}`);
    }
    return Math.round(parsed * 60 * 1000);
}
function printConfig() {
    const cfg = {
        ...DEFAULT_CONFIG,
        ...(getStoreConfig() || {})
    };
    console.log('\n[multi-auth] Config\n');
    console.log(`Strategy: ${cfg.rotationStrategy}`);
    console.log(`Threshold 5h: ${(cfg.stickyThresholdFiveHour * 100).toFixed(0)}%`);
    console.log(`Threshold weekly: ${(cfg.stickyThresholdWeekly * 100).toFixed(0)}%`);
    console.log(`Recovery check: ${Math.round(cfg.stickyRecoveryCheckIntervalMs / 60000)} min`);
    console.log();
}
async function main() {
    switch (command) {
        case 'add':
        case 'login': {
            if (!alias) {
                console.error('Usage: opencode-multi-auth add <alias>');
                console.error('Example: opencode-multi-auth add work');
                process.exit(1);
            }
            try {
                const account = await loginAccount(alias);
                console.log(`\nAccount "${alias}" added successfully!`);
                console.log(`Email: ${account.email || 'unknown'}`);
            }
            catch (err) {
                console.error(`Failed to add account: ${err}`);
                process.exit(1);
            }
            break;
        }
        case 'remove':
        case 'rm': {
            if (!alias) {
                console.error('Usage: opencode-multi-auth remove <alias>');
                process.exit(1);
            }
            removeAccount(alias);
            console.log(`Account "${alias}" removed.`);
            break;
        }
        case 'list':
        case 'ls': {
            const accounts = listAccounts();
            if (accounts.length === 0) {
                console.log('No accounts configured.');
                console.log('Add one with: opencode-multi-auth add <alias>');
            }
            else {
                console.log('\nConfigured accounts:\n');
                for (const acc of accounts) {
                    console.log(`  ${acc.alias}: ${acc.email || 'unknown email'} (uses: ${acc.usageCount})`);
                }
                console.log();
            }
            break;
        }
        case 'status': {
            const store = loadStore();
            const accounts = Object.values(store.accounts);
            const cfg = {
                ...DEFAULT_CONFIG,
                ...(store.config || {})
            };
            console.log('\n[multi-auth] Account Status\n');
            console.log(`Strategy: ${cfg.rotationStrategy}`);
            console.log(`Accounts: ${accounts.length}`);
            console.log(`Active: ${store.activeAlias || 'none'}\n`);
            if (accounts.length === 0) {
                console.log('No accounts configured. Run: opencode-multi-auth add <alias>\n');
                return;
            }
            for (const acc of accounts) {
                const isActive = acc.alias === store.activeAlias ? ' (active)' : '';
                const isRateLimited = acc.rateLimitedUntil && acc.rateLimitedUntil > Date.now()
                    ? ` [RATE LIMITED until ${new Date(acc.rateLimitedUntil).toLocaleTimeString()}]`
                    : '';
                const expiry = new Date(acc.expiresAt).toLocaleString();
                console.log(`  ${acc.alias}${isActive}${isRateLimited}`);
                console.log(`    Email: ${acc.email || 'unknown'}`);
                console.log(`    Uses: ${acc.usageCount}`);
                console.log(`    Token expires: ${expiry}`);
                console.log();
            }
            break;
        }
        case 'config': {
            try {
                if (args.includes('--reset')) {
                    resetStoreConfig();
                    printConfig();
                    break;
                }
                const strategy = getFlagValue('--strategy');
                if (strategy) {
                    const allowed = ['sticky-threshold', 'round-robin', 'least-used', 'random'];
                    if (!allowed.includes(strategy)) {
                        throw new Error(`Invalid --strategy value: ${strategy}`);
                    }
                    updateStoreConfig({ rotationStrategy: strategy });
                }
                const threshold = getFlagValue('--threshold');
                if (threshold) {
                    const normalized = parseThreshold(threshold);
                    updateStoreConfig({
                        stickyThresholdFiveHour: normalized,
                        stickyThresholdWeekly: normalized
                    });
                }
                const thresholds = getFlagValue('--thresholds');
                if (thresholds) {
                    const parts = thresholds.split(',').map(s => s.trim()).filter(Boolean);
                    if (parts.length !== 2) {
                        throw new Error('Use --thresholds <fiveHour,weekly>');
                    }
                    updateStoreConfig({
                        stickyThresholdFiveHour: parseThreshold(parts[0]),
                        stickyThresholdWeekly: parseThreshold(parts[1])
                    });
                }
                const threshold5h = getFlagValue('--threshold-5h');
                if (threshold5h) {
                    updateStoreConfig({ stickyThresholdFiveHour: parseThreshold(threshold5h) });
                }
                const thresholdWeekly = getFlagValue('--threshold-weekly');
                if (thresholdWeekly) {
                    updateStoreConfig({ stickyThresholdWeekly: parseThreshold(thresholdWeekly) });
                }
                const interval = getFlagValue('--interval');
                if (interval) {
                    updateStoreConfig({
                        stickyRecoveryCheckIntervalMs: parseIntervalMinutes(interval)
                    });
                }
                printConfig();
            }
            catch (err) {
                console.error(String(err));
                process.exit(1);
            }
            break;
        }
        case 'path': {
            console.log(getStorePath());
            break;
        }
        case 'web': {
            const portArg = getFlagValue('--port');
            const hostArg = getFlagValue('--host');
            const port = portArg ? Number(portArg) : undefined;
            if (portArg && Number.isNaN(port)) {
                console.error('Invalid --port value');
                process.exit(1);
            }
            startWebConsole({ port, host: hostArg });
            break;
        }
        case 'service': {
            const action = args[1] || 'status';
            const portArg = getFlagValue('--port');
            const hostArg = getFlagValue('--host');
            const port = portArg ? Number(portArg) : undefined;
            if (portArg && Number.isNaN(port)) {
                console.error('Invalid --port value');
                process.exit(1);
            }
            const cliPath = fileURLToPath(import.meta.url);
            if (action === 'install') {
                const file = installService({ cliPath, host: hostArg, port });
                console.log(`Installed systemd user service at ${file}`);
                break;
            }
            if (action === 'disable') {
                disableService();
                console.log('Disabled codex-soft systemd user service.');
                break;
            }
            serviceStatus();
            break;
        }
        case 'help':
        case '--help':
        case '-h':
        default: {
            console.log(`
opencode-multi-auth - Multi-account OAuth rotation for OpenAI Codex

Commands:
  add <alias>      Add a new account (opens browser for OAuth)
  remove <alias>   Remove an account
  list             List all configured accounts
  status           Show detailed account status
  config           Show/update rotation thresholds and strategy
  path             Show config file location
  web              Launch local Codex auth.json dashboard (use --port/--host)
  service          Install/disable systemd user service (install|disable|status)
  help             Show this help message

Examples:
  opencode-multi-auth add personal
  opencode-multi-auth add work
  opencode-multi-auth add backup
  opencode-multi-auth status
  opencode-multi-auth config
  opencode-multi-auth config --threshold 0.8
  opencode-multi-auth config --thresholds 0.75,0.85
  opencode-multi-auth config --threshold-5h 0.8 --threshold-weekly 0.9
  opencode-multi-auth config --interval 30
  opencode-multi-auth web --port 3434 --host 127.0.0.1
  opencode-multi-auth service install --port 3434 --host 127.0.0.1

After adding accounts, the plugin auto-rotates between them.
`);
            break;
        }
    }
}
main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
//# sourceMappingURL=cli.js.map