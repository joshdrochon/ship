/**
 * What the drill needs, and a loud failure when it is missing.
 *
 * No conditional skip anywhere in this package. CLAUDE.md is explicit and L19
 * learned it the expensive way: a suite that skips itself when the world is not
 * set up reports green for a run that proved nothing, and "16 tests green" came
 * to mean "nothing has ever been executed against a booted Ship".
 */
function required(name: string, why: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is required by the refresh-rotation drill. ${why}\n` +
        'Run it with `pnpm drill:refresh`, which boots both instances and sets all four.\n' +
        'See integrations/drills/refresh-rotation/README.md.',
    );
  }
  return value;
}

/** A booted Ship with ordinary token TTLs. */
export function baseUrl(): string {
  return required('SHIP_DRILL_BASE_URL', 'It must point at a booted Ship.').replace(/\/+$/, '');
}

/**
 * A second instance booted with a zero-second refresh TTL.
 *
 * PF-727: *"Token expiry is produced by configuring a short TTL at boot, never
 * by waiting."* A zero-second TTL is the strongest form of that — the refresh
 * token is born expired, so the `expired` case needs no elapsed time at all and
 * cannot flake on a slow machine. One process cannot hold two TTL configs, so
 * this is a second process rather than a second code path.
 */
export function expiredBaseUrl(): string {
  return required(
    'SHIP_DRILL_EXPIRED_BASE_URL',
    'It must point at a Ship booted with SHIP_REFRESH_TOKEN_TTL_SECONDS=0.',
  ).replace(/\/+$/, '');
}

/** The public OAuth app both instances know. Public: a drill holds no secret. */
export function clientId(): string {
  return required('SHIP_DRILL_CLIENT_ID', 'It is the registered public client the drill logs in as.');
}
