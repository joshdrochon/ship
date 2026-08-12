/**
 * scopes/ — ScopeRegistry (scopes-as-data) and the `requireScope` middleware
 * factory.
 *
 * Open/Closed: adding a scope is a registration at module load, not an edit to
 * a middleware. The 403 handler reads the registry to name the missing scope.
 */
export * from './registry.js';
