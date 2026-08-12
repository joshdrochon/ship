/**
 * @ship/sdk — public surface.
 *
 * Stable this week: ShipClient (+ resource clients), verifyWebhook, ShipError
 * union, paginate. Pre-1.0 (may move): ITokenStore beyond in-memory, OAuth
 * flow helper option bags.
 */
export { ShipClient } from './client.js';
export type { ShipClientOptions, Me } from './client.js';
export { ShipError, errorFromResponse } from './errors.js';
export type { ShipErrorKind, ApiErrorBody } from './errors.js';
export { verifyWebhook, SIGNATURE_HEADER } from './webhooks.js';
export type { VerifyOptions } from './webhooks.js';
export { paginate } from './pagination.js';
export type { Page } from './pagination.js';
export { InMemoryTokenStore } from './auth/tokenStore.js';
export type { ITokenStore, StoredTokens } from './auth/tokenStore.js';
export { DocumentsClient } from './resources/documents.js';
export type { ShipDocument, CreateDocumentInput } from './resources/documents.js';
