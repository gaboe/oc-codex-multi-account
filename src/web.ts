import * as fs from 'node:fs'
import * as http from 'node:http'
import * as https from 'node:https'
import * as os from 'node:os'
import * as path from 'node:path'
import { URL } from 'node:url'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { createAuthorizationFlow, loginAccount, refreshToken } from './auth.js'
import { getCodexAuthPath, getCodexAuthStatus, syncCodexAuthFile, writeCodexAuthForAlias } from './codex-auth.js'
import { getStoreStatus, listAccounts, loadStore, removeAccount, updateAccount } from './store.js'
import { getRefreshQueueState, startRefreshQueue, stopRefreshQueue } from './refresh-queue.js'
import { getLogPath, logError, logInfo, readLogTail } from './logger.js'
import type { AccountCredentials, RateLimitWindow } from './types.js'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 3434
const SYNC_INTERVAL_MS = 3000
const SYNC_DEBOUNCE_MS = 600
const ANTIGRAVITY_ACCOUNTS_FILE = path.join(os.homedir(), '.config', 'opencode', 'antigravity-accounts.json')

const execAsync = promisify(exec)

let lastSyncAt = 0
let lastSyncError: string | null = null
let syncTimer: NodeJS.Timeout | null = null
let pendingLogin: { alias: string; startedAt: number; url: string } | null = null
let lastLoginError: string | null = null
let antigravityQuotaState: AntigravityQuotaState = { status: 'idle', scope: 'active' }
let antigravityQuotaInFlight: Promise<AntigravityQuotaState> | null = null

const HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Codex Token Dashboard</title>
    <style>
      @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&family=JetBrains+Mono:wght@400;600&display=swap');

      :root {
        --bg: #0f1116;
        --panel: #1a1e27;
        --panel-2: #222836;
        --accent: #ffb547;
        --accent-2: #6ee7ff;
        --text: #eef1f6;
        --muted: #9aa4b2;
        --danger: #ff6b6b;
        --success: #37d399;
        --warning: #f97316;
        --shadow: rgba(15, 17, 22, 0.45);
      }

      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: 'Space Grotesk', sans-serif;
        background:
          radial-gradient(1200px 600px at 10% 0%, rgba(110, 231, 255, 0.08), transparent 60%),
          radial-gradient(1200px 600px at 90% 10%, rgba(255, 181, 71, 0.1), transparent 55%),
          var(--bg);
        color: var(--text);
        min-height: 100vh;
      }
      header {
        padding: 32px 28px 12px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      h1 {
        margin: 0;
        font-size: 28px;
        font-weight: 700;
        letter-spacing: -0.02em;
      }
      .subtitle {
        color: var(--muted);
        font-size: 14px;
      }
      .container {
        padding: 0 24px 40px;
        display: grid;
        gap: 18px;
      }
      .panel {
        background: linear-gradient(180deg, rgba(26, 30, 39, 0.98), rgba(22, 26, 34, 0.98));
        border: 1px solid rgba(255, 255, 255, 0.06);
        border-radius: 18px;
        box-shadow: 0 18px 40px var(--shadow);
        padding: 18px;
      }
      .meta {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 14px;
      }
      .meta-item {
        background: var(--panel-2);
        border-radius: 14px;
        padding: 12px 14px;
      }
      .meta-item span {
        display: block;
        color: var(--muted);
        font-size: 12px;
      }
      .meta-item strong {
        display: block;
        margin-top: 6px;
        font-size: 16px;
        word-break: break-word;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: center;
      }
      .add-row {
        display: flex;
        gap: 12px;
        margin-top: 12px;
      }
      .add-row input {
        flex: 1;
        background: var(--panel-2);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 12px;
        padding: 12px 14px;
        color: var(--text);
        font-family: inherit;
        font-size: 14px;
      }
      .add-row input::placeholder {
        color: var(--muted);
      }
      .add-row button {
        white-space: nowrap;
      }
      button {
        cursor: pointer;
        border: none;
        border-radius: 10px;
        padding: 10px 14px;
        font-weight: 600;
        font-family: 'Space Grotesk', sans-serif;
        color: #0b0f14;
        background: var(--accent);
        transition: transform 120ms ease, box-shadow 120ms ease;
      }
      button.secondary {
        background: transparent;
        color: var(--text);
        border: 1px solid rgba(255,255,255,0.1);
      }
      button.ghost {
        background: transparent;
        color: var(--muted);
        border: 1px dashed rgba(255,255,255,0.12);
      }
      button.danger {
        background: var(--danger);
        color: #0b0f14;
      }
      button.small {
        padding: 6px 10px;
        font-size: 12px;
      }
      button:active { transform: translateY(1px); }
      .filters {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
        gap: 12px;
      }
      .filters input,
      .filters select {
        width: 100%;
        padding: 10px 12px;
        border-radius: 10px;
        border: 1px solid rgba(255,255,255,0.1);
        background: #141823;
        color: var(--text);
        font-family: 'Space Grotesk', sans-serif;
      }
      .queue {
        display: grid;
        gap: 10px;
        margin-top: 12px;
      }
      .progress-bar {
        width: 100%;
        height: 8px;
        border-radius: 999px;
        background: rgba(255,255,255,0.08);
        overflow: hidden;
      }
      .progress-fill {
        height: 100%;
        border-radius: 999px;
        background: linear-gradient(90deg, var(--accent-2), var(--accent));
        width: 0%;
        transition: width 160ms ease;
      }
      .accounts {
        display: grid;
        gap: 16px;
        grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      }
      .account-card {
        background: var(--panel);
        border-radius: 16px;
        padding: 16px;
        border: 1px solid rgba(255,255,255,0.06);
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .account-title {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .badge {
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        padding: 4px 8px;
        border-radius: 999px;
        background: rgba(55, 211, 153, 0.15);
        color: var(--success);
      }
      .badge.inactive {
        background: rgba(255,255,255,0.08);
        color: var(--muted);
      }
      .badge.recommended {
        background: rgba(110, 231, 255, 0.15);
        color: var(--accent-2);
      }
      .status-badge {
        font-size: 11px;
        padding: 4px 8px;
        border-radius: 999px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .status-idle { background: rgba(255,255,255,0.08); color: var(--muted); }
      .status-queued { background: rgba(110, 231, 255, 0.15); color: var(--accent-2); }
      .status-running { background: rgba(255, 181, 71, 0.2); color: var(--accent); }
      .status-success { background: rgba(55, 211, 153, 0.15); color: var(--success); }
      .status-error { background: rgba(255, 107, 107, 0.18); color: var(--danger); }
      .status-stopped { background: rgba(249, 115, 22, 0.2); color: var(--warning); }
      .account-meta {
        display: grid;
        gap: 6px;
        font-size: 13px;
        color: var(--muted);
      }
      .limit-grid {
        display: grid;
        gap: 8px;
      }
      .limit-card {
        background: #121620;
        border-radius: 12px;
        padding: 10px 12px;
        font-size: 13px;
      }
      .limit-card strong {
        display: block;
        font-size: 14px;
        color: var(--text);
      }
      .limit-card span {
        color: var(--muted);
        font-size: 12px;
      }
      .tag-row {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        align-items: center;
      }
      .tag-chip {
        padding: 4px 8px;
        border-radius: 999px;
        background: rgba(255,255,255,0.08);
        font-size: 11px;
        color: var(--muted);
      }
      .notes {
        font-size: 12px;
        color: var(--muted);
        background: rgba(255,255,255,0.04);
        padding: 8px 10px;
        border-radius: 10px;
      }
      .meta-editor {
        display: none;
        flex-direction: column;
        gap: 8px;
      }
      .meta-editor.show { display: flex; }
      .meta-editor input,
      .meta-editor textarea {
        width: 100%;
        padding: 8px 10px;
        border-radius: 10px;
        border: 1px solid rgba(255,255,255,0.1);
        background: #141823;
        color: var(--text);
        font-family: 'Space Grotesk', sans-serif;
      }
      .card-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .notice {
        font-size: 12px;
        color: var(--muted);
      }
      .toast {
        position: fixed;
        right: 18px;
        bottom: 18px;
        background: #11151e;
        border: 1px solid rgba(255,255,255,0.1);
        padding: 12px 16px;
        border-radius: 12px;
        box-shadow: 0 14px 30px var(--shadow);
        display: none;
      }
      .toast.show { display: block; }
      .logs-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
      }
      .log-box {
        background: #0b0f14;
        border-radius: 12px;
        padding: 12px;
        border: 1px solid rgba(255,255,255,0.08);
        font-family: 'JetBrains Mono', monospace;
        font-size: 12px;
        color: #d6dde8;
        max-height: 240px;
        overflow: auto;
        white-space: pre-wrap;
      }
      .ag-grid {
        display: grid;
        gap: 12px;
      }
      .ag-card {
        background: var(--panel-2);
        border-radius: 14px;
        padding: 12px 14px;
        display: grid;
        gap: 6px;
      }
      .ag-row {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        font-size: 13px;
      }
      .ag-label {
        color: var(--muted);
      }
      .ag-badge {
        padding: 4px 8px;
        border-radius: 999px;
        font-size: 11px;
        background: rgba(255,255,255,0.08);
        color: var(--muted);
      }
      .ag-badge.active {
        background: rgba(55, 211, 153, 0.15);
        color: var(--success);
      }
      .ag-badge.missing {
        background: rgba(255, 107, 107, 0.18);
        color: var(--danger);
      }
      .ag-actions {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        justify-content: flex-end;
      }
      .ag-summary {
        display: grid;
        gap: 10px;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        margin: 12px 0;
      }
      @media (max-width: 720px) {
        header { padding: 26px 18px 10px; }
        .container { padding: 0 16px 28px; }
        .actions { flex-direction: column; align-items: stretch; }
        button { width: 100%; }
      }
    </style>
  </head>
  <body>
    <header>
      <h1>Codex Token Dashboard</h1>
      <div class="subtitle">Local console for ~/.codex/auth.json with manual limit refresh.</div>
    </header>
    <div class="container">
      <section class="panel">
        <div class="meta" id="meta"></div>
      </section>
      <section class="panel">
        <div class="actions">
          <button id="syncBtn">Sync auth.json</button>
          <button class="secondary" id="refreshTokensBtn">Refresh tokens (all)</button>
          <button class="secondary" id="refreshLimitsBtn">Refresh limits (all)</button>
          <button class="secondary" id="refreshBtn">Refresh UI</button>
        </div>
        <div class="add-row">
          <input id="addAliasInput" placeholder="New account alias (e.g., acc8)" />
          <button class="secondary" id="addAccountBtn">Add account</button>
        </div>
        <div class="queue" id="queue"></div>
        <div class="notice" id="notice"></div>
        <div class="notice" id="loginNotice"></div>
      </section>
      <section class="panel">
        <div class="filters">
          <input id="searchInput" placeholder="Search alias / email / tags / notes" />
          <input id="tagInput" placeholder="Filter tags (comma separated)" />
          <select id="sortSelect">
            <option value="recommended">Sort: Recommended first</option>
            <option value="fiveHour">Sort: 5h remaining</option>
            <option value="weekly">Sort: Weekly remaining</option>
            <option value="expiry">Sort: Expiry soon</option>
            <option value="refresh">Sort: Last refresh</option>
            <option value="alias">Sort: Alias</option>
          </select>
          <button class="secondary" id="clearFiltersBtn">Clear filters</button>
        </div>
      </section>
      <section class="accounts" id="accounts"></section>
      <section class="panel">
        <div class="logs-header">
          <div>
            <div style="font-size: 16px; font-weight: 600;">Antigravity accounts</div>
            <div class="notice" id="antigravityPath"></div>
          </div>
        <div class="ag-actions">
            <button class="secondary" id="refreshAg">Refresh</button>
            <button class="secondary" id="refreshAgLimits">Refresh limits (active)</button>
            <button class="secondary" id="refreshAgLimitsAll">Refresh limits (all)</button>
            <button class="secondary" id="copyAgPath">Copy path</button>
            <button class="secondary" id="copyAgLogin">Copy reauth command</button>
          </div>
        </div>
        <div class="meta ag-summary" id="antigravitySummary"></div>
        <div class="notice" id="antigravityNotice"></div>
        <div class="limit-grid" id="antigravityQuota"></div>
        <div class="ag-grid" id="antigravityAccounts"></div>
        <div class="notice">Reauth: <code>opencode auth login</code> · Optional reset: remove the antigravity accounts file, then login again.</div>
      </section>
      <section class="panel">
        <div class="logs-header">
          <div>
            <div style="font-size: 16px; font-weight: 600;">Logs</div>
            <div class="notice" id="logPath"></div>
          </div>
          <button class="secondary" id="refreshLogsBtn">Refresh logs</button>
        </div>
        <pre class="log-box" id="logBox"></pre>
      </section>
    </div>
    <div class="toast" id="toast"></div>
    <script>
      const metaEl = document.getElementById('meta')
      const accountsEl = document.getElementById('accounts')
      const syncBtn = document.getElementById('syncBtn')
      const refreshTokensBtn = document.getElementById('refreshTokensBtn')
      const refreshLimitsBtn = document.getElementById('refreshLimitsBtn')
      const refreshBtn = document.getElementById('refreshBtn')
      const notice = document.getElementById('notice')
      const loginNotice = document.getElementById('loginNotice')
      const toast = document.getElementById('toast')
      const queueEl = document.getElementById('queue')
      const searchInput = document.getElementById('searchInput')
      const tagInput = document.getElementById('tagInput')
      const sortSelect = document.getElementById('sortSelect')
      const clearFiltersBtn = document.getElementById('clearFiltersBtn')
      const logBox = document.getElementById('logBox')
      const refreshLogsBtn = document.getElementById('refreshLogsBtn')
      const logPathEl = document.getElementById('logPath')
      const addAliasInput = document.getElementById('addAliasInput')
      const addAccountBtn = document.getElementById('addAccountBtn')
      const agPathEl = document.getElementById('antigravityPath')
      const agNoticeEl = document.getElementById('antigravityNotice')
      const agAccountsEl = document.getElementById('antigravityAccounts')
      const agSummaryEl = document.getElementById('antigravitySummary')
      const agQuotaEl = document.getElementById('antigravityQuota')
      const refreshAgBtn = document.getElementById('refreshAg')
      const refreshAgLimitsBtn = document.getElementById('refreshAgLimits')
      const refreshAgLimitsAllBtn = document.getElementById('refreshAgLimitsAll')
      const copyAgPathBtn = document.getElementById('copyAgPath')
      const copyAgLoginBtn = document.getElementById('copyAgLogin')

      let latestState = null
      let pollTimer = null

      function showToast(text) {
        toast.textContent = text
        toast.classList.add('show')
        setTimeout(() => toast.classList.remove('show'), 2200)
      }

      async function api(path, options) {
        const res = await fetch(path, {
          headers: { 'Content-Type': 'application/json' },
          ...options
        })
        if (!res.ok) {
          const msg = await res.text()
          throw new Error(msg || 'Request failed')
        }
        return res.json()
      }

      function formatDate(value) {
        if (!value) return 'unknown'
        return new Date(value).toLocaleString()
      }

      function formatRelative(value) {
        if (!value) return 'unknown'
        const ts = new Date(value).getTime()
        if (!Number.isFinite(ts)) return 'unknown'
        const diff = Date.now() - ts
        const minute = 60 * 1000
        const hour = 60 * minute
        const day = 24 * hour
        if (diff < minute) return 'just now'
        if (diff < hour) return Math.floor(diff / minute) + 'm ago'
        if (diff < day) return Math.floor(diff / hour) + 'h ago'
        return Math.floor(diff / day) + 'd ago'
      }

      function formatWhen(value) {
        if (!value) return 'unknown'
        return formatDate(value) + ' · ' + formatRelative(value)
      }

      function escapeHtml(value) {
        if (!value) return ''
        return value
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;')
      }

      function remainingPercent(window) {
        if (!window || typeof window.remaining !== 'number' || typeof window.limit !== 'number') return null
        if (window.limit === 0) return null
        return Math.round((window.remaining / window.limit) * 100)
      }

      function renderLimit(window, label) {
        if (!window) return ''
        const remaining = window.remaining ?? '-'
        const limit = window.limit ?? '-'
        const isPercent = typeof remaining === 'number' && limit === 100
        const remainingText = isPercent ? remaining + '%' : remaining + ' / ' + limit
        const reset = window.resetAt ? formatDate(window.resetAt) : 'unknown'
        const updated = window.updatedAt ? formatDate(window.updatedAt) : 'unknown'
        return \`
          <div class="limit-card">
            <strong>\${label}</strong>
            <span>Remaining: \${remainingText}</span><br />
            <span>Reset: \${reset}</span><br />
            <span>Updated: \${updated}</span>
          </div>
        \`
      }

      function parseTags(value) {
        if (!value) return []
        return value
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean)
      }

      function applyFilters(accounts) {
        const search = (searchInput.value || '').trim().toLowerCase()
        const tagFilter = parseTags(tagInput.value).map((tag) => tag.toLowerCase())

        return accounts.filter((acc) => {
          const tags = (acc.tags || []).map((tag) => tag.toLowerCase())
          const haystack = [
            acc.alias,
            acc.email,
            acc.accountId,
            ...(acc.tags || []),
            acc.notes || ''
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase()

          if (search && !haystack.includes(search)) return false
          if (tagFilter.length > 0 && !tagFilter.some((tag) => tags.includes(tag))) return false
          return true
        })
      }

      function sortAccounts(accounts, state) {
        const mode = sortSelect.value
        const recommended = state.recommendedAlias

        const byAlias = (a, b) => a.alias.localeCompare(b.alias)

        const compareRemaining = (key) => (a, b) => {
          const aRemain = remainingPercent(a.rateLimits?.[key]) ?? -1
          const bRemain = remainingPercent(b.rateLimits?.[key]) ?? -1
          return bRemain - aRemain
        }

        const compareExpiry = (a, b) => {
          const aExp = a.expiresAt || 0
          const bExp = b.expiresAt || 0
          return aExp - bExp
        }

        const compareRefresh = (a, b) => {
          const aRef = a.lastRefresh ? Date.parse(a.lastRefresh) : 0
          const bRef = b.lastRefresh ? Date.parse(b.lastRefresh) : 0
          return bRef - aRef
        }

        let sorted = [...accounts]
        if (mode === 'fiveHour') sorted.sort(compareRemaining('fiveHour'))
        if (mode === 'weekly') sorted.sort(compareRemaining('weekly'))
        if (mode === 'expiry') sorted.sort(compareExpiry)
        if (mode === 'refresh') sorted.sort(compareRefresh)
        if (mode === 'alias') sorted.sort(byAlias)
        if (mode === 'recommended' && recommended) {
          sorted.sort((a, b) => {
            if (a.alias === recommended) return -1
            if (b.alias === recommended) return 1
            return byAlias(a, b)
          })
        }
        return sorted
      }

      function renderAccounts(state) {
        const filtered = sortAccounts(applyFilters(state.accounts), state)
        const cards = filtered.map((acc) => {
          const active = acc.alias === state.currentAlias
          const recommended = acc.alias === state.recommendedAlias
          const badge = active ? 'On device' : 'Stored'
          const badgeClass = active ? 'badge' : 'badge inactive'
          const status = acc.limitStatus || 'idle'
          const statusLabels = {
            idle: 'idle',
            queued: 'queued',
            running: 'refreshing',
            success: 'ok',
            error: 'error',
            stopped: 'stopped'
          }
          const statusClass = \`status-badge status-\${status}\`
          const statusLabel = statusLabels[status] || status
          const tags = (acc.tags || []).map((tag) => \`<span class="tag-chip">\${escapeHtml(tag)}</span>\`).join('')
          const notes = acc.notes ? escapeHtml(acc.notes) : 'No notes yet.'
          const limitBlocks = [
            renderLimit(acc.rateLimits?.fiveHour, '5h limit'),
            renderLimit(acc.rateLimits?.weekly, 'Weekly limit')
          ].join('')

          return \`
            <div class="account-card">
              <div class="account-title">
                <div>
                  <div style="font-size: 18px; font-weight: 600;">\${escapeHtml(acc.alias)}</div>
                  <div style="color: var(--muted); font-size: 12px;">\${escapeHtml(acc.email || acc.accountId || 'unknown account')}</div>
                </div>
                <div style="display: grid; gap: 6px; justify-items: end;">
                  <span class="\${badgeClass}">\${badge}</span>
                  \${recommended ? '<span class="badge recommended">Recommended</span>' : ''}
                  <span class="\${statusClass}">\${statusLabel}</span>
                </div>
              </div>
              <div class="account-meta">
                <div>Token expires: \${formatDate(acc.expiresAt)}</div>
                <div>Last seen: \${acc.lastSeenAt ? formatDate(acc.lastSeenAt) : acc.lastUsed ? formatDate(acc.lastUsed) : 'never'}</div>
                <div>Last refresh: \${acc.lastRefresh ? formatDate(acc.lastRefresh) : 'unknown'}</div>
                <div>Usage count: \${acc.usageCount ?? 0}</div>
                \${acc.limitError ? \`<div style="color: var(--danger);">Limit error: \${escapeHtml(acc.limitError)}</div>\` : ''}
              </div>
              <div class="limit-grid">\${limitBlocks || '<span class="notice">No rate-limit data yet.</span>'}</div>
              <div class="tag-row">
                \${tags || '<span class="notice">No tags yet.</span>'}
                <button class="ghost small" data-action="edit-meta" data-alias="\${escapeHtml(acc.alias)}">Edit tags/notes</button>
              </div>
              <div class="notes">\${notes}</div>
              <div class="meta-editor" data-editor="\${escapeHtml(acc.alias)}">
                <input data-field="tags" placeholder="tags: work, personal" value="\${escapeHtml((acc.tags || []).join(', '))}" />
                <textarea data-field="notes" rows="3" placeholder="Notes">\${escapeHtml(acc.notes || '')}</textarea>
                <button class="secondary small" data-action="save-meta" data-alias="\${escapeHtml(acc.alias)}">Save</button>
              </div>
              <div class="card-actions">
                <button data-action="switch" data-alias="\${escapeHtml(acc.alias)}">Use on device</button>
                <button class="secondary" data-action="refresh-token" data-alias="\${escapeHtml(acc.alias)}">Refresh token</button>
                <button class="secondary" data-action="refresh" data-alias="\${escapeHtml(acc.alias)}">Refresh limits</button>
                <button class="danger" data-action="remove" data-alias="\${escapeHtml(acc.alias)}">Remove</button>
              </div>
            </div>
          \`
        }).join('')

        accountsEl.innerHTML = cards || '<div class="notice">No accounts yet. Sync auth.json first.</div>'
      }

      function renderMeta(state) {
        const storeStatus = state.storeStatus
        const storeLine = storeStatus.encrypted
          ? storeStatus.locked ? 'Encrypted (locked)' : 'Encrypted'
          : 'Plain'
        metaEl.innerHTML = \`
          <div class="meta-item">
            <span>Accounts</span>
            <strong>\${state.accounts.length}</strong>
          </div>
          <div class="meta-item">
            <span>Current token</span>
            <strong>\${state.currentAlias || 'none'}</strong>
          </div>
          <div class="meta-item">
            <span>Recommended token</span>
            <strong>\${state.recommendedAlias || 'n/a'}</strong>
          </div>
          <div class="meta-item">
            <span>auth.json path</span>
            <strong style="font-size: 13px;">\${state.authPath}</strong>
          </div>
          <div class="meta-item">
            <span>Store</span>
            <strong>\${storeLine}</strong>
          </div>
          <div class="meta-item">
            <span>Last sync</span>
            <strong>\${state.lastSyncAt ? formatDate(state.lastSyncAt) : 'never'}</strong>
          </div>
        \`
        notice.textContent = state.lastSyncError || storeStatus.error || ''
      }

      function renderLogin(state) {
        if (!loginNotice) return
        if (state.login && state.login.url) {
          const alias = escapeHtml(state.login.alias || 'account')
          const url = escapeHtml(state.login.url)
          loginNotice.innerHTML = 'Login in progress for <strong>' + alias + '</strong> — <a href="' + url + '" target="_blank" rel="noreferrer">Open login</a>'
          return
        }
        if (state.lastLoginError) {
          loginNotice.textContent = 'Login error: ' + state.lastLoginError
          return
        }
        loginNotice.textContent = ''
      }

      function renderQueue(state) {
        const queue = state.queue
        refreshLimitsBtn.disabled = Boolean(queue?.running)
        if (!queue) {
          queueEl.innerHTML = '<div class="notice">No refresh activity.</div>'
          return
        }
        const percent = queue.total ? Math.round((queue.completed / queue.total) * 100) : 0
        const statusLabel = queue.running ? 'Running' : queue.stopped ? 'Stopped' : 'Idle'
        queueEl.innerHTML = \`
          <div class="notice">Queue: \${statusLabel} · \${queue.completed}/\${queue.total} · Errors: \${queue.errors}</div>
          <div class="progress-bar"><div class="progress-fill" style="width: \${percent}%"></div></div>
          <div class="notice">Current: \${queue.currentAlias || 'none'}</div>
          \${queue.running ? '<button class="danger small" id="stopQueueBtn">Stop refresh</button>' : ''}
        \`
        const stopBtn = document.getElementById('stopQueueBtn')
        if (stopBtn) {
          stopBtn.addEventListener('click', async () => {
            await api('/api/limits/stop', { method: 'POST', body: '{}' })
            showToast('Stopping queue')
            await refreshState()
          })
        }
      }

      function renderAntigravity(state) {
        const ag = state.antigravity || {}
        if (agPathEl) {
          agPathEl.textContent = ag.path ? 'Path: ' + ag.path : ''
        }
        const quota = ag.quota || {}
        const quotaStatus = quota.status || 'idle'
        const quotaScope = quota.scope || 'active'
        const quotaFetched = quota.fetchedAt ? formatWhen(quota.fetchedAt) : 'never'
        if (agNoticeEl) {
          const errorBits = []
          if (ag.error) errorBits.push(ag.error)
          if (quotaStatus === 'error') {
            errorBits.push('Quota error: ' + (quota.error || 'unknown'))
          } else if (quotaStatus === 'ok') {
            errorBits.push('Quota updated: ' + quotaFetched)
          } else {
            errorBits.push('Quota not loaded yet')
          }
          agNoticeEl.textContent = errorBits.filter(Boolean).join(' · ')
        }
        if (agSummaryEl) {
          const accounts = Array.isArray(ag.accounts) ? ag.accounts : []
          const activeIndex = typeof ag.activeIndex === 'number' ? ag.activeIndex : null
          const activeAccount = activeIndex !== null ? accounts.find((acc) => acc.index === activeIndex) : null
          const activeLabel = activeAccount ? (activeAccount.alias || ('#' + activeAccount.index)) : '—'
          const lastRead = ag.readAt ? formatWhen(ag.readAt) : 'unknown'
          const hasResetTimes = accounts.some((acc) => acc.rateLimitResetTimes && Object.keys(acc.rateLimitResetTimes).length > 0)
          const hasLiveLimits = quotaStatus === 'ok' && quota.snapshot && Array.isArray(quota.snapshot.models) && quota.snapshot.models.length > 0
          const limitsLabel = hasLiveLimits
            ? (quotaScope === 'all' ? 'Live quotas (all)' : 'Live quotas (active)')
            : (hasResetTimes ? 'Reset times only' : 'n/a')
          agSummaryEl.innerHTML = '' +
            '<div class="meta-item"><span>Total</span><strong>' + accounts.length + '</strong></div>' +
            '<div class="meta-item"><span>Active</span><strong>' + escapeHtml(activeLabel) + '</strong></div>' +
            '<div class="meta-item"><span>Last read</span><strong>' + lastRead + '</strong></div>' +
            '<div class="meta-item"><span>Limits data</span><strong>' + limitsLabel + '</strong></div>'
        }
        if (agQuotaEl) {
          if (quotaStatus === 'ok' && quota.snapshot) {
            const snapshot = quota.snapshot
            const prompt = snapshot.promptCredits
            const promptCard = prompt ? (
              '<div class="limit-card">' +
                '<strong>Prompt credits</strong>' +
                '<span>Remaining: ' + prompt.available + ' / ' + prompt.monthly + '</span><br />' +
                '<span>Remaining %: ' + Math.round(prompt.remainingPercentage) + '%</span>' +
              '</div>'
            ) : ''
            const modelCards = (snapshot.models || []).map((model) => {
              const remaining = typeof model.remainingPercentage === 'number'
                ? Math.round(model.remainingPercentage) + '%'
                : 'unknown'
              const reset = model.timeUntilResetFormatted || (model.resetTime ? formatDate(model.resetTime) : 'unknown')
              return '' +
                '<div class="limit-card">' +
                  '<strong>' + escapeHtml(model.label || model.modelId || 'model') + '</strong>' +
                  '<span>Remaining: ' + remaining + '</span><br />' +
                  '<span>Reset: ' + reset + '</span>' +
                '</div>'
            }).join('')
            const none = !promptCard && !modelCards
            agQuotaEl.innerHTML = none
              ? '<div class="notice" style="grid-column: 1 / -1;">No quota data yet.</div>'
              : (promptCard + modelCards + '<div class="notice" style="grid-column: 1 / -1;">Limits reflect the ' + (quotaScope === 'all' ? 'last refreshed account' : 'active Antigravity account') + '.</div>')
          } else if (quotaStatus === 'error') {
            agQuotaEl.innerHTML = '<div class="notice" style="grid-column: 1 / -1;">Quota error: ' + escapeHtml(quota.error || 'unknown') + '</div>'
          } else {
            agQuotaEl.innerHTML = '<div class="notice" style="grid-column: 1 / -1;">Click "Refresh limits" to load Antigravity quotas.</div>'
          }
        }
        if (!agAccountsEl) return
        const accounts = Array.isArray(ag.accounts) ? ag.accounts : []
        if (accounts.length === 0) {
          agAccountsEl.innerHTML = '<div class="notice">No Antigravity accounts found.</div>'
          return
        }
        const perAccount = quota.perAccount || {}
        agAccountsEl.innerHTML = accounts.map((acc) => {
          const active = acc.index === ag.activeIndex
          const lastUsed = acc.lastUsed ? new Date(acc.lastUsed).getTime() : 0
          const stale = lastUsed ? (Date.now() - lastUsed) > (7 * 24 * 60 * 60 * 1000) : false
          const activeBadge = active ? '<span class="ag-badge active">Active</span>' : '<span class="ag-badge">Stored</span>'
          const tokenBadge = acc.hasRefreshToken ? '<span class="ag-badge">token</span>' : '<span class="ag-badge missing">missing token</span>'
          const staleBadge = stale ? '<span class="ag-badge missing">stale</span>' : ''
          const resetEntries = acc.rateLimitResetTimes ? Object.entries(acc.rateLimitResetTimes) : []
          const resetText = resetEntries.length
            ? resetEntries.map(([key, value]) => escapeHtml(key) + ': ' + formatWhen(value)).join(' · ')
            : 'unknown (no reset info)'
          const quotaSnapshot = perAccount[acc.index]
          const quotaPrompt = quotaSnapshot?.promptCredits
          const quotaModels = quotaSnapshot?.models || []
          const quotaSummary = quotaSnapshot
            ? (
                '<div class="ag-row"><span class="ag-label">Quota updated</span><span>' + formatWhen(quotaSnapshot.timestamp) + '</span></div>' +
                (quotaSnapshot.email ? '<div class="ag-row"><span class="ag-label">Quota email</span><span>' + escapeHtml(quotaSnapshot.email) + '</span></div>' : '') +
                (quotaPrompt
                  ? '<div class="ag-row"><span class="ag-label">Prompt credits</span><span>' + quotaPrompt.available + ' / ' + quotaPrompt.monthly + '</span></div>'
                  : '') +
                (quotaModels.length
                  ? '<div class="ag-row"><span class="ag-label">Models</span><span>' +
                      quotaModels.slice(0, 3).map((model) => {
                        const remaining = typeof model.remainingPercentage === 'number' ? Math.round(model.remainingPercentage) + '%' : 'n/a'
                        return escapeHtml(model.label || model.modelId || 'model') + ': ' + remaining
                      }).join(' · ') +
                    '</span></div>'
                  : '')
              )
            : '<div class="ag-row"><span class="ag-label">Quota</span><span>not loaded</span></div>'
          return '' +
            '<div class="ag-card">' +
              '<div class="ag-row">' +
                '<strong>' + escapeHtml(acc.alias || ('#' + acc.index)) + '</strong>' +
                '<div style="display:flex; gap:6px;">' + activeBadge + tokenBadge + staleBadge + '</div>' +
              '</div>' +
              '<div class="ag-row"><span class="ag-label">Project</span><span>' + escapeHtml(acc.projectId || 'unknown') + '</span></div>' +
              '<div class="ag-row"><span class="ag-label">Managed</span><span>' + escapeHtml(acc.managedProjectId || '—') + '</span></div>' +
              '<div class="ag-row"><span class="ag-label">Added</span><span>' + (acc.addedAt ? formatWhen(acc.addedAt) : 'unknown') + '</span></div>' +
              '<div class="ag-row"><span class="ag-label">Last used</span><span>' + (acc.lastUsed ? formatWhen(acc.lastUsed) : 'never') + '</span></div>' +
              '<div class="ag-row"><span class="ag-label">Limits reset</span><span>' + resetText + '</span></div>' +
              quotaSummary +
            '</div>'
        }).join('')
      }

      function updatePolling(queue) {
        if (queue?.running && !pollTimer) {
          pollTimer = setInterval(() => refreshState(), 2000)
        }
        if (!queue?.running && pollTimer) {
          clearInterval(pollTimer)
          pollTimer = null
        }
      }

      async function refreshLogs() {
        const logs = await api('/api/logs')
        logPathEl.textContent = logs.path ? \`Path: \${logs.path}\` : ''
        logBox.textContent = (logs.lines || []).join('\\n') || 'No logs yet.'
      }

      async function refreshState() {
        const state = await api('/api/state')
        latestState = state
        renderMeta(state)
        renderQueue(state)
        renderAccounts(state)
        renderLogin(state)
        renderAntigravity(state)
        updatePolling(state.queue)
      }

      accountsEl.addEventListener('click', async (event) => {
        const target = event.target
        if (!(target instanceof HTMLElement)) return
        const alias = target.dataset.alias
        const action = target.dataset.action
        if (!alias || !action) return

        if (action === 'switch') {
          await api('/api/switch', { method: 'POST', body: JSON.stringify({ alias }) })
          showToast('Switched auth.json')
          await refreshState()
          return
        }
        if (action === 'refresh-token') {
          const result = await api('/api/token/refresh', { method: 'POST', body: JSON.stringify({ alias }) })
          const failures = result.results?.filter((item) => item.error) || []
          showToast(failures.length ? 'Token: ' + failures[0].error : 'Token refreshed')
          await refreshState()
          return
        }
        if (action === 'refresh') {
          await api('/api/limits/refresh', { method: 'POST', body: JSON.stringify({ alias }) })
          showToast('Refreshing limits')
          await refreshState()
          return
        }
        if (action === 'remove') {
          await api('/api/remove', { method: 'POST', body: JSON.stringify({ alias }) })
          showToast('Account removed')
          await refreshState()
          return
        }
        if (action === 'edit-meta') {
          const editor = document.querySelector(\`.meta-editor[data-editor="\${CSS.escape(alias)}"]\`)
          if (editor) {
            editor.classList.toggle('show')
          }
          return
        }
        if (action === 'save-meta') {
          const editor = document.querySelector(\`.meta-editor[data-editor="\${CSS.escape(alias)}"]\`)
          if (!editor) return
          const tagsInput = editor.querySelector('input[data-field="tags"]')
          const notesInput = editor.querySelector('textarea[data-field="notes"]')
          const tags = tagsInput ? tagsInput.value : ''
          const notes = notesInput ? notesInput.value : ''
          await api('/api/account/meta', {
            method: 'POST',
            body: JSON.stringify({ alias, tags, notes })
          })
          showToast('Saved tags/notes')
          await refreshState()
        }
      })

      syncBtn.addEventListener('click', async () => {
        await api('/api/sync', { method: 'POST', body: '{}' })
        showToast('Synced auth.json')
        await refreshState()
      })

      refreshTokensBtn.addEventListener('click', async () => {
        const result = await api('/api/token/refresh', { method: 'POST', body: '{}' })
        const failures = result.results?.filter((item) => item.error) || []
        if (failures.length === 0) {
          showToast('Tokens refreshed')
        } else {
          showToast('Tokens: ' + failures.length + ' failed')
        }
        await refreshState()
      })

      refreshLimitsBtn.addEventListener('click', async () => {
        await api('/api/limits/refresh', { method: 'POST', body: '{}' })
        showToast('Refreshing limits')
        await refreshState()
      })

      refreshBtn.addEventListener('click', async () => {
        await refreshState()
        showToast('Refreshed')
      })

      refreshLogsBtn.addEventListener('click', async () => {
        await refreshLogs()
        showToast('Logs refreshed')
      })

      if (copyAgLoginBtn) {
        copyAgLoginBtn.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText('opencode auth login')
            showToast('Command copied')
          } catch {
            showToast('Copy failed')
          }
        })
      }

      if (refreshAgBtn) {
        refreshAgBtn.addEventListener('click', async () => {
          await refreshState()
          showToast('Antigravity refreshed')
        })
      }

      if (refreshAgLimitsBtn) {
        refreshAgLimitsBtn.addEventListener('click', async () => {
          await api('/api/antigravity/refresh', { method: 'POST', body: '{}' })
          await refreshState()
          showToast('Antigravity limits refreshed')
        })
      }

      if (refreshAgLimitsAllBtn) {
        refreshAgLimitsAllBtn.addEventListener('click', async () => {
          await api('/api/antigravity/refresh-all', { method: 'POST', body: '{}' })
          await refreshState()
          showToast('Antigravity limits refreshed (all)')
        })
      }

      if (copyAgPathBtn) {
        copyAgPathBtn.addEventListener('click', async () => {
          try {
            const path = latestState?.antigravity?.path || ''
            if (path) {
              await navigator.clipboard.writeText(path)
              showToast('Path copied')
            } else {
              showToast('No path')
            }
          } catch {
            showToast('Copy failed')
          }
        })
      }

      if (addAccountBtn && addAliasInput) {
        const startLogin = async () => {
          const raw = addAliasInput.value.trim()
          const alias = raw || 'account-' + Date.now()
          try {
            const result = await api('/api/auth/start', {
              method: 'POST',
              body: JSON.stringify({ alias })
            })
            addAliasInput.value = alias
            if (result?.url && loginNotice) {
              const url = escapeHtml(result.url)
              loginNotice.innerHTML = 'Login in progress for <strong>' + escapeHtml(alias) + '</strong> — <a href="' + url + '" target="_blank" rel="noreferrer">Open login</a>'
            }
            showToast('Open login URL')
          } catch (err) {
            showToast('Login start failed')
          }
        }
        addAccountBtn.addEventListener('click', startLogin)
        addAliasInput.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') startLogin()
        })
      }

      searchInput.addEventListener('input', () => {
        if (latestState) renderAccounts(latestState)
      })
      tagInput.addEventListener('input', () => {
        if (latestState) renderAccounts(latestState)
      })
      sortSelect.addEventListener('change', () => {
        if (latestState) renderAccounts(latestState)
      })
      clearFiltersBtn.addEventListener('click', () => {
        searchInput.value = ''
        tagInput.value = ''
        sortSelect.value = 'recommended'
        if (latestState) renderAccounts(latestState)
      })

      refreshState().catch((err) => {
        console.error(err)
        notice.textContent = 'Failed to load state.'
      })
      refreshLogs().catch(() => {
        logBox.textContent = 'No logs yet.'
      })
    </script>
  </body>
</html>`

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const data = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data)
  })
  res.end(data)
}

