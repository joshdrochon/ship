/**
 * api/v1/ — the ONLY public router.
 *
 * A fresh middleware stack that shares nothing with the internal `/api`
 * surface: bearer auth, scope enforcement, rate limiting, audit, and the
 * `ApiError` envelope. List endpoints paginate with opaque cursors.
 */
export * from './errors.js';
export * from './requestId.js';
export * from './errorMiddleware.js';
export * from './routeFitness.js';
export * from './envelopeAssertion.js';
export * from './pagination.js';
export { createPublicRouter } from './router.js';
export type { PublicRouterDeps } from './router.js';
