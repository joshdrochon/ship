/**
 * The action layer's public surface.
 *
 * Two exports matter to callers: `makeShipAct`, which is what gets injected as
 * `GraphDeps.act`, and `getShipApiBreakerStats`, which the health endpoint
 * reads (Q28). Everything else is exported for tests.
 *
 * Nothing here imports a runtime value from `graph/`. The dependency runs the
 * other way — the graph injects this — and keeping it type-only means the
 * action client can be exercised with nothing else running.
 */
export {
  createShipClient,
  getShipApiBreakerStats,
  resetShipApiBreaker,
  assertSingleDocumentPath,
  AUTOMATED_BY,
  MAX_ATTEMPTS,
  MAX_TOTAL_MS,
  REQUEST_TIMEOUT_MS,
  CircuitBreaker,
  CircuitOpenError,
} from './client.js';
export type {
  ShipClient,
  ShipClientOptions,
  ShipResult,
  FetchLike,
  HttpResponse,
} from './client.js';

export { makeShipAct } from './act.js';
export type { ActResult } from './act.js';