function scrubAccount(account: AccountCredentials): Omit<AccountCredentials, 'accessToken' | 'refreshToken' | 'idToken'> {
  const { accessToken, refreshToken, idToken, ...rest } = account
  return rest
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 1_000_000) {
        req.destroy()
        reject(new Error('Payload too large'))
      }
    })
    req.on('end', () => {
      if (!data) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(data))
      } catch (err) {
        reject(err)
      }
    })
  })
}

function remainingPercent(window?: RateLimitWindow): number | null {
  if (!window || typeof window.remaining !== 'number' || typeof window.limit !== 'number') return null
  if (window.limit === 0) return null
  return Math.round((window.remaining / window.limit) * 100)
}

function recommendAlias(accounts: AccountCredentials[]): string | null {
  let best: { alias: string; score: number } | null = null
  const now = Date.now()
  for (const account of accounts) {
    const fiveRaw = remainingPercent(account.rateLimits?.fiveHour)
    const weeklyRaw = remainingPercent(account.rateLimits?.weekly)
    if (fiveRaw === null && weeklyRaw === null) {
      continue
    }
    const five = fiveRaw ?? 0
    const weekly = weeklyRaw ?? 0
    const expiresInDays = account.expiresAt ? (account.expiresAt - now) / (24 * 3600 * 1000) : 30
    const expiryPenalty = expiresInDays < 3 ? 20 : expiresInDays < 7 ? 10 : 0
    const score = five * 2 + weekly - expiryPenalty
    if (!best || score > best.score) {
      best = { alias: account.alias, score }
    }
  }
  return best?.alias ?? null
}

