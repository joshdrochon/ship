/**
 * OAuth flow helpers — each flow end-to-end in one call.
 *
 * TODO(josh) E5:
 *  - authorizationCodeFlow({ baseUrl, clientId, redirectUri, scopes, openBrowser })
 *      generates verifier+S256 challenge, drives /oauth/authorize, exchanges
 *      the code at /oauth/token, persists via ITokenStore.
 *  - deviceLogin({ baseUrl, clientId, scopes, onUserCode })
 *      POST /oauth/device/code → surface user_code + verification_uri →
 *      poll /oauth/token honoring `interval` and slow_down (+5s) → persist.
 *  - refresh handling: single-flight, rotate on every use, corrupted store →
 *      treated as logged out ({ kind: 'auth' }).
 */
export {};
