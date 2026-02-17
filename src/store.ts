import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'node:crypto'
import type {
  AccountStore,
  AccountCredentials,
  RateLimitHistoryEntry,
  RateLimitSnapshot,
  PluginConfig
} from './types.js'

const STORE_DIR_ENV = 'OPENCODE_MULTI_AUTH_STORE_DIR'
const STORE_FILE_ENV = 'OPENCODE_MULTI_AUTH_STORE_FILE'
const DEFAULT_STORE_DIR = path.join(os.homedir(), '.config', 'oc-codex-multi-account')
const DEFAULT_STORE_FILE = 'accounts.json'
const LEGACY_STORE_FILE = path.join(os.homedir(), '.config', 'opencode-multi-auth', 'accounts.json')

function getStoreDir(): string {
  const override = process.env[STORE_DIR_ENV]
  if (override && override.trim()) return path.resolve(override.trim())
  return DEFAULT_STORE_DIR
}

function getStoreFile(): string {
  const override = process.env[STORE_FILE_ENV]
  if (override && override.trim()) return path.resolve(override.trim())
  return path.join(getStoreDir(), DEFAULT_STORE_FILE)
}

const STORE_ENV_PASSPHRASE = 'CODEX_SOFT_STORE_PASSPHRASE'
const STORE_VERSION = 1

type EncryptedStoreFile = {
  encrypted: true
  version: number
  salt: string
  iv: string
  tag: string
  data: string
}

let storeLocked = false
let lastStoreError: string | null = null
let lastStoreEncrypted = false

function ensureDir(): void {
  const dir = getStoreDir()
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
}

function migrateLegacyStoreIfNeeded(): void {
  const target = getStoreFile()
  if (fs.existsSync(target)) return
  if (!fs.existsSync(LEGACY_STORE_FILE)) return

  try {
    fs.copyFileSync(LEGACY_STORE_FILE, target)
    fs.chmodSync(target, 0o600)
    console.log(`[multi-auth] Migrated credentials store to ${target}`)
  } catch (err) {
    console.error('[multi-auth] Failed to migrate legacy credentials store:', err)
  }
}

function emptyStore(): AccountStore {
  return {
    accounts: {},
    activeAlias: null,
    rotationIndex: 0,
    lastRotation: Date.now()
  }
}

function getPassphrase(): string | null {
  const value = process.env[STORE_ENV_PASSPHRASE]
  return value && value.trim().length > 0 ? value : null
}

function isEncryptedFile(payload: any): payload is EncryptedStoreFile {
  return Boolean(payload && payload.encrypted === true && typeof payload.data === 'string')
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase, salt, 32)
}

function encryptStore(store: AccountStore, passphrase: string): EncryptedStoreFile {
  const salt = crypto.randomBytes(16)
  const iv = crypto.randomBytes(12)
  const key = deriveKey(passphrase, salt)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const serialized = JSON.stringify(store)
  const encrypted = Buffer.concat([cipher.update(serialized, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    encrypted: true,
    version: STORE_VERSION,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64')
  }
}

function decryptStore(file: EncryptedStoreFile, passphrase: string): AccountStore {
  const salt = Buffer.from(file.salt, 'base64')
  const iv = Buffer.from(file.iv, 'base64')
  const tag = Buffer.from(file.tag, 'base64')
  const data = Buffer.from(file.data, 'base64')
  const key = deriveKey(passphrase, salt)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
  return JSON.parse(decrypted) as AccountStore
}

function buildSnapshot(window?: { remaining?: number; limit?: number; resetAt?: number }): RateLimitSnapshot | undefined {
  if (!window) return undefined
  return {
    remaining: window.remaining,
    limit: window.limit,
    resetAt: window.resetAt
  }
}

function buildHistoryEntry(rateLimits?: { fiveHour?: any; weekly?: any }): RateLimitHistoryEntry | null {
  if (!rateLimits?.fiveHour && !rateLimits?.weekly) return null
  const updatedAtValues = [rateLimits?.fiveHour?.updatedAt, rateLimits?.weekly?.updatedAt].filter(
    (value): value is number => typeof value === 'number'
  )
  const at = updatedAtValues.length > 0 ? Math.max(...updatedAtValues) : Date.now()
  return {
    at,
    fiveHour: buildSnapshot(rateLimits?.fiveHour),
    weekly: buildSnapshot(rateLimits?.weekly)
  }
}

function appendHistory(
  history: RateLimitHistoryEntry[] | undefined,
  entry: RateLimitHistoryEntry
): RateLimitHistoryEntry[] {
  const next = history ? [...history] : []
  const last = next[next.length - 1]
  const same =
    last &&
    last.fiveHour?.remaining === entry.fiveHour?.remaining &&
    last.weekly?.remaining === entry.weekly?.remaining &&
    last.fiveHour?.resetAt === entry.fiveHour?.resetAt &&
    last.weekly?.resetAt === entry.weekly?.resetAt
  if (!same) {
    next.push(entry)
  }
  if (next.length > 160) {
    return next.slice(next.length - 160)
  }
  return next
}

export function loadStore(): AccountStore {
  storeLocked = false
  lastStoreError = null
  lastStoreEncrypted = false
  ensureDir()
  migrateLegacyStoreIfNeeded()
  const file = getStoreFile()
  if (fs.existsSync(file)) {
    try {
      const data = fs.readFileSync(file, 'utf-8')
      const parsed = JSON.parse(data)
      if (isEncryptedFile(parsed)) {
        lastStoreEncrypted = true
        const passphrase = getPassphrase()
        if (!passphrase) {
          storeLocked = true
          lastStoreError = `Store is encrypted. Set ${STORE_ENV_PASSPHRASE} to unlock.`
          return emptyStore()
        }
        try {
          return decryptStore(parsed, passphrase)
        } catch (err) {
          storeLocked = true
          lastStoreError = 'Failed to decrypt store. Check passphrase.'
          console.error('[multi-auth] Failed to decrypt store:', err)
          return emptyStore()
        }
      }
      return parsed as AccountStore
    } catch {
      storeLocked = true
      lastStoreError = 'Failed to parse store. Store locked until fixed.'
      console.error('[multi-auth] Failed to parse store, resetting')
    }
  }
  return emptyStore()
}

export function saveStore(store: AccountStore): void {
  ensureDir()
  if (storeLocked) {
    console.error('[multi-auth] Store locked; refusing to overwrite encrypted file.')
    return
  }

  const file = getStoreFile()
  const passphrase = getPassphrase()
  const payload = passphrase ? encryptStore(store, passphrase) : store
  const json = JSON.stringify(payload, null, 2)

  // Best-effort backup to help recover from crashes/corruption.
  try {
    if (fs.existsSync(file)) {
      fs.copyFileSync(file, `${file}.bak`)
      fs.chmodSync(`${file}.bak`, 0o600)
    }
  } catch {
    // ignore backup failures
  }

  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  let fd: number | null = null

  try {
    fd = fs.openSync(tmp, 'w', 0o600)
    fs.writeFileSync(fd, json, { encoding: 'utf-8' })
    try {
      fs.fsyncSync(fd)
    } catch {
      // fsync not supported everywhere; best-effort
    }
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // ignore
      }
    }
  }

  try {
    fs.renameSync(tmp, file)
  } catch (err: any) {
    // Windows can fail to rename over an existing file.
    if (err?.code === 'EPERM' || err?.code === 'EEXIST') {
      try {
        fs.unlinkSync(file)
      } catch {
        // ignore
      }
      fs.renameSync(tmp, file)
    } else {
      try {
        fs.unlinkSync(tmp)
      } catch {
        // ignore
      }
      throw err
    }
  }

  try {
    fs.chmodSync(file, 0o600)
  } catch {
    // ignore
  }
}