function runSync(): void {
  try {
    const result = syncCodexAuthFile()
    const authStatus = getCodexAuthStatus()
    lastSyncAt = Date.now()
    lastSyncError = authStatus.error
    if (result.updated || result.added) {
      logInfo(`Synced auth.json (${result.alias ?? 'none'})`)
    }
    if (authStatus.error) {
      logError(authStatus.error)
    }
  } catch (err) {
    lastSyncError = String(err)
    logError(`Sync failed: ${lastSyncError}`)
  }
}

type AntigravityAccountView = {
  index: number
  alias?: string
  projectId?: string
  managedProjectId?: string
  addedAt?: number | string
  lastUsed?: number | string
  hasRefreshToken: boolean
  rateLimitResetTimes?: Record<string, number>
}

type AntigravityPromptCredits = {
  available: number
  monthly: number
  usedPercentage: number
  remainingPercentage: number
}

type AntigravityQuotaModel = {
  label: string
  modelId: string
  remainingFraction?: number
  remainingPercentage?: number
  isExhausted: boolean
  resetTime?: number
  timeUntilResetMs?: number
  timeUntilResetFormatted?: string
}

type AntigravityQuotaSnapshot = {
  timestamp: number
  name?: string
  email?: string
  promptCredits?: AntigravityPromptCredits
  models: AntigravityQuotaModel[]
}

