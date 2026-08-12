/**
 * Platform barrel — what the composition root (api/src/app.ts) wires together.
 *
 * Each of the eight modules below owns its own barrel; this file re-exports
 * those, so the composition root imports from `./platform/index.js` and never
 * reaches past a module boundary into a file.
 *
 * app.ts sketch (see docs/architecture.md "Composition Root"):
 *
 *   import { createPublicRouter, createOAuthRouter, InProcessEventBus, ... } from './platform/index.js';
 *   app.use('/oauth', createOAuthRouter(oauthDeps));
 *   app.use('/api/v1', createPublicRouter({ bearerAuth, perAppLimiter, perTokenLimiter, auditSink }));
 *   app.get('/api/v1/openapi.json', serveGeneratedSpec());   // boot-fails on generation error
 */
export * from './api/v1/index.js';
export * from './scopes/index.js';
export * from './webhooks/index.js';
export * from './ratelimit/index.js';
export * from './oauth/index.js';
export * from './apps/index.js';
export * from './audit/index.js';
export * from './openapi/index.js';
