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
export * from './page.js';
export * from './routeMetadata.js';
export * from './keysetIndex.js';
export * from './middlewareOrder.js';
export * from './bodyErrors.js';
export { createPublicRouter, V1_UNAUTHENTICATED_PATHS, isUnauthenticatedV1Path, PUBLIC_BODY_LIMIT } from './router.js';
export type { PublicRouterDeps } from './router.js';
