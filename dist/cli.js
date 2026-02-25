#!/usr/bin/env node
import { Args, Command, Options } from "@effect/cli";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Console, Effect, Option } from "effect";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loginAccount } from "./auth.js";
import { getStoreConfig, getStorePath, listAccounts, loadStore, removeAccount, resetStoreConfig, updateStoreConfig, } from "./store.js";
import { disableService, installService, serviceStatus } from "./systemd.js";
import { DEFAULT_CONFIG } from "./types.js";
import { startWebConsole } from "./web.js";
function parseThreshold(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`Invalid threshold value: ${value}`);
    }
    return parsed > 1 ? parsed / 100 : parsed;
}
function parseIntervalMinutes(value) {
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`Invalid interval value: ${value}`);
    }
    return Math.round(value * 60 * 1000);
}
function currentConfig() {
    return {
        ...DEFAULT_CONFIG,
        ...(getStoreConfig() || {}),
    };
}
function resolveCliVersion() {
    try {
        const thisFile = fileURLToPath(import.meta.url);
        const pkgPath = join(dirname(thisFile), "..", "package.json");
        const parsed = JSON.parse(readFileSync(pkgPath, "utf-8"));
        return parsed.version || "0.0.0";
    }
    catch {
        return process.env.npm_package_version ?? "0.0.0";
    }
}
const printConfigEffect = Effect.gen(function* () {
    const cfg = currentConfig();
    yield* Console.log("\n[multi-auth] Config\n");
    yield* Console.log(`Strategy: ${cfg.rotationStrategy}`);
    yield* Console.log(`Threshold 5h: ${(cfg.stickyThresholdFiveHour * 100).toFixed(0)}%`);
    yield* Console.log(`Threshold weekly: ${(cfg.stickyThresholdWeekly * 100).toFixed(0)}%`);
    yield* Console.log(`Recovery check: ${Math.round(cfg.stickyRecoveryCheckIntervalMs / 60000)} min\n`);
});
const aliasArg = Args.text({ name: "alias" }).pipe(Args.withDescription("Account alias"));
const addHandler = ({ alias }) => Effect.tryPromise({
    try: async () => {
        const account = await loginAccount(alias);
        console.log(`\nAccount "${alias}" added successfully!`);
        console.log(`Email: ${account.email || "unknown"}`);
    },
    catch: (err) => new Error(`Failed to add account: ${err instanceof Error ? err.message : String(err)}`),
});
const addCommand = Command.make("add", { alias: aliasArg }, addHandler).pipe(Command.withDescription("Add a new account (opens browser for OAuth)"));
const loginCommand = Command.make("login", { alias: aliasArg }, addHandler).pipe(Command.withDescription("Alias for add"));
const removeCommand = Command.make("remove", { alias: aliasArg }, ({ alias }) => Effect.sync(() => {
    removeAccount(alias);
    console.log(`Account "${alias}" removed.`);
})).pipe(Command.withDescription("Remove an account"));
const rmCommand = Command.make("rm", { alias: aliasArg }, ({ alias }) => Effect.sync(() => {
    removeAccount(alias);
    console.log(`Account "${alias}" removed.`);
})).pipe(Command.withDescription("Alias for remove"));
const listCommand = Command.make("list", {}, () => Effect.sync(() => {
    const accounts = listAccounts();
    if (accounts.length === 0) {
        console.log("No accounts configured.");
        console.log("Add one with: opencode-multi-auth add <alias>");
        return;
    }
    console.log("\nConfigured accounts:\n");
    for (const acc of accounts) {
        console.log(`  ${acc.alias}: ${acc.email || "unknown email"} (uses: ${acc.usageCount})`);
    }
    console.log();
})).pipe(Command.withDescription("List all configured accounts"));
const lsCommand = Command.make("ls", {}, () => Effect.sync(() => {
    const accounts = listAccounts();
    if (accounts.length === 0) {
        console.log("No accounts configured.");
        console.log("Add one with: opencode-multi-auth add <alias>");
        return;
    }
    console.log("\nConfigured accounts:\n");
    for (const acc of accounts) {
        console.log(`  ${acc.alias}: ${acc.email || "unknown email"} (uses: ${acc.usageCount})`);
    }
    console.log();
})).pipe(Command.withDescription("Alias for list"));
const statusCommand = Command.make("status", {}, () => Effect.sync(() => {
    const store = loadStore();
    const accounts = Object.values(store.accounts);
    const cfg = currentConfig();
    console.log("\n[multi-auth] Account Status\n");
    console.log(`Strategy: ${cfg.rotationStrategy}`);
    console.log(`Accounts: ${accounts.length}`);
    console.log(`Active: ${store.activeAlias || "none"}\n`);
    if (accounts.length === 0) {
        console.log("No accounts configured. Run: opencode-multi-auth add <alias>\n");
        return;
    }
    for (const acc of accounts) {
        const isActive = acc.alias === store.activeAlias ? " (active)" : "";
        const isRateLimited = acc.rateLimitedUntil && acc.rateLimitedUntil > Date.now()
            ? ` [RATE LIMITED until ${new Date(acc.rateLimitedUntil).toLocaleTimeString()}]`
            : "";
        const expiry = new Date(acc.expiresAt).toLocaleString();
        console.log(`  ${acc.alias}${isActive}${isRateLimited}`);
        console.log(`    Email: ${acc.email || "unknown"}`);
        console.log(`    Uses: ${acc.usageCount}`);
        console.log(`    Token expires: ${expiry}`);
        console.log();
    }
})).pipe(Command.withDescription("Show detailed account status"));
const pingCommand = Command.make("ping", { alias: aliasArg }, ({ alias }) => Effect.tryPromise({
    try: async () => {
        try {
            const store = loadStore();
            const account = store.accounts[alias];
            if (!account) {
                console.log(JSON.stringify({ status: "error", alias, error: "Account not found" }));
                return;
            }
            if (!account.accessToken) {
                console.log(JSON.stringify({ status: "error", alias, error: "Missing access token" }));
                return;
            }
            if (account.expiresAt < Date.now()) {
                console.log(JSON.stringify({ status: "error", alias, error: "Token expired" }));
                return;
            }
            const res = await fetch("https://api.openai.com/v1/models", {
                method: "GET",
                headers: {
                    Authorization: `Bearer ${account.accessToken}`,
                },
            });
            if (res.ok) {
                console.log(JSON.stringify({ status: "ok", alias }));
                return;
            }
            console.log(JSON.stringify({ status: "error", alias, error: `HTTP ${res.status}` }));
        }
        catch (err) {
            console.log(JSON.stringify({ status: "error", alias, error: String(err) }));
        }
    },
    catch: (err) => new Error(`Ping command failed: ${err instanceof Error ? err.message : String(err)}`),
})).pipe(Command.withDescription("Check account token against OpenAI API"));
const pathCommand = Command.make("path", {}, () => Effect.sync(() => {
    console.log(getStorePath());
})).pipe(Command.withDescription("Show config file location"));
const webCommand = Command.make("web", {
    port: Options.integer("port").pipe(Options.optional),
    host: Options.text("host").pipe(Options.optional),
}, ({ port, host }) => Effect.sync(() => {
    startWebConsole({
        port: Option.getOrUndefined(port),
        host: Option.getOrUndefined(host),
    });
})).pipe(Command.withDescription("Launch local Codex auth.json dashboard"));
const serviceInstallCommand = Command.make("install", {
    port: Options.integer("port").pipe(Options.optional),
    host: Options.text("host").pipe(Options.optional),
}, ({ port, host }) => Effect.sync(() => {
    const cliPath = fileURLToPath(import.meta.url);
    const file = installService({
        cliPath,
        host: Option.getOrUndefined(host),
        port: Option.getOrUndefined(port),
    });
    console.log(`Installed systemd user service at ${file}`);
})).pipe(Command.withDescription("Install systemd user service"));
const serviceDisableCommand = Command.make("disable", {}, () => Effect.sync(() => {
    disableService();
    console.log("Disabled codex-soft systemd user service.");
})).pipe(Command.withDescription("Disable systemd user service"));
const serviceStatusCommand = Command.make("status", {}, () => Effect.sync(() => {
    serviceStatus();
})).pipe(Command.withDescription("Show systemd user service status"));
const serviceCommand = Command.make("service", {}).pipe(Command.withDescription("Install/disable systemd user service"), Command.withSubcommands([
    serviceInstallCommand,
    serviceDisableCommand,
    serviceStatusCommand,
]));
const configCommand = Command.make("config", {
    strategy: Options.choice("strategy", [
        "sticky-threshold",
        "round-robin",
        "least-used",
        "random",
    ]).pipe(Options.optional),
    threshold: Options.text("threshold").pipe(Options.optional),
    thresholds: Options.text("thresholds").pipe(Options.optional),
    threshold5h: Options.text("threshold-5h").pipe(Options.optional),
    thresholdWeekly: Options.text("threshold-weekly").pipe(Options.optional),
    interval: Options.integer("interval").pipe(Options.optional),
    reset: Options.boolean("reset"),
}, ({ strategy, threshold, thresholds, threshold5h, thresholdWeekly, interval, reset }) => Effect.try({
    try: () => {
        if (reset) {
            resetStoreConfig();
            return;
        }
        if (Option.isSome(strategy)) {
            updateStoreConfig({ rotationStrategy: strategy.value });
        }
        if (Option.isSome(threshold)) {
            const normalized = parseThreshold(threshold.value);
            updateStoreConfig({
                stickyThresholdFiveHour: normalized,
                stickyThresholdWeekly: normalized,
            });
        }
        if (Option.isSome(thresholds)) {
            const parts = thresholds.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
            if (parts.length !== 2) {
                throw new Error("Use --thresholds <fiveHour,weekly>");
            }
            updateStoreConfig({
                stickyThresholdFiveHour: parseThreshold(parts[0]),
                stickyThresholdWeekly: parseThreshold(parts[1]),
            });
        }
        if (Option.isSome(threshold5h)) {
            updateStoreConfig({
                stickyThresholdFiveHour: parseThreshold(threshold5h.value),
            });
        }
        if (Option.isSome(thresholdWeekly)) {
            updateStoreConfig({
                stickyThresholdWeekly: parseThreshold(thresholdWeekly.value),
            });
        }
        if (Option.isSome(interval)) {
            updateStoreConfig({
                stickyRecoveryCheckIntervalMs: parseIntervalMinutes(interval.value),
            });
        }
    },
    catch: (err) => new Error(err instanceof Error ? err.message : String(err)),
}).pipe(Effect.zipRight(printConfigEffect))).pipe(Command.withDescription("Show/update rotation thresholds and strategy"));
const rootCommand = Command.make("opencode-multi-auth", {}).pipe(Command.withDescription("Multi-account OAuth rotation for OpenAI Codex"), Command.withSubcommands([
    addCommand,
    loginCommand,
    removeCommand,
    rmCommand,
    listCommand,
    lsCommand,
    statusCommand,
    pingCommand,
    pathCommand,
    webCommand,
    serviceCommand,
    configCommand,
]));
const cli = Command.run(rootCommand, {
    name: "opencode-multi-auth",
    version: resolveCliVersion(),
});
cli(process.argv).pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain);
//# sourceMappingURL=cli.js.map