/**
 * PF-660 — the portal's four rendered states, as one mapping both list hooks
 * share.
 *
 * *"Empty, error, 401 and 429 states are rendered states — the portal never
 * spins or blanks."* The empty and auth cases are behaviour (an empty-state node;
 * a silent single re-mint), and the other two are this function: a `ShipError`
 * becomes a `message` plus the `request_id` a developer can quote in a bug
 * report (PF-502), and a 429 additionally becomes the number of seconds to wait,
 * taken from `Retry-After` (PF-306).
 *
 * ── Why `retryAfterSeconds` is null for everything except a rate limit ───────
 * `ShipError.retryAfterSeconds` is also populated for some retryable server
 * failures, and the UI uses this field to DISABLE a control until it elapses.
 * Disabling Retry for 30 seconds after a 502 would be the portal punishing a
 * user for the server's fault; only a 429 is a limit the user can actually spend
 * their way past, and only a 429 is a bucket their own integration shares
 * (PF-304). So the narrowing is on `kind`, not on the presence of the header.
 *
 * Extracted from `usePortalDeliveries` when `usePortalSubscriptions` arrived
 * rather than copied into it: two hooks mapping errors slightly differently is
 * how one screen ends up showing `request_id` and its neighbour showing a bare
 * "something went wrong".
 */
import { ShipError } from '@ship/sdk';
import { PortalTokenError } from './portalClient';

/** What the UI renders instead of guessing. */
export interface PortalError {
  message: string;
  requestId: string | null;
  /** Seconds to wait, and ONLY when the failure was a 429. */
  retryAfterSeconds: number | null;
}

export function toPortalError(e: unknown, fallback: string): PortalError {
  if (e instanceof ShipError) {
    return {
      message: e.message,
      requestId: e.requestId ?? null,
      retryAfterSeconds: e.kind === 'rate_limit' ? (e.retryAfterSeconds ?? null) : null,
    };
  }
  // A PF-652 mint that failed. It carries no `request_id` — the token endpoint is
  // on the session surface, not on `/api/v1`, so there is no envelope to read one
  // from, and inventing a blank field would suggest one exists to quote.
  if (e instanceof PortalTokenError) {
    return { message: e.message, requestId: null, retryAfterSeconds: null };
  }
  return {
    message: e instanceof Error ? e.message : fallback,
    requestId: null,
    retryAfterSeconds: null,
  };
}