type AntigravityQuotaState = {
  status: 'idle' | 'ok' | 'error'
  scope?: 'active' | 'all'
  fetchedAt?: number
  error?: string
  snapshot?: AntigravityQuotaSnapshot
  perAccount?: Record<number, AntigravityQuotaSnapshot>
}

function loadAntigravityAccounts(): {
  path: string
  error?: string
  activeIndex?: number
  readAt?: number
  accounts: AntigravityAccountView[]
} {
  const result = { path: ANTIGRAVITY_ACCOUNTS_FILE, accounts: [] as AntigravityAccountView[], readAt: Date.now() }
  if (!fs.existsSync(ANTIGRAVITY_ACCOUNTS_FILE)) {
    return { ...result, error: 'antigravity-accounts.json not found' }
  }
  try {
    const raw = JSON.parse(fs.readFileSync(ANTIGRAVITY_ACCOUNTS_FILE, 'utf-8')) as any
    const activeIndex = typeof raw?.activeIndex === 'number' ? raw.activeIndex : undefined
    const accounts = Array.isArray(raw?.accounts) ? raw.accounts : []
    const view = accounts.map((acc: any, index: number) => ({
      index,
      alias: acc?.projectId || acc?.managedProjectId,
      projectId: acc?.projectId,
      managedProjectId: acc?.managedProjectId,
      addedAt: acc?.addedAt,
      lastUsed: acc?.lastUsed,
      hasRefreshToken: Boolean(acc?.refreshToken),
      rateLimitResetTimes: acc?.rateLimitResetTimes && typeof acc.rateLimitResetTimes === 'object'
        ? acc.rateLimitResetTimes
        : undefined
    }))
    return { ...result, activeIndex, accounts: view }
  } catch (err) {
    return { ...result, error: `Failed to parse antigravity accounts: ${err}` }
  }
}

