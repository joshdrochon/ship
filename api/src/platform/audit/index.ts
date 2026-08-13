/**
 * audit/ — the public API call log.
 *
 * One row per `/api/v1` request: timestamp, app `client_id`, `user_id`, route,
 * scope, status, latency, `request_id`. This is what makes "the agent went
 * through the front door" provable with a query rather than a claim.
 */
export * from './audit.js';
export * from './pgAuditSink.js';
