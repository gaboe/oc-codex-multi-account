import { generatePKCE } from '@openauthjs/openauth/pkce';
import { randomBytes } from 'node:crypto';
import * as http from 'http';
import * as url from 'url';
import { addAccount, updateAccount, loadStore } from './store.js';
import { clearAuthInvalid } from './rotation.js';
import { decodeJwtPayload, getAccountIdFromClaims, getEmailFromClaims, getExpiryFromClaims } from './codex-auth.js';
// OpenAI OAuth endpoints (same as official Codex CLI)
const OPENAI_ISSUER = 'https://auth.openai.com';
const AUTHORIZE_URL = `${OPENAI_ISSUER}/oauth/authorize`;
const TOKEN_URL = `${OPENAI_ISSUER}/oauth/token`;
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const REDIRECT_PORT = 1455;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/auth/callback`;
const SCOPES = ['openid', 'profile', 'email', 'offline_access'];
export async function createAuthorizationFlow() {
    const pkce = await generatePKCE();
    const state = randomBytes(16).toString('hex');
    const authUrl = new URL(AUTHORIZE_URL);
    authUrl.searchParams.set('client_id', CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', SCOPES.join(' '));
    authUrl.searchParams.set('code_challenge', pkce.challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('audience', 'https://api.openai.com/v1');
    authUrl.searchParams.set('id_token_add_organizations', 'true');
    authUrl.searchParams.set('codex_cli_simplified_flow', 'true');
    authUrl.searchParams.set('originator', 'codex_cli_rs');
    return { pkce, state, url: authUrl.toString() };
}
export async function loginAccount(alias, flow) {
    const activeFlow = flow ?? await createAuthorizationFlow();
    const { pkce, state } = activeFlow;
    return new Promise((resolve, reject) => {
        let server = null;
        const cleanup = () => {
            if (server) {
                server.close();
                server = null;
            }
        };
        server = http.createServer(async (req, res) => {
            if (!req.url?.startsWith('/auth/callback')) {
                res.writeHead(404);
                res.end('Not found');
                return;
            }
            const parsedUrl = url.parse(req.url, true);
            const code = parsedUrl.query.code;
            const returnedState = parsedUrl.query.state;
            if (!code) {
                res.writeHead(400);
                res.end('No authorization code received');
                cleanup();
                reject(new Error('No authorization code'));
                return;
            }
            if (returnedState && returnedState !== state) {
                res.writeHead(400);
                res.end('Invalid state');
                cleanup();
                reject(new Error('Invalid state'));
                return;
            }
            try {
                // Exchange code for tokens
                const tokenRes = await fetch(TOKEN_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        grant_type: 'authorization_code',
                        client_id: CLIENT_ID,
                        code,
                        code_verifier: pkce.verifier,
                        redirect_uri: REDIRECT_URI
                    })
                });
                if (!tokenRes.ok) {
                    throw new Error(`Token exchange failed: ${tokenRes.status}`);
                }
                const tokens = (await tokenRes.json());
                if (!tokens.refresh_token) {
                    throw new Error('Token exchange did not return a refresh_token');
                }
                const now = Date.now();
                const accessClaims = decodeJwtPayload(tokens.access_token);
                const idClaims = tokens.id_token ? decodeJwtPayload(tokens.id_token) : null;
                const expiresAt = getExpiryFromClaims(accessClaims) || getExpiryFromClaims(idClaims) || now + tokens.expires_in * 1000;
                let email = getEmailFromClaims(idClaims) || getEmailFromClaims(accessClaims);
                try {
                    const userRes = await fetch(`${OPENAI_ISSUER}/userinfo`, {
                        headers: { Authorization: `Bearer ${tokens.access_token}` }
                    });
                    if (userRes.ok) {
                        const user = (await userRes.json());
                        email = user.email || email;
                    }
                }
                catch {
                    /* user info fetch is non-critical */
                }
                const accountId = getAccountIdFromClaims(idClaims) ||
                    getAccountIdFromClaims(accessClaims);
                const store = addAccount(alias, {
                    accessToken: tokens.access_token,
                    refreshToken: tokens.refresh_token,
                    idToken: tokens.id_token,
                    accountId,
                    expiresAt,
                    email,
                    lastRefresh: new Date(now).toISOString(),
                    lastSeenAt: now,
                    source: 'opencode',
                    authInvalid: false,
                    authInvalidatedAt: undefined
                });
                const account = store.accounts[alias];
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(`
          <html>
            <body style="font-family: system-ui; padding: 40px; text-align: center;">
              <h1>Account "${alias}" authenticated!</h1>
              <p>${email || 'Unknown email'}</p>
              <p>You can close this window.</p>
            </body>
          </html>
        `);
                cleanup();
                resolve(account);
            }
            catch (err) {
                res.writeHead(500);
                res.end('Authentication failed');
                cleanup();
                reject(err);
            }
        });
        server.listen(REDIRECT_PORT, () => {
            console.log(`\n[multi-auth] Login for account "${alias}"`);
            console.log(`[multi-auth] Open this URL in your browser:\n`);
            console.log(`  ${activeFlow.url}\n`);
            console.log(`[multi-auth] Waiting for callback on port ${REDIRECT_PORT}...`);
        });
        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                reject(new Error(`Port ${REDIRECT_PORT} is in use. Stop Codex CLI if running.`));
            }
            else {
                reject(err);
            }
        });
        // Timeout after 5 minutes
        setTimeout(() => {
            cleanup();
            reject(new Error('Login timeout - no callback received'));
        }, 5 * 60 * 1000);
    });
}
export async function refreshToken(alias) {
    const store = loadStore();
    const account = store.accounts[alias];
    if (!account?.refreshToken) {
        console.error(`[multi-auth] No refresh token for ${alias}`);
        return null;
    }
    try {
        const tokenRes = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                client_id: CLIENT_ID,
                refresh_token: account.refreshToken
            })
        });
        if (!tokenRes.ok) {
            console.error(`[multi-auth] Refresh failed for ${alias}: ${tokenRes.status}`);
            // If the refresh token is invalid/expired, mark this account invalid so
            // rotation can keep working without repeatedly selecting a broken account.
            if (tokenRes.status === 401 || tokenRes.status === 403) {
                try {
                    updateAccount(alias, {
                        authInvalid: true,
                        authInvalidatedAt: Date.now()
                    });
                }
                catch {
                    // ignore
                }
            }
            return null;
        }
        const tokens = (await tokenRes.json());
        const accessClaims = decodeJwtPayload(tokens.access_token);
        const idClaims = tokens.id_token ? decodeJwtPayload(tokens.id_token) : null;
        const expiresAt = getExpiryFromClaims(accessClaims) || getExpiryFromClaims(idClaims) || Date.now() + tokens.expires_in * 1000;
        const updates = {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token || account.refreshToken,
            expiresAt,
            lastRefresh: new Date().toISOString(),
            idToken: tokens.id_token || account.idToken,
            accountId: getAccountIdFromClaims(idClaims) ||
                getAccountIdFromClaims(accessClaims) ||
                account.accountId
        };
        const updatedStore = updateAccount(alias, updates);
        clearAuthInvalid(alias);
        return updatedStore.accounts[alias];
    }
    catch (err) {
        console.error(`[multi-auth] Refresh error for ${alias}:`, err);
        return null;
    }
}
export async function ensureValidToken(alias) {
    const store = loadStore();
    const account = store.accounts[alias];
    if (!account)
        return null;
    // Refresh if expiring within 5 minutes
    const bufferMs = 5 * 60 * 1000;
    if (account.expiresAt < Date.now() + bufferMs) {
        console.log(`[multi-auth] Refreshing token for ${alias}`);
        const refreshed = await refreshToken(alias);
        return refreshed?.accessToken || null;
    }
    return account.accessToken;
}
//# sourceMappingURL=auth.js.map