function isAntigravityProcessLine(line: string): boolean {
  const lower = line.toLowerCase()
  if (lower.includes('antigravity')) return true
  return /--app_data_dir\s+antigravity\b/i.test(line)
}

function getAntigravityProcessName(): string | null {
  if (process.platform === 'darwin') {
    return `language_server_macos${process.arch === 'arm64' ? '_arm' : ''}`
  }
  if (process.platform === 'linux') {
    return `language_server_linux${process.arch === 'arm64' ? '_arm' : '_x64'}`
  }
  if (process.platform === 'win32') {
    return 'language_server_windows_x64.exe'
  }
  return null
}

async function detectAntigravityProcessInfo(): Promise<{ pid: number; extensionPort: number; csrfToken: string; connectPort: number } | null> {
  const processName = getAntigravityProcessName()
  if (!processName) {
    throw new Error('Unsupported platform for Antigravity quotas')
  }
  if (process.platform === 'win32') {
    throw new Error('Antigravity quota detection is not implemented for Windows yet')
  }

  const cmd = process.platform === 'darwin' ? `pgrep -fl ${processName}` : `pgrep -af ${processName}`
  const { stdout } = await execAsync(cmd)
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  const tokenLines = lines.filter((line) => line.includes('--csrf_token'))
  if (tokenLines.length === 0) {
    return null
  }

  const ordered = [
    ...tokenLines.filter(isAntigravityProcessLine),
    ...tokenLines.filter((line) => !isAntigravityProcessLine(line))
  ]

  for (const line of ordered) {
    const parts = line.split(/\s+/)
    const pid = Number(parts[0])
    if (!Number.isFinite(pid)) {
      continue
    }
    const portMatch = line.match(/--extension_server_port[=\s]+(\d+)/)
    const tokenMatch = line.match(/--csrf_token[=\s]+([a-zA-Z0-9\-]+)/)
    if (!tokenMatch) {
      continue
    }
    const extensionPort = portMatch ? Number(portMatch[1]) : 0
    const csrfToken = tokenMatch[1]
    const ports = await listListeningPorts(pid)
    const workingPort = await findWorkingPort(ports, csrfToken)
    const connectPort = workingPort || (extensionPort > 0 ? extensionPort : 0)
    if (!connectPort) {
      return null
    }
    return { pid, extensionPort, csrfToken, connectPort }
  }

  return null
}

