/**
 * Moved to `@ship/shared`. This file is a re-export, kept so existing imports
 * keep working.
 *
 * ── Why it moved ────────────────────────────────────────────────────────────
 * The agent needs the same breaker — engineering requirement 4 says reuse it,
 * do not write a second one. It was reaching it through
 * `../../../api/dist/services/circuitBreaker.js`, a relative path into another
 * package's build output. That worked, and it quietly made `api` unable to
 * import anything from `agent`: doing so would have closed a build cycle where
 * neither package could compile first.
 *
 * That cycle is why `POST /api/fleetgraph/chat` returned 503 `agent_not_wired`
 * while its route, schema, rate limit and tests were all finished. The graph
 * existed; `api` simply had no way to reach it.
 *
 * The breaker is a generic, dependency-free utility used by two packages, which
 * is what `shared/` is for. Moving it makes the dependency graph a line —
 * shared → agent → api — instead of a loop.
 *
 * The re-export stays because deleting it would touch call sites that have
 * nothing to do with this change, and a rename that large hides the one edit
 * that matters.
 */
export {
  CircuitBreaker,
  CircuitOpenError,
  type CircuitBreakerOptions,
  type CircuitState,
} from '@ship/shared';
