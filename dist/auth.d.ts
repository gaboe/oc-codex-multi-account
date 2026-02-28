import type { AccountCredentials } from './types.js';
interface AuthorizationFlow {
    pkce: {
        verifier: string;
        challenge: string;
    };
    state: string;
    url: string;
}
export declare function createAuthorizationFlow(): Promise<AuthorizationFlow>;
export declare function loginAccount(alias: string, flow?: AuthorizationFlow): Promise<AccountCredentials>;
export declare function refreshToken(alias: string): Promise<AccountCredentials | null>;
export declare function ensureValidToken(alias: string): Promise<string | null>;
/**
 * Exchange an authorization code for tokens and update the account store.
 * Used by the 2-step reauth flow (step 2).
 */
export declare function exchangeCodeForTokens(alias: string, code: string, verifier: string): Promise<AccountCredentials>;
export {};
//# sourceMappingURL=auth.d.ts.map