export function getStoreDiagnostics(): {
  storeDir: string
  storeFile: string
  locked: boolean
  encrypted: boolean
  error: string | null
} {
  return {
    storeDir: getStoreDir(),
    storeFile: getStoreFile(),
    locked: storeLocked,
    encrypted: lastStoreEncrypted,
    error: lastStoreError
  }
}


export function addAccount(alias: string, creds: Omit<AccountCredentials, 'alias' | 'usageCount'>): AccountStore {
  const store = loadStore()
  const entry = buildHistoryEntry(creds.rateLimits)
  store.accounts[alias] = {
    ...creds,
    alias,
    usageCount: 0,
    rateLimitHistory: entry ? [entry] : creds.rateLimitHistory
  }
  if (!store.activeAlias) {
    store.activeAlias = alias
  }
  saveStore(store)
  return store
}

export function removeAccount(alias: string): AccountStore {
  const store = loadStore()
  delete store.accounts[alias]
  if (store.activeAlias === alias) {
    const remaining = Object.keys(store.accounts)
    store.activeAlias = remaining[0] || null
  }
  saveStore(store)
  return store
}

export function updateAccount(alias: string, updates: Partial<AccountCredentials>): AccountStore {
  const store = loadStore()
  if (store.accounts[alias]) {
    const current = store.accounts[alias]
    const next = { ...current, ...updates }
    if (updates.rateLimits || next.rateLimits) {
      const entry = buildHistoryEntry(next.rateLimits)
      if (entry) {
        next.rateLimitHistory = appendHistory(current.rateLimitHistory, entry)
      }
    }
    store.accounts[alias] = next
    saveStore(store)
  }
  return store
}

export function setActiveAlias(alias: string | null): AccountStore {
  const store = loadStore()
  const now = Date.now()
  const previousAlias = store.activeAlias

  if (alias === null) {
    store.activeAlias = null
  } else if (store.accounts[alias]) {
    if (previousAlias && previousAlias !== alias && store.accounts[previousAlias]) {
      store.accounts[previousAlias] = {
        ...store.accounts[previousAlias],
        lastActiveUntil: now
      }
    }

    store.activeAlias = alias
    store.accounts[alias] = {
      ...store.accounts[alias],
      lastSeenAt: now,
      lastActiveUntil: undefined
    }

    const aliases = Object.keys(store.accounts)
    const idx = aliases.indexOf(alias)
    if (idx >= 0) {
      store.rotationIndex = idx
    }
    store.lastRotation = now
  }
  saveStore(store)
  return store
}

export function getActiveAccount(): AccountCredentials | null {
  const store = loadStore()
  if (!store.activeAlias) return null
  return store.accounts[store.activeAlias] || null
}

export function listAccounts(): AccountCredentials[] {
  const store = loadStore()
  return Object.values(store.accounts)
}

export function getStorePath(): string {
  return getStoreFile()
}

export function getStoreStatus(): { locked: boolean; encrypted: boolean; error: string | null } {
  const diag = getStoreDiagnostics()
  return { locked: diag.locked, encrypted: diag.encrypted, error: diag.error }
}

export function getStoreConfig(): AccountStore['config'] {
  const store = loadStore()
  return store.config
}

export function updateStoreConfig(
  updates: Partial<Pick<PluginConfig, 'rotationStrategy' | 'stickyThresholdFiveHour' | 'stickyThresholdWeekly' | 'stickyRecoveryCheckIntervalMs'>>
): AccountStore {
  const store = loadStore()
  const current = store.config || {}
  store.config = {
    ...current,
    ...updates
  }
  saveStore(store)
  return store
}

export function resetStoreConfig(): AccountStore {
  const store = loadStore()
  delete store.config
  saveStore(store)
  return store
}
