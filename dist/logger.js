import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
const DEFAULT_LOG_FILE = path.join(os.homedir(), '.config', 'opencode', 'codex-multi-account-log.log');
const LOG_FILE = process.env.CODEX_SOFT_LOG_PATH || DEFAULT_LOG_FILE;
const MAX_LOG_LINES = 400;
function ensureDir() {
    const dir = path.dirname(LOG_FILE);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
}
function sanitize(message) {
    return message
        .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[jwt]')
        .replace(/\bsk-[A-Za-z0-9]{10,}\b/g, '[token]');
}
function append(level, message) {
    try {
        ensureDir();
        const line = `${new Date().toISOString()} [${level}] ${sanitize(message)}\n`;
        fs.appendFileSync(LOG_FILE, line, { encoding: 'utf-8', mode: 0o600 });
    }
    catch {
        // Ignore log write failures
    }
}
export function logInfo(message) {
    append('info', message);
}
export function logWarn(message) {
    append('warn', message);
}
export function logError(message) {
    append('error', message);
}
export function getLogPath() {
    return LOG_FILE;
}
export function readLogTail(maxLines = MAX_LOG_LINES) {
    try {
        if (!fs.existsSync(LOG_FILE))
            return [];
        const data = fs.readFileSync(LOG_FILE, 'utf-8');
        const lines = data.split('\n').filter(Boolean);
        return lines.slice(Math.max(0, lines.length - maxLines));
    }
    catch {
        return [];
    }
}
//# sourceMappingURL=logger.js.map