async function listListeningPorts(pid: number): Promise<number[]> {
  try {
    const cmd = `lsof -nP -a -iTCP -sTCP:LISTEN -p ${pid}`
    const { stdout } = await execAsync(cmd)
    const ports = new Set<number>()
    const regex = /:(\d+)\s+\(LISTEN\)/g
    let match: RegExpExecArray | null
    while ((match = regex.exec(stdout)) !== null) {
      const port = Number(match[1])
      if (Number.isFinite(port)) {
        ports.add(port)
      }
    }
    return Array.from(ports.values()).sort((a, b) => a - b)
  } catch {
    return []
  }
}

function antigravityRequest<T>(port: number, csrfToken: string, pathName: string, body: object): Promise<T> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = https.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathName,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'Connect-Protocol-Version': '1',
          'X-Codeium-Csrf-Token': csrfToken
        },
        rejectUnauthorized: false,
        timeout: 5000
      },
      (res) => {
        let data = ''
        res.on('data', (chunk) => { data += chunk })
        res.on('end', () => {
          try {
            resolve(JSON.parse(data) as T)
          } catch {
            reject(new Error('Invalid JSON response'))
          }
        })
      }
    )
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('Request timeout'))
    })
    req.write(payload)
    req.end()
  })
}

async function testAntigravityPort(port: number, csrfToken: string): Promise<boolean> {
  try {
    await antigravityRequest<any>(
      port,
      csrfToken,
      '/exa.language_server_pb.LanguageServerService/GetUnleashData',
      { wrapper_data: {} }
    )
    return true
  } catch {
    return false
  }
}

async function findWorkingPort(ports: number[], csrfToken: string): Promise<number | null> {
  for (const port of ports) {
    const ok = await testAntigravityPort(port, csrfToken)
    if (ok) return port
  }
  return null
}

function formatAntigravityDuration(ms: number, resetTime?: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'Ready'
  const mins = Math.ceil(ms / 60000)
  let duration = ''
  if (mins < 60) {
    duration = `${mins}m`
  } else {
    const hours = Math.floor(mins / 60)
    duration = `${hours}h ${mins % 60}m`
  }
  if (!resetTime) return duration
  const resetDate = new Date(resetTime)
  const dateStr = resetDate.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' })
  const timeStr = resetDate.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
  return `${duration} (${dateStr} ${timeStr})`
}

function updateAntigravityActiveIndex(raw: any, index: number): any {
  const next = { ...raw }
  next.activeIndex = index
  if (next.activeIndexByFamily && typeof next.activeIndexByFamily === 'object') {
    next.activeIndexByFamily = { ...next.activeIndexByFamily }
    for (const key of Object.keys(next.activeIndexByFamily)) {
      next.activeIndexByFamily[key] = index
    }
  }
  return next
}

async function refreshAntigravityQuotaAll(): Promise<AntigravityQuotaState> {
  if (antigravityQuotaInFlight) {
    return antigravityQuotaInFlight
  }
  antigravityQuotaInFlight = (async () => {
    let originalRaw = ''
    let parsed: any
    try {
      if (!fs.existsSync(ANTIGRAVITY_ACCOUNTS_FILE)) {
        throw new Error('antigravity-accounts.json not found')
      }
      originalRaw = fs.readFileSync(ANTIGRAVITY_ACCOUNTS_FILE, 'utf-8')
      parsed = JSON.parse(originalRaw)
      const accounts = Array.isArray(parsed?.accounts) ? parsed.accounts : []
      if (accounts.length === 0) {
        throw new Error('No Antigravity accounts available')
      }

      const perAccount: Record<number, AntigravityQuotaSnapshot> = {}
      for (let index = 0; index < accounts.length; index += 1) {
        const next = updateAntigravityActiveIndex(parsed, index)
        fs.writeFileSync(ANTIGRAVITY_ACCOUNTS_FILE, JSON.stringify(next, null, 2))
        await new Promise((resolve) => setTimeout(resolve, 500))
        const snapshot = await fetchAntigravityQuota()
        perAccount[index] = snapshot
      }

      antigravityQuotaState = {
        status: 'ok',
        scope: 'all',
        fetchedAt: Date.now(),
        snapshot: perAccount[parsed.activeIndex ?? 0] || perAccount[0],
        perAccount
      }
    } catch (err) {
      antigravityQuotaState = {
        status: 'error',
        scope: 'all',
        fetchedAt: Date.now(),
        error: String(err),
        perAccount: antigravityQuotaState.perAccount
      }
    } finally {
      if (originalRaw) {
        try {
          fs.writeFileSync(ANTIGRAVITY_ACCOUNTS_FILE, originalRaw)
        } catch (err) {
          logError(`Failed to restore antigravity accounts file: ${err}`)
        }
      }
      antigravityQuotaInFlight = null
    }
    return antigravityQuotaState
  })()
  return antigravityQuotaInFlight
}

function parseAntigravityQuota(data: any): AntigravityQuotaSnapshot {
  const userStatus = data?.userStatus
  const planInfo = userStatus?.planStatus?.planInfo
  const availableCredits = userStatus?.planStatus?.availablePromptCredits
  let promptCredits: AntigravityPromptCredits | undefined

  if (planInfo && availableCredits !== undefined) {
    const monthly = Number(planInfo.monthlyPromptCredits)
    const available = Number(availableCredits)
    if (Number.isFinite(monthly) && monthly > 0) {
      promptCredits = {
        available,
        monthly,
        usedPercentage: ((monthly - available) / monthly) * 100,
        remainingPercentage: (available / monthly) * 100
      }
    }
  }

  const rawModels = userStatus?.cascadeModelConfigData?.clientModelConfigs || []
  const models: AntigravityQuotaModel[] = rawModels
    .filter((model: any) => model?.quotaInfo)
    .map((model: any) => {
      const reset = model.quotaInfo?.resetTime ? new Date(model.quotaInfo.resetTime) : null
      const resetTime = reset ? reset.getTime() : undefined
      const remainingFraction = typeof model.quotaInfo?.remainingFraction === 'number'
        ? model.quotaInfo.remainingFraction
        : undefined
      const remainingPercentage = typeof remainingFraction === 'number'
        ? remainingFraction * 100
        : undefined
      const diff = resetTime ? resetTime - Date.now() : undefined
      const label = model.label || model.modelOrAlias?.model || 'model'
      const modelId = model.modelOrAlias?.model || model.modelOrAlias?.alias || 'unknown'
      return {
        label,
        modelId,
        remainingFraction,
        remainingPercentage,
        isExhausted: remainingFraction === 0,
        resetTime,
        timeUntilResetMs: diff,
        timeUntilResetFormatted: typeof diff === 'number' ? formatAntigravityDuration(diff, resetTime) : undefined
      }
    })

  return {
    timestamp: Date.now(),
    name: userStatus?.name,
    email: userStatus?.email,
    promptCredits,
    models
  }
}

async function fetchAntigravityQuota(): Promise<AntigravityQuotaSnapshot> {
  const info = await detectAntigravityProcessInfo()
  if (!info) {
    throw new Error('Antigravity process not found')
  }

  const data = await antigravityRequest<any>(
    info.connectPort,
    info.csrfToken,
    '/exa.language_server_pb.LanguageServerService/GetUserStatus',
    {
      metadata: {
        ideName: 'antigravity',
        extensionName: 'antigravity',
        locale: 'en'
      }
    }
  )

  return parseAntigravityQuota(data)
}

