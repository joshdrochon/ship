/**
 * scopes/ — ScopeRegistry (scopes-as-data) and the `requireScope` middleware
 * factory.
 *
 * Open/Closed: adding a scope is a registration in `scopes.ts` at module load,
 * not an edit to a middleware. The 403 handler reads the registry to name the
 * missing scope and to quote its description back to the caller.
 *
 * Five files, deliberately separated (PF-061 splits the first two apart, and
 * the sketch this replaced had them in one):
 *
 *   registry.ts       the data structure — no express, no HTTP, no scope names
 *   scopes.ts         the seven canonical scopes; the ONLY file a new scope edits
 *   auth-context.ts   request state the platform reads (`res.locals.platformAuth`)
 *   require-scope.ts  the middleware factory — no scope names, no scope prose
 *   route-metadata.ts what each route declares, for PF-079 and L13's generator
 */
export * from './registry.js';
export * from './scopes.js';
export * from './auth-context.js';
export * from './require-scope.js';
export * from './route-metadata.js';
