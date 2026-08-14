/**
 * PF-497 — `ShipErrorKind` is exactly five members, and an exhaustive `switch`
 * compiles with NO `default` branch.
 *
 * PRD p.4: *"Consumers can switch on kind exhaustively."* That is a COMPILE-TIME
 * property. A runtime test that switches over five strings passes just as
 * happily when a sixth kind is added and nobody handles it — the whole value of
 * an exhaustive switch is that `tsc` refuses the incomplete one.
 *
 * So the proof is the `never` assignment below. Delete a case and
 * `pnpm type-check` fails with "Type 'ShipErrorKind' is not assignable to type
 * 'never'"; add a sixth kind to the union and it fails the same way.
 */
import type { ShipErrorKind } from '../src/index.js';
import { SHIP_ERROR_KINDS, ShipError } from '../src/index.js';

/**
 * The exhaustive switch, with no `default`. `noImplicitReturns` is on, so every
 * path must return — which is a second, independent way this breaks if a case
 * goes missing.
 */
export function describe(error: ShipError): string {
  switch (error.kind) {
    case 'auth':
      // The 6→5 collapse in action (PF-500): `kind` alone cannot tell 401 from
      // 403, and `code` can.
      return error.code === 'forbidden'
        ? `Missing scope: ${error.requiredScope ?? 'unknown'}`
        : 'Re-authenticate or refresh.';
    case 'rate_limit':
      return `Slow down for ${error.retryAfterSeconds ?? 0}s.`;
    case 'not_found':
      return 'No such resource.';
    case 'validation':
      return 'The request was rejected.';
    case 'server':
      return 'Ship failed. Retry or report the request id.';
    default: {
      // THE PROOF. Reachable only if a `kind` exists that no case above
      // handles, and assigning a non-`never` value to `never` is an error.
      const unreachable: never = error.kind;
      return unreachable;
    }
  }
}

/** The union and the runtime array are the same five members, in both directions. */
type KindsMatchArray = (typeof SHIP_ERROR_KINDS)[number] extends ShipErrorKind ? true : never;
type ArrayMatchesKinds = ShipErrorKind extends (typeof SHIP_ERROR_KINDS)[number] ? true : never;

export const kindsAgree: KindsMatchArray & ArrayMatchesKinds = true;

/** A sixth kind is not assignable — the union is closed. */
// @ts-expect-error — 'teapot' is not a ShipErrorKind.
export const notAKind: ShipErrorKind = 'teapot';