async function refreshAntigravityQuota(): Promise<AntigravityQuotaState> {
  if (antigravityQuotaInFlight) {
    return antigravityQuotaInFlight
  }
  antigravityQuotaInFlight = (async () => {
    try {
      const snapshot = await fetchAntigravityQuota()
      antigravityQuotaState = {
        status: 'ok',
        scope: 'active',
        fetchedAt: Date.now(),
        snapshot
      }
    } catch (err) {
      antigravityQuotaState = {
        status: 'error',
        scope: 'active',
        fetchedAt: Date.now(),
        error: String(err)
      }
    } finally {
      antigravityQuotaInFlight = null
    }
    return antigravityQuotaState
  })()
  return antigravityQuotaInFlight
}

function scheduleSync(): void {
  if (syncTimer) {
    clearTimeout(syncTimer)
  }
  syncTimer = setTimeout(() => {
    runSync()
  }, SYNC_DEBOUNCE_MS)
}

function startAuthWatcher(): void {
  const authPath = getCodexAuthPath()
  fs.watchFile(authPath, { interval: SYNC_INTERVAL_MS }, () => {
    scheduleSync()
  })
}

export function startWebConsole(options?: { port?: number; host?: string }): http.Server {
  const host = options?.host || DEFAULT_HOST
  const port = options?.port || DEFAULT_PORT

  runSync()
  startAuthWatcher()

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url || '/', `http://${host}:${port}`)
    const path = requestUrl.pathname

    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(HTML)
      return
    }

    if (req.method === 'GET' && path === '/api/state') {
      runSync()
      const store = loadStore()
      const rawAccounts = Object.values(store.accounts)
      const accounts = rawAccounts.map(scrubAccount)
      const storeStatus = getStoreStatus()
      const antigravity = loadAntigravityAccounts()
      sendJson(res, 200, {
        authPath: getCodexAuthPath(),
        currentAlias: store.activeAlias,
        accounts,
        lastSyncAt,
        lastSyncError,
        storeStatus,
        login: pendingLogin,
        lastLoginError,
        antigravity: { ...antigravity, quota: antigravityQuotaState },
        queue: getRefreshQueueState(),
        recommendedAlias: recommendAlias(rawAccounts),
        logPath: getLogPath()
      })
      return
    }

    if (req.method === 'GET' && path === '/api/logs') {
      const limitParam = requestUrl.searchParams.get('limit')
      const limit = limitParam ? Number(limitParam) : undefined
      const lines = readLogTail(Number.isFinite(limit) ? limit : undefined)
      sendJson(res, 200, { path: getLogPath(), lines })
      return
    }

    if (req.method === 'POST' && path === '/api/sync') {
      try {
        runSync()
        sendJson(res, 200, { ok: true })
      } catch (err) {
        sendJson(res, 500, { error: String(err) })
      }
      return
    }

    if (req.method === 'POST' && path === '/api/auth/start') {
      const body = await readJsonBody(req)
      const alias = typeof body.alias === 'string' ? body.alias.trim() : ''
      if (!alias) {
        sendJson(res, 400, { error: 'Missing alias' })
        return
      }
      if (pendingLogin) {
        sendJson(res, 409, { error: `Login already in progress for ${pendingLogin.alias}` })
        return
      }
      try {
        const flow = await createAuthorizationFlow()
        pendingLogin = { alias, startedAt: Date.now(), url: flow.url }
        lastLoginError = null
        loginAccount(alias, flow)
          .then(() => {
            logInfo(`Login completed for ${alias}`)
            pendingLogin = null
          })
          .catch((err) => {
            lastLoginError = String(err)
            logError(`Login failed for ${alias}: ${err}`)
            pendingLogin = null
          })
        sendJson(res, 200, { ok: true, url: flow.url })
      } catch (err) {
        lastLoginError = String(err)
        sendJson(res, 500, { error: String(err) })
      }
      return
    }

    if (req.method === 'POST' && path === '/api/switch') {
      const body = await readJsonBody(req)
      if (!body.alias) {
        sendJson(res, 400, { error: 'Missing alias' })
        return
      }
      try {
        writeCodexAuthForAlias(body.alias)
        sendJson(res, 200, { ok: true })
      } catch (err) {
        sendJson(res, 400, { error: String(err) })
      }
      return
    }

    if (req.method === 'POST' && path === '/api/remove') {
      const body = await readJsonBody(req)
      if (!body.alias) {
        sendJson(res, 400, { error: 'Missing alias' })
        return
      }
      removeAccount(body.alias)
      sendJson(res, 200, { ok: true })
      return
    }

    if (req.method === 'POST' && path === '/api/account/meta') {
      const body = await readJsonBody(req)
      if (!body.alias) {
        sendJson(res, 400, { error: 'Missing alias' })
        return
      }
      const tags = typeof body.tags === 'string'
        ? body.tags
          .split(',')
          .map((tag: string) => tag.trim().toLowerCase())
          .filter(Boolean)
        : []
      const uniqueTags = Array.from(new Set(tags))
      const notes = typeof body.notes === 'string' ? body.notes.trim() : ''
      updateAccount(body.alias, {
        tags: uniqueTags.length > 0 ? uniqueTags : undefined,
        notes: notes || undefined
      })
      sendJson(res, 200, { ok: true })
      return
    }

    if (req.method === 'POST' && path === '/api/token/refresh') {
      const body = await readJsonBody(req)
      const store = loadStore()
      const candidates = Object.values(store.accounts)
      const alias = typeof body.alias === 'string' ? body.alias : undefined
      const targets = alias ? candidates.filter((acc) => acc.alias === alias) : candidates
      if (alias && targets.length === 0) {
        sendJson(res, 400, { error: 'Unknown alias' })
        return
      }

      const results: Array<{ alias: string; updated: boolean; error?: string }> = []
      for (const account of targets) {
        if (!account.refreshToken) {
          results.push({ alias: account.alias, updated: false, error: 'No refresh token' })
          continue
        }
        const refreshed = await refreshToken(account.alias)
        if (!refreshed) {
          results.push({ alias: account.alias, updated: false, error: 'Token refresh failed' })
          continue
        }

        if (store.activeAlias === account.alias && refreshed.idToken) {
          try {
            writeCodexAuthForAlias(account.alias)
          } catch (err) {
            results.push({ alias: account.alias, updated: true, error: `Refreshed, but failed to update auth.json: ${err}` })
            continue
          }
        }

        results.push({ alias: account.alias, updated: true })
      }

      sendJson(res, 200, { ok: true, results })
      return
    }

    if (req.method === 'POST' && path === '/api/limits/refresh') {
      const body = await readJsonBody(req)
      const accounts = listAccounts().filter((acc) => acc.idToken)
      if (body.alias && !accounts.find((acc) => acc.alias === body.alias)) {
        sendJson(res, 400, { error: 'Unknown alias' })
        return
      }
      const queue = startRefreshQueue(accounts, body.alias)
      sendJson(res, 200, { ok: true, queue })
      return
    }

    if (req.method === 'POST' && path === '/api/limits/stop') {
      stopRefreshQueue()
      sendJson(res, 200, { ok: true })
      return
    }

    if (req.method === 'POST' && path === '/api/antigravity/refresh') {
      await refreshAntigravityQuota()
      sendJson(res, 200, { ok: true, quota: antigravityQuotaState })
      return
    }

    if (req.method === 'POST' && path === '/api/antigravity/refresh-all') {
      await refreshAntigravityQuotaAll()
      sendJson(res, 200, { ok: true, quota: antigravityQuotaState })
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  })

  server.listen(port, host, () => {
    console.log(`[multi-auth] Codex dashboard running at http://${host}:${port}`)
    logInfo(`Codex dashboard running at http://${host}:${port}`)
  })

  return server
}
